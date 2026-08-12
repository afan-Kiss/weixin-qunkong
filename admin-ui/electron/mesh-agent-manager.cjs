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
 */
async function runElevated(file, args) {
  if ((deps.platform || process.platform) !== 'win32') {
    return runExecFile(file, args)
  }
  const argList = (args || []).map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',')
  const ps = [
    `$p = Start-Process -FilePath '${String(file).replace(/'/g, "''")}'`,
    argList ? ` -ArgumentList @(${argList})` : '',
    ' -Verb RunAs -Wait -PassThru -WindowStyle Hidden',
    '; if ($null -eq $p) { exit 1 } else { exit $p.ExitCode }',
  ].join('')
  return runExecFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    timeoutMs: 300000,
  })
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
 */
async function installMeshAgent() {
  const paths = resolveMeshAgentPaths()
  if (!fileExists(paths.exePath) || !fileExists(paths.mshPath)) {
    log('ERROR', 'install aborted: agent files missing', { exe: paths.exePath, msh: paths.mshPath })
    return { ok: false, code: 'MESH_AGENT_FILES_MISSING', message: '缺少 meshagent.exe 或 meshagent.msh' }
  }
  if ((deps.platform || process.platform) !== 'win32') {
    return { ok: false, code: 'UNSUPPORTED_OS', message: '仅支持 Windows 安装 MeshAgent 服务' }
  }

  log('INFO', 'installing MeshAgent service')
  // Common MeshAgent flags: -fullinstall installs service + copies files.
  let result = await runElevated(paths.exePath, ['-fullinstall'])
  if (!result.ok) {
    result = await runElevated(paths.exePath, ['-install'])
  }
  if (!result.ok) {
    // Fallback: some builds use "Mesh Service install"
    result = await runElevated(paths.exePath, ['Mesh', 'Service', 'install'])
  }

  const after = await getMeshAgentStatus()
  const ok = result.ok || after.servicePresent || after.status === 'running'
  log(ok ? 'INFO' : 'ERROR', 'install finished', { ok, status: after.status })
  return {
    ok,
    code: ok ? 'OK' : 'MESH_INSTALL_FAILED',
    message: ok ? 'MeshAgent 已安装' : redact(result.stderr || result.error || '安装失败'),
    status: after,
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

async function repairMeshAgent() {
  log('INFO', 'repairing MeshAgent')
  const stopped = await stopMeshAgent()
  const paths = resolveMeshAgentPaths()
  if (!fileExists(paths.exePath) || !fileExists(paths.mshPath)) {
    return { ok: false, code: 'MESH_AGENT_FILES_MISSING', message: '缺少 meshagent.exe 或 meshagent.msh', status: await getMeshAgentStatus() }
  }
  // Re-run fullinstall elevated, then start.
  const installed = await installMeshAgent()
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
 * @param {{ clientId?: string }} [options]
 */
async function ensureMeshAgentRunning(options = {}) {
  const clientId = String(options.clientId || '').trim()
  log('INFO', 'ensureMeshAgentRunning', { clientId: clientId || undefined })
  const before = await getMeshAgentStatus()
  if (before.status === 'running') {
    return { ok: true, code: 'OK', action: 'noop', message: 'MeshAgent 已在运行', status: before }
  }
  if (before.status === 'missing') {
    const installed = await installMeshAgent()
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
    }
  }
  if (before.status === 'stopped' || before.status === 'installed_no_service') {
    const started = await startMeshAgent()
    return {
      ok: started.ok,
      code: started.ok ? 'OK' : started.code,
      action: 'start',
      message: started.message,
      status: started.status,
    }
  }
  // broken / unknown / error
  const repaired = await repairMeshAgent()
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
  setMeshAgentDepsForTest,
  resetMeshAgentDepsForTest,
  redact,
}
