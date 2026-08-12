'use strict'
/**
 * 启动耗时采样（Windows）
 *   node scripts/benchmark-startup.cjs <exe> [--runs=3] [--label=name]
 *
 * firstVisible: 目标进程树出现任一可见窗口（含 portable splash / Electron splash）
 * mainVisible: 目标进程出现较大的 Chrome_WidgetWin 主窗口（面积阈值）
 */
const { spawn, execSync, execFileSync } = require('child_process')
const { existsSync, statSync, writeFileSync, mkdirSync, readFileSync, unlinkSync } = require('fs')
const path = require('path')
const os = require('os')

const args = process.argv.slice(2)
const target = args.find((a) => !a.startsWith('--'))
const runs = Number((args.find((a) => a.startsWith('--runs=')) || '--runs=3').slice(7)) || 3
const label = (args.find((a) => a.startsWith('--label=')) || `--label=${path.basename(target || 'app')}`).slice(8)

if (!target || !existsSync(target)) {
  console.error('usage: node scripts/benchmark-startup.cjs <exe> [--runs=3] [--label=name]')
  process.exit(1)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function killWxqkProcesses() {
  try { execSync('taskkill /IM "微信群控管理平台.exe" /T /F', { stdio: 'ignore', windowsHide: true }) } catch {}
  try {
    execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      "Get-Process | Where-Object { $_.ProcessName -match '微信群控' } | Stop-Process -Force -ErrorAction SilentlyContinue",
    ], { stdio: 'ignore', windowsHide: true })
  } catch {}
}

function resolveExe(input) {
  if (input.toLowerCase().endsWith('.exe')) return path.resolve(input)
  const candidates = [
    path.join(input, '微信群控管理平台.exe'),
    path.join(input, 'win-unpacked', '微信群控管理平台.exe'),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return path.resolve(input)
}

function writeUtf8Bom(file, content) {
  writeFileSync(file, `\uFEFF${content}`, 'utf8')
}

function startMonitor(outFile, t0, exePath) {
  const ps1 = path.join(os.tmpdir(), `wxqk-startup-mon-${process.pid}.ps1`)
  const exeEsc = exePath.replace(/'/g, "''")
  const outEsc = outFile.replace(/'/g, "''")
  writeUtf8Bom(ps1, `
$ErrorActionPreference = 'SilentlyContinue'
$out = '${outEsc}'
$exe = '${exeEsc}'
$exeName = [IO.Path]::GetFileNameWithoutExtension($exe)
$t0 = [int64]${t0}
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinEnumWxqkBench {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static List<string> All() {
    var list = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      RECT r; GetWindowRect(h, out r);
      int w = Math.Max(0, r.Right - r.Left); int ht = Math.Max(0, r.Bottom - r.Top);
      list.Add(pid + "|" + c.ToString() + "|" + w + "x" + ht);
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
function TargetPids {
  $set = New-Object 'System.Collections.Generic.HashSet[int]'
  Get-CimInstance Win32_Process | ForEach-Object {
    $name = [string]$_.Name
    $cmd = [string]$_.CommandLine
    if ($name -like '*微信群控*' -or $cmd -like '*微信群控*' -or $name -like ($exeName + '*')) {
      [void]$set.Add([int]$_.ProcessId)
    }
  }
  return $set
}
$first = $null
$main = $null
$deadline = [DateTime]::UtcNow.AddSeconds(120)
while ([DateTime]::UtcNow -lt $deadline -and ($null -eq $first -or $null -eq $main)) {
  $elapsed = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $t0
  $pids = TargetPids
  foreach ($row in [WinEnumWxqkBench]::All()) {
    $parts = $row.Split('|')
    if ($parts.Length -lt 3) { continue }
    $pid = [int]$parts[0]
    if (-not $pids.Contains($pid)) { continue }
    $cls = $parts[1]
    $size = $parts[2]
    $wh = $size.Split('x')
    $w = [int]$wh[0]; $h = [int]$wh[1]
    if ($null -eq $first -and $w -ge 40 -and $h -ge 40) { $first = $elapsed }
    # 主界面明显大于 splash（splash ~300x132 / portable bmp ~480x220）
    if ($null -eq $main -and $cls.StartsWith('Chrome_WidgetWin') -and $w -ge 600 -and $h -ge 400) {
      $main = $elapsed
    }
  }
  (@{ t = $elapsed; first = $first; main = $main } | ConvertTo-Json -Compress) | Set-Content -Path $out -Encoding UTF8
  if ($null -ne $first -and $null -ne $main) { break }
  Start-Sleep -Milliseconds 70
}
`)
  const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  return { pid: child.pid, ps1 }
}

function readMonitor(outFile) {
  try {
    const raw = readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '').trim()
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function main() {
  const exe = resolveExe(target)
  const sizeMb = Number((statSync(exe).size / (1024 * 1024)).toFixed(1))
  console.log(`benchmark label=${label} exe=${exe} size=${sizeMb}MB runs=${runs}`)

  killWxqkProcesses()
  await sleep(800)

  const results = []
  for (let i = 1; i <= runs; i++) {
    killWxqkProcesses()
    await sleep(800)
    const outFile = path.join(os.tmpdir(), `wxqk-bench-${process.pid}-${i}.json`)
    try { unlinkSync(outFile) } catch {}
    const t0 = Date.now()
    const mon = startMonitor(outFile, t0, exe)
    await sleep(400)
    console.log(`run ${i}: spawning...`)
    const app = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false })
    app.on('error', (err) => console.error('spawn error', err))
    app.unref()

    let snapshot = null
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      snapshot = readMonitor(outFile)
      if (snapshot && snapshot.first != null && snapshot.main != null) break
      await sleep(120)
    }
    const row = {
      run: i,
      firstVisibleMs: snapshot?.first ?? null,
      mainVisibleMs: snapshot?.main ?? null,
    }
    results.push(row)
    console.log(`run ${i}: firstVisible=${row.firstVisibleMs}ms main=${row.mainVisibleMs}ms`)
    try { process.kill(mon.pid) } catch {}
    killWxqkProcesses()
    await sleep(1500)
  }

  function avg(key) {
    const vals = results.map((r) => r[key]).filter((v) => typeof v === 'number')
    if (!vals.length) return null
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)
  }

  const summary = {
    label,
    exe,
    sizeMb,
    runs,
    avgFirstVisibleMs: avg('firstVisibleMs'),
    avgMainVisibleMs: avg('mainVisibleMs'),
    results,
    host: os.hostname(),
    measuredAt: new Date().toISOString(),
  }
  const outDir = path.join(__dirname, '..', 'release-bench')
  mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `startup-${label.replace(/[^\w.-]+/g, '_')}-${Date.now()}.json`)
  writeFileSync(outFile, JSON.stringify(summary, null, 2), 'utf8')
  console.log(JSON.stringify({
    avgFirstVisibleMs: summary.avgFirstVisibleMs,
    avgMainVisibleMs: summary.avgMainVisibleMs,
    sizeMb,
  }, null, 2))
  console.log('wrote', outFile)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
