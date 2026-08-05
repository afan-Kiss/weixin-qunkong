#Requires -Version 5.1
# One-command release: bump (optional) → package portable → publish to update channel.
param(
  [string]$BaseUrl = 'https://xiangyuzhubao.xyz/wxqk',
  [string]$Password = $env:WXQK_PUBLISH_PASSWORD,
  [switch]$Mandatory,
  [switch]$SkipBump,
  [switch]$SkipPackage,
  [string]$ExePath = '',
  [int]$Concurrency = 4,
  [int]$PreferredChunkMB = 4
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

if (-not $Password) {
  throw 'Missing password. Pass -Password or set env WXQK_PUBLISH_PASSWORD.'
}

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

function Resolve-LatestPortableExe {
  param([string]$Preferred)
  if ($Preferred -and (Test-Path -LiteralPath $Preferred)) {
    return (Get-Item -LiteralPath $Preferred).FullName
  }
  $pkg = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $display = ([string]$pkg.version) -replace '\.0$', ''
  if ($display -notmatch '^\d+\.\d+$') {
    if ([string]$pkg.version -match '^(\d+)\.(\d+)') { $display = "$($Matches[1]).$($Matches[2])" }
  }
  $outputDir = 'release-v19'
  if ($pkg.build -and $pkg.build.directories -and $pkg.build.directories.output) {
    $outputDir = [string]$pkg.build.directories.output
  }
  $expected = Join-Path $root (Join-Path $outputDir ("微信群控系统v{0}.exe" -f $display))
  if (Test-Path -LiteralPath $expected) { return (Get-Item -LiteralPath $expected).FullName }
  # 控制台/脚本编码可能导致中文 Filter 匹配失败，改用版本号回退查找
  $versionPattern = ('v{0}\.exe$' -f [regex]::Escape($display))
  $hit = Get-ChildItem -LiteralPath (Join-Path $root $outputDir) -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -ieq '.exe' -and $_.Name -match $versionPattern } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($hit) { return $hit.FullName }
  $hit = Get-ChildItem -LiteralPath (Join-Path $root $outputDir) -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -ieq '.exe' -and $_.Name -like '*v*.exe' } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($hit) { return $hit.FullName }
  throw "Portable EXE not found under $outputDir"
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
  Write-Host '== electron-builder portable =='
  npx electron-builder --win portable
  if ($LASTEXITCODE -ne 0) { throw "electron-builder failed: $LASTEXITCODE" }
}

$exe = Resolve-LatestPortableExe -Preferred $ExePath
Write-Host "== publish $exe =="
$publishArgs = @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', (Join-Path $PSScriptRoot '_publish-release-once.ps1'),
  '-BaseUrl', $BaseUrl,
  '-ExePath', $exe,
  '-Password', $Password,
  '-Concurrency', "$Concurrency",
  '-PreferredChunkMB', "$PreferredChunkMB"
)
if ($Mandatory) { $publishArgs += '-Mandatory' }
& powershell @publishArgs
if ($LASTEXITCODE -ne 0) { throw "publish failed: $LASTEXITCODE" }

$swAll.Stop()
Write-Host ("All done in {0:N1}s" -f $swAll.Elapsed.TotalSeconds)
