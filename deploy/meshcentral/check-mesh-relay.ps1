#Requires -Version 5.1
<#
.SYNOPSIS
  Helper to inspect WXQK MeshAgent / MeshCentral Relay topology on Windows.

.DESCRIPTION
  Does NOT decrypt payloads. Prints MeshCentral endpoints from env and current
  TCP connections that look related to the branded WXQK agent / mesh ports.
  Also reports legacy "Mesh Agent" if still present (pre-branding installs).
  Use together with config webRTC=false to confirm Relay-only operation.

.EXAMPLE
  $env:WXQK_MESH_HOSTNAME = 'mesh.example.invalid'
  .\check-mesh-relay.ps1
#>

param(
  [string]$MeshHost = $env:WXQK_MESH_HOSTNAME,
  [int]$HttpsPort = 443,
  [int]$AgentPort = 4433
)

Write-Host '[MESH] Relay topology helper (not a cryptographic proof)' -ForegroundColor Cyan

if (-not $MeshHost) {
  Write-Warning 'WXQK_MESH_HOSTNAME / -MeshHost not set; listing WXQK agent connections only'
} else {
  Write-Host "[MESH] Expected MeshCentral host: $MeshHost"
  Write-Host "[MESH] Expected ports: HTTPS/WSS=$HttpsPort Agent=$AgentPort"
}

$svc = Get-Service -Name 'WXQK' -ErrorAction SilentlyContinue
if ($svc) {
  Write-Host "[MESH] WXQK service: $($svc.Status)"
} else {
  Write-Host '[MESH] WXQK service: not found'
}

$legacy = Get-Service -Name 'Mesh Agent' -ErrorAction SilentlyContinue
if ($legacy) {
  Write-Host "[MESH] legacy Mesh Agent service still present: $($legacy.Status)"
}

$procs = Get-Process -Name 'WXQK','meshagent','MeshAgent' -ErrorAction SilentlyContinue
if ($procs) {
  Write-Host "[MESH] agent processes: $(($procs | ForEach-Object { '{0}:{1}' -f $_.ProcessName, $_.Id }) -join ', ')"
} else {
  Write-Host '[MESH] no WXQK/meshagent process'
}

Write-Host '[MESH] TCP connections involving agent process or common mesh ports:'
try {
  $conns = Get-NetTCPConnection -ErrorAction SilentlyContinue |
    Where-Object {
      $_.OwningProcess -in @($procs.Id) -or
      $_.RemotePort -in @($HttpsPort, $AgentPort, 443, 4433) -or
      $_.LocalPort -in @($HttpsPort, $AgentPort, 443, 4433)
    }
  if ($conns) {
    $conns | Select-Object -First 30 LocalAddress, LocalPort, RemoteAddress, RemotePort, State, OwningProcess |
      Format-Table -AutoSize | Out-String | Write-Host
  } else {
    Write-Host '[MESH] no matching TCP connections'
  }
} catch {
  Write-Warning $_.Exception.Message
}
