'use strict'
/**
 * Cold-start LOCAL_AGENT gate using win-unpacked + empty PORTABLE_EXECUTABLE_DIR
 * (no account-session.bin). Does not require manual double-click, but exercises
 * the same whenReady → startLocalMeshPrepareOnStartup path.
 */
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execFileSync } = require('child_process')

const root = path.join(__dirname, '..')
const unpacked = path.join(root, 'release-v19', 'win-unpacked')
const exeName = '微信群控管理平台.exe'
const exe = path.join(unpacked, exeName)
const coldDir = path.join(os.tmpdir(), `wxqk-cold-boot-${Date.now()}`)

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true })
  } catch (err) {
    return `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  if (!fs.existsSync(exe)) {
    console.error('MISSING_EXE', exe)
    process.exit(3)
  }
  fs.mkdirSync(coldDir, { recursive: true })
  const sessionBin = path.join(coldDir, 'WXQK-Data', 'account-session.bin')
  console.log(JSON.stringify({
    phase: 'preflight',
    exe,
    coldDir,
    accountSessionExists: fs.existsSync(sessionBin),
    programFilesWxqk: fs.existsSync('C:\\Program Files\\WXQK\\WXQK.exe'),
    serviceQuery: run('sc.exe', ['query', 'WXQK']).includes('1060') ? 'missing' : 'present',
  }, null, 2))

  const child = spawn(exe, [], {
    cwd: unpacked,
    env: {
      ...process.env,
      PORTABLE_EXECUTABLE_DIR: coldDir,
      PORTABLE_EXECUTABLE_FILE: path.join(coldDir, '微信群控系统v1.98.exe'),
    },
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.unref()
  console.log(JSON.stringify({ phase: 'launched', pid: child.pid }, null, 2))

  let ok = false
  for (let i = 0; i < 36; i++) {
    await sleep(5000)
    const exeExists = fs.existsSync('C:\\Program Files\\WXQK\\WXQK.exe')
    const mshExists = fs.existsSync('C:\\Program Files\\WXQK\\WXQK.msh')
    const qc = run('sc.exe', ['query', 'WXQK'])
    const running = /STATE[\s\S]*RUNNING/i.test(qc)
    const procs = run('powershell.exe', [
      '-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='WXQK.exe'\" | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress",
    ]).trim()
    console.log(JSON.stringify({
      phase: 'poll',
      sec: (i + 1) * 5,
      exeExists,
      mshExists,
      running,
      procs: procs.slice(0, 300),
    }))
    const pathMatch = procs.includes('Program Files\\WXQK\\WXQK.exe') || procs.includes('Program Files\\\\WXQK\\\\WXQK.exe')
    if (exeExists && mshExists && running && pathMatch) {
      ok = true
      break
    }
    if (exeExists && mshExists && running) {
      const pathOk = /BINARY_PATH_NAME\s*:\s*"?C:\\Program Files\\WXQK\\WXQK\.exe/i.test(run('sc.exe', ['qc', 'WXQK']))
      if (pathOk) {
        ok = true
        break
      }
    }
  }

  const final = {
    phase: 'final',
    ok,
    exeExists: fs.existsSync('C:\\Program Files\\WXQK\\WXQK.exe'),
    mshExists: fs.existsSync('C:\\Program Files\\WXQK\\WXQK.msh'),
    qc: run('sc.exe', ['query', 'WXQK']).split(/\r?\n/).slice(0, 12).join('\n'),
    binary: run('sc.exe', ['qc', 'WXQK']).match(/BINARY_PATH_NAME.*/)?.[0] || '',
    accountSessionAfter: fs.existsSync(sessionBin),
    identityCreated: fs.existsSync(path.join(coldDir, 'WXQK-Data', 'security', 'device-identity.json')),
    tcp4433: run('powershell.exe', ['-NoProfile', '-Command', 'Get-NetTCPConnection -RemotePort 4433 -ErrorAction SilentlyContinue | Select-Object -First 3 State,RemoteAddress | ConvertTo-Json -Compress']),
  }
  console.log(JSON.stringify(final, null, 2))
  process.exit(ok ? 0 : 2)
}

main().catch((e) => { console.error(e); process.exit(1) })
