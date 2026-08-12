# Startup benchmark for wxqk portable / unpacked.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/benchmark-startup.ps1 -Exe <path> -Runs 3 -Label name [-ColdExtract]
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [int]$Runs = 3,
  [string]$Label = 'bench',
  [switch]$ColdExtract
)

$ErrorActionPreference = 'SilentlyContinue'
$markFile = Join-Path $env:TEMP 'wxqk-startup-marks.json'

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WxqkWinBench {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static List<string> Visible() {
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

function Clear-PortableUnpackCache {
  foreach ($root in @($env:TEMP, $env:TMP)) {
    if (-not $root -or -not (Test-Path -LiteralPath $root)) { continue }
    Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $hint = Join-Path $_.FullName '微信群控管理平台.exe'
      $hint2 = Join-Path $_.FullName 'resources\app.asar'
      if ((Test-Path -LiteralPath $hint) -or (Test-Path -LiteralPath $hint2)) {
        Write-Host "clear unpack cache: $($_.FullName)"
        Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
      }
    }
  }
}

function Stop-AllWxqk {
  for ($round = 0; $round -lt 5; $round++) {
    Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $_.ProcessName -like '微信群控*'
    } | ForEach-Object {
      try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch {}
      try { & taskkill.exe /F /T /PID $_.Id 2>$null | Out-Null } catch {}
    }
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      ([string]$_.Name -match '微信群控') -or ([string]$_.CommandLine -match '微信群控管理平台')
    } | ForEach-Object {
      try { & taskkill.exe /F /T /PID $_.ProcessId 2>$null | Out-Null } catch {}
    }
    $left = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '微信群控*' })
    if ($left.Count -eq 0) { break }
    Start-Sleep -Milliseconds 400
  }
  Start-Sleep -Milliseconds 1000
}

function Read-Marks {
  if (-not (Test-Path -LiteralPath $markFile)) { return $null }
  try {
    return (Get-Content -LiteralPath $markFile -Raw -Encoding UTF8 | ConvertFrom-Json)
  } catch { return $null }
}

if (-not (Test-Path -LiteralPath $Exe)) { throw "exe not found: $Exe" }
$Exe = (Resolve-Path -LiteralPath $Exe).Path
$sizeMb = [math]::Round((Get-Item -LiteralPath $Exe).Length / 1MB, 1)
$exeBase = [IO.Path]::GetFileNameWithoutExtension($Exe)
$isPortableArtifact = $Exe -notmatch 'win-unpacked'
Write-Host "benchmark label=$Label exe=$Exe size=${sizeMb}MB runs=$Runs cold=$ColdExtract portable=$isPortableArtifact"

$results = @()
Stop-AllWxqk

for ($i = 1; $i -le $Runs; $i++) {
  Stop-AllWxqk
  if ($ColdExtract) { Clear-PortableUnpackCache }
  Remove-Item -Force -ErrorAction SilentlyContinue $markFile

  $t0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Write-Host "run $i : spawning at $t0 ..."
  $proc = Start-Process -FilePath $Exe -PassThru -WorkingDirectory (Split-Path -Parent $Exe)

  $first = $null
  $main = $null
  $marksReady = $null
  $deadline = [DateTime]::UtcNow.AddSeconds(180)
  $nextPidScan = [DateTime]::UtcNow
  $target = @{}
  if ($proc) { $target[[int]$proc.Id] = $true }

  while ([DateTime]::UtcNow -lt $deadline -and ($null -eq $first -or $null -eq $main)) {
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $elapsed = $now - $t0

    # 二次实例撞锁：非 portable 启动进程很快退出且无 marks
    if (-not $isPortableArtifact -and $proc -and $proc.HasExited -and $elapsed -gt 2500 -and $null -eq (Read-Marks)) {
      Write-Host "  abort: starter exited early (likely single-instance collision)"
      break
    }

    if ([DateTime]::UtcNow -ge $nextPidScan) {
      $target = @{}
      if ($proc -and -not $proc.HasExited) { $target[[int]$proc.Id] = $true }
      Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessName -like '微信群控*' -or $_.ProcessName -eq $exeBase
      } | ForEach-Object { $target[[int]$_.Id] = $true }
      $nextPidScan = [DateTime]::UtcNow.AddMilliseconds(300)
    }

    foreach ($row in [WxqkWinBench]::Visible()) {
      $parts = $row.Split('|')
      if ($parts.Length -lt 3) { continue }
      $pid = [int]$parts[0]
      if (-not $target.ContainsKey($pid)) { continue }
      $wh = $parts[2].Split('x')
      $w = [int]$wh[0]; $h = [int]$wh[1]
      if ($null -eq $first -and $w -ge 80 -and $h -ge 60) {
        $first = $elapsed
        Write-Host "  firstVisible=${first}ms pid=$pid size=$($parts[2]) class=$($parts[1])"
      }
    }

    $marks = Read-Marks
    if ($null -eq $main -and $marks -and $marks.'ready-to-show' -ne $null -and $marks.updatedAt) {
      $main = [int64]$marks.updatedAt - $t0
      $marksReady = $marks
      if ($main -lt 0) { $main = $elapsed }
      Write-Host "  main(ready-to-show)=${main}ms electronInternal=$($marks.'ready-to-show')ms"
      if ($null -eq $first) { $first = $main }
    }

    # 旧包无 marks：用大窗口近似主界面
    if ($null -eq $main) {
      foreach ($row in [WxqkWinBench]::Visible()) {
        $parts = $row.Split('|')
        if ($parts.Length -lt 3) { continue }
        $pid = [int]$parts[0]
        if (-not $target.ContainsKey($pid)) { continue }
        $cls = $parts[1]
        $wh = $parts[2].Split('x')
        $w = [int]$wh[0]; $h = [int]$wh[1]
        if ($cls.StartsWith('Chrome_WidgetWin') -and $w -ge 700 -and $h -ge 450) {
          $main = $elapsed
          Write-Host "  main(window)=${main}ms size=$($parts[2])"
          if ($null -eq $first) { $first = $main }
          break
        }
      }
    }
    Start-Sleep -Milliseconds 50
  }

  if ($null -eq $first -and $null -ne $main) { $first = $main }

  Write-Host "run $i : firstVisible=${first}ms main=${main}ms"
  $results += [pscustomobject]@{
    run = $i
    firstVisibleMs = $first
    mainVisibleMs = $main
    electronMarks = $marksReady
  }
  Stop-AllWxqk
  Start-Sleep -Milliseconds 2500
}

function Avg($name) {
  $vals = @($results | Where-Object { $_.$name -ne $null } | ForEach-Object { [int64]($_.$name) })
  if ($vals.Count -eq 0) { return $null }
  return [int](($vals | Measure-Object -Average).Average)
}

$summary = [ordered]@{
  label = $Label
  exe = $Exe
  sizeMb = $sizeMb
  runs = $Runs
  coldExtract = [bool]$ColdExtract
  avgFirstVisibleMs = Avg 'firstVisibleMs'
  avgMainVisibleMs = Avg 'mainVisibleMs'
  results = $results
  measuredAt = (Get-Date).ToString('o')
}
$outDir = Join-Path $PSScriptRoot '..\release-bench'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$outFile = Join-Path $outDir ("startup-{0}-{1}.json" -f ($Label -replace '[^\w\.-]+','_'), [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
($summary | ConvertTo-Json -Depth 6) | Set-Content -Path $outFile -Encoding UTF8
Write-Host "SUMMARY first=$($summary.avgFirstVisibleMs)ms main=$($summary.avgMainVisibleMs)ms size=$sizeMb MB"
Write-Host "wrote $outFile"
