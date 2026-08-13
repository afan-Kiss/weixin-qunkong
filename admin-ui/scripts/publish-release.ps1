#Requires -Version 5.1
# One-command release: bump (optional) → package portable → publish to update channel.
param(
  [string]$BaseUrl = '',
  # Deprecated CLI secret: prefer WXQK_PUBLISH_PASSWORD env inherited by child process.
  [string]$Password = '',
  [switch]$Mandatory,
  [switch]$SkipBump,
  [switch]$SkipPackage,
  [string]$ExePath = '',
  [string[]]$TargetClientIds = @(),
  [int]$Concurrency = 4,
  [int]$PreferredChunkMB = 4,
  [switch]$InsecureTls
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# GitHub electron zip 常下坏；国内默认走 npmmirror
if (-not $env:ELECTRON_MIRROR -or -not $env:ELECTRON_MIRROR.Trim()) {
  $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
}

if ($Password) {
  Write-Warning 'Do not pass -Password on the command line; use WXQK_PUBLISH_PASSWORD env only.'
  if (-not $env:WXQK_PUBLISH_PASSWORD) { $env:WXQK_PUBLISH_PASSWORD = $Password }
}
if (-not $env:WXQK_PUBLISH_PASSWORD) {
  throw 'Missing publish credential (set WXQK_PUBLISH_PASSWORD in the environment).'
}

if (-not $BaseUrl) {
  $resolved = & node (Join-Path $PSScriptRoot 'resolve-production-base.cjs')
  if ($LASTEXITCODE -ne 0 -or -not $resolved) {
    throw 'Failed to resolve canonical production BaseUrl from secure-config'
  }
  $BaseUrl = ([string]$resolved).Trim()
}
Write-Host ("== publish BaseUrl host: {0} ==" -f ([uri]$BaseUrl).Host)
Write-Host ("== TLS verification: {0} ==" -f (-not $InsecureTls.IsPresent))
if ($TargetClientIds -and $TargetClientIds.Count -gt 0) {
  Write-Host ("== targetClientIds: {0} ==" -f ($TargetClientIds -join ','))
}

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$script:PackageOutputDir = ''

function Get-PackageDisplayVersion {
  $pkg = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $display = ([string]$pkg.version) -replace '\.0$', ''
  if ($display -notmatch '^\d+\.\d+$') {
    if ([string]$pkg.version -match '^(\d+)\.(\d+)') { $display = "$($Matches[1]).$($Matches[2])" }
  }
  return @{ Display = $display; Pkg = $pkg }
}

function Get-DefaultOutputDirName {
  param($Pkg)
  $outputDir = 'release-v19'
  if ($Pkg.build -and $Pkg.build.directories -and $Pkg.build.directories.output) {
    $outputDir = [string]$Pkg.build.directories.output
  }
  return $outputDir
}

# 若默认 win-unpacked 被占用（常见：Cursor 索引锁住 app.asar），换旁路/时间戳目录。
function Test-OutputDirWritable {
  param([string]$DirName)
  $abs = if ([System.IO.Path]::IsPathRooted($DirName)) { $DirName } else { Join-Path $root $DirName }
  $asar = Join-Path $abs 'win-unpacked\resources\app.asar'
  if (Test-Path -LiteralPath $asar) {
    try {
      $fs = [System.IO.File]::Open($asar, 'Open', 'ReadWrite', 'None')
      $fs.Close()
    } catch {
      return $false
    }
  }
  $unpacked = Join-Path $abs 'win-unpacked'
  if (Test-Path -LiteralPath $unpacked) {
    try {
      Remove-Item -LiteralPath $unpacked -Recurse -Force -ErrorAction Stop
    } catch {
      return $false
    }
  }
  return $true
}

function Resolve-BuilderOutputDir {
  param([string]$PreferredName)
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $candidates = @(
    $PreferredName,
    ('{0}-build' -f $PreferredName),
    ('{0}-tmp' -f $PreferredName),
    ('{0}-{1}' -f $PreferredName, $stamp)
  )
  foreach ($name in $candidates) {
    if (Test-OutputDirWritable -DirName $name) {
      if ($name -ne $PreferredName) {
        Write-Host ("== win-unpacked/app.asar locked; using output {0} ==" -f $name)
      }
      return $name
    }
    Write-Host ("== skip locked output: {0} ==" -f $name)
  }
  $outside = Join-Path $env:TEMP ("wxqk-release-{0}" -f $stamp)
  New-Item -ItemType Directory -Force -Path $outside | Out-Null
  Write-Host ("== all workspace release dirs locked (often Cursor); using {0} ==" -f $outside)
  return $outside
}

function Resolve-LatestPortableExe {
  param([string]$Preferred)
  if ($Preferred -and (Test-Path -LiteralPath $Preferred)) {
    return (Get-Item -LiteralPath $Preferred).FullName
  }
  $meta = Get-PackageDisplayVersion
  $display = $meta.Display
  $versionPattern = ('v{0}\.exe$' -f [regex]::Escape($display))
  $dirs = New-Object System.Collections.Generic.List[string]
  if ($script:PackageOutputDir) { [void]$dirs.Add($script:PackageOutputDir) }
  [void]$dirs.Add((Get-DefaultOutputDirName -Pkg $meta.Pkg))
  [void]$dirs.Add('release-v19-build')
  [void]$dirs.Add('release-v19-tmp')
  Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'release-v19*' } |
    Sort-Object LastWriteTime -Descending |
    ForEach-Object { [void]$dirs.Add($_.Name) }
  # 临时目录旁路产物
  Get-ChildItem -LiteralPath $env:TEMP -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'wxqk-release-*' } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 5 |
    ForEach-Object { [void]$dirs.Add($_.FullName) }
  $seen = @{}
  foreach ($name in $dirs) {
    if (-not $name -or $seen.ContainsKey($name)) { continue }
    $seen[$name] = $true
    $dir = if ([System.IO.Path]::IsPathRooted($name)) { $name } else { Join-Path $root $name }
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    $expected = Join-Path $dir ("微信群控系统v{0}.exe" -f $display)
    if (Test-Path -LiteralPath $expected) { return (Get-Item -LiteralPath $expected).FullName }
    # 控制台/脚本编码可能导致中文 Filter 匹配失败，改用版本号回退查找
    $hit = Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Extension -ieq '.exe' -and $_.Name -match $versionPattern } |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  throw "Portable EXE not found for v$display (searched: $($seen.Keys -join ', '))"
}

$swAll = [System.Diagnostics.Stopwatch]::StartNew()

if (-not $SkipPackage) {
  Write-Host '== ensure hooks =='
  node scripts/ensure-hooks.cjs
  if (-not $SkipBump) {
    Write-Host '== bump version =='
    node scripts/bump-version.cjs
  } else {
    Write-Host '== skip bump (use current package.json version) =='
  }
  Write-Host '== vite build =='
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed: $LASTEXITCODE" }
  Write-Host '== portable splash bmp =='
  node scripts/generate-portable-splash.cjs
  if ($LASTEXITCODE -ne 0) { throw "generate portable splash failed: $LASTEXITCODE" }
  $meta = Get-PackageDisplayVersion
  $script:PackageOutputDir = Resolve-BuilderOutputDir -PreferredName (Get-DefaultOutputDirName -Pkg $meta.Pkg)
  $builderOut = [string]$script:PackageOutputDir
  Write-Host ("== electron-builder portable (output={0}, mirror={1}) ==" -f $builderOut, $env:ELECTRON_MIRROR)
  # 避免 npx.ps1 对含 $script: 的参数二次 Expand；直接调 electron-builder CLI
  $ebCli = Join-Path $root 'node_modules\electron-builder\cli.js'
  if (-not (Test-Path -LiteralPath $ebCli)) {
    throw "electron-builder missing: $ebCli (run npm install)"
  }
  node $ebCli --win portable --config.directories.output=$builderOut
  if ($LASTEXITCODE -ne 0) { throw "electron-builder failed: $LASTEXITCODE" }
}

$exe = Resolve-LatestPortableExe -Preferred $ExePath
Write-Host "== publish $exe =="
# Default: verify TLS with system trust. -InsecureTls is emergency/dev only.
$useInsecureTls = [bool]$InsecureTls.IsPresent
if ($useInsecureTls) {
  Write-Warning 'HIGH RISK: -InsecureTls disables TLS certificate verification. Production must NOT use this switch. Prefer a publicly trusted certificate (e.g. Let''s Encrypt IP cert).'
}
# Password travels only via inherited env WXQK_PUBLISH_PASSWORD — never argv.
$publishArgs = @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', (Join-Path $PSScriptRoot '_publish-release-once.ps1'),
  '-BaseUrl', $BaseUrl,
  '-ExePath', $exe,
  '-Concurrency', "$Concurrency",
  '-PreferredChunkMB', "$PreferredChunkMB"
)
if ($Mandatory) { $publishArgs += '-Mandatory' }
if ($useInsecureTls) { $publishArgs += '-InsecureTls' }
if ($TargetClientIds -and $TargetClientIds.Count -gt 0) {
  $publishArgs += '-TargetClientIds'
  foreach ($cid in $TargetClientIds) { $publishArgs += [string]$cid }
}
# Guard: never allow secret or -Password in child argv
$joinedArgs = ($publishArgs -join ' ')
if ($joinedArgs -match '(?i)-Password\b') { throw 'Refusing to launch publisher with -Password in argv' }
if ($env:WXQK_PUBLISH_PASSWORD -and $joinedArgs.Contains([string]$env:WXQK_PUBLISH_PASSWORD)) {
  throw 'Refusing to launch publisher with secret embedded in argv'
}
& powershell @publishArgs
if ($LASTEXITCODE -ne 0) { throw "publish failed: $LASTEXITCODE" }

$swAll.Stop()
Write-Host ("All done in {0:N1}s" -f $swAll.Elapsed.TotalSeconds)
