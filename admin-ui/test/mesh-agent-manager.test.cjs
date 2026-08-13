'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const os = require('os')
const fs = require('fs')

const {
  resolveMeshAgentPaths,
  getMeshAgentStatus,
  ensureMeshAgentRunning,
  installMeshAgent,
  startMeshAgent,
  stopMeshAgent,
  redact,
  setMeshAgentDepsForTest,
  resetMeshAgentDepsForTest,
} = require('../electron/mesh-agent-manager.cjs')

test.afterEach(() => {
  resetMeshAgentDepsForTest()
})

test('redact strips login tokens and long hex', () => {
  const raw = 'open https://mesh.example/?login=abc123&node=n1 hex=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  const out = redact(raw)
  assert.match(out, /login=\*\*\*/)
  assert.doesNotMatch(out, /login=abc123/)
  assert.match(out, /\*\*\*hex\*\*\*/)
})

test('resolveMeshAgentPaths uses resources/meshcentral in unpackaged mode', () => {
  setMeshAgentDepsForTest({
    isPackaged: false,
    resourcesPath: 'C:\\packed\\resources',
    platform: 'win32',
  })
  const paths = resolveMeshAgentPaths()
  assert.equal(paths.packaged, false)
  assert.equal(path.basename(paths.root), 'meshcentral')
  assert.equal(path.basename(paths.exePath), 'meshagent.exe')
  assert.equal(path.basename(paths.mshPath), 'meshagent.msh')
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
})

test('getMeshAgentStatus reports missing when files absent', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-agent-'))
  const fakeFs = {
    existsSync: (p) => false,
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
})

test('ensureMeshAgentRunning starts when files exist but service missing', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-agent-'))
  const root = path.join(tmp, 'meshcentral')
  const installed = path.join(tmp, 'installed')
  fs.mkdirSync(root)
  fs.mkdirSync(installed)
  const exe = path.join(root, 'meshagent.exe')
  const msh = path.join(root, 'meshagent.msh')
  fs.writeFileSync(exe, 'fake')
  fs.writeFileSync(msh, 'MeshName=Test\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\n')
  fs.writeFileSync(path.join(installed, 'MeshAgent.exe'), 'fake')
  fs.writeFileSync(
    path.join(installed, 'MeshAgent.msh'),
    'MeshName=Test\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\nagentName=WXQK-client-test-1\n',
  )

  let serviceRunning = false

  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    installedAgentDir: installed,
    platform: 'win32',
    fs,
    execFile: (cmd, args, opts, cb) => {
      if (String(cmd).toLowerCase().includes('powershell')) {
        serviceRunning = true
        return cb(null, 'ok', '')
      }
      if (String(cmd).toLowerCase().includes('sc') && args[0] === 'query') {
        if (!serviceRunning) {
          return cb(Object.assign(new Error('missing'), { code: 1060 }), '', 'FAILED 1060\nThe specified service does not exist')
        }
        return cb(null, 'STATE              : 4  RUNNING\n', '')
      }
      if (String(cmd).toLowerCase().includes('sc') && args[0] === 'start') {
        serviceRunning = true
        return cb(null, 'SERVICE_NAME: Mesh Agent\n', '')
      }
      return cb(null, '', '')
    },
  })

  const first = await getMeshAgentStatus()
  assert.equal(first.status, 'installed_no_service')

  const ensured = await ensureMeshAgentRunning({ clientId: 'client-test-1' })
  assert.equal(ensured.ok, true)
  assert.equal(ensured.action, 'start')
})

test('ensureMeshAgentRunning installs when binaries present but marked missing path empty', async () => {
  // Force "missing" by reporting no exe/msh even if install would need files — install fails clearly.
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

test('ensureMeshAgentRunning is noop when running with matching agentName', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-agent-'))
  const root = path.join(tmp, 'meshcentral')
  const installed = path.join(tmp, 'installed')
  fs.mkdirSync(root)
  fs.mkdirSync(installed)
  fs.writeFileSync(path.join(root, 'meshagent.exe'), 'fake')
  fs.writeFileSync(path.join(root, 'meshagent.msh'), 'MeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\n')
  fs.writeFileSync(path.join(installed, 'MeshAgent.exe'), 'fake')
  fs.writeFileSync(path.join(installed, 'meshagent.msh'), 'MeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\nagentName=WXQK-c1\n')

  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    installedAgentDir: installed,
    platform: 'win32',
    fs,
    execFile: (cmd, args, opts, cb) => {
      if (String(cmd).toLowerCase().includes('sc') && args[0] === 'query') {
        return cb(null, 'STATE              : 4  RUNNING\n', '')
      }
      if (String(args[0] || '').includes('version') || String(args[0] || '') === '-version') {
        return cb(null, 'MeshAgent 1.2.3\n', '')
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
  fs.writeFileSync(path.join(root, 'meshagent.exe'), 'fake')
  fs.writeFileSync(path.join(root, 'meshagent.msh'), 'MeshName=WXQK Devices\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\n')
  fs.writeFileSync(path.join(installed, 'MeshAgent.exe'), 'fake')
  // no meshagent.msh in installed dir → needs repair
  let powershellRuns = 0
  let running = true
  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    installedAgentDir: installed,
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
        return cb(null, 'MeshAgent 1.2.3\n', '')
      }
      return cb(null, '', '')
    },
  })

  const ensured = await ensureMeshAgentRunning({ clientId: 'c1' })
  assert.equal(ensured.action, 'repair')
  assert.equal(ensured.ok, true)
  assert.ok(powershellRuns >= 1)
})

test('start/stop use service controls without inventing RDP', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-agent-'))
  const root = path.join(tmp, 'meshcentral')
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, 'meshagent.exe'), 'fake')
  fs.writeFileSync(path.join(root, 'meshagent.msh'), 'x')
  let running = false
  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    platform: 'win32',
    fs,
    execFile: (cmd, args, opts, cb) => {
      if (args[0] === 'query') {
        return cb(null, running ? 'STATE : 4 RUNNING\n' : 'STATE : 1 STOPPED\n', '')
      }
      if (args[0] === 'start') {
        running = true
        return cb(null, 'ok', '')
      }
      if (args[0] === 'stop') {
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
  const {
    installedAgentNeedsRepair,
    setMeshAgentDepsForTest,
    resetMeshAgentDepsForTest,
  } = require('../electron/mesh-agent-manager.cjs')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-repair-'))
  const root = path.join(tmp, 'meshcentral')
  const installed = path.join(tmp, 'installed')
  fs.mkdirSync(root)
  fs.mkdirSync(installed)
  fs.writeFileSync(path.join(root, 'meshagent.exe'), 'fake')
  fs.writeFileSync(
    path.join(root, 'meshagent.msh'),
    'MeshName=WXQK\nMeshID=mesh-id\nServerID=server-id\nMeshServer=wss://mesh.example/agent.ashx\n',
  )
  fs.writeFileSync(path.join(installed, 'MeshAgent.exe'), 'fake')
  // Missing MeshServer / ServerID / MeshID entirely
  fs.writeFileSync(path.join(installed, 'MeshAgent.msh'), 'agentName=WXQK-c1\n')
  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    installedAgentDir: installed,
    platform: 'win32',
    fs,
  })
  assert.equal(installedAgentNeedsRepair('c1'), true)
  // Wrong agentName
  fs.writeFileSync(
    path.join(installed, 'MeshAgent.msh'),
    'MeshID=mesh-id\nServerID=server-id\nMeshServer=wss://mesh.example/agent.ashx\nagentName=WRONG\n',
  )
  assert.equal(installedAgentNeedsRepair('c1'), true)
  // Matching
  fs.writeFileSync(
    path.join(installed, 'MeshAgent.msh'),
    'MeshID=mesh-id\nServerID=server-id\nMeshServer=wss://mesh.example/agent.ashx\nagentName=WXQK-c1\n',
  )
  assert.equal(installedAgentNeedsRepair('c1'), false)
  resetMeshAgentDepsForTest()
})

test('ensureMeshAgentRunning repairs stopped agent with stale msh before start', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-agent-'))
  const root = path.join(tmp, 'meshcentral')
  const installed = path.join(tmp, 'installed')
  fs.mkdirSync(root)
  fs.mkdirSync(installed)
  fs.writeFileSync(path.join(root, 'meshagent.exe'), 'fake')
  fs.writeFileSync(
    path.join(root, 'meshagent.msh'),
    'MeshName=WXQK Devices\nMeshID=x\nServerID=y\nMeshServer=wss://x/agent.ashx\n',
  )
  fs.writeFileSync(path.join(installed, 'MeshAgent.exe'), 'fake')
  fs.writeFileSync(path.join(installed, 'MeshAgent.msh'), 'agentName=OLD\n')
  let powershellRuns = 0
  let running = false
  setMeshAgentDepsForTest({
    isPackaged: true,
    resourcesPath: tmp,
    installedAgentDir: installed,
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
        return cb(null, 'MeshAgent 1.2.3\n', '')
      }
      return cb(null, '', '')
    },
  })

  const ensured = await ensureMeshAgentRunning({ clientId: 'c1' })
  assert.equal(ensured.action, 'repair')
  assert.equal(ensured.ok, true)
  assert.ok(powershellRuns >= 1)
})
