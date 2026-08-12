#Requires -Version 5.1
<#
.SYNOPSIS
  Helper to inspect MeshAgent / MeshCentral Relay topology on Windows.

.DESCRIPTION
  Does NOT decrypt payloads. Prints MeshCentral endpoints from env and current
  TCP connections that look related to MeshAgent / mesh ports.
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
  Write-Warning 'WXQK_MESH_HOSTNAME / -MeshHost not set; listing Mesh Agent connections only'
} else {
  Write-Host "[MESH] Expected MeshCentral host: $MeshHost"
  Write-Host "[MESH] Expected ports: HTTPS/WSS=$HttpsPort Agent=$AgentPort"
}

$svc = Get-Service -Name 'Mesh Agent' -ErrorAction SilentlyContinue
if ($svc) {
  Write-Host "[MESH] Mesh Agent service: $($svc.Status)"
} else {
  Write-Host '[MESH] Mesh Agent service: not found'
}

$procs = Get-Process -Name 'meshagent','MeshAgent' -ErrorAction SilentlyContinue
if ($procs) {
  Write-Host "[MESH] meshagent processes: $($procs.Id -join ', ')"
} else {
  Write-Host '[MESH] no meshagent process'
}

Write-Host '[MESH] TCP connections involving meshagent or common mesh ports:'
try {
  $conns = Get-NetTCPConnection -ErrorAction SilentlyContinue |
    Where-Object {
      $_.OwningProcess -in @($procs.Id) -or
      $_.RemotePort -in @($HttpsPort, $AgentPort, 443, 4433) -or
      $_.LocalPort -in @($AgentPort, 4433)
    }
  if (-not $conns) {
    Write-Host '  (none matched)'
  } else {
    $conns | Select-Object -First 40 LocalAddress, LocalPort, RemoteAddress, RemotePort, State, OwningProcess |
      Format-Table -AutoSize
  }
} catch {
  Write-Warning "Get-NetTCPConnection failed: $_"
  Write-Host 'Fallback: netstat -ano | findstr /i "443 4433 mesh"'
  netstat -ano | Select-String -Pattern ':(443|4433)\s'
}

Write-Host ''
Write-Host '[MESH] Interpretation:'
Write-Host '  OK: MeshAgent remote endpoints resolve to your MeshCentral server IP/hostname.'
Write-Host '  Suspicious: long-lived remote desktop-like connections directly to the viewer PC public IP.'
Write-Host '  Also confirm MeshCentral config.json has "webRTC": false after every upgrade.'
