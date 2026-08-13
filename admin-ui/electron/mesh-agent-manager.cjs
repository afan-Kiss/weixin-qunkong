'use strict'

/**
 * MeshAgent lifecycle helpers for WXQK Electron client.
 * Does NOT implement remote desktop protocol — only install/start/stop of MeshAgent.
 *
 * Log tag: [MESH]. Secrets (msh contents, tokens) must be redacted.
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn, execFile } = require('child_process')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)

const LOG_TAG = '[MESH]'
const SERVICE_NAME = 'Mesh Agent'
const EXE_NAME = 'meshagent.exe'
const MSH_NAME = 'meshagent.msh'
const AGENT_NAME_PREFIX = 'WXQK-'
/** MeshServer / MeshID / ServerID / MeshName must never be rewritten from clientId. */
const MSH_IDENTITY_KEYS = new Set(['MeshServer', 'MeshID', 'ServerID', 'MeshName'])

/** @type {{ spawn?: typeof spawn, execFile?: typeof execFile, fs?: typeof fs, platform?: NodeJS.Platform, resourcesPath?: string, isPackaged?: boolean, now?: () => number }} */
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
    // electron app may be unavailable in unit tests
    // eslint-disable-next-line global-require
    const { app } = require('electron')
    return Boolean(app && app.isPackaged)
  } catch {
    return Boolean(deps.resourcesPath)
  }
}

/**
 * Resolve MeshAgent binary + .msh directory.
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
 * Windows service install directory (where MeshAgent actually runs from).
 * 64-bit agent installs to Program Files; older 32-bit builds use Program Files (x86).
 * @returns {{ dir: string, exePath: string, mshPath: string } | null}
 */
function resolveInstalledMeshAgentPaths() {
  if (deps.installedAgentDir) {
    const dir = String(deps.installedAgentDir)
    return {
      dir,
      exePath: path.join(dir, 'MeshAgent.exe'),
      mshPath: path.join(dir, 'MeshAgent.msh'),
    }
  }
  if ((deps.platform || process.platform) !== 'win32') return null
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Mesh Agent'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Mesh Agent'),
  ]
  const fsApi = deps.fs || fs
  for (const dir of candidates) {
    try {
      if (fsApi.existsSync(path.join(dir, 'MeshAgent.exe'))) {
        const mshCap = path.join(dir, 'MeshAgent.msh')
        const mshLow = path.join(dir, MSH_NAME)
        return {
          dir,
          exePath: path.join(dir, 'MeshAgent.exe'),
          mshPath: fsApi.existsSync(mshCap) ? mshCap : mshLow,
        }
      }
    } catch { /* continue */ }
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
  const installed = resolveInstalledMeshAgentPaths()
  if (!installed) return true
  const fsApi = deps.fs || fs
  try {
    if (!fsApi.existsSync(installed.mshPath)) return true
    const raw = fsApi.readFileSync(installed.mshPath, 'utf8')
    const parsed = parseMshText(raw)
    const current = String(parsed.get('agentName') || '').trim()
    if (current !== expected) return true
    // Also repair when packaged template endpoint/cert changed (e.g. 8444→4433).
    const templatePath = resolveMeshAgentPaths().mshPath
    if (fileExists(templatePath)) {
      const tmpl = parseMshText(fsApi.readFileSync(templatePath, 'utf8'))
      for (const key of ['MeshServer', 'ServerID', 'MeshID']) {
        const want = String(tmpl.get(key) || '').trim()
        const got = String(parsed.get(key) || '').trim()
        // Template requires the field: missing/empty got must repair (not only mismatch).
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
    return { ok: false, code: 'MESH_AGENT_FILES_MISSING', message: '缺少 meshagent.msh 模板' }
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
  // Guard: never overwrite Mesh identity with agentName accidentally
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
    return { ok: false, code: 'MESH_AGENT_FILES_MISSING', message: '缺少 meshagent.exe 或 meshagent.msh' }
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
 * Copy staged MeshAgent.msh into the Windows install directory (requires elevation).
 * @param {string} stagedMshPath
 */
async function syncInstalledMsh(stagedMshPath) {
  const installed = resolveInstalledMeshAgentPaths()
  if (!installed || !fileExists(stagedMshPath)) {
    return { ok: false, code: 'MSH_SYNC_SKIP', message: 'install dir or staged msh missing' }
  }
  const destCap = path.join(installed.dir, 'MeshAgent.msh')
  const destLow = path.join(installed.dir, MSH_NAME)
  const dest = destCap
  const src = String(stagedMshPath).replace(/'/g, "''")
  const dst = dest.replace(/'/g, "''")
  const dstLow = destLow.replace(/'/g, "''")
  const ps = [
    `Copy-Item -LiteralPath '${src}' -Destination '${dst}' -Force;`,
    `if (Test-Path -LiteralPath '${dstLow}') { if ('${dstLow}' -ne '${dst}') { Remove-Item -LiteralPath '${dstLow}' -Force -ErrorAction SilentlyContinue } }`,
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
 * Query Windows service state for Mesh Agent.
 */
async function queryServiceState() {
  if ((deps.platform || process.platform) !== 'win32') {
    return { present: false, state: 'unsupported', raw: '' }
  }
  const result = await runExecFile('sc.exe', ['query', SERVICE_NAME], { timeoutMs: 15000 })
  const raw = `${result.stdout}\n${result.stderr}`
  if (/FAILED\s+1060/i.test(raw) || /does not exist/i.test(raw)) {
    return { present: false, state: 'missing', raw }
  }
  if (/RUNNING/i.test(raw)) return { present: true, state: 'running', raw }
  if (/STOPPED/i.test(raw)) return { present: true, state: 'stopped', raw }
  if (/START_PENDING|STOP_PENDING|CONTINUE_PENDING|PAUSE_PENDING/i.test(raw)) {
    return { present: true, state: 'pending', raw }
  }
  if (result.ok) return { present: true, state: 'unknown', raw }
  return { present: false, state: 'error', raw }
}

async function getMeshAgentVersion() {
  const { exePath } = resolveMeshAgentPaths()
  if (!fileExists(exePath)) {
    return { ok: false, version: '', message: 'meshagent_missing' }
  }
  // MeshAgent often prints version with -version / --version / help banners.
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

async function getMeshAgentStatus() {
  const paths = resolveMeshAgentPaths()
  const exePresent = fileExists(paths.exePath)
  const mshPresent = fileExists(paths.mshPath)
  const service = await queryServiceState()
  const versionInfo = exePresent ? await getMeshAgentVersion() : { ok: false, version: '', message: 'meshagent_missing' }

  let status = 'missing'
  if (!exePresent || !mshPresent) status = 'missing'
  else if (service.state === 'running') status = 'running'
  else if (service.state === 'stopped' || service.state === 'pending') status = 'stopped'
  else if (service.state === 'error' || service.state === 'unknown') status = 'broken'
  else if (exePresent && mshPresent && !service.present) status = 'installed_no_service'
  else status = 'missing'

  return {
    ok: true,
    status,
    exePresent,
    mshPresent,
    servicePresent: service.present,
    serviceState: service.state,
    version: versionInfo.version || '',
    paths: {
      root: paths.root,
      exePath: paths.exePath,
      mshPath: paths.mshPath,
      packaged: paths.packaged,
    },
    hostname: os.hostname(),
    checkedAt: new Date(deps.now()).toISOString(),
  }
}

/**
 * Install MeshAgent as a Windows service when possible.
 * Elevates only for install.
 * When clientId is provided, installs from a staged msh with agentName=WXQK-<clientId>.
 * @param {{ clientId?: string }} [options]
 */
async function installMeshAgent(options = {}) {
  const clientId = safeClientIdForAgent(options.clientId)
  const paths = resolveMeshAgentPaths()
  if (!fileExists(paths.exePath) || !fileExists(paths.mshPath)) {
    log('ERROR', 'install aborted: agent files missing', { exe: paths.exePath, msh: paths.mshPath })
    return { ok: false, code: 'MESH_AGENT_FILES_MISSING', message: '缺少 meshagent.exe 或 meshagent.msh' }
  }
  if ((deps.platform || process.platform) !== 'win32') {
    return { ok: false, code: 'UNSUPPORTED_OS', message: '仅支持 Windows 安装 MeshAgent 服务' }
  }

  let installExe = paths.exePath
  let agentName = ''
  let stagingDir = ''
  if (clientId) {
    const staged = prepareInstallStaging(clientId)
    if (!staged.ok) {
      log('ERROR', 'staging msh failed', { code: staged.code, message: staged.message })
      return { ok: false, code: staged.code, message: staged.message }
    }
    installExe = staged.exePath
    agentName = staged.agentName
    stagingDir = staged.stagingDir
    log('INFO', 'installing MeshAgent from staging', { agentName })
  } else {
    log('INFO', 'installing MeshAgent service')
  }

  const elevateOpts = stagingDir ? { cwd: stagingDir } : {}
  // Common MeshAgent flags: -fullinstall installs service + copies files.
  // WorkingDirectory must be staging so MeshAgent.msh is picked up next to the exe.
  let result = await runElevated(installExe, ['-fullinstall'], elevateOpts)
  if (!result.ok) {
    result = await runElevated(installExe, ['-install'], elevateOpts)
  }
  if (!result.ok) {
    // Fallback: some builds use "Mesh Service install"
    result = await runElevated(installExe, ['Mesh', 'Service', 'install'], elevateOpts)
  }

  let mshSync = null
  if (stagingDir && clientId) {
    const stagedMsh = path.join(stagingDir, MSH_NAME)
    mshSync = await syncInstalledMsh(stagedMsh)
    log(mshSync.ok ? 'INFO' : 'WARN', 'post-install msh sync', mshSync)
  }

  const after = await getMeshAgentStatus()
  const ok = result.ok || after.servicePresent || after.status === 'running'
  log(ok ? 'INFO' : 'ERROR', 'install finished', { ok, status: after.status, agentName: agentName || undefined })
  return {
    ok,
    code: ok ? 'OK' : 'MESH_INSTALL_FAILED',
    message: ok ? 'MeshAgent 已安装' : redact(result.stderr || result.error || '安装失败'),
    status: after,
    agentName: agentName || undefined,
    stagingDir: stagingDir || undefined,
    mshSynced: Boolean(mshSync && mshSync.ok),
  }
}

async function startMeshAgent() {
  if ((deps.platform || process.platform) !== 'win32') {
    return { ok: false, code: 'UNSUPPORTED_OS', message: '仅支持 Windows' }
  }
  log('INFO', 'starting MeshAgent service')
  let result = await runExecFile('sc.exe', ['start', SERVICE_NAME], { timeoutMs: 60000 })
  if (!result.ok) {
    const paths = resolveMeshAgentPaths()
    if (fileExists(paths.exePath)) {
      result = await runElevated(paths.exePath, ['-start'])
    }
  }
  const after = await getMeshAgentStatus()
  const ok = after.status === 'running' || /already been started|1056/i.test(`${result.stdout}\n${result.stderr}`)
  return {
    ok,
    code: ok ? 'OK' : 'MESH_START_FAILED',
    message: ok ? 'MeshAgent 已启动' : redact(result.stderr || result.error || '启动失败'),
    status: after,
  }
}

async function stopMeshAgent() {
  if ((deps.platform || process.platform) !== 'win32') {
    return { ok: false, code: 'UNSUPPORTED_OS', message: '仅支持 Windows' }
  }
  log('INFO', 'stopping MeshAgent service')
  let result = await runExecFile('sc.exe', ['stop', SERVICE_NAME], { timeoutMs: 60000 })
  if (!result.ok) {
    const paths = resolveMeshAgentPaths()
    if (fileExists(paths.exePath)) {
      result = await runElevated(paths.exePath, ['-stop'])
    }
  }
  const after = await getMeshAgentStatus()
  const ok = after.status === 'stopped' || after.status === 'installed_no_service' || /1052|1062|not started/i.test(`${result.stdout}\n${result.stderr}`)
  return {
    ok: ok || result.ok,
    code: (ok || result.ok) ? 'OK' : 'MESH_STOP_FAILED',
    message: (ok || result.ok) ? 'MeshAgent 已停止' : redact(result.stderr || result.error || '停止失败'),
    status: after,
  }
}

async function restartMeshAgent() {
  log('INFO', 'restarting MeshAgent')
  await stopMeshAgent()
  return startMeshAgent()
}

async function repairMeshAgent(options = {}) {
  log('INFO', 'repairing MeshAgent')
  const stopped = await stopMeshAgent()
  const paths = resolveMeshAgentPaths()
  if (!fileExists(paths.exePath) || !fileExists(paths.mshPath)) {
    return { ok: false, code: 'MESH_AGENT_FILES_MISSING', message: '缺少 meshagent.exe 或 meshagent.msh', status: await getMeshAgentStatus() }
  }
  // Re-run fullinstall elevated (with agentName when clientId known), then start.
  const installed = await installMeshAgent({ clientId: options.clientId })
  if (!installed.ok) {
    return { ok: false, code: 'MESH_REPAIR_FAILED', message: installed.message, stop: stopped, install: installed }
  }
  const started = await startMeshAgent()
  return {
    ok: started.ok,
    code: started.ok ? 'OK' : 'MESH_REPAIR_FAILED',
    message: started.ok ? 'MeshAgent 已修复并启动' : started.message,
    stop: stopped,
    install: installed,
    start: started,
    status: started.status,
  }
}

async function uninstallMeshAgent() {
  if ((deps.platform || process.platform) !== 'win32') {
    return { ok: false, code: 'UNSUPPORTED_OS', message: '仅支持 Windows' }
  }
  log('INFO', 'uninstalling MeshAgent')
  const paths = resolveMeshAgentPaths()
  let result = { ok: false, stdout: '', stderr: '', error: '', code: 1 }
  if (fileExists(paths.exePath)) {
    result = await runElevated(paths.exePath, ['-fulluninstall'])
    if (!result.ok) result = await runElevated(paths.exePath, ['-uninstall'])
    if (!result.ok) result = await runElevated(paths.exePath, ['Mesh', 'Service', 'uninstall'])
  }
  // Best-effort service delete if binary flags failed.
  if (!result.ok) {
    await runElevated('sc.exe', ['stop', SERVICE_NAME])
    result = await runElevated('sc.exe', ['delete', SERVICE_NAME])
  }
  const after = await getMeshAgentStatus()
  const ok = !after.servicePresent || after.status === 'missing'
  return {
    ok,
    code: ok ? 'OK' : 'MESH_UNINSTALL_FAILED',
    message: ok ? 'MeshAgent 已卸载' : redact(result.stderr || result.error || '卸载失败'),
    status: after,
  }
}

/**
 * Lifecycle helper: missing→install, stopped→start, running→noop, broken→repair.
 * New installs use staged msh with agentName=WXQK-<clientId>.
 * @param {{ clientId?: string }} [options]
 */
async function ensureMeshAgentRunning(options = {}) {
  const clientId = safeClientIdForAgent(options.clientId)
  log('INFO', 'ensureMeshAgentRunning', { clientId: clientId || undefined })
  const before = await getMeshAgentStatus()
  if (before.status === 'running') {
    // 旧安装常在“服务已运行”但无 agentName / 无 msh：MeshCentral 节点列表为空，无法绑定
    if (clientId && installedAgentNeedsRepair(clientId)) {
      log('WARN', 'running agent missing/stale agentName — repairing', {
        clientId,
        expected: buildAgentName(clientId),
      })
      const repaired = await repairMeshAgent({ clientId })
      return {
        ok: repaired.ok,
        code: repaired.ok ? 'OK' : repaired.code,
        action: 'repair',
        message: repaired.message,
        status: repaired.status || (await getMeshAgentStatus()),
        agentName: buildAgentName(clientId),
      }
    }
    return { ok: true, code: 'OK', action: 'noop', message: 'MeshAgent 已在运行', status: before }
  }
  if (before.status === 'missing') {
    const installed = await installMeshAgent({ clientId })
    if (!installed.ok) {
      return { ok: false, code: installed.code, action: 'install', message: installed.message, status: installed.status || before }
    }
    const started = await startMeshAgent()
    return {
      ok: started.ok,
      code: started.ok ? 'OK' : started.code,
      action: 'install_start',
      message: started.message,
      status: started.status,
      agentName: installed.agentName,
    }
  }
  if (before.status === 'stopped' || before.status === 'installed_no_service') {
    // Even when stopped: validate installed .msh before start (stale agentName / MeshServer / etc).
    if (clientId && installedAgentNeedsRepair(clientId)) {
      log('WARN', 'stopped agent needs repair before start', {
        clientId,
        expected: buildAgentName(clientId),
      })
      const repaired = await repairMeshAgent({ clientId })
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
    return {
      ok: started.ok,
      code: started.ok ? 'OK' : started.code,
      action: 'start',
      message: started.message,
      status: started.status,
    }
  }
  // broken / unknown / error — repair may reinstall with agentName when clientId known
  const repaired = await repairMeshAgent({ clientId })
  return {
    ok: repaired.ok,
    code: repaired.ok ? 'OK' : repaired.code,
    action: 'repair',
    message: repaired.message,
    status: repaired.status || (await getMeshAgentStatus()),
  }
}

module.exports = {
  LOG_TAG,
  SERVICE_NAME,
  AGENT_NAME_PREFIX,
  MSH_IDENTITY_KEYS,
  resolveMeshAgentPaths,
  getMeshAgentStatus,
  getMeshAgentVersion,
  installMeshAgent,
  startMeshAgent,
  stopMeshAgent,
  restartMeshAgent,
  repairMeshAgent,
  uninstallMeshAgent,
  ensureMeshAgentRunning,
  safeClientIdForAgent,
  buildAgentName,
  parseMshText,
  serializeMshWithAgentName,
  stageMshForClient,
  prepareInstallStaging,
  resolveInstalledMeshAgentPaths,
  installedAgentNeedsRepair,
  setMeshAgentDepsForTest,
  resetMeshAgentDepsForTest,
  redact,
}
