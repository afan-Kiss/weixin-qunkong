#Requires -Version 5.1
# One-shot: chunk-upload + publish a versioned EXE to wxqk admin release API.
# Faster path: prefer 4MB parts + parallel uploads (server supports unordered parts).
param(
  [Parameter(Mandatory = $true)][string]$BaseUrl,
  [Parameter(Mandatory = $true)][string]$ExePath,
  [Parameter(Mandatory = $true)][string]$Password,
  [switch]$Mandatory,
  [string[]]$TargetClientIds = @(),
  [int]$Concurrency = 4,
  [int]$PreferredChunkMB = 4,
  [switch]$InsecureTls
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# Default: system TLS verification. TrustAllCertsPolicy only when -InsecureTls is explicit.
if ($InsecureTls.IsPresent) {
  Write-Warning 'HIGH RISK: -InsecureTls installs TrustAllCertsPolicy (TLS verification disabled). Do not use for production publish.'
  add-type @"
using System.Net;
using System.Security.Cryptography.X509Certificates;
public class WxqkTrustAllCertsPolicy : ICertificatePolicy {
  public bool CheckValidationResult(ServicePoint s, X509Certificate c, WebRequest r, int p) { return true; }
}
"@
  [System.Net.ServicePointManager]::CertificatePolicy = New-Object WxqkTrustAllCertsPolicy
  [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
}
if (-not (Test-Path -LiteralPath $ExePath)) {
  throw "EXE not found: $ExePath"
}
if ($Concurrency -lt 1) { $Concurrency = 1 }
if ($Concurrency -gt 8) { $Concurrency = 8 }
if ($PreferredChunkMB -lt 1) { $PreferredChunkMB = 1 }
if ($PreferredChunkMB -gt 4) { $PreferredChunkMB = 4 }

$file = Get-Item -LiteralPath $ExePath
$fileName = $file.Name
$fileSize = [int64]$file.Length
$version = ''
if ($fileName -match 'v(\d+\.\d+)\.exe$') { $version = $Matches[1] }
if (-not $version) { throw "Filename must end with vMAJOR.MINOR.exe: $fileName" }

$base = $BaseUrl.TrimEnd('/')
$d = Get-Date
$buildId = '{0:yyyyMMdd}-{0:HHmmss}-{1}' -f $d, ([guid]::NewGuid().ToString('N').Substring(0, 6))
$preferredChunk = [int64]$PreferredChunkMB * 1MB

Write-Host "Publish: $fileName -> $base (buildId=$buildId version=$version size=$fileSize)"

$loginBody = (@{ password = $Password } | ConvertTo-Json -Compress)
$login = Invoke-RestMethod -Method Post -Uri "$base/api/login" -ContentType 'application/json; charset=utf-8' -Body $loginBody -TimeoutSec 30
$token = [string]($login.token)
if (-not $token) { throw "login failed: $($login | ConvertTo-Json -Compress)" }
$headers = @{ 'X-Admin-Token' = $token }

$initObj = @{
  buildId = $buildId
  fileName = $fileName
  fileSize = $fileSize
  chunkSize = $preferredChunk
}
$initBody = ($initObj | ConvertTo-Json -Compress)
$init = Invoke-RestMethod -Method Post -Uri "$base/api/admin/release/upload/init" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $initBody -TimeoutSec 60
if (-not $init.ok) { throw "upload init failed: $($init | ConvertTo-Json -Compress)" }

$publishedBuildId = $null
if ([string]$init.mode -eq 'complete' -and $init.sha256) {
  Write-Host "Upload recovered as complete sha256=$($init.sha256)"
  $publishedBuildId = [string]($init.buildId)
  if (-not $publishedBuildId) { $publishedBuildId = $buildId }
} else {
  $chunkSize = [int64]($init.chunkHint)
  if ($chunkSize -le 0) { $chunkSize = $preferredChunk }
  # Old servers ignore requested chunkSize and always hint 1MB — honor their session size.
  $chunkSize = [Math]::Max(64KB, [Math]::Min(4MB, $chunkSize))
  $totalParts = [int][Math]::Ceiling($fileSize / $chunkSize)
  $already = @()
  if ($init.uploadedParts) { $already = @($init.uploadedParts) }
  $pending = New-Object System.Collections.Generic.List[int]
  for ($i = 0; $i -lt $totalParts; $i++) {
    if ($already -notcontains $i) { [void]$pending.Add($i) }
  }
  Write-Host ("Upload mode=parts parts={0} pending={1} chunk={2} concurrency={3}" -f $totalParts, $pending.Count, $chunkSize, $Concurrency)

  Add-Type -AssemblyName System.Net.Http | Out-Null
  $sw = [System.Diagnostics.Stopwatch]::StartNew()

  $worker = {
    param([int]$Index, [int64]$ChunkSize, [string]$FilePath, [int64]$FileSize, [string]$Base, [string]$BuildId, [string]$Token)
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.Net.Http | Out-Null
    $offset = [int64]$Index * [int64]$ChunkSize
    $toRead = [int][Math]::Min([int64]$ChunkSize, [int64]$FileSize - $offset)
    $fs = [System.IO.File]::OpenRead($FilePath)
    try {
      $null = $fs.Seek($offset, 'Begin')
      $payload = New-Object byte[] $toRead
      $read = 0
      while ($read -lt $toRead) {
        $n = $fs.Read($payload, $read, $toRead - $read)
        if ($n -le 0) { throw "unexpected EOF at part $Index" }
        $read += $n
      }
    } finally {
      $fs.Dispose()
    }
    $uri = "$Base/api/admin/release/upload/part?buildId=$([uri]::EscapeDataString($BuildId))&index=$Index"
    $client = New-Object System.Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromMinutes(5)
    $null = $client.DefaultRequestHeaders.TryAddWithoutValidation('X-Admin-Token', $Token)
    try {
      $lastErr = $null
      for ($attempt = 1; $attempt -le 8; $attempt++) {
        try {
          $content = New-Object System.Net.Http.ByteArrayContent(,$payload)
          $content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse('application/octet-stream')
          $resp = $client.PostAsync($uri, $content).GetAwaiter().GetResult()
          $text = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
          if (-not $resp.IsSuccessStatusCode) { throw "HTTP $([int]$resp.StatusCode): $text" }
          $data = $text | ConvertFrom-Json
          if ($data.ok -eq $false) { throw [string]$data.message }
          return $Index
        } catch {
          $lastErr = $_
          Start-Sleep -Milliseconds ([Math]::Min(4000, 250 * [Math]::Pow(2, $attempt - 1)))
        }
      }
      throw "part $Index failed: $lastErr"
    } finally {
      $client.Dispose()
    }
  }

  if ($pending.Count -gt 0) {
    $pool = [runspacefactory]::CreateRunspacePool(1, $Concurrency)
    $pool.Open()
    $jobs = @()
    foreach ($index in $pending) {
      $ps = [powershell]::Create().AddScript($worker).AddArgument([int]$index).AddArgument([int64]$chunkSize).AddArgument([string]$file.FullName).AddArgument([int64]$fileSize).AddArgument([string]$base).AddArgument([string]$buildId).AddArgument([string]$token)
      $ps.RunspacePool = $pool
      $jobs += @{ PowerShell = $ps; Handle = $ps.BeginInvoke(); Index = $index }
    }
    $doneCount = 0
    $firstError = $null
    foreach ($job in $jobs) {
      try {
        $null = $job.PowerShell.EndInvoke($job.Handle)
        if ($job.PowerShell.HadErrors) {
          $msg = ($job.PowerShell.Streams.Error | ForEach-Object { $_.ToString() }) -join '; '
          throw "part $($job.Index) failed: $msg"
        }
      } catch {
        if (-not $firstError) { $firstError = $_ }
      } finally {
        $job.PowerShell.Dispose()
      }
      if ($firstError) { break }
      $doneCount++
      $step = [Math]::Max(1, [Math]::Ceiling($pending.Count / 10.0))
      if (($doneCount % $step) -eq 0 -or $doneCount -eq $pending.Count) {
        $pct = [Math]::Round(($doneCount / $pending.Count) * 100, 1)
        $mbps = 0
        if ($sw.Elapsed.TotalSeconds -gt 0) {
          $mbps = [Math]::Round((($doneCount * $chunkSize) / 1MB) / $sw.Elapsed.TotalSeconds, 2)
        }
        Write-Host ("  uploaded {0}/{1} ({2}%) ~{3} MB/s" -f $doneCount, $pending.Count, $pct, $mbps)
      }
    }
    foreach ($job in $jobs) {
      try { if ($job.PowerShell -and -not $job.PowerShell.Runspace.IsDisposed) { $job.PowerShell.Stop() } } catch {}
    }
    $pool.Close()
    $pool.Dispose()
    if ($firstError) { throw $firstError }
  }
  $sw.Stop()
  Write-Host ("Upload parts done in {0:N1}s" -f $sw.Elapsed.TotalSeconds)

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
}

$pubObj = @{
  version = $version
  buildId = $publishedBuildId
  gitCommit = ''
  mandatory = [bool]$Mandatory.IsPresent
  fileName = $fileName
}
if ($TargetClientIds -and $TargetClientIds.Count -gt 0) {
  $pubObj.targetClientIds = @($TargetClientIds)
}
$pubBody = ($pubObj | ConvertTo-Json -Compress)
$pub = Invoke-RestMethod -Method Post -Uri "$base/api/admin/release/publish" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $pubBody -TimeoutSec 60
if (-not $pub.ok -and $null -ne $pub.ok) {
  throw "publish failed: $($pub | ConvertTo-Json -Compress)"
}
$man = $pub.manifest
Write-Host ("Publish done: version={0} seq={1} unchanged={2} buildId={3}" -f $man.version, $man.releaseSequence, [bool]$pub.unchanged, $man.buildId)
$pub | ConvertTo-Json -Depth 6
