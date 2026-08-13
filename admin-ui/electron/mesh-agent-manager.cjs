'use strict'

/**
 * WXQK MeshAgent lifecycle helpers for Electron client.
 * Brands the Windows agent as WXQK (EXE / service / install dir).
 * Does NOT implement remote desktop protocol — only install/start/stop/migrate.
 *
 * Log tag: [MESH]. Secrets (msh contents, tokens) must be redacted.
 * User-facing UI messages stay generic ("正在准备服务…"); tech detail stays in logs.
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { spawn, execFile } = require('child_process')
const { promisify } = require('util')
const serviceHealth = require('./mesh-service-health.cjs')
const agentArtifact = require('./mesh-agent-artifact.cjs')
const { withAgentLifecycleLock } = require('./agent-lifecycle-lock.cjs')

const execFileAsync = promisify(execFile)

const LOG_TAG = '[MESH]'
/** Windows service name / display name after MeshCentral agentCustomization */
const SERVICE_NAME = 'WXQK'
const SERVICE_DISPLAY_NAME = 'WXQK'
const EXE_NAME = 'WXQK.exe'
const MSH_NAME = 'WXQK.msh'
/** Pre-branding installs used MeshCentral defaults — migration only */
const LEGACY_SERVICE_NAME = 'Mesh Agent'
const LEGACY_EXE_NAMES = ['MeshAgent.exe', 'meshagent.exe']
const LEGACY_MSH_NAMES = ['MeshAgent.msh', 'meshagent.msh']
const AGENT_NAME_PREFIX = 'WXQK-'
/** MeshServer / MeshID / ServerID / MeshName must never be rewritten from clientId. */
const MSH_IDENTITY_KEYS = new Set(['MeshServer', 'MeshID', 'ServerID', 'MeshName'])

/**
 * @typedef {{
 *   spawn?: typeof spawn,
 *   execFile?: typeof execFile,
 *   fs?: typeof fs,
 *   platform?: NodeJS.Platform,
 *   resourcesPath?: string,
 *   isPackaged?: boolean,
 *   now?: () => number,
 *   installedAgentDir?: string,
 *   legacyInstalledAgentDir?: string,
 *   serviceBinaryPath?: string,
 *   verifyBrandedArtifact?: (exePath: string) => Promise<{ ok: boolean, code?: string, message?: string, fileDescription?: string, originalFilename?: string, skipped?: boolean }> | { ok: boolean, code?: string, message?: string, fileDescription?: string, originalFilename?: string, skipped?: boolean },
 * }} MeshAgentDeps
 */
/** @type {MeshAgentDeps} */
let deps = {
  spawn,
  execFile,
  fs,
  platform: process.platform,
  resourcesPath: process.resourcesPath || '',
  isPackaged: undefined,
  now: () => Date.now(),
}

/**
 * Inject doubles for unit tests.
 * @param {Partial<typeof deps>} overrides
 */
function setMeshAgentDepsForTest(overrides = {}) {
  deps = { ...deps, ...overrides }
}

function resetMeshAgentDepsForTest() {
  deps = {
    spawn,
    execFile,
    fs,
    platform: process.platform,
    resourcesPath: process.resourcesPath || '',
    isPackaged: undefined,
    now: () => Date.now(),
  }
}

/**
 * @param {unknown} value
 */
function redact(value) {
  const text = String(value == null ? '' : value)
  return text
    .replace(/login=[^&\s]+/gi, 'login=***')
    .replace(/auth=[^&\s]+/gi, 'auth=***')
    .replace(/MeshID=[^\s\r\n]+/gi, 'MeshID=***')
    .replace(/ServerID=[^\s\r\n]+/gi, 'ServerID=***')
    .replace(/[0-9a-f]{64,}/gi, '***hex***')
}

/**
 * @param {'INFO'|'WARN'|'ERROR'} level
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 */
function log(level, message, extra) {
  const payload = extra && Object.keys(extra).length
    ? ` ${redact(JSON.stringify(extra))}`
    : ''
  const line = `${LOG_TAG} ${level} ${redact(message)}${payload}`
  if (level === 'ERROR') console.error(line)
  else if (level === 'WARN') console.warn(line)
  else console.log(line)
}

function isPackaged() {
  if (typeof deps.isPackaged === 'boolean') return deps.isPackaged
  try {
    // eslint-disable-next-line global-require
    const { app } = require('electron')
    return Boolean(app && app.isPackaged)
  } catch {
    return Boolean(deps.resourcesPath)
  }
}

/**
 * Resolve packaged WXQK agent binary + .msh directory.
 * Production: process.resourcesPath/meshcentral
 * Dev: admin-ui/resources/meshcentral
 */
function resolveMeshAgentPaths() {
  const packaged = isPackaged()
  const resourcesRoot = packaged
    ? path.join(String(deps.resourcesPath || process.resourcesPath || ''), 'meshcentral')
    : path.join(__dirname, '..', 'resources', 'meshcentral')

  return {
    root: resourcesRoot,
    exePath: path.join(resourcesRoot, EXE_NAME),
    mshPath: path.join(resourcesRoot, MSH_NAME),
    packaged,
  }
}

/**
 * @param {string} dir
 * @param {string[]} exeNames
 * @param {string[]} mshNames
 * @returns {{ dir: string, exePath: string, mshPath: string, branded: boolean } | null}
 */
function pickAgentDir(dir, exeNames, mshNames, branded) {
  const fsApi = deps.fs || fs
  for (const exeName of exeNames) {
    const exePath = path.join(dir, exeName)
    try {
      if (!fsApi.existsSync(exePath)) continue
      let mshPath = ''
      for (const mshName of mshNames) {
        const candidate = path.join(dir, mshName)
        if (fsApi.existsSync(candidate)) {
          mshPath = candidate
          break
        }
      }
      if (!mshPath) mshPath = path.join(dir, mshNames[0])
      return { dir, exePath, mshPath, branded: Boolean(branded) }
    } catch { /* continue */ }
  }
  return null
}

/**
 * Branded install dirs (MeshCentral agentCustomization: companyName + serviceName).
 * Typical: Program Files\WXQK\WXQK.exe or Program Files\WXQK\WXQK\WXQK.exe
 */
function brandedInstallDirCandidates() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  return [
    path.join(pf, 'WXQK'),
    path.join(pf, 'WXQK', 'WXQK'),
    path.join(pf86, 'WXQK'),
    path.join(pf86, 'WXQK', 'WXQK'),
  ]
}

function legacyInstallDirCandidates() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  return [
    path.join(pf, 'Mesh Agent'),
    path.join(pf86, 'Mesh Agent'),
  ]
}

/**
 * Windows service install directory for branded WXQK agent.
 * @returns {{ dir: string, exePath: string, mshPath: string, branded: boolean } | null}
 */
function resolveInstalledMeshAgentPaths() {
  if (deps.installedAgentDir) {
    const dir = String(deps.installedAgentDir)
    return pickAgentDir(dir, [EXE_NAME, 'WXQK.EXE', ...LEGACY_EXE_NAMES], [MSH_NAME, 'WXQK.MSH', ...LEGACY_MSH_NAMES], true)
      || {
        dir,
        exePath: path.join(dir, EXE_NAME),
        mshPath: path.join(dir, MSH_NAME),
        branded: true,
      }
  }
  if ((deps.platform || process.platform) !== 'win32') return null
  for (const dir of brandedInstallDirCandidates()) {
    const found = pickAgentDir(dir, [EXE_NAME, 'WXQK.EXE'], [MSH_NAME, 'WXQK.MSH', ...LEGACY_MSH_NAMES], true)
    if (found) return found
  }
  return null
}

/**
 * Legacy Mesh Agent install path (pre-branding). Used only for ownership check + migration.
 * @returns {{ dir: string, exePath: string, mshPath: string, branded: boolean } | null}
 */
function resolveLegacyInstalledMeshAgentPaths() {
  if (deps.legacyInstalledAgentDir) {
    const dir = String(deps.legacyInstalledAgentDir)
    return pickAgentDir(dir, LEGACY_EXE_NAMES, LEGACY_MSH_NAMES, false)
      || {
        dir,
        exePath: path.join(dir, 'MeshAgent.exe'),
        mshPath: path.join(dir, 'MeshAgent.msh'),
        branded: false,
      }
  }
  if ((deps.platform || process.platform) !== 'win32') return null
  for (const dir of legacyInstallDirCandidates()) {
    const found = pickAgentDir(dir, LEGACY_EXE_NAMES, LEGACY_MSH_NAMES, false)
    if (found) return found
  }
  return null
}

/**
 * True when a running Agent cannot be matched as WXQK-<clientId> (missing/stale msh).
 * @param {string} clientId
 */
function installedAgentNeedsRepair(clientId) {
  const expected = buildAgentName(clientId)
  if (!expected) return false
  const installed = resolveInstalledMeshAgentPaths() || resolveLegacyInstalledMeshAgentPaths()
  if (!installed) return true
  const fsApi = deps.fs || fs
  try {
    if (!fsApi.existsSync(installed.mshPath)) return true
    const raw = fsApi.readFileSync(installed.mshPath, 'utf8')
    const parsed = parseMshText(raw)
    const current = String(parsed.get('agentName') || '').trim()
    if (current !== expected) return true
    const templatePath = resolveMeshAgentPaths().mshPath
    if (fileExists(templatePath)) {
      const tmpl = parseMshText(fsApi.readFileSync(templatePath, 'utf8'))
      for (const key of ['MeshServer', 'ServerID', 'MeshID', 'MeshName']) {
        const want = String(tmpl.get(key) || '').trim()
        const got = String(parsed.get(key) || '').trim()
        if (want && want !== got) return true
      }
    }
    return false
  } catch {
    return true
  }
}

/**
 * Validate clientId before writing agentName into msh.
 * @param {unknown} value
 * @returns {string}
 */
function safeClientIdForAgent(value) {
  const id = String(value || '').trim()
  if (!id || id.length > 128 || !/^[A-Za-z0-9._:@-]+$/.test(id)) return ''
  return id
}

/**
 * MeshAgent display name sent to MeshCentral (replaces hostname for new installs).
 * @param {string} clientId
 * @returns {string}
 */
function buildAgentName(clientId) {
  const cid = safeClientIdForAgent(clientId)
  return cid ? `${AGENT_NAME_PREFIX}${cid}` : ''
}

/**
 * Parse msh key=value lines (ignore blanks / comments).
 * @param {string} text
 * @returns {Map<string, string>}
 */
function parseMshText(text) {
  const map = new Map()
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1).trim()
    if (key) map.set(key, val)
  }
  return map
}

/**
 * Serialize msh map preserving identity keys; set/replace agentName only.
 * @param {Map<string, string>} map
 * @param {string} agentName
 * @returns {string}
 */
function serializeMshWithAgentName(map, agentName) {
  const next = new Map(map)
  if (agentName) next.set('agentName', agentName)
  else next.delete('agentName')
  const lines = []
  for (const [key, val] of next.entries()) {
    lines.push(`${key}=${val}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * Copy template msh → staging and set agentName=WXQK-<clientId>.
 * Never mutates the shared resources template.
 * @param {{ clientId: string, stagingDir: string, templateMshPath?: string }} opts
 */
function stageMshForClient(opts) {
  const clientId = safeClientIdForAgent(opts.clientId)
  const agentName = buildAgentName(clientId)
  if (!clientId || !agentName) {
    return { ok: false, code: 'BAD_CLIENT_ID', message: 'clientId 无效，无法写入 agentName' }
  }
  const templatePath = opts.templateMshPath || resolveMeshAgentPaths().mshPath
  const stagingDir = String(opts.stagingDir || '').trim()
  if (!stagingDir) {
    return { ok: false, code: 'BAD_STAGING', message: 'staging 目录无效' }
  }
  const fsApi = deps.fs || fs
  if (!fileExists(templatePath)) {
    return { ok: false, code: 'MESH_AGENT_FILES_MISSING', message: '缺少 WXQK.msh 模板' }
  }
  try {
    fsApi.mkdirSync(stagingDir, { recursive: true })
  } catch (err) {
    return { ok: false, code: 'STAGING_MKDIR_FAILED', message: String(err?.message || err) }
  }
  let raw = ''
  try {
    raw = fsApi.readFileSync(templatePath, 'utf8')
  } catch (err) {
    return { ok: false, code: 'MSH_READ_FAILED', message: String(err?.message || err) }
  }
  const parsed = parseMshText(raw)
  for (const key of MSH_IDENTITY_KEYS) {
    if (!parsed.has(key) || !String(parsed.get(key) || '').trim()) {
      return { ok: false, code: 'MSH_IDENTITY_INCOMPLETE', message: `模板缺少 ${key}` }
    }
  }
  const beforeIdentity = Object.fromEntries([...MSH_IDENTITY_KEYS].map((k) => [k, parsed.get(k)]))
  const stagedText = serializeMshWithAgentName(parsed, agentName)
  const staged = parseMshText(stagedText)
  for (const key of MSH_IDENTITY_KEYS) {
    if (staged.get(key) !== beforeIdentity[key]) {
      return { ok: false, code: 'MSH_IDENTITY_MUTATED', message: `拒绝修改 ${key}` }
    }
  }
  if (staged.get('agentName') !== agentName) {
    return { ok: false, code: 'MSH_AGENT_NAME_FAILED', message: 'agentName 写入失败' }
  }
  const outPath = path.join(stagingDir, MSH_NAME)
  try {
    fsApi.writeFileSync(outPath, stagedText, 'utf8')
  } catch (err) {
    return { ok: false, code: 'MSH_WRITE_FAILED', message: String(err?.message || err) }
  }
  return { ok: true, code: 'OK', agentName, mshPath: outPath, stagingDir }
}

/**
 * Prepare staging dir with exe + agentName msh for a fresh install.
 * @param {string} clientId
 */
function prepareInstallStaging(clientId) {
  const paths = resolveMeshAgentPaths()
  if (!fileExists(paths.exePath) || !fileExists(paths.mshPath)) {
    return { ok: false, code: 'MESH_AGENT_FILES_MISSING', message: '缺少 WXQK.exe 或 WXQK.msh' }
  }
  const fsApi = deps.fs || fs
  const stagingDir = path.join(os.tmpdir(), `wxqk-mesh-stage-${safeClientIdForAgent(clientId) || 'x'}-${Date.now()}`)
  const staged = stageMshForClient({ clientId, stagingDir, templateMshPath: paths.mshPath })
  if (!staged.ok) return staged
  const stagedExe = path.join(stagingDir, EXE_NAME)
  try {
    fsApi.copyFileSync(paths.exePath, stagedExe)
  } catch (err) {
    return { ok: false, code: 'EXE_COPY_FAILED', message: String(err?.message || err) }
  }
  return {
    ok: true,
    code: 'OK',
    stagingDir,
    exePath: stagedExe,
    mshPath: staged.mshPath,
    agentName: staged.agentName,
  }
}

/**
 * @param {string} filePath
 */
function fileExists(filePath) {
  try {
    return deps.fs.existsSync(filePath)
  } catch {
    return false
  }
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number, windowsHide?: boolean }} [opts]
 */
function runExecFile(command, args, opts = {}) {
  const exec = deps.execFile || execFile
  const timeout = opts.timeoutMs || 120000
  return new Promise((resolve) => {
    exec(
      command,
      args,
      {
        cwd: opts.cwd,
        timeout,
        windowsHide: opts.windowsHide !== false,
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: error ? String(error.message || error) : '',
        })
      },
    )
  })
}

/**
 * Elevate a command via PowerShell Start-Process -Verb RunAs (UAC).
 * @param {string} file
 * @param {string[]} args
 * @param {{ cwd?: string }} [opts]
 */
async function runElevated(file, args, opts = {}) {
  if ((deps.platform || process.platform) !== 'win32') {
    return runExecFile(file, args, { cwd: opts.cwd })
  }
  const argList = (args || []).map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',')
  const cwd = String(opts.cwd || '').trim()
  const wd = cwd ? ` -WorkingDirectory '${cwd.replace(/'/g, "''")}'` : ''
  const ps = [
    `$p = Start-Process -FilePath '${String(file).replace(/'/g, "''")}'`,
    argList ? ` -ArgumentList @(${argList})` : '',
    wd,
    ' -Verb RunAs -Wait -PassThru -WindowStyle Hidden',
    '; if ($null -eq $p) { exit 1 } else { exit $p.ExitCode }',
  ].join('')
  return runExecFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    timeoutMs: 300000,
  })
}

/**
 * Copy staged WXQK.msh into the Windows install directory (requires elevation).
 * @param {string} stagedMshPath
 */
async function syncInstalledMsh(stagedMshPath) {
  const installed = resolveInstalledMeshAgentPaths()
  if (!installed || !fileExists(stagedMshPath)) {
    return { ok: false, code: 'MSH_SYNC_SKIP', message: 'install dir or staged msh missing' }
  }
  const dest = path.join(installed.dir, MSH_NAME)
  const destAlt = path.join(installed.dir, 'WXQK.MSH')
  const src = String(stagedMshPath).replace(/'/g, "''")
  const dst = dest.replace(/'/g, "''")
  const dstAlt = destAlt.replace(/'/g, "''")
  const ps = [
    `Copy-Item -LiteralPath '${src}' -Destination '${dst}' -Force;`,
    `if (('${dstAlt}' -ne '${dst}') -and (Test-Path -LiteralPath '${dstAlt}')) { Remove-Item -LiteralPath '${dstAlt}' -Force -ErrorAction SilentlyContinue }`,
  ].join(' ')
  const result = await runElevated('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps])
  return {
    ok: result.ok,
    code: result.ok ? 'OK' : 'MSH_SYNC_FAILED',
    message: result.ok ? 'msh synced' : redact(result.stderr || result.error || 'msh sync failed'),
    dest,
  }
}

/**
 * @param {string} serviceName
 */
/**
 * Normalize BINARY_PATH_NAME from `sc qc` (strip quotes / args).
 * @param {string} raw
 * @returns {string}
 */
function normalizeServiceBinaryPath(raw) {
  let text = String(raw || '').trim()
  if (!text) return ''
  if (text.startsWith('"')) {
    const end = text.indexOf('"', 1)
    if (end > 1) return text.slice(1, end)
  }
  const flag = text.search(/\s+-\w/)
  if (flag > 0) return text.slice(0, flag).trim()
  return text
}

/**
 * Parse BINARY_PATH_NAME from `sc.exe qc` output.
 * @param {string} qcText
 * @returns {string}
 */
function parseScBinaryPath(qcText) {
  const text = String(qcText || '')
  const m = text.match(/BINARY_PATH_NAME\s*:\s*(.+)$/im)
  if (!m) return ''
  return normalizeServiceBinaryPath(m[1])
}

/**
 * Read real SCM ImagePath for a Windows service.
 * @param {string} serviceName
 * @returns {Promise<{ present: boolean, binaryPath: string, raw: string }>}
 */
async function queryServiceImagePath(serviceName) {
  if (typeof deps.serviceBinaryPath === 'string' && deps.serviceBinaryPath) {
    return { present: true, binaryPath: normalizeServiceBinaryPath(deps.serviceBinaryPath), raw: 'deps' }
  }
  if ((deps.platform || process.platform) !== 'win32') {
    return { present: false, binaryPath: '', raw: '' }
  }
  const result = await runExecFile('sc.exe', ['qc', serviceName], { timeoutMs: 15000 })
  const raw = `${result.stdout}\n${result.stderr}`
  if (/FAILED\s+1060/i.test(raw) || /does not exist/i.test(raw)) {
    return { present: false, binaryPath: '', raw }
  }
  const binaryPath = parseScBinaryPath(raw)
  return { present: Boolean(binaryPath) || result.ok, binaryPath, raw }
}

/**
 * Canonical branded install locations (Program Files\\WXQK\\WXQK.exe).
 * @returns {{ dir: string, exePath: string, mshPath: string }}
 */
function expectedBrandedInstallPaths() {
  if (deps.installedAgentDir) {
    const dir = String(deps.installedAgentDir)
    return { dir, exePath: path.join(dir, EXE_NAME), mshPath: path.join(dir, MSH_NAME) }
  }
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const dir = path.join(pf, 'WXQK')
  return { dir, exePath: path.join(dir, EXE_NAME), mshPath: path.join(dir, MSH_NAME) }
}

/**
 * True when ImagePath points at branded WXQK.exe under an allowed install dir.
 * @param {string} binaryPath
 * @param {string} [expectedExePath]
 */
function isBrandedImagePath(binaryPath, expectedExePath) {
  const normalized = normalizeServiceBinaryPath(binaryPath).replace(/\//g, '\\')
  if (!normalized) return false
  const base = path.basename(normalized).toLowerCase()
  if (base !== EXE_NAME.toLowerCase()) return false
  if (expectedExePath) {
    const want = String(expectedExePath).replace(/\//g, '\\').toLowerCase()
    if (normalized.toLowerCase() === want) return true
  }
  return /\\WXQK(?:\\WXQK)?\\WXQK\.exe$/i.test(normalized)
}

/**
 * Detect UAC / elevation denial from elevated command result.
 * @param {{ ok?: boolean, code?: number, stdout?: string, stderr?: string, error?: string }} result
 */
function isElevationDenied(result) {
  const text = `${result && result.stderr || ''}\n${result && result.stdout || ''}\n${result && result.error || ''}`
  if (/1223/.test(text)) return true
  if (/canceled by the user|cancelled by the user|被用户取消|用户取消/i.test(text)) return true
  if (/requires elevation|请求的操作需要提升/i.test(text)) return true
  return false
}

/**
 * PE / brand gate for packaged WXQK.exe — never install default MeshAgent artifact.
 * Non-PE test doubles (tiny fake files) skip with skipped:true.
 * @param {string} exePath
 */
async function verifyBrandedAgentArtifact(exePath) {
  if (typeof deps.verifyBrandedArtifact === 'function') {
    return deps.verifyBrandedArtifact(exePath)
  }
  if (!fileExists(exePath)) {
    return { ok: false, code: 'MESH_AGENT_FILES_MISSING', message: '缺少 WXQK.exe' }
  }
  if (path.basename(exePath).toLowerCase() !== EXE_NAME.toLowerCase()) {
    return { ok: false, code: 'MESH_BAD_ARTIFACT_NAME', message: 'Agent 文件名必须是 WXQK.exe' }
  }
  let isPe = false
  try {
    const fd = deps.fs.openSync(exePath, 'r')
    try {
      const buf = Buffer.alloc(2)
      deps.fs.readSync(fd, buf, 0, 2, 0)
      isPe = buf[0] === 0x4d && buf[1] === 0x5a
    } finally {
      try { deps.fs.closeSync(fd) } catch { /* ignore */ }
    }
  } catch {
    isPe = false
  }
  if (!isPe) {
    return { ok: true, skipped: true, fileDescription: 'WXQK', originalFilename: EXE_NAME }
  }
  if ((deps.platform || process.platform) !== 'win32') {
    return { ok: true, skipped: true, fileDescription: 'WXQK', originalFilename: EXE_NAME }
  }
  const esc = String(exePath).replace(/'/g, "''")
  const ps = [
    `$vi = [System.Diagnostics.FileVersionInfo]::GetVersionInfo('${esc}')`,
    `$obj = [pscustomobject]@{ FileDescription = $vi.FileDescription; OriginalFilename = $vi.OriginalFilename; ProductName = $vi.ProductName }`,
    `$obj | ConvertTo-Json -Compress`,
  ].join('; ')
  const result = await runExecFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    timeoutMs: 30000,
  })
  if (!result.ok) {
    return { ok: false, code: 'MESH_BAD_ARTIFACT', message: '无法读取 Agent 版本资源' }
  }
  let info = {}
  try {
    info = JSON.parse(String(result.stdout || '').trim() || '{}')
  } catch {
    return { ok: false, code: 'MESH_BAD_ARTIFACT', message: 'Agent 版本资源解析失败' }
  }
  const desc = String(info.FileDescription || '').trim()
  const orig = String(info.OriginalFilename || '').trim()
  const product = String(info.ProductName || '').trim()
  if (!/^WXQK$/i.test(desc) || !/^WXQK\.exe$/i.test(orig)) {
    return {
      ok: false,
      code: 'MESH_BAD_ARTIFACT',
      message: '发行包 Agent 不是品牌化 WXQK（疑似默认 MeshAgent）',
      fileDescription: desc,
      originalFilename: orig,
      productName: product,
    }
  }
  return { ok: true, fileDescription: desc, originalFilename: orig, productName: product }
}

/**
 * @param {string} serviceName
 */
async function queryNamedServiceState(serviceName) {
  if ((deps.platform || process.platform) !== 'win32') {
    return { present: false, state: 'unsupported', raw: '', name: serviceName }
  }
  const result = await runExecFile('sc.exe', ['query', serviceName], { timeoutMs: 15000 })
  const raw = `${result.stdout}\n${result.stderr}`
  if (/FAILED\s+1060/i.test(raw) || /does not exist/i.test(raw)) {
    return { present: false, state: 'missing', raw, name: serviceName }
  }
  if (/RUNNING/i.test(raw)) return { present: true, state: 'running', raw, name: serviceName }
  if (/STOPPED/i.test(raw)) return { present: true, state: 'stopped', raw, name: serviceName }
  if (/START_PENDING|STOP_PENDING|CONTINUE_PENDING|PAUSE_PENDING/i.test(raw)) {
    return { present: true, state: 'pending', raw, name: serviceName }
  }
  if (result.ok) return { present: true, state: 'unknown', raw, name: serviceName }
  return { present: false, state: 'error', raw, name: serviceName }
}

async function queryServiceState() {
  return queryNamedServiceState(SERVICE_NAME)
}

async function queryLegacyServiceState() {
  return queryNamedServiceState(LEGACY_SERVICE_NAME)
}

/**
 * @param {{
 *   installedExePresent: boolean,
 *   installedMshPresent: boolean,
 *   servicePresent: boolean,
 *   imagePath: string,
 *   imagePathOk: boolean,
 * }} probe
 */
function classifyBrandInstallHealth(probe) {
  const filesOk = Boolean(probe.installedExePresent && probe.installedMshPresent)
  if (probe.servicePresent) {
    if (!filesOk || !probe.imagePathOk) return 'stale_service'
    return 'files_and_service_ok'
  }
  if (filesOk) return 'files_only'
  return 'missing'
}

/**
 * True only when EXE + MSH exist and ImagePath is branded WXQK.exe.
 * Never treat bare servicePresent as success.
 * @param {{
 *   installedExePresent?: boolean,
 *   installedMshPresent?: boolean,
 *   exePresent?: boolean,
 *   mshPresent?: boolean,
 *   imagePathOk?: boolean,
 *   servicePresent?: boolean,
 *   status?: string,
 * }} status
 */
function isBrandedInstallHealthy(status) {
  const exe = status.installedExePresent != null ? status.installedExePresent : status.exePresent
  const msh = status.installedMshPresent != null ? status.installedMshPresent : status.mshPresent
  return Boolean(exe && msh && status.imagePathOk && status.servicePresent)
}

/**
 * Stop + delete orphan WXQK SCM registration (files may already be gone).
 */
async function removeStaleWxqkServiceRegistration() {
  log('WARN', 'removing stale WXQK service registration')
  await runElevated('sc.exe', ['stop', SERVICE_NAME])
  const deleted = await runElevated('sc.exe', ['delete', SERVICE_NAME])
  if (isElevationDenied(deleted)) {
    return { ok: false, code: 'MESH_ELEVATION_REQUIRED', message: '需要管理员权限以修复损坏的服务', result: deleted }
  }
  const expected = expectedBrandedInstallPaths()
  const dirEsc = expected.dir.replace(/'/g, "''")
  await runElevated('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `if (Test-Path -LiteralPath '${dirEsc}') { Remove-Item -LiteralPath '${dirEsc}' -Recurse -Force -ErrorAction SilentlyContinue }`,
  ])
  return {
    ok: deleted.ok || /1060|does not exist/i.test(`${deleted.stdout}\n${deleted.stderr}`),
    code: deleted.ok ? 'OK' : 'STALE_SERVICE_DELETE_FAILED',
    message: deleted.ok ? 'stale service removed' : redact(deleted.stderr || deleted.error || 'delete failed'),
    result: deleted,
  }
}

/**
 * Confirm a legacy Mesh Agent install belongs to this WXQK deployment.
 * @param {{ clientId?: string }} [opts]
 */
function isLegacyAgentOwnedByWxqk(opts = {}) {
  const legacy = resolveLegacyInstalledMeshAgentPaths()
  if (!legacy) {
    return { owned: false, reason: 'no_legacy_install' }
  }
  const fsApi = deps.fs || fs
  let parsed = new Map()
  try {
    if (fsApi.existsSync(legacy.mshPath)) {
      parsed = parseMshText(fsApi.readFileSync(legacy.mshPath, 'utf8'))
    }
  } catch {
    return { owned: false, reason: 'msh_unreadable' }
  }

  const agentName = String(parsed.get('agentName') || '').trim()
  if (agentName.startsWith(AGENT_NAME_PREFIX)) {
    const clientId = safeClientIdForAgent(opts.clientId)
    if (clientId) {
      const expected = buildAgentName(clientId)
      if (agentName === expected) {
        return { owned: true, reason: 'agentName_match', agentName, legacy }
      }
      return { owned: true, reason: 'agentName_prefix', agentName, legacy }
    }
    return { owned: true, reason: 'agentName_prefix', agentName, legacy }
  }

  const templatePath = resolveMeshAgentPaths().mshPath
  if (!fileExists(templatePath)) {
    return { owned: false, reason: 'no_template_to_compare', agentName, legacy }
  }
  try {
    const tmpl = parseMshText(fsApi.readFileSync(templatePath, 'utf8'))
    const keys = ['MeshServer', 'ServerID', 'MeshID']
    let matched = 0
    let required = 0
    for (const key of keys) {
      const want = String(tmpl.get(key) || '').trim()
      if (!want) continue
      required += 1
      const got = String(parsed.get(key) || '').trim()
      if (want === got) matched += 1
    }
    if (required >= 2 && matched === required) {
      return { owned: true, reason: 'identity_match', agentName, legacy }
    }
  } catch {
    return { owned: false, reason: 'template_compare_failed', agentName, legacy }
  }

  return { owned: false, reason: 'not_wxqk', agentName, legacy }
}

/**
 * Stop legacy service and attempt uninstall only after branded WXQK is healthy.
 * @param {{ clientId?: string }} [options]
 */
async function migrateLegacyMeshAgentToWxqk(options = {}) {
  const clientId = safeClientIdForAgent(options.clientId)
  const ownership = isLegacyAgentOwnedByWxqk({ clientId })
  if (!ownership.owned) {
    log('INFO', 'skip legacy migration — not WXQK owned', { reason: ownership.reason })
    return {
      ok: false,
      code: 'LEGACY_NOT_OWNED',
      action: 'skip_migrate',
      message: '检测到第三方 Mesh Agent，已跳过',
      ownership,
    }
  }

  log('INFO', 'migrating legacy Mesh Agent → WXQK', { reason: ownership.reason, clientId: clientId || undefined })

  const legacyState = await queryLegacyServiceState()
  const legacyWasRunning = legacyState.state === 'running' || legacyState.state === 'pending'
  if (legacyState.present) {
    await runExecFile('sc.exe', ['stop', LEGACY_SERVICE_NAME], { timeoutMs: 60000 })
  }

  const installed = await installMeshAgent({ clientId })
  if (!installed.ok) {
    log('ERROR', 'migration install failed — rolling back legacy', { message: installed.message })
    if (legacyWasRunning) {
      await runExecFile('sc.exe', ['start', LEGACY_SERVICE_NAME], { timeoutMs: 60000 })
    }
    return {
      ok: false,
      code: installed.code === 'MESH_ELEVATION_REQUIRED' ? 'MESH_ELEVATION_REQUIRED' : 'MIGRATE_INSTALL_FAILED',
      action: 'migrate_rollback',
      message: installed.message || '服务升级失败，已恢复旧服务',
      install: installed,
      ownership,
    }
  }

  const started = await startMeshAgent()
  if (!started.ok || !isBrandedInstallHealthy(started.status || {}) || (started.status && started.status.status !== 'running')) {
    log('ERROR', 'migration start failed — rolling back legacy', { message: started.message })
    try {
      await uninstallMeshAgent()
    } catch { /* best effort */ }
    if (legacyWasRunning || legacyState.present) {
      await runExecFile('sc.exe', ['start', LEGACY_SERVICE_NAME], { timeoutMs: 60000 })
    }
    return {
      ok: false,
      code: started.code === 'MESH_ELEVATION_REQUIRED' ? 'MESH_ELEVATION_REQUIRED' : 'MIGRATE_START_FAILED',
      action: 'migrate_rollback',
      message: started.message || '服务启动失败，已恢复旧服务',
      start: started,
      ownership,
    }
  }

  const legacyPaths = ownership.legacy || resolveLegacyInstalledMeshAgentPaths()
  if (legacyPaths && fileExists(legacyPaths.exePath)) {
    let un = await runElevated(legacyPaths.exePath, ['-fulluninstall'])
    if (!un.ok) un = await runElevated(legacyPaths.exePath, ['-uninstall'])
    if (!un.ok) {
      await runElevated('sc.exe', ['stop', LEGACY_SERVICE_NAME])
      await runElevated('sc.exe', ['delete', LEGACY_SERVICE_NAME])
    }
  } else if (legacyState.present) {
    await runElevated('sc.exe', ['stop', LEGACY_SERVICE_NAME])
    await runElevated('sc.exe', ['delete', LEGACY_SERVICE_NAME])
  }

  const after = await getMeshAgentStatus()
  log('INFO', 'legacy migration complete', { status: after.status })
  return {
    ok: true,
    code: 'OK',
    action: 'migrate',
    message: '服务已就绪',
    status: after,
    agentName: buildAgentName(clientId) || undefined,
    ownership,
  }
}

async function getMeshAgentVersion() {
  const packaged = resolveMeshAgentPaths()
  const installed = resolveInstalledMeshAgentPaths()
  const exePath = (installed && fileExists(installed.exePath))
    ? installed.exePath
    : packaged.exePath
  if (!fileExists(exePath)) {
    return { ok: false, version: '', message: 'wxqk_agent_missing' }
  }
  for (const args of [['-version'], ['--version'], ['version']]) {
    const result = await runExecFile(exePath, args, { timeoutMs: 10000 })
    const text = `${result.stdout}\n${result.stderr}`.trim()
    const match = text.match(/(\d+\.\d+\.\d+(?:\.\d+)?)/)
    if (match) {
      return { ok: true, version: match[1], message: '' }
    }
    if (text && result.ok) {
      return { ok: true, version: text.split(/\r?\n/)[0].slice(0, 80), message: '' }
    }
  }
  try {
    const st = deps.fs.statSync(exePath)
    return { ok: true, version: `file:${st.size}`, message: 'version_flag_unavailable' }
  } catch (err) {
    return { ok: false, version: '', message: String(err && err.message || err) }
  }
}

/**
 * Status based on INSTALLED brand files + structured SCM health — never package-only presence.
 */
async function getMeshAgentStatus() {
  const packaged = resolveMeshAgentPaths()
  const expected = expectedBrandedInstallPaths()
  const installedResolved = resolveInstalledMeshAgentPaths()
  const installedExePath = installedResolved ? installedResolved.exePath : expected.exePath
  const installedMshPath = installedResolved ? installedResolved.mshPath : expected.mshPath

  const packagedExePresent = fileExists(packaged.exePath)
  const packagedMshPresent = fileExists(packaged.mshPath)
  const installedExePresent = fileExists(installedExePath)
  const installedMshPresent = fileExists(installedMshPath)

  let healthSvc
  if (deps.serviceHealth) {
    healthSvc = { ...deps.serviceHealth, name: SERVICE_NAME }
  } else if (deps.serviceBinaryPath != null || deps.forceScServiceQuery) {
    // Unit tests inject serviceBinaryPath + sc.exe mocks — keep locale-independent CIM for production.
    const service = await queryServiceState()
    let pathName = ''
    if (service.present) {
      const qc = await queryServiceImagePath(SERVICE_NAME)
      pathName = qc.binaryPath || ''
    }
    if (typeof deps.serviceBinaryPath === 'string' && deps.serviceBinaryPath) {
      pathName = normalizeServiceBinaryPath(deps.serviceBinaryPath)
    }
    healthSvc = {
      present: service.present,
      state: service.state,
      startMode: deps.serviceStartMode || 'Auto',
      pathName,
      processId: service.state === 'running' ? 1 : 0,
      name: SERVICE_NAME,
      source: 'sc-test',
    }
  } else {
    healthSvc = await serviceHealth.queryServiceHealth(SERVICE_NAME, {
      platform: deps.platform || process.platform,
      execFile: deps.execFile || execFile,
    })
  }
  const service = {
    present: healthSvc.present,
    state: healthSvc.state,
  }
  let imagePath = healthSvc.pathName || ''
  if (typeof deps.serviceBinaryPath === 'string' && deps.serviceBinaryPath) {
    imagePath = normalizeServiceBinaryPath(deps.serviceBinaryPath)
  }
  const imagePathOk = service.present ? isBrandedImagePath(imagePath, expected.exePath) : false

  const health = classifyBrandInstallHealth({
    installedExePresent,
    installedMshPresent,
    servicePresent: service.present,
    imagePath,
    imagePathOk,
  })

  const packagedFp = packagedExePresent
    ? agentArtifact.readPackagedArtifactFingerprint(packaged.root, packaged.exePath, { fs: deps.fs || fs })
    : { sha256: '', source: 'missing', size: 0 }
  const installedFp = installedExePresent
    ? agentArtifact.readInstalledArtifactFingerprint(installedExePath, { fs: deps.fs || fs })
    : { sha256: '', source: 'missing', size: 0 }
  const outdated = agentArtifact.isArtifactOutdated(packagedFp, installedFp)

  let status = 'missing'
  if (health === 'stale_service') {
    status = 'stale_service'
  } else if (health === 'missing') {
    status = 'missing'
  } else if (service.present && !serviceHealth.isAutomaticStartMode(healthSvc.startMode) && health === 'files_and_service_ok') {
    status = 'service_config_broken'
  } else if (outdated && health === 'files_and_service_ok') {
    status = 'outdated_agent'
  } else if (service.state === 'running' && health === 'files_and_service_ok') {
    status = 'running'
  } else if ((service.state === 'stopped' || service.state === 'pending') && health === 'files_and_service_ok') {
    status = 'stopped'
  } else if (health === 'files_only') {
    status = 'installed_no_service'
  } else if (service.state === 'error' || service.state === 'unknown') {
    status = 'broken'
  } else {
    status = 'broken'
  }

  // When CIM reports a PID, verify ExecutablePath matches branded WXQK.exe
  let executablePath = ''
  let processGate = { gate: 'WAIT', code: 'UNCHECKED' }
  if (
    healthSvc.state === 'running'
    && Number(healthSvc.processId || 0) > 0
    && !deps.serviceHealth
    && !deps.forceScServiceQuery
    && healthSvc.source === 'cim'
  ) {
    try {
      const proc = await serviceHealth.queryProcessExecutablePath(healthSvc.processId, {
        platform: deps.platform || process.platform,
        execFile: deps.execFile || execFile,
      })
      executablePath = proc.path || ''
    } catch { /* ignore */ }
  }
  processGate = serviceHealth.evaluateProcessGate({
    state: healthSvc.state,
    processId: healthSvc.processId,
    processIdKnown: healthSvc.processIdKnown === true || healthSvc.source === 'cim',
    pathName: imagePath,
    executablePath,
    expectedExePath: expected.exePath,
    source: healthSvc.source,
  })
  if (processGate.code === 'PROCESS_MISMATCH' && status === 'running') {
    status = 'process_mismatch'
  }

  const versionInfo = installedExePresent || packagedExePresent
    ? await getMeshAgentVersion()
    : { ok: false, version: '', message: 'wxqk_agent_missing' }

  return {
    ok: true,
    status,
    exePresent: installedExePresent,
    mshPresent: installedMshPresent,
    installedExePresent,
    installedMshPresent,
    packagedExePresent,
    packagedMshPresent,
    servicePresent: service.present,
    serviceState: service.state,
    startMode: healthSvc.startMode || '',
    processId: healthSvc.processId || 0,
    processIdKnown: healthSvc.processIdKnown !== false && healthSvc.source !== 'sc',
    executablePath,
    processGate,
    imagePath,
    imagePathOk,
    outdatedAgent: outdated,
    packagedSha256: packagedFp.sha256 || '',
    installedSha256: installedFp.sha256 || '',
    packagedMetaMismatch: Boolean(packagedFp.metaMismatch),
    serviceHealth: healthSvc,
    serviceHealthSource: healthSvc.source || '',
    serviceName: SERVICE_NAME,
    serviceDisplayName: SERVICE_DISPLAY_NAME,
    version: versionInfo.version || '',
    paths: {
      root: packaged.root,
      exePath: packaged.exePath,
      mshPath: packaged.mshPath,
      installedExePath,
      installedMshPath,
      packaged: packaged.packaged,
    },
    hostname: os.hostname(),
    checkedAt: new Date(deps.now()).toISOString(),
  }
}

/**
 * @param {{ exePath: string, mshPath: string }} files
 */
async function installBrandedWindowsService(files) {
  const expected = expectedBrandedInstallPaths()
  const installDir = expected.dir
  const destExe = expected.exePath
  const destMsh = expected.mshPath
  const srcExe = String(files.exePath).replace(/'/g, "''")
  const srcMsh = String(files.mshPath).replace(/'/g, "''")
  const dirEsc = installDir.replace(/'/g, "''")
  const exeEsc = destExe.replace(/'/g, "''")
  const mshEsc = destMsh.replace(/'/g, "''")
  const svc = SERVICE_NAME.replace(/'/g, "''")
  const display = SERVICE_DISPLAY_NAME.replace(/'/g, "''")
  const ps = [
    `$ErrorActionPreference = 'Stop'`,
    `New-Item -ItemType Directory -Force -Path '${dirEsc}' | Out-Null`,
    `Copy-Item -LiteralPath '${srcExe}' -Destination '${exeEsc}' -Force`,
    `Copy-Item -LiteralPath '${srcMsh}' -Destination '${mshEsc}' -Force`,
    `if (-not (Test-Path -LiteralPath '${exeEsc}')) { throw 'WXQK.exe missing after copy' }`,
    `if (-not (Test-Path -LiteralPath '${mshEsc}')) { throw 'WXQK.msh missing after copy' }`,
    `$svc = Get-Service -Name '${svc}' -ErrorAction SilentlyContinue`,
    `if ($null -eq $svc) {`,
    `  New-Service -Name '${svc}' -BinaryPathName '"${exeEsc}"' -DisplayName '${display}' -Description '${display}' -StartupType Automatic | Out-Null`,
    `}`,
    `sc.exe config '${svc}' type= own | Out-Null`,
    `sc.exe config '${svc}' binPath= '"${exeEsc}"' | Out-Null`,
    `$svc2 = Get-Service -Name '${svc}' -ErrorAction SilentlyContinue`,
    `if ($null -ne $svc2 -and $svc2.Status -ne 'Running') { Start-Service -Name '${svc}' }`,
    `if (-not (Test-Path -LiteralPath '${exeEsc}')) { throw 'WXQK.exe missing after service config' }`,
    `Get-Service -Name '${svc}' | Select-Object -ExpandProperty Status`,
  ].join('; ')
  return runElevated('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps])
}

/**
 * @param {{ clientId?: string }} [options]
 */
async function installMeshAgent(options = {}) {
  const clientId = safeClientIdForAgent(options.clientId)
  const paths = resolveMeshAgentPaths()
  if (!fileExists(paths.exePath) || !fileExists(paths.mshPath)) {
    log('ERROR', 'install aborted: agent files missing', { exe: paths.exePath, msh: paths.mshPath })
    return { ok: false, code: 'MESH_AGENT_FILES_MISSING', message: '缺少 WXQK.exe 或 WXQK.msh' }
  }
  if ((deps.platform || process.platform) !== 'win32') {
    return { ok: false, code: 'UNSUPPORTED_OS', message: '仅支持 Windows 安装服务' }
  }

  const brandGate = await verifyBrandedAgentArtifact(paths.exePath)
  if (!brandGate.ok) {
    log('ERROR', 'install aborted: bad branded artifact', brandGate)
    return {
      ok: false,
      code: brandGate.code || 'MESH_BAD_ARTIFACT',
      message: brandGate.message || '发行包 Agent 无效',
      brand: brandGate,
    }
  }

  let installExe = paths.exePath
  let installMsh = paths.mshPath
  let agentName = ''
  let stagingDir = ''
  if (clientId) {
    const staged = prepareInstallStaging(clientId)
    if (!staged.ok) {
      log('ERROR', 'staging msh failed', { code: staged.code, message: staged.message })
      return { ok: false, code: staged.code, message: staged.message }
    }
    installExe = staged.exePath
    installMsh = staged.mshPath
    agentName = staged.agentName
    stagingDir = staged.stagingDir
    log('INFO', 'installing WXQK agent from staging', { agentName })
  } else {
    log('INFO', 'installing WXQK agent service')
  }

  // Primary path: official MeshCentral agent -fullinstall from staging (exe+msh same dir).
  // PowerShell New-Service is fallback when branding/fullinstall cannot produce healthy ImagePath.
  const elevateOpts = stagingDir ? { cwd: stagingDir } : {}
  let result = await runElevated(installExe, ['-fullinstall'], elevateOpts)
  let installPath = 'fullinstall'
  if (isElevationDenied(result)) {
    return {
      ok: false,
      code: 'MESH_ELEVATION_REQUIRED',
      message: '需要管理员权限才能安装服务',
      status: await getMeshAgentStatus(),
    }
  }
  if (!result.ok) {
    log('WARN', 'fullinstall failed — trying -install', { error: redact(result.stderr || result.error || '') })
    result = await runElevated(installExe, ['-install'], elevateOpts)
    installPath = 'install'
  }
  let after = await getMeshAgentStatus()
  if (!result.ok || !isBrandedInstallHealthy(after)) {
    log('WARN', 'official install incomplete — PowerShell branded fallback', {
      status: after.status,
      imagePathOk: after.imagePathOk,
      installedExePresent: after.installedExePresent,
    })
    result = await installBrandedWindowsService({ exePath: installExe, mshPath: installMsh })
    installPath = 'powershell_new_service'
    if (isElevationDenied(result)) {
      return {
        ok: false,
        code: 'MESH_ELEVATION_REQUIRED',
        message: '需要管理员权限才能安装服务',
        status: await getMeshAgentStatus(),
      }
    }
  }

  let mshSync = null
  if (stagingDir && clientId) {
    const stagedMsh = path.join(stagingDir, MSH_NAME)
    mshSync = await syncInstalledMsh(stagedMsh)
    log(mshSync.ok ? 'INFO' : 'WARN', 'post-install msh sync', mshSync)
  }

  await runElevated('sc.exe', ['config', SERVICE_NAME, 'type=', 'own'])

  after = await getMeshAgentStatus()
  // CRITICAL: never treat orphan servicePresent as install success
  const ok = isBrandedInstallHealthy(after) && (Boolean(result.ok) || after.status === 'running' || after.status === 'stopped')
  log(ok ? 'INFO' : 'ERROR', 'install finished', {
    ok,
    installPath,
    status: after.status,
    imagePathOk: after.imagePathOk,
    installedExePresent: after.installedExePresent,
    agentName: agentName || undefined,
  })
  return {
    ok,
    code: ok ? 'OK' : 'MESH_INSTALL_FAILED',
    message: ok ? '服务已就绪' : redact(result.stderr || result.error || '安装失败：缺少可执行文件或服务配置无效'),
    status: after,
    agentName: agentName || undefined,
    stagingDir: stagingDir || undefined,
    mshSynced: Boolean(mshSync && mshSync.ok),
    installPath,
  }
}

async function startMeshAgent() {
  if ((deps.platform || process.platform) !== 'win32') {
    return { ok: false, code: 'UNSUPPORTED_OS', message: '仅支持 Windows' }
  }
  const before = await getMeshAgentStatus()
  if (before.status === 'stale_service' || !isBrandedInstallHealthy(before)) {
    return {
      ok: false,
      code: before.status === 'stale_service' ? 'MESH_STALE_SERVICE' : 'MESH_START_FAILED',
      message: '服务安装不完整，无法启动',
      status: before,
    }
  }
  log('INFO', 'starting WXQK service')
  let result = await runExecFile('sc.exe', ['start', SERVICE_NAME], { timeoutMs: 60000 })
  if (!result.ok) {
    const installed = resolveInstalledMeshAgentPaths()
    const exePath = installed && fileExists(installed.exePath)
      ? installed.exePath
      : resolveMeshAgentPaths().exePath
    if (fileExists(exePath)) {
      result = await runElevated(exePath, ['-start'])
      if (isElevationDenied(result)) {
        return {
          ok: false,
          code: 'MESH_ELEVATION_REQUIRED',
          message: '需要管理员权限才能启动服务',
          status: await getMeshAgentStatus(),
        }
      }
    }
  }
  const after = await getMeshAgentStatus()
  const already = /already been started|1056/i.test(`${result.stdout}\n${result.stderr}`)
  const ok = after.status === 'running' && isBrandedInstallHealthy(after)
  return {
    ok: ok || (already && after.status === 'running' && isBrandedInstallHealthy(after)),
    code: (ok || (already && after.status === 'running')) ? 'OK' : 'MESH_START_FAILED',
    message: (ok || already) ? '服务已就绪' : redact(result.stderr || result.error || '启动失败'),
    status: after,
  }
}

async function stopMeshAgent() {
  if ((deps.platform || process.platform) !== 'win32') {
    return { ok: false, code: 'UNSUPPORTED_OS', message: '仅支持 Windows' }
  }
  log('INFO', 'stopping WXQK service')
  let result = await runExecFile('sc.exe', ['stop', SERVICE_NAME], { timeoutMs: 60000 })
  if (!result.ok) {
    const installed = resolveInstalledMeshAgentPaths()
    if (installed && fileExists(installed.exePath)) {
      result = await runElevated(installed.exePath, ['-stop'])
    }
  }
  const after = await getMeshAgentStatus()
  const ok = after.status === 'stopped'
    || after.status === 'installed_no_service'
    || after.status === 'stale_service'
    || after.status === 'missing'
    || /1052|1062|not started/i.test(`${result.stdout}\n${result.stderr}`)
  return {
    ok: ok || result.ok,
    code: (ok || result.ok) ? 'OK' : 'MESH_STOP_FAILED',
    message: (ok || result.ok) ? '服务已停止' : redact(result.stderr || result.error || '停止失败'),
    status: after,
  }
}

async function restartMeshAgent() {
  log('INFO', 'restarting WXQK service')
  await stopMeshAgent()
  return startMeshAgent()
}

async function repairMeshAgent(options = {}) {
  log('INFO', 'repairing WXQK service')
  const before = await getMeshAgentStatus()
  if (before.status === 'stale_service' || (before.servicePresent && !isBrandedInstallHealthy(before))) {
    const removed = await removeStaleWxqkServiceRegistration()
    if (!removed.ok) {
      return {
        ok: false,
        code: removed.code || 'MESH_REPAIR_FAILED',
        message: removed.message || '无法清除损坏的服务注册',
        status: await getMeshAgentStatus(),
        remove: removed,
      }
    }
  } else {
    await stopMeshAgent()
  }

  const paths = resolveMeshAgentPaths()
  if (!fileExists(paths.exePath) || !fileExists(paths.mshPath)) {
    return { ok: false, code: 'MESH_AGENT_FILES_MISSING', message: '缺少 WXQK.exe 或 WXQK.msh', status: await getMeshAgentStatus() }
  }
  const installed = await installMeshAgent({ clientId: options.clientId })
  if (!installed.ok) {
    return { ok: false, code: installed.code || 'MESH_REPAIR_FAILED', message: installed.message, install: installed, status: installed.status }
  }
  const started = await startMeshAgent()
  const ok = Boolean(started.ok && started.status && started.status.status === 'running' && isBrandedInstallHealthy(started.status))
  return {
    ok,
    code: ok ? 'OK' : (started.code || 'MESH_REPAIR_FAILED'),
    message: ok ? '服务已就绪' : started.message,
    install: installed,
    start: started,
    status: started.status,
  }
}

async function uninstallMeshAgent() {
  if ((deps.platform || process.platform) !== 'win32') {
    return { ok: false, code: 'UNSUPPORTED_OS', message: '仅支持 Windows' }
  }
  log('INFO', 'uninstalling WXQK service')
  const installed = resolveInstalledMeshAgentPaths()
  const packaged = resolveMeshAgentPaths()
  let result = { ok: false, stdout: '', stderr: '', error: '', code: 1 }
  const exePath = installed && fileExists(installed.exePath)
    ? installed.exePath
    : packaged.exePath
  if (fileExists(exePath)) {
    result = await runElevated(exePath, ['-fulluninstall'])
    if (!result.ok) result = await runElevated(exePath, ['-uninstall'])
    if (!result.ok) result = await runElevated(exePath, ['Mesh', 'Service', 'uninstall'])
  }
  if (!result.ok) {
    await runElevated('sc.exe', ['stop', SERVICE_NAME])
    result = await runElevated('sc.exe', ['delete', SERVICE_NAME])
  }
  const after = await getMeshAgentStatus()
  const ok = !after.servicePresent || after.status === 'missing'
  return {
    ok,
    code: ok ? 'OK' : 'MESH_UNINSTALL_FAILED',
    message: ok ? '服务已卸载' : redact(result.stderr || result.error || '卸载失败'),
    status: after,
  }
}

/**
 * Ensure StartMode=Automatic + failure recovery. Best-effort; never throws.
 */
async function hardenServiceConfig() {
  try {
    const result = await serviceHealth.ensureServiceAutoAndRecovery(SERVICE_NAME, runElevated)
    log(result.ok ? 'INFO' : 'WARN', 'service auto+recovery harden', {
      configOk: result.configOk,
      failureOk: result.failureOk,
    })
    return result
  } catch (err) {
    log('WARN', 'service harden failed', { error: String(err && err.message || err) })
    return { ok: false }
  }
}

/**
 * Upgrade installed WXQK.exe when packaged SHA differs. Backup → install → start; rollback on failure.
 * Preserves clientId / agentName / MeshServer / ServerID / MeshID via stageMshForClient.
 * @param {{ clientId?: string }} [options]
 */
async function upgradeMeshAgent(options = {}) {
  const clientId = safeClientIdForAgent(options.clientId)
  log('INFO', 'upgrading WXQK agent artifact', { clientId: clientId || undefined })
  const expected = expectedBrandedInstallPaths()
  const packaged = resolveMeshAgentPaths()
  if (!fileExists(packaged.exePath) || !fileExists(packaged.mshPath)) {
    return { ok: false, code: 'MESH_AGENT_FILES_MISSING', message: '缺少发行包 Agent', status: await getMeshAgentStatus() }
  }
  const brandGate = await verifyBrandedAgentArtifact(packaged.exePath)
  if (!brandGate.ok) {
    return {
      ok: false,
      code: brandGate.code || 'MESH_BAD_ARTIFACT',
      message: brandGate.message || '发行包 Agent 无效',
      status: await getMeshAgentStatus(),
    }
  }

  const fsApi = deps.fs || fs
  const backupDir = path.join(os.tmpdir(), `wxqk-agent-bak-${deps.now()}`)
  try {
    fsApi.mkdirSync(backupDir, { recursive: true })
    if (fileExists(expected.exePath)) fsApi.copyFileSync(expected.exePath, path.join(backupDir, EXE_NAME))
    if (fileExists(expected.mshPath)) fsApi.copyFileSync(expected.mshPath, path.join(backupDir, MSH_NAME))
  } catch (err) {
    log('WARN', 'agent backup incomplete', { error: String(err && err.message || err) })
  }

  const restoreBackup = async () => {
    if (!fileExists(path.join(backupDir, EXE_NAME))) return { ok: false }
    log('WARN', 'rolling back agent upgrade from backup')
    const bakExe = path.join(backupDir, EXE_NAME).replace(/'/g, "''")
    const bakMsh = path.join(backupDir, MSH_NAME).replace(/'/g, "''")
    const destExe = expected.exePath.replace(/'/g, "''")
    const destMsh = expected.mshPath.replace(/'/g, "''")
    const dirEsc = expected.dir.replace(/'/g, "''")
    await runElevated('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      [
        `New-Item -ItemType Directory -Force -Path '${dirEsc}' | Out-Null`,
        `Copy-Item -LiteralPath '${bakExe}' -Destination '${destExe}' -Force`,
        `if (Test-Path -LiteralPath '${bakMsh}') { Copy-Item -LiteralPath '${bakMsh}' -Destination '${destMsh}' -Force }`,
      ].join('; '),
    ])
    await hardenServiceConfig()
    return startMeshAgent()
  }

  await stopMeshAgent()
  const installed = await installMeshAgent({ clientId })
  if (isElevationDenied(installed) || installed.code === 'MESH_ELEVATION_REQUIRED') {
    await restoreBackup()
    return {
      ok: false,
      code: 'MESH_ELEVATION_REQUIRED',
      message: installed.message || '需要管理员权限才能升级服务',
      status: await getMeshAgentStatus(),
      rolledBack: true,
    }
  }
  if (!installed.ok) {
    const rolled = await restoreBackup()
    return {
      ok: false,
      code: installed.code || 'MESH_UPGRADE_FAILED',
      message: installed.message || 'Agent 升级失败已回滚',
      status: rolled.status || (await getMeshAgentStatus()),
      rolledBack: true,
    }
  }

  await hardenServiceConfig()
  const started = await startMeshAgent()
  let after = started.status || (await getMeshAgentStatus())
  // After upgrade SHA must match packaged; status must be running (not outdated_agent)
  if (!started.ok || after.status !== 'running' || after.outdatedAgent) {
    const rolled = await restoreBackup()
    return {
      ok: false,
      code: 'MESH_UPGRADE_FAILED',
      message: 'Agent 升级后验证失败，已回滚',
      status: rolled.status || after,
      rolledBack: true,
    }
  }
  after = await getMeshAgentStatus()
  log('INFO', 'agent upgrade ok', {
    packagedSha: String(after.packagedSha256 || '').slice(0, 12),
    installedSha: String(after.installedSha256 || '').slice(0, 12),
  })
  return {
    ok: true,
    code: 'OK',
    action: 'upgrade',
    message: '服务已升级',
    status: after,
    agentName: buildAgentName(clientId) || installed.agentName,
  }
}

/**
 * Prefer MSH-only identity repair when EXE is current (avoid full binary reinstall).
 * Restarts service so Agent reloads agentName.
 * @param {{ clientId: string }} options
 */
async function repairMshIdentityOnly(options = {}) {
  const clientId = safeClientIdForAgent(options.clientId)
  if (!clientId) {
    return { ok: false, code: 'BAD_CLIENT_ID', message: 'clientId 无效' }
  }
  const expected = buildAgentName(clientId)
  log('WARN', 'IDENTITY_AGENT_MISMATCH — msh-only repair', { expected })
  const stagingDir = path.join(os.tmpdir(), `wxqk-msh-fix-${Date.now()}`)
  const staged = stageMshForClient({
    clientId,
    stagingDir,
    templateMshPath: resolveMeshAgentPaths().mshPath,
  })
  if (!staged.ok) {
    return { ok: false, code: staged.code, message: staged.message, action: 'msh_repair' }
  }
  // Prefer rewriting from installed msh when present (preserve live MeshServer/ServerID/MeshID)
  const installed = resolveInstalledMeshAgentPaths()
  if (installed && fileExists(installed.mshPath)) {
    try {
      const fsApi = deps.fs || fs
      const raw = fsApi.readFileSync(installed.mshPath, 'utf8')
      const parsed = parseMshText(raw)
      const rewritten = serializeMshWithAgentName(parsed, expected)
      fsApi.writeFileSync(staged.mshPath, rewritten, 'utf8')
    } catch { /* keep template-staged msh */ }
  }
  const synced = await syncInstalledMsh(staged.mshPath)
  if (!synced.ok) {
    return {
      ok: false,
      code: synced.code || 'MSH_SYNC_FAILED',
      message: synced.message || 'msh sync failed',
      action: 'msh_repair',
    }
  }
  await stopMeshAgent()
  const started = await startMeshAgent()
  const stillBroken = installedAgentNeedsRepair(clientId)
  const status = await getMeshAgentStatus()
  return {
    ok: Boolean(started.ok && !stillBroken && status.status === 'running'),
    code: stillBroken ? 'IDENTITY_AGENT_MISMATCH' : (started.ok ? 'OK' : started.code),
    action: 'msh_repair',
    message: stillBroken ? 'agentName still mismatched after msh repair' : 'msh identity repaired',
    status,
    agentName: expected,
  }
}

/**
 * Lifecycle: healthy → noop; stale/outdated/config → repair/upgrade; missing+owned legacy → migrate.
 * @param {{ clientId?: string }} [options]
 */
async function ensureMeshAgentRunning(options = {}) {
  // Lock uses real fs (not test doubles) so agent lifecycle stays exclusive across users.
  return withAgentLifecycleLock(async () => ensureMeshAgentRunningUnlocked(options), {
    timeoutMs: 180000,
  })
}

/**
 * @param {{ clientId?: string }} [options]
 */
async function ensureMeshAgentRunningUnlocked(options = {}) {
  const clientId = safeClientIdForAgent(options.clientId)
  log('INFO', 'ensureMeshAgentRunning', { clientId: clientId || undefined })
  let before = await getMeshAgentStatus()

  if (before.status === 'process_mismatch') {
    log('WARN', 'PROCESS_MISMATCH — repairing', {
      processId: before.processId,
      executablePath: before.executablePath,
    })
    const repaired = await repairMeshAgent({ clientId })
    if (repaired.ok) await hardenServiceConfig()
    return {
      ok: repaired.ok,
      code: repaired.ok ? 'OK' : repaired.code,
      action: 'repair_process_mismatch',
      message: repaired.message,
      status: repaired.status || (await getMeshAgentStatus()),
      agentName: buildAgentName(clientId) || undefined,
    }
  }

  if (before.status === 'stale_service') {
    log('WARN', 'detected STALE_SERVICE — auto repair', {
      imagePath: before.imagePath,
      installedExePresent: before.installedExePresent,
      installedMshPresent: before.installedMshPresent,
    })
    const repaired = await repairMeshAgent({ clientId })
    if (repaired.ok) {
      await hardenServiceConfig()
      await cleanupOwnedLegacyAfterBrandHealthy({ clientId })
    }
    return {
      ok: repaired.ok,
      code: repaired.ok ? 'OK' : repaired.code,
      action: 'repair_stale',
      message: repaired.message,
      status: repaired.status || (await getMeshAgentStatus()),
      agentName: buildAgentName(clientId) || undefined,
    }
  }

  if (before.status === 'service_config_broken') {
    log('WARN', 'service StartMode not Automatic — hardening', { startMode: before.startMode })
    const hard = await hardenServiceConfig()
    if (isElevationDenied(hard) || hard.code === 'MESH_ELEVATION_REQUIRED') {
      return {
        ok: false,
        code: 'MESH_ELEVATION_REQUIRED',
        action: 'repair_service_config',
        message: '需要管理员权限以修复服务启动类型',
        status: await getMeshAgentStatus(),
      }
    }
    before = await getMeshAgentStatus()
    if (before.status === 'service_config_broken') {
      const repaired = await repairMeshAgent({ clientId })
      if (repaired.ok) await hardenServiceConfig()
      return {
        ok: repaired.ok,
        code: repaired.ok ? 'OK' : repaired.code,
        action: 'repair_service_config',
        message: repaired.message,
        status: repaired.status || (await getMeshAgentStatus()),
        agentName: buildAgentName(clientId) || undefined,
      }
    }
    // Fall through — may still be outdated/stopped/running
  }

  if (before.status === 'outdated_agent') {
    log('WARN', 'detected OUTDATED_AGENT — upgrade', {
      packagedSha: String(before.packagedSha256 || '').slice(0, 12),
      installedSha: String(before.installedSha256 || '').slice(0, 12),
    })
    const upgraded = await upgradeMeshAgent({ clientId })
    return {
      ok: upgraded.ok,
      code: upgraded.ok ? 'OK' : upgraded.code,
      action: 'upgrade',
      message: upgraded.message,
      status: upgraded.status || (await getMeshAgentStatus()),
      agentName: upgraded.agentName || buildAgentName(clientId) || undefined,
      rolledBack: Boolean(upgraded.rolledBack),
    }
  }

  if (before.status === 'missing' || (before.status === 'installed_no_service' && !before.servicePresent)) {
    const legacy = await queryLegacyServiceState()
    const legacyFiles = resolveLegacyInstalledMeshAgentPaths()
    if (legacy.present || legacyFiles) {
      const ownership = isLegacyAgentOwnedByWxqk({ clientId })
      if (ownership.owned) {
        const migrated = await migrateLegacyMeshAgentToWxqk({ clientId })
        if (migrated.ok) await hardenServiceConfig()
        return {
          ok: migrated.ok,
          code: migrated.code,
          action: migrated.action || 'migrate',
          message: migrated.message,
          status: migrated.status || (await getMeshAgentStatus()),
          agentName: migrated.agentName || buildAgentName(clientId) || undefined,
        }
      }
      log('WARN', 'legacy Mesh Agent present but not owned by WXQK — leave alone', {
        reason: ownership.reason,
      })
    }
  }

  if (before.status === 'running') {
    if (clientId && installedAgentNeedsRepair(clientId)) {
      log('WARN', 'IDENTITY_AGENT_MISMATCH — reconciling now', {
        clientId,
        expected: buildAgentName(clientId),
      })
      // Prefer msh-only when artifact is current (avoid unnecessary EXE reinstall)
      if (!before.outdatedAgent && before.installedExePresent && before.imagePathOk) {
        const mshOnly = await repairMshIdentityOnly({ clientId })
        if (mshOnly.ok) {
          await hardenServiceConfig()
          return {
            ok: true,
            code: 'OK',
            action: 'msh_repair',
            message: mshOnly.message,
            status: mshOnly.status || (await getMeshAgentStatus()),
            agentName: buildAgentName(clientId),
            identityAgentMismatch: false,
          }
        }
        log('WARN', 'msh-only repair failed — falling back to full repair', {
          code: mshOnly.code,
          message: mshOnly.message,
        })
      }
      const repaired = await repairMeshAgent({ clientId })
      if (repaired.ok) await hardenServiceConfig()
      const after = repaired.status || (await getMeshAgentStatus())
      const stillMismatch = Boolean(clientId && installedAgentNeedsRepair(clientId))
      return {
        ok: repaired.ok && !stillMismatch,
        code: stillMismatch ? 'IDENTITY_AGENT_MISMATCH' : (repaired.ok ? 'OK' : repaired.code),
        action: 'repair',
        message: repaired.message,
        status: after,
        agentName: buildAgentName(clientId),
        identityAgentMismatch: stillMismatch,
      }
    }
    // Healthy running — do not elevate on every ensure (UAC spam).
    return { ok: true, code: 'OK', action: 'noop', message: '服务已就绪', status: before }
  }

  if (before.status === 'missing') {
    const installed = await installMeshAgent({ clientId })
    if (!installed.ok) {
      return { ok: false, code: installed.code, action: 'install', message: installed.message, status: installed.status || before }
    }
    await hardenServiceConfig()
    const started = await startMeshAgent()
    const ok = Boolean(started.ok && started.status && started.status.status === 'running' && isBrandedInstallHealthy(started.status))
    if (ok) await cleanupOwnedLegacyAfterBrandHealthy({ clientId })
    return {
      ok,
      code: ok ? 'OK' : started.code,
      action: 'install_start',
      message: started.message,
      status: started.status,
      agentName: installed.agentName,
    }
  }

  if (before.status === 'stopped' || before.status === 'installed_no_service') {
    if (before.status === 'installed_no_service') {
      // Files on disk but no healthy SCM registration — must install, not only sc start
      const installed = await installMeshAgent({ clientId })
      if (!installed.ok) {
        return { ok: false, code: installed.code, action: 'install', message: installed.message, status: installed.status || before }
      }
      await hardenServiceConfig()
      const started = await startMeshAgent()
      const ok = Boolean(started.ok && started.status && started.status.status === 'running' && isBrandedInstallHealthy(started.status))
      return {
        ok,
        code: ok ? 'OK' : started.code,
        action: 'install_start',
        message: started.message,
        status: started.status,
        agentName: installed.agentName || buildAgentName(clientId) || undefined,
      }
    }
    if (clientId && installedAgentNeedsRepair(clientId)) {
      log('WARN', 'stopped agent needs repair before start', {
        clientId,
        expected: buildAgentName(clientId),
      })
      const repaired = await repairMeshAgent({ clientId })
      if (repaired.ok) await hardenServiceConfig()
      return {
        ok: repaired.ok,
        code: repaired.ok ? 'OK' : repaired.code,
        action: 'repair',
        message: repaired.message,
        status: repaired.status || (await getMeshAgentStatus()),
        agentName: buildAgentName(clientId),
      }
    }
    const started = await startMeshAgent()
    if (started.ok) await hardenServiceConfig()
    return {
      ok: started.ok,
      code: started.ok ? 'OK' : started.code,
      action: 'start',
      message: started.message,
      status: started.status,
      agentName: buildAgentName(clientId) || undefined,
    }
  }

  const repaired = await repairMeshAgent({ clientId })
  if (repaired.ok) {
    await hardenServiceConfig()
    await cleanupOwnedLegacyAfterBrandHealthy({ clientId })
  }
  return {
    ok: repaired.ok,
    code: repaired.ok ? 'OK' : repaired.code,
    action: 'repair',
    message: repaired.message,
    status: repaired.status || (await getMeshAgentStatus()),
  }
}

/**
 * After branded WXQK is healthy+running, uninstall owned legacy Mesh Agent leftovers.
 * Never touches third-party Mesh Agent installs.
 * @param {{ clientId?: string }} [options]
 */
async function cleanupOwnedLegacyAfterBrandHealthy(options = {}) {
  const status = await getMeshAgentStatus()
  if (status.status !== 'running' || !isBrandedInstallHealthy(status)) {
    return { ok: false, code: 'BRAND_NOT_READY', message: 'branded agent not healthy; skip legacy cleanup' }
  }
  const clientId = safeClientIdForAgent(options.clientId)
  const ownership = isLegacyAgentOwnedByWxqk({ clientId })
  const alts = []
  if (ownership.owned && ownership.legacy) alts.push(ownership.legacy)
  for (const dir of legacyInstallDirCandidates()) {
    const found = pickAgentDir(dir, LEGACY_EXE_NAMES, LEGACY_MSH_NAMES, false)
    if (found) alts.push(found)
  }
  const seen = new Set()
  let cleaned = 0
  for (const found of alts) {
    if (!found || !fileExists(found.exePath) || seen.has(found.dir)) continue
    seen.add(found.dir)
    let parsed = new Map()
    try {
      if (fileExists(found.mshPath)) parsed = parseMshText(deps.fs.readFileSync(found.mshPath, 'utf8'))
    } catch { /* ignore */ }
    const agentName = String(parsed.get('agentName') || '').trim()
    const ownedByPrefix = agentName.startsWith(AGENT_NAME_PREFIX)
    let ownedByIdentity = false
    if (!ownedByPrefix) {
      const templatePath = resolveMeshAgentPaths().mshPath
      if (fileExists(templatePath) && fileExists(found.mshPath)) {
        try {
          const tmpl = parseMshText(deps.fs.readFileSync(templatePath, 'utf8'))
          const keys = ['MeshServer', 'ServerID', 'MeshID']
          let matched = 0
          let required = 0
          for (const key of keys) {
            const want = String(tmpl.get(key) || '').trim()
            if (!want) continue
            required += 1
            if (want === String(parsed.get(key) || '').trim()) matched += 1
          }
          ownedByIdentity = required >= 2 && matched === required
        } catch { /* ignore */ }
      }
    }
    if (!ownedByPrefix && !ownedByIdentity) continue
    log('INFO', 'cleaning owned legacy Mesh Agent leftover', { dir: found.dir, agentName: agentName || undefined })
    let un = await runElevated(found.exePath, ['-fulluninstall'])
    if (!un.ok) un = await runElevated(found.exePath, ['-uninstall'])
    if (!un.ok) {
      await runElevated('sc.exe', ['stop', LEGACY_SERVICE_NAME])
      await runElevated('sc.exe', ['delete', LEGACY_SERVICE_NAME])
    }
    cleaned += 1
  }
  return { ok: true, code: 'OK', cleaned, message: cleaned ? 'legacy leftovers cleaned' : 'no owned legacy leftovers' }
}

module.exports = {
  LOG_TAG,
  SERVICE_NAME,
  SERVICE_DISPLAY_NAME,
  EXE_NAME,
  MSH_NAME,
  LEGACY_SERVICE_NAME,
  AGENT_NAME_PREFIX,
  MSH_IDENTITY_KEYS,
  resolveMeshAgentPaths,
  getMeshAgentStatus,
  getMeshAgentVersion,
  installMeshAgent,
  upgradeMeshAgent,
  hardenServiceConfig,
  startMeshAgent,
  stopMeshAgent,
  restartMeshAgent,
  repairMeshAgent,
  uninstallMeshAgent,
  ensureMeshAgentRunning,
  repairMshIdentityOnly,
  migrateLegacyMeshAgentToWxqk,
  isLegacyAgentOwnedByWxqk,
  queryLegacyServiceState,
  queryServiceImagePath,
  parseScBinaryPath,
  normalizeServiceBinaryPath,
  isBrandedImagePath,
  isBrandedInstallHealthy,
  verifyBrandedAgentArtifact,
  removeStaleWxqkServiceRegistration,
  expectedBrandedInstallPaths,
  cleanupOwnedLegacyAfterBrandHealthy,
  safeClientIdForAgent,
  buildAgentName,
  parseMshText,
  serializeMshWithAgentName,
  stageMshForClient,
  prepareInstallStaging,
  resolveInstalledMeshAgentPaths,
  resolveLegacyInstalledMeshAgentPaths,
  installedAgentNeedsRepair,
  setMeshAgentDepsForTest,
  resetMeshAgentDepsForTest,
  redact,
}
