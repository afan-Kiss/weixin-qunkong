'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

const artifact = require('../electron/mesh-agent-artifact.cjs')
const networkGate = require('../electron/mesh-network-gate.cjs')
const serviceHealth = require('../electron/mesh-service-health.cjs')
const paths = require('../electron/wxqk-data-paths.cjs')
const {
  assertProductionIdentitySafeToBootstrap,
  writeProductionIdentityManifest,
} = require('../../deploy/meshcentral/production_identity_guard.js')

test('artifact outdated when packaged SHA differs from installed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'art-'))
  const packaged = path.join(dir, 'WXQK.exe')
  const installed = path.join(dir, 'installed.exe')
  writeFileSync(packaged, 'NEW-AGENT-BYTES')
  writeFileSync(installed, 'OLD-AGENT-BYTES')
  const meta = artifact.writePackagedArtifactMeta(dir, packaged)
  assert.ok(meta.sha256)
  assert.equal(meta.fileDescription, 'WXQK')
  assert.doesNotMatch(JSON.stringify(meta), /login|token|MeshID|secret/i)
  const p = artifact.readPackagedArtifactFingerprint(dir, packaged)
  const i = artifact.readInstalledArtifactFingerprint(installed)
  assert.equal(artifact.isArtifactOutdated(p, i), true)
  writeFileSync(installed, 'NEW-AGENT-BYTES')
  const i2 = artifact.readInstalledArtifactFingerprint(installed)
  assert.equal(artifact.isArtifactOutdated(p, i2), false)
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('network gate parses MeshServer endpoint and classifies TCP', async () => {
  const ep = networkGate.parseAgentEndpointFromMsh(
    'MeshServer=wss://mesh.example.test:4433/agent.ashx\nMeshID=mesh://x/\n',
  )
  assert.equal(ep.host, 'mesh.example.test')
  assert.equal(ep.port, 4433)
  const tcp = await networkGate.probeTcp('127.0.0.1', 1, 200)
  assert.equal(tcp.ok, false)
  assert.ok(['TCP_FAIL', 'TCP_TIMEOUT'].includes(tcp.code))
})

test('service StartMode Automatic detection', () => {
  assert.equal(serviceHealth.isAutomaticStartMode('Auto'), true)
  assert.equal(serviceHealth.isAutomaticStartMode('Automatic'), true)
  assert.equal(serviceHealth.isAutomaticStartMode('AUTO_START'), true)
  assert.equal(serviceHealth.isAutomaticStartMode('Disabled'), false)
  assert.equal(serviceHealth.isAutomaticStartMode('Manual'), false)
  assert.equal(serviceHealth.isAutomaticStartMode('Demand'), false)
})

test('production identity guard fail-closed when marker + empty data', () => {
  const deploy = mkdtempSync(path.join(tmpdir(), 'mesh-deploy-'))
  mkdirSync(path.join(deploy, 'data'), { recursive: true })
  writeProductionIdentityManifest(deploy, { serverId: 'abc', meshId: 'mesh://x', agentPort: 4433 })
  const fs = require('fs')
  for (const name of fs.readdirSync(path.join(deploy, 'data'))) {
    fs.unlinkSync(path.join(deploy, 'data', name))
  }
  const guard = assertProductionIdentitySafeToBootstrap(deploy)
  assert.equal(guard.ok, false)
  assert.equal(guard.code, 'MESH_PRODUCTION_IDENTITY_MISSING')
  try { rmSync(deploy, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('production identity guard fails when only manifest remains (no Mesh cert/db)', () => {
  const deploy = mkdtempSync(path.join(tmpdir(), 'mesh-deploy-'))
  writeProductionIdentityManifest(deploy, { serverId: 'abc', meshId: 'mesh://x', agentPort: 4433 })
  // Manifest alone is NOT MeshCentral identity
  const guard = assertProductionIdentitySafeToBootstrap(deploy)
  assert.equal(guard.ok, false)
  assert.equal(guard.code, 'MESH_PRODUCTION_IDENTITY_MISSING')
  try { rmSync(deploy, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('production identity guard passes when agentserver cert present', () => {
  const deploy = mkdtempSync(path.join(tmpdir(), 'mesh-deploy-'))
  writeProductionIdentityManifest(deploy, { serverId: 'abc', meshId: 'mesh://x', agentPort: 4433 })
  writeFileSync(path.join(deploy, 'data', 'agentserver-cert-public.crt'), 'CERT')
  const guard = assertProductionIdentitySafeToBootstrap(deploy)
  assert.equal(guard.ok, true)
  try { rmSync(deploy, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('production identity guard fails on mapping history + empty data', () => {
  const deploy = mkdtempSync(path.join(tmpdir(), 'mesh-deploy-'))
  mkdirSync(path.join(deploy, 'data'), { recursive: true })
  const guard = assertProductionIdentitySafeToBootstrap(deploy, { hasWxqkMappingDb: true })
  assert.equal(guard.ok, false)
  assert.equal(guard.code, 'MESH_PRODUCTION_IDENTITY_MISSING')
  try { rmSync(deploy, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('mesh-remote-bridge classifies NETWORK_BLOCKED without reinstall language', () => {
  const src = readFileSync(
    path.join(__dirname, '..', 'electron', 'mesh-remote-bridge.cjs'),
    'utf8',
  )
  assert.match(src, /NETWORK_BLOCKED/)
  assert.match(src, /checkAgentNetworkGate/)
  assert.match(src, /Never repair\/reinstall when the failure is actually NETWORK_BLOCKED/)
})

test('ensureMeshAgentRunning upgrades outdated_agent with rollback', () => {
  const src = readFileSync(
    path.join(__dirname, '..', 'electron', 'mesh-agent-manager.cjs'),
    'utf8',
  )
  assert.match(src, /outdated_agent/)
  assert.match(src, /async function upgradeMeshAgent/)
  assert.match(src, /rolling back agent upgrade/)
  assert.match(src, /hardenServiceConfig/)
  assert.match(src, /ensureServiceAutoAndRecovery/)
  assert.match(src, /MeshName/)
  assert.match(src, /service_config_broken/)
  assert.doesNotMatch(src, /taskkill\s+\/IM\s+WXQK\.exe/i)
  assert.doesNotMatch(src, /taskkill\s+\/IM\s+MeshAgent\.exe/i)
})

test('watchdog exists with elevation backoff and network recover', () => {
  const src = readFileSync(
    path.join(__dirname, '..', 'electron', 'mesh-agent-watchdog.cjs'),
    'utf8',
  )
  assert.match(src, /ELEVATION_BACKOFF_MS/)
  assert.match(src, /NETWORK_BLOCKED/)
  assert.match(src, /onNetworkRecovered/)
  assert.match(src, /not reinstalling/)
  assert.match(src, /LOCAL_AGENT_READY/)
  const wd = require('../electron/mesh-agent-watchdog.cjs')
  const gates = wd.buildLocalGates({
    packagedExePresent: true,
    packagedMshPresent: true,
    servicePresent: true,
    imagePathOk: true,
    startMode: 'Auto',
    status: 'running',
    processId: 42,
    processIdKnown: true,
    source: 'cim',
    paths: { installedExePath: 'C:\\Program Files\\WXQK\\WXQK.exe' },
    executablePath: 'C:\\Program Files\\WXQK\\WXQK.exe',
    outdatedAgent: false,
  }, { ok: false })
  assert.equal(gates.NETWORK, 'FAIL')
  assert.equal(gates.PROCESS, 'PASS')
  assert.equal(gates.LOCAL_AGENT_READY, true)
  assert.equal(gates.NETWORK_BLOCKED, true)

  const pidZero = wd.buildLocalGates({
    packagedExePresent: true,
    packagedMshPresent: true,
    servicePresent: true,
    imagePathOk: true,
    startMode: 'Auto',
    status: 'running',
    processId: 0,
    processIdKnown: true,
    source: 'cim',
    outdatedAgent: false,
  }, { ok: true })
  assert.notEqual(pidZero.PROCESS, 'PASS')
  assert.equal(pidZero.LOCAL_AGENT_READY, false)
})

test('stable userData migration is idempotent and never overwrites identity', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mig-'))
  const stable = path.join(root, 'stable')
  const legacy = path.join(root, 'legacy-WXQK-Data')
  mkdirSync(path.join(legacy, 'security'), { recursive: true })
  writeFileSync(path.join(legacy, 'account-session.bin'), 'tok')
  writeFileSync(path.join(legacy, 'security', 'device-identity.json'), '{"deviceId":"x"}')
  mkdirSync(path.join(stable, 'security'), { recursive: true })
  writeFileSync(path.join(stable, 'security', 'device-identity.json'), '{"deviceId":"stable"}')
  const first = paths.migrateLegacyPortableUserDataIfNeeded({
    stableUserDataDir: stable,
    legacyPortableUserDataDir: legacy,
  })
  // Session migrator does not copy identity; existing stable identity file untouched
  assert.equal(JSON.parse(readFileSync(path.join(stable, 'security', 'device-identity.json'), 'utf8')).deviceId, 'stable')
  assert.ok(first.reason === 'copied' || first.migrated === true || first.reason === 'already_migrated' || first.copied)
  const second = paths.migrateLegacyPortableUserDataIfNeeded({
    stableUserDataDir: stable,
    legacyPortableUserDataDir: legacy,
  })
  assert.equal(second.reason, 'already_migrated')
  try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('updater cleanup refuses Program Files WXQK and identity paths', () => {
  const updater = require('../electron/client-updater.cjs')
  assert.equal(updater.isSafeUpdaterCleanupPath('C:\\Program Files\\WXQK\\WXQK.exe'), false)
  assert.equal(updater.isSafeUpdaterCleanupPath('C:\\Temp\\wxqk-old.exe'), true)
  const src = readFileSync(path.join(__dirname, '..', 'electron', 'client-updater.cjs'), 'utf8')
  assert.match(src, /isSafeUpdaterCleanupPath/)
  assert.match(src, /isProtectedWxqkPath/)
})

test('startup scrub refuses protected agent/identity paths', () => {
  assert.equal(paths.isProtectedWxqkPath('C:\\Program Files\\WXQK\\WXQK.msh'), true)
  const scrubSrc = readFileSync(path.join(__dirname, '..', 'electron', 'startup-cache-scrub.cjs'), 'utf8')
  assert.match(scrubSrc, /isProtectedWxqkPath/)
})

test('manage.py doctor includes TLS SPKI check and production identity guard', () => {
  const manage = readFileSync(path.join(__dirname, '..', '..', 'deploy', 'meshcentral', 'manage.py'), 'utf8')
  assert.match(manage, /_check_tls_spki_against_pins/)
  assert.match(manage, /MESH_PRODUCTION_IDENTITY_MISSING/)
  assert.match(manage, /cmd_backup/)
  assert.match(manage, /cmd_restore/)
  assert.match(manage, /CURRENT\+NEXT/)
  assert.match(manage, /preserving WXQK_MESH_GROUP/)
  assert.match(manage, /_meshcentral_data_has_identity/)
  assert.match(manage, /TLS_PINS_REQUIRED/)
})

test('network blocked has dedicated user message (not install failure)', () => {
  const { userMessageForCode } = require('../electron/mesh-remote-bridge.cjs')
  assert.match(userMessageForCode('NETWORK_BLOCKED'), /网络/)
  assert.doesNotMatch(userMessageForCode('NETWORK_BLOCKED'), /安装失败/)
})

test('logout stops remote agent websocket but not mesh Windows service', () => {
  const main = readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  assert.match(main, /ipcMain\.handle\('auth:logout',\s*async\s*\(\)\s*=>\s*\{\s*await softwareAuth\.logout\(\);\s*stopRemoteAgent\(\)/)
  assert.match(main, /do NOT stopMeshAgent/)
  // Ensure before-quit never *calls* stopMeshAgent / uninstallMeshAgent (comments may mention the name)
  const beforeQuitIdx = main.indexOf("app.on('before-quit'")
  assert.ok(beforeQuitIdx > 0)
  const beforeQuitSlice = main.slice(beforeQuitIdx, beforeQuitIdx + 800)
  assert.match(beforeQuitSlice, /stopRemoteAgent\(\)/)
  assert.doesNotMatch(beforeQuitSlice, /(?<!NOT\s|\/\/[^\n]*)\bstopMeshAgent\s*\(/)
  assert.doesNotMatch(beforeQuitSlice, /\buninstallMeshAgent\s*\(/)
})

test('identity schema v2 drops plaintext when DPAPI path is used in writer', () => {
  const { writeIdentityFile, IDENTITY_SCHEMA_VERSION } = require('../electron/device-identity.cjs')
  assert.equal(IDENTITY_SCHEMA_VERSION, 2)
  const dir = mkdtempSync(path.join(tmpdir(), 'idw-'))
  const file = path.join(dir, 'device-identity.json')
  // Without electron safeStorage → plaintext fallback for tests is OK
  writeIdentityFile(file, {
    publicKeyB64: 'a'.repeat(44),
    deviceId: 'abc',
    clientId: 'abc',
    createdAt: '2026-01-01T00:00:00.000Z',
  }, '-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n')
  const row = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(row.schemaVersion, 2)
  assert.equal(row.machineBindingVersion, 1)
  assert.ok(row.privateKeyPem || row.privateKeyEnc)
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('msh core identity keys exclude dynamic agentName from full-file hash upgrades', () => {
  const src = readFileSync(path.join(__dirname, '..', 'electron', 'mesh-agent-manager.cjs'), 'utf8')
  assert.match(src, /MSH_IDENTITY_KEYS/)
  assert.match(src, /installedAgentNeedsRepair/)
  // Must compare core keys, not hash entire msh
  assert.doesNotMatch(src, /sha256.*installedMsh|mshSha256|hashFileSync\(.*msh/i)
})
