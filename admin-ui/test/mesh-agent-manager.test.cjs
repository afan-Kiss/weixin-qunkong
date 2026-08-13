'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const os = require('os')
const fs = require('fs')

const {
  SERVICE_NAME,
  EXE_NAME,
  MSH_NAME,
  LEGACY_SERVICE_NAME,
  resolveMeshAgentPaths,
  getMeshAgentStatus,
  ensureMeshAgentRunning,
  installMeshAgent,
  startMeshAgent,
  stopMeshAgent,
  isLegacyAgentOwnedByWxqk,
  migrateLegacyMeshAgentToWxqk,
  redact,
  setMeshAgentDepsForTest,
  resetMeshAgentDepsForTest,
  installedAgentNeedsRepair,
  isBrandedInstallHealthy,
  parseScBinaryPath,
  isBrandedImagePath,
} = require('../electron/mesh-agent-manager.cjs')

test.afterEach(() => {
  resetMeshAgentDepsForTest()
})

test('brand constants use WXQK without Remote', () => {
  assert.equal(SERVICE_NAME, 'WXQK')
  assert.equal(EXE_NAME, 'WXQK.exe')
  assert.equal(MSH_NAME, 'WXQK.msh')
  assert.equal(LEGACY_SERVICE_NAME, 'Mesh Agent')
  assert.doesNotMatch(SERVICE_NAME, /remote/i)
  assert.doesNotMatch(EXE_NAME, /remote/i)
})

test('redact strips login tokens and long hex', () => {
  const raw = 'open https://mesh.example/?login=abc123&node=n1 hex=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  const out = redact(raw)
  assert.match(out, /login=\*\*\*/)
  assert.doesNotMatch(out, /login=abc123/)
  assert.match(out, /\*\*\*hex\*\*\*/)
})

test('resolveMeshAgentPaths uses branded WXQK.exe in unpackaged mode', () => {
  setMeshAgentDepsForTest({
    isPackaged: false,
    resourcesPath: 'C:\\packed\\resources',
    platform: 'win32',
  })
  const paths = resolveMeshAgentPaths()
  assert.equal(paths.packaged, false)
  assert.equal(path.basename(paths.root), 'meshcentral')
  assert.equal(path.basename(paths.exePath), 'WXQK.exe')
  assert.equal(path.basename(paths.mshPath), 'WXQK.msh')
  assert.match(paths.root.replace(/\\/g, '/'), /resources\/meshcentral$/)
})

test('resolveMeshAgentPaths uses process.resourcesPath when packaged', () => {
  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: path.join('E:', 'dist', 'resources'),
    platform: 'win32',
  })
  const paths = resolveMeshAgentPaths()
  assert.equal(paths.packaged, true)
  assert.equal(paths.root, path.join('E:', 'dist', 'resources', 'meshcentral'))
  assert.equal(path.basename(paths.exePath), 'WXQK.exe')
})

test('getMeshAgentStatus reports missing when files absent', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-agent-'))
  const fakeFs = {
    existsSync: () => false,
    statSync: fs.statSync,
  }
  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    platform: 'win32',
    fs: fakeFs,
    execFile: (_cmd, _args, _opts, cb) => cb(Object.assign(new Error('fail'), { code: 1060 }), '', 'FAILED 1060'),
  })
  const status = await getMeshAgentStatus()
  assert.equal(status.status, 'missing')
  assert.equal(status.exePresent, false)
  assert.equal(status.mshPresent, false)
  assert.equal(status.serviceName, 'WXQK')
})

test('ensureMeshAgentRunning starts when files exist but service missing', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-agent-'))
  const root = path.join(tmp, 'meshcentral')
  const installed = path.join(tmp, 'installed')
  fs.mkdirSync(root)
  fs.mkdirSync(installed)
  const exe = path.join(root, 'WXQK.exe')
  const msh = path.join(root, 'WXQK.msh')
  fs.writeFileSync(exe, 'fake')
  fs.writeFileSync(msh, 'MeshName=Test\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\n')
  fs.writeFileSync(path.join(installed, 'WXQK.exe'), 'fake')
  fs.writeFileSync(
    path.join(installed, 'WXQK.msh'),
    'MeshName=Test\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\nagentName=WXQK-client-test-1\n',
  )

  let wxqkRunning = false

  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    installedAgentDir: installed,
    serviceBinaryPath: path.join(installed, 'WXQK.exe'),
    legacyInstalledAgentDir: path.join(tmp, 'no-legacy'),
    platform: 'win32',
    fs,
    execFile: (cmd, args, opts, cb) => {
      if (String(cmd).toLowerCase().includes('powershell')) {
        wxqkRunning = true
        return cb(null, 'ok', '')
      }
      if (String(cmd).toLowerCase().includes('sc') && args[0] === 'query') {
        const name = String(args[1] || '')
        if (name === LEGACY_SERVICE_NAME) {
          return cb(Object.assign(new Error('missing'), { code: 1060 }), '', 'FAILED 1060\nThe specified service does not exist')
        }
        if (!wxqkRunning) {
          return cb(Object.assign(new Error('missing'), { code: 1060 }), '', 'FAILED 1060\nThe specified service does not exist')
        }
        return cb(null, 'STATE              : 4  RUNNING\n', '')
      }
      if (String(cmd).toLowerCase().includes('sc') && args[0] === 'start') {
        assert.equal(args[1], SERVICE_NAME)
        wxqkRunning = true
        return cb(null, 'SERVICE_NAME: WXQK\n', '')
      }
      return cb(null, '', '')
    },
  })

  const first = await getMeshAgentStatus()
  assert.equal(first.status, 'installed_no_service')

  const ensured = await ensureMeshAgentRunning({ clientId: 'client-test-1' })
  assert.equal(ensured.ok, true)
  assert.ok(['start', 'install_start'].includes(ensured.action))
})

test('ensureMeshAgentRunning installs when binaries present but marked missing path empty', async () => {
  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: path.join(os.tmpdir(), 'empty-mesh-' + Date.now()),
    platform: 'win32',
    fs: { existsSync: () => false, statSync: fs.statSync },
    execFile: (_cmd, _args, _opts, cb) => cb(Object.assign(new Error('x'), { code: 1060 }), '', 'FAILED 1060'),
  })
  const ensured = await ensureMeshAgentRunning({ clientId: 'c-missing' })
  assert.equal(ensured.ok, false)
  assert.equal(ensured.action, 'install')
  assert.equal(ensured.code, 'MESH_AGENT_FILES_MISSING')
})

test('ensureMeshAgentRunning is noop when WXQK running with matching agentName', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-agent-'))
  const root = path.join(tmp, 'meshcentral')
  const installed = path.join(tmp, 'installed')
  fs.mkdirSync(root)
  fs.mkdirSync(installed)
  fs.writeFileSync(path.join(root, 'WXQK.exe'), 'fake')
  fs.writeFileSync(path.join(root, 'WXQK.msh'), 'MeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\n')
  fs.writeFileSync(path.join(installed, 'WXQK.exe'), 'fake')
  fs.writeFileSync(path.join(installed, 'WXQK.msh'), 'MeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\nagentName=WXQK-c1\n')

  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    installedAgentDir: installed,
    serviceBinaryPath: path.join(installed, 'WXQK.exe'),
    platform: 'win32',
    fs,
    execFile: (cmd, args, opts, cb) => {
      if (String(cmd).toLowerCase().includes('sc') && args[0] === 'query') {
        return cb(null, 'STATE              : 4  RUNNING\n', '')
      }
      if (String(args[0] || '').includes('version') || String(args[0] || '') === '-version') {
        return cb(null, 'WXQK 1.2.3\n', '')
      }
      return cb(null, '', '')
    },
  })

  const ensured = await ensureMeshAgentRunning({ clientId: 'c1' })
  assert.equal(ensured.ok, true)
  assert.equal(ensured.action, 'noop')
  assert.equal(ensured.status.status, 'running')
})

test('ensureMeshAgentRunning repairs running agent without agentName msh', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-agent-'))
  const root = path.join(tmp, 'meshcentral')
  const installed = path.join(tmp, 'installed')
  fs.mkdirSync(root)
  fs.mkdirSync(installed)
  fs.writeFileSync(path.join(root, 'WXQK.exe'), 'fake')
  fs.writeFileSync(path.join(root, 'WXQK.msh'), 'MeshName=WXQK Devices\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\n')
  fs.writeFileSync(path.join(installed, 'WXQK.exe'), 'fake')
  fs.writeFileSync(path.join(installed, 'WXQK.msh'), 'MeshName=WXQK Devices\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\n')
  let powershellRuns = 0
  let running = true
  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    installedAgentDir: installed,
    serviceBinaryPath: path.join(installed, 'WXQK.exe'),
    platform: 'win32',
    fs,
    execFile: (cmd, args, opts, cb) => {
      const c = String(cmd || '').toLowerCase()
      if (c.includes('sc') && args[0] === 'query') {
        return cb(null, running ? 'STATE              : 4  RUNNING\n' : 'STATE              : 1  STOPPED\n', '')
      }
      if (c.includes('sc') && args[0] === 'stop') {
        running = false
        return cb(null, 'OK\n', '')
      }
      if (c.includes('sc') && args[0] === 'start') {
        running = true
        return cb(null, 'OK\n', '')
      }
      if (c.includes('powershell')) {
        powershellRuns += 1
        fs.writeFileSync(
          path.join(installed, 'WXQK.msh'),
          'MeshName=WXQK Devices\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\nagentName=WXQK-c1\n',
        )
        running = true
        return cb(null, '', '')
      }
      if (String(args[0] || '').includes('version') || String(args[0] || '') === '-version') {
        return cb(null, 'WXQK 1.2.3\n', '')
      }
      return cb(null, '', '')
    },
  })

  const ensured = await ensureMeshAgentRunning({ clientId: 'c1' })
  assert.ok(['repair', 'msh_repair'].includes(ensured.action), `action=${ensured.action}`)
  assert.equal(ensured.ok, true, ensured.message || ensured.code)
  assert.ok(powershellRuns >= 1)
})

test('start/stop use WXQK service controls', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-agent-'))
  const root = path.join(tmp, 'meshcentral')
  const installed = path.join(tmp, 'installed')
  fs.mkdirSync(root)
  fs.mkdirSync(installed)
  fs.writeFileSync(path.join(root, 'WXQK.exe'), 'fake')
  fs.writeFileSync(path.join(root, 'WXQK.msh'), 'x')
  fs.writeFileSync(path.join(installed, 'WXQK.exe'), 'fake')
  fs.writeFileSync(path.join(installed, 'WXQK.msh'), 'x')
  let running = false
  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    installedAgentDir: installed,
    serviceBinaryPath: path.join(installed, 'WXQK.exe'),
    platform: 'win32',
    fs,
    execFile: (cmd, args, opts, cb) => {
      if (args[0] === 'query') {
        assert.equal(args[1], SERVICE_NAME)
        return cb(null, running ? 'STATE : 4 RUNNING\n' : 'STATE : 1 STOPPED\n', '')
      }
      if (args[0] === 'start') {
        assert.equal(args[1], SERVICE_NAME)
        running = true
        return cb(null, 'ok', '')
      }
      if (args[0] === 'stop') {
        assert.equal(args[1], SERVICE_NAME)
        running = false
        return cb(null, 'ok', '')
      }
      return cb(null, '', '')
    },
  })
  const started = await startMeshAgent()
  assert.equal(started.ok, true)
  const stopped = await stopMeshAgent()
  assert.equal(stopped.ok, true)
})

test('installMeshAgent fails clearly when binaries missing', async () => {
  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: path.join(os.tmpdir(), 'no-such-mesh-root-' + Date.now()),
    platform: 'win32',
    fs: { existsSync: () => false, statSync: fs.statSync },
  })
  const result = await installMeshAgent()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'MESH_AGENT_FILES_MISSING')
})

test('installedAgentNeedsRepair when template MeshServer present but installed missing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-repair-'))
  const root = path.join(tmp, 'meshcentral')
  const installed = path.join(tmp, 'installed')
  fs.mkdirSync(root)
  fs.mkdirSync(installed)
  fs.writeFileSync(path.join(root, 'WXQK.exe'), 'fake')
  fs.writeFileSync(
    path.join(root, 'WXQK.msh'),
    'MeshName=WXQK\nMeshID=mesh-id\nServerID=server-id\nMeshServer=wss://mesh.example/agent.ashx\n',
  )
  fs.writeFileSync(path.join(installed, 'WXQK.exe'), 'fake')
  fs.writeFileSync(path.join(installed, 'WXQK.msh'), 'agentName=WXQK-c1\n')
  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    installedAgentDir: installed,
    serviceBinaryPath: path.join(installed, 'WXQK.exe'),
    platform: 'win32',
    fs,
  })
  assert.equal(installedAgentNeedsRepair('c1'), true)
  fs.writeFileSync(
    path.join(installed, 'WXQK.msh'),
    'MeshID=mesh-id\nServerID=server-id\nMeshServer=wss://mesh.example/agent.ashx\nagentName=WRONG\n',
  )
  assert.equal(installedAgentNeedsRepair('c1'), true)
  fs.writeFileSync(
    path.join(installed, 'WXQK.msh'),
    'MeshName=WXQK\nMeshID=mesh-id\nServerID=server-id\nMeshServer=wss://mesh.example/agent.ashx\nagentName=WXQK-c1\n',
  )
  assert.equal(installedAgentNeedsRepair('c1'), false)
})

test('ensureMeshAgentRunning repairs stopped agent with stale msh before start', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-agent-'))
  const root = path.join(tmp, 'meshcentral')
  const installed = path.join(tmp, 'installed')
  fs.mkdirSync(root)
  fs.mkdirSync(installed)
  fs.writeFileSync(path.join(root, 'WXQK.exe'), 'fake')
  fs.writeFileSync(
    path.join(root, 'WXQK.msh'),
    'MeshName=WXQK Devices\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\n',
  )
  fs.writeFileSync(path.join(installed, 'WXQK.exe'), 'fake')
  fs.writeFileSync(path.join(installed, 'WXQK.msh'), 'agentName=OLD\n')
  let powershellRuns = 0
  let running = false
  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    installedAgentDir: installed,
    serviceBinaryPath: path.join(installed, 'WXQK.exe'),
    platform: 'win32',
    fs,
    execFile: (cmd, args, opts, cb) => {
      const c = String(cmd || '').toLowerCase()
      if (c.includes('sc') && args[0] === 'query') {
        return cb(null, running ? 'STATE              : 4  RUNNING\n' : 'STATE              : 1  STOPPED\n', '')
      }
      if (c.includes('sc') && args[0] === 'stop') {
        running = false
        return cb(null, 'OK\n', '')
      }
      if (c.includes('sc') && args[0] === 'start') {
        running = true
        return cb(null, 'OK\n', '')
      }
      if (c.includes('powershell')) {
        powershellRuns += 1
        return cb(null, '', '')
      }
      if (String(args[0] || '').includes('version') || String(args[0] || '') === '-version') {
        return cb(null, 'WXQK 1.2.3\n', '')
      }
      return cb(null, '', '')
    },
  })

  const ensured = await ensureMeshAgentRunning({ clientId: 'c1' })
  assert.equal(ensured.action, 'repair')
  assert.equal(ensured.ok, true)
  assert.ok(powershellRuns >= 1)
})

test('isLegacyAgentOwnedByWxqk recognizes agentName prefix', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-own-'))
  const root = path.join(tmp, 'meshcentral')
  const legacy = path.join(tmp, 'legacy')
  fs.mkdirSync(root)
  fs.mkdirSync(legacy)
  fs.writeFileSync(path.join(root, 'WXQK.exe'), 'fake')
  fs.writeFileSync(path.join(root, 'WXQK.msh'), 'MeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\n')
  fs.writeFileSync(path.join(legacy, 'MeshAgent.exe'), 'fake')
  fs.writeFileSync(
    path.join(legacy, 'MeshAgent.msh'),
    'MeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\nagentName=WXQK-c1\n',
  )
  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    legacyInstalledAgentDir: legacy,
    platform: 'win32',
    fs,
  })
  const owned = isLegacyAgentOwnedByWxqk({ clientId: 'c1' })
  assert.equal(owned.owned, true)
  assert.match(owned.reason, /agentName/)
})

test('isLegacyAgentOwnedByWxqk refuses third-party Mesh Agent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-third-'))
  const root = path.join(tmp, 'meshcentral')
  const legacy = path.join(tmp, 'legacy')
  fs.mkdirSync(root)
  fs.mkdirSync(legacy)
  fs.writeFileSync(path.join(root, 'WXQK.exe'), 'fake')
  fs.writeFileSync(path.join(root, 'WXQK.msh'), 'MeshID=wxqk-mesh\nServerID=wxqk-srv\nMeshServer=wss://wxqk.example/agent.ashx\n')
  fs.writeFileSync(path.join(legacy, 'MeshAgent.exe'), 'fake')
  fs.writeFileSync(
    path.join(legacy, 'MeshAgent.msh'),
    'MeshID=other-mesh\nServerID=other-srv\nMeshServer=wss://other.example/agent.ashx\nagentName=OfficePC\n',
  )
  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    legacyInstalledAgentDir: legacy,
    platform: 'win32',
    fs,
  })
  const owned = isLegacyAgentOwnedByWxqk({ clientId: 'c1' })
  assert.equal(owned.owned, false)
  assert.equal(owned.reason, 'not_wxqk')
})

test('migrateLegacyMeshAgentToWxqk migrates owned legacy service', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-mig-'))
  const root = path.join(tmp, 'meshcentral')
  const legacy = path.join(tmp, 'legacy')
  const branded = path.join(tmp, 'branded')
  fs.mkdirSync(root)
  fs.mkdirSync(legacy)
  fs.mkdirSync(branded)
  fs.writeFileSync(path.join(root, 'WXQK.exe'), 'fake')
  fs.writeFileSync(
    path.join(root, 'WXQK.msh'),
    'MeshName=WXQK\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\n',
  )
  fs.writeFileSync(path.join(legacy, 'MeshAgent.exe'), 'fake')
  fs.writeFileSync(
    path.join(legacy, 'MeshAgent.msh'),
    'MeshName=WXQK\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\nagentName=WXQK-c1\n',
  )

  let wxqkPresent = false
  let wxqkRunning = false
  let legacyPresent = true
  let legacyRunning = true
  let deletedLegacy = false

  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    installedAgentDir: branded,
    serviceBinaryPath: path.join(branded, 'WXQK.exe'),
    legacyInstalledAgentDir: legacy,
    platform: 'win32',
    fs,
    execFile: (cmd, args, opts, cb) => {
      const c = String(cmd || '').toLowerCase()
      const a0 = String(args[0] || '')
      const a1 = String(args[1] || '')
      if (c.includes('powershell')) {
        // elevate install / uninstall / msh sync
        wxqkPresent = true
        wxqkRunning = true
        if (String(args.join(' ')).includes('delete') || String(args.join(' ')).includes('-fulluninstall') || String(args.join(' ')).includes('-uninstall')) {
          deletedLegacy = true
          legacyPresent = false
          legacyRunning = false
        }
        return cb(null, '', '')
      }
      if (c.includes('sc') && a0 === 'query') {
        if (a1 === LEGACY_SERVICE_NAME) {
          if (!legacyPresent) {
            return cb(Object.assign(new Error('missing'), { code: 1060 }), '', 'FAILED 1060')
          }
          return cb(null, legacyRunning ? 'STATE : 4 RUNNING\n' : 'STATE : 1 STOPPED\n', '')
        }
        if (a1 === SERVICE_NAME) {
          if (!wxqkPresent) {
            return cb(Object.assign(new Error('missing'), { code: 1060 }), '', 'FAILED 1060')
          }
          return cb(null, wxqkRunning ? 'STATE : 4 RUNNING\n' : 'STATE : 1 STOPPED\n', '')
        }
      }
      if (c.includes('sc') && a0 === 'stop' && a1 === LEGACY_SERVICE_NAME) {
        legacyRunning = false
        return cb(null, 'ok', '')
      }
      if (c.includes('sc') && a0 === 'start' && a1 === SERVICE_NAME) {
        wxqkPresent = true
        wxqkRunning = true
        return cb(null, 'ok', '')
      }
      if (c.includes('sc') && a0 === 'delete' && a1 === LEGACY_SERVICE_NAME) {
        deletedLegacy = true
        legacyPresent = false
        return cb(null, 'ok', '')
      }
      return cb(null, '', '')
    },
  })

  // After install, pretend branded files exist so status becomes running.
  fs.writeFileSync(path.join(branded, 'WXQK.exe'), 'fake')
  fs.writeFileSync(
    path.join(branded, 'WXQK.msh'),
    'MeshName=WXQK\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\nagentName=WXQK-c1\n',
  )

  const migrated = await migrateLegacyMeshAgentToWxqk({ clientId: 'c1' })
  assert.equal(migrated.ok, true)
  assert.equal(migrated.action, 'migrate')
  assert.equal(deletedLegacy || !legacyPresent, true)
})

test('migrateLegacyMeshAgentToWxqk does not touch third-party agent', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-mig-skip-'))
  const root = path.join(tmp, 'meshcentral')
  const legacy = path.join(tmp, 'legacy')
  fs.mkdirSync(root)
  fs.mkdirSync(legacy)
  fs.writeFileSync(path.join(root, 'WXQK.exe'), 'fake')
  fs.writeFileSync(path.join(root, 'WXQK.msh'), 'MeshID=a\nServerID=b\nMeshServer=wss://a/agent.ashx\n')
  fs.writeFileSync(path.join(legacy, 'MeshAgent.exe'), 'fake')
  fs.writeFileSync(
    path.join(legacy, 'MeshAgent.msh'),
    'MeshID=other\nServerID=other\nMeshServer=wss://other/agent.ashx\n',
  )
  let stopCalled = false
  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    legacyInstalledAgentDir: legacy,
    platform: 'win32',
    fs,
    execFile: (cmd, args, opts, cb) => {
      if (String(cmd).toLowerCase().includes('sc') && args[0] === 'stop') {
        stopCalled = true
      }
      return cb(null, '', '')
    },
  })
  const migrated = await migrateLegacyMeshAgentToWxqk({ clientId: 'c1' })
  assert.equal(migrated.ok, false)
  assert.equal(migrated.code, 'LEGACY_NOT_OWNED')
  assert.equal(stopCalled, false)
})

test('migrateLegacyMeshAgentToWxqk rolls back when install fails', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-mig-fail-'))
  const root = path.join(tmp, 'meshcentral')
  const legacy = path.join(tmp, 'legacy')
  fs.mkdirSync(root)
  fs.mkdirSync(legacy)
  // Packaged files intentionally absent → install fails
  fs.writeFileSync(path.join(legacy, 'MeshAgent.exe'), 'fake')
  fs.writeFileSync(
    path.join(legacy, 'MeshAgent.msh'),
    'MeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\nagentName=WXQK-c1\n',
  )
  // Need template for ownership via agentName only — write template without shipping exe
  fs.writeFileSync(path.join(root, 'WXQK.msh'), 'MeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\n')

  let legacyRestarted = false
  let legacyRunning = true
  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    legacyInstalledAgentDir: legacy,
    platform: 'win32',
    fs,
    execFile: (cmd, args, opts, cb) => {
      const c = String(cmd || '').toLowerCase()
      if (c.includes('sc') && args[0] === 'query' && args[1] === LEGACY_SERVICE_NAME) {
        return cb(null, legacyRunning ? 'STATE : 4 RUNNING\n' : 'STATE : 1 STOPPED\n', '')
      }
      if (c.includes('sc') && args[0] === 'stop' && args[1] === LEGACY_SERVICE_NAME) {
        legacyRunning = false
        return cb(null, 'ok', '')
      }
      if (c.includes('sc') && args[0] === 'start' && args[1] === LEGACY_SERVICE_NAME) {
        legacyRestarted = true
        legacyRunning = true
        return cb(null, 'ok', '')
      }
      if (c.includes('sc') && args[0] === 'query' && args[1] === SERVICE_NAME) {
        return cb(Object.assign(new Error('missing'), { code: 1060 }), '', 'FAILED 1060')
      }
      return cb(null, '', '')
    },
  })

  const migrated = await migrateLegacyMeshAgentToWxqk({ clientId: 'c1' })
  assert.equal(migrated.ok, false)
  assert.equal(migrated.action, 'migrate_rollback')
  assert.equal(legacyRestarted, true)
})

test('ensureMeshAgentRunning migrates owned legacy Mesh Agent', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-ensure-mig-'))
  const root = path.join(tmp, 'meshcentral')
  const legacy = path.join(tmp, 'legacy')
  const branded = path.join(tmp, 'branded')
  fs.mkdirSync(root)
  fs.mkdirSync(legacy)
  fs.mkdirSync(branded)
  fs.writeFileSync(path.join(root, 'WXQK.exe'), 'fake')
  fs.writeFileSync(
    path.join(root, 'WXQK.msh'),
    'MeshName=WXQK\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\n',
  )
  fs.writeFileSync(path.join(legacy, 'MeshAgent.exe'), 'fake')
  fs.writeFileSync(
    path.join(legacy, 'MeshAgent.msh'),
    'MeshName=WXQK\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\nagentName=WXQK-c1\n',
  )
  fs.writeFileSync(path.join(branded, 'WXQK.exe'), 'fake')
  fs.writeFileSync(
    path.join(branded, 'WXQK.msh'),
    'MeshName=WXQK\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\nagentName=WXQK-c1\n',
  )

  let wxqkPresent = false
  let wxqkRunning = false
  let legacyPresent = true

  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    installedAgentDir: branded,
    serviceBinaryPath: path.join(branded, 'WXQK.exe'),
    legacyInstalledAgentDir: legacy,
    platform: 'win32',
    fs,
    execFile: (cmd, args, opts, cb) => {
      const c = String(cmd || '').toLowerCase()
      const a0 = String(args[0] || '')
      const a1 = String(args[1] || '')
      if (c.includes('powershell')) {
        wxqkPresent = true
        wxqkRunning = true
        legacyPresent = false
        return cb(null, '', '')
      }
      if (c.includes('sc') && a0 === 'query') {
        if (a1 === LEGACY_SERVICE_NAME) {
          if (!legacyPresent) return cb(Object.assign(new Error('missing'), { code: 1060 }), '', 'FAILED 1060')
          return cb(null, 'STATE : 4 RUNNING\n', '')
        }
        if (a1 === SERVICE_NAME) {
          if (!wxqkPresent) return cb(Object.assign(new Error('missing'), { code: 1060 }), '', 'FAILED 1060')
          return cb(null, wxqkRunning ? 'STATE : 4 RUNNING\n' : 'STATE : 1 STOPPED\n', '')
        }
      }
      if (c.includes('sc') && a0 === 'stop' && a1 === LEGACY_SERVICE_NAME) {
        return cb(null, 'ok', '')
      }
      if (c.includes('sc') && a0 === 'start' && a1 === SERVICE_NAME) {
        wxqkPresent = true
        wxqkRunning = true
        return cb(null, 'ok', '')
      }
      return cb(null, '', '')
    },
  })

  const ensured = await ensureMeshAgentRunning({ clientId: 'c1' })
  assert.equal(ensured.ok, true)
  assert.equal(ensured.action, 'migrate')
})

test('ensureMeshAgentRunning leaves third-party Mesh Agent alone and installs WXQK', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-ensure-third-'))
  const root = path.join(tmp, 'meshcentral')
  const legacy = path.join(tmp, 'legacy')
  const branded = path.join(tmp, 'branded')
  fs.mkdirSync(root)
  fs.mkdirSync(legacy)
  fs.mkdirSync(branded)
  fs.writeFileSync(path.join(root, 'WXQK.exe'), 'fake')
  fs.writeFileSync(
    path.join(root, 'WXQK.msh'),
    'MeshName=WXQK\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\n',
  )
  fs.writeFileSync(path.join(legacy, 'MeshAgent.exe'), 'fake')
  fs.writeFileSync(
    path.join(legacy, 'MeshAgent.msh'),
    'MeshID=other\nServerID=other\nMeshServer=wss://other/agent.ashx\n',
  )

  let legacyDeleted = false
  let wxqkPresent = false
  let wxqkRunning = false

  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    installedAgentDir: branded,
    serviceBinaryPath: path.join(branded, 'WXQK.exe'),
    legacyInstalledAgentDir: legacy,
    platform: 'win32',
    fs,
    execFile: (cmd, args, opts, cb) => {
      const c = String(cmd || '').toLowerCase()
      const a0 = String(args[0] || '')
      const a1 = String(args[1] || '')
      if (c.includes('powershell')) {
        wxqkPresent = true
        wxqkRunning = true
        fs.writeFileSync(path.join(branded, 'WXQK.exe'), 'fake')
        fs.writeFileSync(
          path.join(branded, 'WXQK.msh'),
          'MeshName=WXQK\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\nagentName=WXQK-c1\n',
        )
        return cb(null, '', '')
      }
      if (c.includes('sc') && a0 === 'query') {
        if (a1 === LEGACY_SERVICE_NAME) {
          return cb(null, 'STATE : 4 RUNNING\n', '')
        }
        if (a1 === SERVICE_NAME) {
          if (!wxqkPresent) return cb(Object.assign(new Error('missing'), { code: 1060 }), '', 'FAILED 1060')
          return cb(null, wxqkRunning ? 'STATE : 4 RUNNING\n' : 'STATE : 1 STOPPED\n', '')
        }
      }
      if (c.includes('sc') && a0 === 'delete' && a1 === LEGACY_SERVICE_NAME) {
        legacyDeleted = true
        return cb(null, 'ok', '')
      }
      if (c.includes('sc') && a0 === 'start' && a1 === SERVICE_NAME) {
        wxqkPresent = true
        wxqkRunning = true
        return cb(null, 'ok', '')
      }
      return cb(null, '', '')
    },
  })

  const ensured = await ensureMeshAgentRunning({ clientId: 'c1' })
  assert.equal(ensured.ok, true)
  assert.ok(['install_start', 'start', 'repair'].includes(ensured.action))
  assert.equal(legacyDeleted, false)
})

test('parseScBinaryPath strips quotes', () => {
  assert.equal(
    parseScBinaryPath('BINARY_PATH_NAME   : "C:\\Program Files\\WXQK\\WXQK.exe"'),
    'C:\\Program Files\\WXQK\\WXQK.exe',
  )
  assert.equal(isBrandedImagePath('C:\\Program Files\\WXQK\\WXQK.exe'), true)
  assert.equal(isBrandedImagePath('C:\\Program Files\\Mesh Agent\\MeshAgent.exe'), false)
})

test('getMeshAgentStatus reports stale_service when SCM exists but install dir gone', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-stale-'))
  const root = path.join(tmp, 'meshcentral')
  const installed = path.join(tmp, 'installed')
  fs.mkdirSync(root)
  fs.mkdirSync(installed)
  fs.writeFileSync(path.join(root, 'WXQK.exe'), 'fake')
  fs.writeFileSync(path.join(root, 'WXQK.msh'), 'MeshName=WXQK\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\n')
  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    installedAgentDir: installed,
    serviceBinaryPath: path.join(installed, 'WXQK.exe'),
    platform: 'win32',
    fs,
    execFile: (cmd, args, opts, cb) => {
      if (String(cmd).toLowerCase().includes('sc') && args[0] === 'query' && args[1] === SERVICE_NAME) {
        return cb(null, 'STATE              : 1  STOPPED\n', '')
      }
      return cb(Object.assign(new Error('missing'), { code: 1060 }), '', 'FAILED 1060')
    },
  })
  const status = await getMeshAgentStatus()
  assert.equal(status.status, 'stale_service')
  assert.equal(status.servicePresent, true)
  assert.equal(status.installedExePresent, false)
  assert.equal(isBrandedInstallHealthy(status), false)
})

test('installMeshAgent fails when command fails even if orphan servicePresent', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-install-fail-'))
  const root = path.join(tmp, 'meshcentral')
  const installed = path.join(tmp, 'installed')
  fs.mkdirSync(root)
  fs.mkdirSync(installed)
  fs.writeFileSync(path.join(root, 'WXQK.exe'), 'fake')
  fs.writeFileSync(path.join(root, 'WXQK.msh'), 'MeshName=WXQK\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\n')
  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    installedAgentDir: installed,
    serviceBinaryPath: path.join(installed, 'WXQK.exe'),
    platform: 'win32',
    fs,
    execFile: (cmd, args, opts, cb) => {
      const c = String(cmd || '').toLowerCase()
      if (c.includes('powershell')) {
        return cb(Object.assign(new Error('elevate failed'), { code: 1 }), '', 'install failed')
      }
      if (c.includes('sc') && args[0] === 'query' && args[1] === SERVICE_NAME) {
        return cb(null, 'STATE              : 1  STOPPED\n', '')
      }
      return cb(null, '', '')
    },
  })
  const result = await installMeshAgent({ clientId: 'c1' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'MESH_INSTALL_FAILED')
})

test('ensureMeshAgentRunning repairs stale_service by reinstalling branded files', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-repair-stale-'))
  const root = path.join(tmp, 'meshcentral')
  const installed = path.join(tmp, 'installed')
  fs.mkdirSync(root)
  fs.mkdirSync(installed)
  fs.writeFileSync(path.join(root, 'WXQK.exe'), 'fake')
  fs.writeFileSync(
    path.join(root, 'WXQK.msh'),
    'MeshName=WXQK\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\n',
  )

  let wxqkPresent = true
  let wxqkRunning = false
  let deleted = false

  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    installedAgentDir: installed,
    serviceBinaryPath: path.join(installed, 'WXQK.exe'),
    platform: 'win32',
    fs,
    execFile: (cmd, args, opts, cb) => {
      const c = String(cmd || '').toLowerCase()
      const a0 = String(args[0] || '')
      const a1 = String(args[1] || '')
      const joined = args.map(String).join(' ')
      if (c.includes('powershell')) {
        if (joined.includes("'delete'") || joined.includes(' sc.exe ') && joined.includes('delete')) {
          deleted = true
          wxqkPresent = false
          wxqkRunning = false
          return cb(null, '', '')
        }
        fs.writeFileSync(path.join(installed, 'WXQK.exe'), 'fake')
        fs.writeFileSync(
          path.join(installed, 'WXQK.msh'),
          'MeshName=WXQK\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\nagentName=WXQK-c1\n',
        )
        wxqkPresent = true
        wxqkRunning = true
        return cb(null, 'Running', '')
      }
      if (c.includes('sc') && a0 === 'query') {
        if (a1 === LEGACY_SERVICE_NAME) {
          return cb(Object.assign(new Error('missing'), { code: 1060 }), '', 'FAILED 1060')
        }
        if (!wxqkPresent) return cb(Object.assign(new Error('missing'), { code: 1060 }), '', 'FAILED 1060')
        return cb(null, wxqkRunning ? 'STATE : 4 RUNNING\n' : 'STATE : 1 STOPPED\n', '')
      }
      if (c.includes('sc') && a0 === 'delete' && a1 === SERVICE_NAME) {
        deleted = true
        wxqkPresent = false
        return cb(null, 'ok', '')
      }
      if (c.includes('sc') && a0 === 'stop') {
        wxqkRunning = false
        return cb(null, 'ok', '')
      }
      if (c.includes('sc') && a0 === 'start' && a1 === SERVICE_NAME) {
        wxqkPresent = true
        wxqkRunning = true
        return cb(null, 'ok', '')
      }
      if (c.includes('sc') && a0 === 'config') return cb(null, 'ok', '')
      return cb(null, '', '')
    },
  })

  const before = await getMeshAgentStatus()
  assert.equal(before.status, 'stale_service')

  const ensured = await ensureMeshAgentRunning({ clientId: 'c1' })
  assert.equal(ensured.action, 'repair_stale')
  assert.equal(ensured.ok, true)
  assert.equal(ensured.status.status, 'running')
  assert.equal(fs.existsSync(path.join(installed, 'WXQK.exe')), true)
  assert.equal(fs.existsSync(path.join(installed, 'WXQK.msh')), true)
  assert.equal(deleted, true)
})

test('ensureMeshAgentRunning fails clearly when UAC denied during stale repair', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-uac-'))
  const root = path.join(tmp, 'meshcentral')
  const installed = path.join(tmp, 'installed')
  fs.mkdirSync(root)
  fs.mkdirSync(installed)
  fs.writeFileSync(path.join(root, 'WXQK.exe'), 'fake')
  fs.writeFileSync(path.join(root, 'WXQK.msh'), 'MeshName=WXQK\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\n')
  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    installedAgentDir: installed,
    serviceBinaryPath: path.join(installed, 'WXQK.exe'),
    platform: 'win32',
    fs,
    execFile: (cmd, args, opts, cb) => {
      const c = String(cmd || '').toLowerCase()
      if (c.includes('powershell')) {
        return cb(Object.assign(new Error('canceled'), { code: 1223 }), '', 'canceled by the user 1223')
      }
      if (c.includes('sc') && args[0] === 'query' && args[1] === SERVICE_NAME) {
        return cb(null, 'STATE : 1 STOPPED\n', '')
      }
      return cb(null, '', '')
    },
  })
  const ensured = await ensureMeshAgentRunning({ clientId: 'c1' })
  assert.equal(ensured.ok, false)
  assert.equal(ensured.action, 'repair_stale')
  assert.equal(ensured.code, 'MESH_ELEVATION_REQUIRED')
})

test('getMeshAgentStatus reports outdated_agent when packaged SHA differs', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-outdated-'))
  const root = path.join(tmp, 'meshcentral')
  const installed = path.join(tmp, 'installed')
  fs.mkdirSync(root)
  fs.mkdirSync(installed)
  fs.writeFileSync(path.join(root, 'WXQK.exe'), 'NEW-AGENT-BYTES-V2')
  fs.writeFileSync(path.join(root, 'WXQK.msh'), 'MeshName=WXQK\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\n')
  fs.writeFileSync(path.join(installed, 'WXQK.exe'), 'OLD-AGENT-BYTES-V1')
  fs.writeFileSync(path.join(installed, 'WXQK.msh'), 'MeshName=WXQK\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\nagentName=WXQK-c1\n')
  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    installedAgentDir: installed,
    serviceBinaryPath: path.join(installed, 'WXQK.exe'),
    platform: 'win32',
    fs,
    execFile: (cmd, args, opts, cb) => {
      if (String(cmd).toLowerCase().includes('sc') && args[0] === 'query') {
        return cb(null, 'STATE              : 4  RUNNING\n', '')
      }
      return cb(null, '', '')
    },
  })
  const status = await getMeshAgentStatus()
  assert.equal(status.status, 'outdated_agent')
  assert.equal(status.outdatedAgent, true)
  assert.ok(status.packagedSha256)
  assert.ok(status.installedSha256)
  assert.notEqual(status.packagedSha256, status.installedSha256)
})

test('ensureMeshAgentRunning upgrades outdated_agent and preserves agentName', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-upgrade-'))
  const root = path.join(tmp, 'meshcentral')
  const installed = path.join(tmp, 'installed')
  fs.mkdirSync(root)
  fs.mkdirSync(installed)
  fs.writeFileSync(path.join(root, 'WXQK.exe'), 'NEW-AGENT-BYTES-V2')
  fs.writeFileSync(path.join(root, 'WXQK.msh'), 'MeshName=WXQK\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\n')
  fs.writeFileSync(path.join(installed, 'WXQK.exe'), 'OLD-AGENT-BYTES-V1')
  fs.writeFileSync(path.join(installed, 'WXQK.msh'), 'MeshName=WXQK\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\nagentName=WXQK-c1\n')
  let running = true
  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    installedAgentDir: installed,
    serviceBinaryPath: path.join(installed, 'WXQK.exe'),
    platform: 'win32',
    fs,
    execFile: (cmd, args, opts, cb) => {
      const c = String(cmd || '').toLowerCase()
      const a0 = String(args?.[0] || '')
      if (c.includes('sc') && a0 === 'query') {
        return cb(null, running ? 'STATE : 4 RUNNING\n' : 'STATE : 1 STOPPED\n', '')
      }
      if (c.includes('sc') && a0 === 'stop') {
        running = false
        return cb(null, 'ok', '')
      }
      if (c.includes('sc') && a0 === 'start') {
        running = true
        return cb(null, 'ok', '')
      }
      if (c.includes('sc') && (a0 === 'config' || a0 === 'failure' || a0 === 'failureflag')) {
        return cb(null, 'ok', '')
      }
      if (c.includes('powershell')) {
        // Simulate install: copy packaged exe over installed
        try {
          fs.copyFileSync(path.join(root, 'WXQK.exe'), path.join(installed, 'WXQK.exe'))
          const msh = fs.readFileSync(path.join(root, 'WXQK.msh'), 'utf8')
          fs.writeFileSync(path.join(installed, 'WXQK.msh'), `${msh}agentName=WXQK-c1\n`)
        } catch { /* ignore */ }
        running = true
        return cb(null, 'ok', '')
      }
      return cb(null, '', '')
    },
  })
  const before = await getMeshAgentStatus()
  assert.equal(before.status, 'outdated_agent')
  const ensured = await ensureMeshAgentRunning({ clientId: 'c1' })
  assert.equal(ensured.action, 'upgrade')
  assert.equal(ensured.ok, true)
  assert.equal(ensured.status.status, 'running')
  assert.equal(ensured.status.outdatedAgent, false)
  assert.equal(ensured.status.packagedSha256, ensured.status.installedSha256)
  const msh = fs.readFileSync(path.join(installed, 'WXQK.msh'), 'utf8')
  assert.match(msh, /agentName=WXQK-c1/)
  assert.match(msh, /MeshID=x/)
  assert.match(msh, /ServerID=y/)
})

test('getMeshAgentStatus reports service_config_broken when StartMode Disabled', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-disabled-'))
  const root = path.join(tmp, 'meshcentral')
  const installed = path.join(tmp, 'installed')
  fs.mkdirSync(root)
  fs.mkdirSync(installed)
  fs.writeFileSync(path.join(root, 'WXQK.exe'), 'fake')
  fs.writeFileSync(path.join(root, 'WXQK.msh'), 'MeshName=WXQK\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\n')
  fs.writeFileSync(path.join(installed, 'WXQK.exe'), 'fake')
  fs.writeFileSync(path.join(installed, 'WXQK.msh'), 'MeshName=WXQK\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\nagentName=WXQK-c1\n')
  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    installedAgentDir: installed,
    serviceBinaryPath: path.join(installed, 'WXQK.exe'),
    serviceStartMode: 'Disabled',
    platform: 'win32',
    fs,
    execFile: (cmd, args, opts, cb) => {
      if (String(cmd).toLowerCase().includes('sc') && args[0] === 'query') {
        return cb(null, 'STATE : 1 STOPPED\n', '')
      }
      return cb(null, '', '')
    },
  })
  const status = await getMeshAgentStatus()
  assert.equal(status.status, 'service_config_broken')
})

test('wrong ImagePath MeshAgent.exe is treated as stale_service', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-bad-image-'))
  const root = path.join(tmp, 'meshcentral')
  const installed = path.join(tmp, 'installed')
  fs.mkdirSync(root)
  fs.mkdirSync(installed)
  fs.writeFileSync(path.join(root, 'WXQK.exe'), 'fake')
  fs.writeFileSync(path.join(root, 'WXQK.msh'), 'MeshName=WXQK\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\n')
  fs.writeFileSync(path.join(installed, 'WXQK.exe'), 'fake')
  fs.writeFileSync(path.join(installed, 'WXQK.msh'), 'x')
  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    installedAgentDir: installed,
    serviceBinaryPath: 'C:\\Program Files\\Mesh Agent\\MeshAgent.exe',
    platform: 'win32',
    fs,
    execFile: (cmd, args, opts, cb) => {
      if (String(cmd).toLowerCase().includes('sc') && args[0] === 'query') {
        return cb(null, 'STATE : 1 STOPPED\n', '')
      }
      return cb(null, '', '')
    },
  })
  const status = await getMeshAgentStatus()
  assert.equal(status.status, 'stale_service')
  assert.equal(status.imagePathOk, false)
})
