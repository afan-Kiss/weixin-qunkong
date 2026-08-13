'use strict'

/**
 * Structured Windows service health via CIM JSON (locale-independent).
 * Falls back to sc.exe query/qc when CIM unavailable.
 */

const { execFile } = require('child_process')
const { promisify } = require('util')
const path = require('path')

const execFileAsync = promisify(execFile)

const SERVICE_NAME = 'WXQK'

/**
 * @param {string} raw
 */
function normalizePathName(raw) {
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
 * @param {string} serviceName
 * @param {{ execFile?: typeof execFile, platform?: string, serviceHealth?: object }} [deps]
 */
async function queryServiceHealth(serviceName = SERVICE_NAME, deps = {}) {
  if (deps.serviceHealth) {
    return { ...deps.serviceHealth, name: serviceName }
  }
  if ((deps.platform || process.platform) !== 'win32') {
    return {
      present: false,
      state: 'unsupported',
      startMode: '',
      pathName: '',
      processId: 0,
      name: serviceName,
      source: 'unsupported',
    }
  }

  const exec = deps.execFile || execFile
  const run = (cmd, args) => new Promise((resolve) => {
    exec(cmd, args, { windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || ''), error })
    })
  })

  const ps = [
    `$ErrorActionPreference='SilentlyContinue'`,
    `$s = Get-CimInstance Win32_Service -Filter "Name='${String(serviceName).replace(/'/g, "''")}'"`,
    `if ($null -eq $s) { '{}' } else {`,
    `  [pscustomobject]@{`,
    `    Name=$s.Name; State=$s.State; StartMode=$s.StartMode; PathName=$s.PathName; ProcessId=$s.ProcessId; StartName=$s.StartName`,
    `  } | ConvertTo-Json -Compress`,
    `}`,
  ].join('; ')

  const cim = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps])
  if (cim.ok) {
    try {
      const json = JSON.parse(String(cim.stdout || '').trim() || '{}')
      if (!json || !json.Name) {
        return {
          present: false,
          state: 'missing',
          startMode: '',
          pathName: '',
          processId: 0,
          name: serviceName,
          source: 'cim',
        }
      }
      const stateRaw = String(json.State || '')
      let state = 'unknown'
      if (/running/i.test(stateRaw)) state = 'running'
      else if (/stopped/i.test(stateRaw)) state = 'stopped'
      else if (/pending/i.test(stateRaw)) state = 'pending'
      else if (stateRaw) state = stateRaw.toLowerCase()
      return {
        present: true,
        state,
        startMode: String(json.StartMode || ''),
        pathName: normalizePathName(json.PathName || ''),
        processId: Number(json.ProcessId || 0) || 0,
        startName: String(json.StartName || ''),
        name: serviceName,
        source: 'cim',
      }
    } catch { /* fall through to sc */ }
  }

  // Fallback: sc.exe
  const query = await run('sc.exe', ['query', serviceName])
  const rawQ = `${query.stdout}\n${query.stderr}`
  if (/FAILED\s+1060/i.test(rawQ) || /does not exist/i.test(rawQ)) {
    return {
      present: false,
      state: 'missing',
      startMode: '',
      pathName: '',
      processId: 0,
      name: serviceName,
      source: 'sc',
    }
  }
  let state = 'unknown'
  if (/RUNNING/i.test(rawQ)) state = 'running'
  else if (/STOPPED/i.test(rawQ)) state = 'stopped'
  else if (/PENDING/i.test(rawQ)) state = 'pending'
  const qc = await run('sc.exe', ['qc', serviceName])
  const pathM = String(qc.stdout || '').match(/BINARY_PATH_NAME\s*:\s*(.+)$/im)
  const startM = String(qc.stdout || '').match(/START_TYPE\s*:\s*\d+\s+(\w+)/i)
  return {
    present: true,
    state,
    startMode: startM ? startM[1] : '',
    pathName: pathM ? normalizePathName(pathM[1]) : '',
    processId: 0,
    name: serviceName,
    source: 'sc',
  }
}

/**
 * Ensure Automatic start + failure recovery (restart with backoff).
 * @param {string} serviceName
 * @param {(file: string, args: string[], opts?: object) => Promise<object>} runElevated
 */
async function ensureServiceAutoAndRecovery(serviceName, runElevated) {
  const name = String(serviceName || SERVICE_NAME)
  const config = await runElevated('sc.exe', ['config', name, 'start=', 'auto'])
  // reset= 86400 seconds; actions= restart/5000/restart/15000/restart/60000
  const failure = await runElevated('sc.exe', [
    'failure', name,
    'reset=', '86400',
    'actions=', 'restart/5000/restart/15000/restart/60000',
  ])
  let failureFlagOk = false
  try {
    const flag = await runElevated('sc.exe', ['failureflag', name, '1'])
    failureFlagOk = Boolean(flag?.ok)
  } catch { /* ignore */ }
  return {
    ok: Boolean(config?.ok),
    configOk: Boolean(config?.ok),
    failureOk: Boolean(failure?.ok),
    failureFlagOk,
  }
}

function isAutomaticStartMode(startMode) {
  const s = String(startMode || '').toLowerCase().replace(/\s+/g, '')
  if (!s) return true // unknown → don't force broken until CIM returns
  if (s.includes('disabled') || s.includes('manual') || s.includes('demand')) return false
  return s === 'auto' || s === 'automatic' || s.includes('auto')
}

module.exports = {
  SERVICE_NAME,
  queryServiceHealth,
  ensureServiceAutoAndRecovery,
  isAutomaticStartMode,
  normalizePathName,
}
