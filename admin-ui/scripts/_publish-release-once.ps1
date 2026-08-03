#Requires -Version 5.1
# One-shot: chunk-upload + publish a versioned EXE to 发财888 / 九游 admin release API.
param(
  [Parameter(Mandatory = $true)][string]$BaseUrl,
  [Parameter(Mandatory = $true)][string]$ExePath,
  [Parameter(Mandatory = $true)][string]$Password,
  [switch]$Mandatory
)

$ErrorActionPreference = 'Stop'
# Avoid IE HTML-parsing security prompt on Windows PowerShell 5.1.
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

if (-not (Test-Path -LiteralPath $ExePath)) {
  throw "EXE not found: $ExePath"
}
$file = Get-Item -LiteralPath $ExePath
$fileName = $file.Name
$fileSize = [int64]$file.Length
$version = ''
if ($fileName -match 'v(\d+\.\d+)\.exe$') { $version = $Matches[1] }
if (-not $version) { throw "Filename must end with vMAJOR.MINOR.exe: $fileName" }

$base = $BaseUrl.TrimEnd('/')
$d = Get-Date
$buildId = '{0:yyyyMMdd}-{0:HHmmss}-{1}' -f $d, ([guid]::NewGuid().ToString('N').Substring(0, 6))
$chunkSize = 1MB

Write-Host "Publish: $fileName -> $base (buildId=$buildId version=$version size=$fileSize)"

$loginBody = (@{ password = $Password } | ConvertTo-Json -Compress)
$login = Invoke-RestMethod -Method Post -Uri "$base/api/login" -ContentType 'application/json; charset=utf-8' -Body $loginBody -TimeoutSec 30
$token = [string]($login.token)
if (-not $token) { throw "login failed: $($login | ConvertTo-Json -Compress)" }
$headers = @{ 'X-Admin-Token' = $token }

$initBody = (@{
  buildId = $buildId
  fileName = $fileName
  fileSize = $fileSize
} | ConvertTo-Json -Compress)
$init = Invoke-RestMethod -Method Post -Uri "$base/api/admin/release/upload/init" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $initBody -TimeoutSec 60
if (-not $init.ok) { throw "upload init failed: $($init | ConvertTo-Json -Compress)" }

$mode = [string]($init.mode)
if (-not $mode) { $mode = 'parts' }
$hint = [int64]($init.chunkHint)
if ($hint -gt 0) { $chunkSize = [Math]::Max(64KB, [Math]::Min(4MB, $hint)) }
$totalParts = [int][Math]::Ceiling($fileSize / $chunkSize)
Write-Host "Upload mode=$mode parts=$totalParts chunk=$chunkSize"

$fs = [System.IO.File]::OpenRead($file.FullName)
try {
  $buf = New-Object byte[] $chunkSize
  for ($i = 0; $i -lt $totalParts; $i++) {
    $toRead = [int][Math]::Min($chunkSize, $fileSize - ([int64]$i * $chunkSize))
    $read = 0
    while ($read -lt $toRead) {
      $n = $fs.Read($buf, $read, $toRead - $read)
      if ($n -le 0) { throw "unexpected EOF at part $i" }
      $read += $n
    }
    $payload = New-Object byte[] $toRead
    [Array]::Copy($buf, 0, $payload, 0, $toRead)
    $ok = $false
    $lastErr = $null
    for ($attempt = 1; $attempt -le 8; $attempt++) {
      try {
        $uri = "$base/api/admin/release/upload/part?buildId=$([uri]::EscapeDataString($buildId))&index=$i"
        # -UseBasicParsing: never use IE engine (stops the “分析页面时可能会运行脚本” popup).
        $resp = Invoke-WebRequest -Method Post -Uri $uri -Headers $headers `
          -ContentType 'application/octet-stream' -Body $payload -TimeoutSec 120 `
          -UseBasicParsing
        $data = $resp.Content | ConvertFrom-Json
        if ($data.ok -eq $false) { throw ($data.message -as [string]) }
        $ok = $true
        break
      } catch {
        $lastErr = $_
        Start-Sleep -Milliseconds ([Math]::Min(5000, 350 * [Math]::Pow(2, $attempt - 1)))
      }
    }
    if (-not $ok) { throw "part $i failed: $lastErr" }
    if ((($i + 1) % 5) -eq 0 -or $i -eq ($totalParts - 1)) {
      $pct = [Math]::Round((($i + 1) / $totalParts) * 100, 1)
      Write-Host ("  uploaded {0}/{1} ({2}%)" -f ($i + 1), $totalParts, $pct)
    }
  }
} finally {
  $fs.Dispose()
}

$finishBody = (@{ buildId = $buildId } | ConvertTo-Json -Compress)
$finished = $null
for ($attempt = 1; $attempt -le 5; $attempt++) {
  try {
    $finished = Invoke-RestMethod -Method Post -Uri "$base/api/admin/release/upload/finish" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $finishBody -TimeoutSec 180
    if ($finished.ok) { break }
  } catch {
    if ($attempt -eq 5) { throw }
    Start-Sleep -Seconds 2
  }
}
if (-not $finished -or -not $finished.ok) {
  throw "upload finish failed: $($finished | ConvertTo-Json -Compress)"
}
$publishedBuildId = [string]($finished.buildId)
if (-not $publishedBuildId) { $publishedBuildId = $buildId }
Write-Host "Upload OK buildId=$publishedBuildId sha256=$($finished.sha256)"

$pubBody = (@{
  version = $version
  buildId = $publishedBuildId
  gitCommit = ''
  mandatory = [bool]$Mandatory.IsPresent -or $true
  fileName = $fileName
} | ConvertTo-Json -Compress)
# Always mandatory=true like admin UI default unless caller clears it — keep true.
$pubObj = @{
  version = $version
  buildId = $publishedBuildId
  gitCommit = ''
  mandatory = $true
  fileName = $fileName
}
if ($PSBoundParameters.ContainsKey('Mandatory') -and -not $Mandatory) { $pubObj.mandatory = $false }
$pubBody = ($pubObj | ConvertTo-Json -Compress)
$pub = Invoke-RestMethod -Method Post -Uri "$base/api/admin/release/publish" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $pubBody -TimeoutSec 60
if (-not $pub.ok -and $null -ne $pub.ok) {
  throw "publish failed: $($pub | ConvertTo-Json -Compress)"
}
$man = $pub.manifest
$seq = $man.releaseSequence
$unchanged = [bool]$pub.unchanged
Write-Host ("Publish done: version={0} seq={1} unchanged={2} buildId={3}" -f $man.version, $seq, $unchanged, $man.buildId)
$pub | ConvertTo-Json -Depth 6
