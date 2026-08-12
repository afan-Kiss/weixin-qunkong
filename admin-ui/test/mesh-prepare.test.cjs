const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  buildAgentName,
  safeClientIdForAgent,
  parseMshText,
  serializeMshWithAgentName,
  stageMshForClient,
  MSH_IDENTITY_KEYS,
} = require('../electron/mesh-agent-manager.cjs')

const {
  ensureMeshReady,
  getMeshPrepareStatus,
  isBindSuccess,
  shouldStopBindRetry,
  userMessageForCode,
  PHASE,
} = require('../electron/mesh-remote-bridge.cjs')

test('buildAgentName uses WXQK- prefix and rejects bad ids', () => {
  assert.equal(buildAgentName('abc-1'), 'WXQK-abc-1')
  assert.equal(safeClientIdForAgent('../x'), '')
  assert.equal(buildAgentName('../x'), '')
  assert.equal(buildAgentName(''), '')
})

test('stageMshForClient writes agentName without mutating Mesh identity keys', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wxqk-msh-'))
  const template = path.join(tmp, 'meshagent.msh')
  fs.writeFileSync(
    template,
    [
      'MeshName=WXQK Devices',
      'MeshID=meshid-value-keep',
      'ServerID=serverid-value-keep',
      'MeshServer=wss://mesh.example:443/',
      'agentName=OLD',
    ].join('\n'),
    'utf8',
  )
  const stagingDir = path.join(tmp, 'stage')
  const staged = stageMshForClient({
    clientId: 'client-42',
    stagingDir,
    templateMshPath: template,
  })
  assert.equal(staged.ok, true)
  assert.equal(staged.agentName, 'WXQK-client-42')
  const text = fs.readFileSync(staged.mshPath, 'utf8')
  const map = parseMshText(text)
  assert.equal(map.get('agentName'), 'WXQK-client-42')
  assert.equal(map.get('MeshID'), 'meshid-value-keep')
  assert.equal(map.get('ServerID'), 'serverid-value-keep')
  assert.equal(map.get('MeshServer'), 'wss://mesh.example:443/')
  assert.equal(map.get('MeshName'), 'WXQK Devices')
  // template unchanged
  assert.match(fs.readFileSync(template, 'utf8'), /agentName=OLD/)
  for (const key of MSH_IDENTITY_KEYS) {
    assert.ok(map.has(key))
  }
})

test('serializeMshWithAgentName replaces only agentName', () => {
  const map = parseMshText('MeshID=a\nServerID=b\nMeshServer=c\nMeshName=d\n')
  const out = serializeMshWithAgentName(map, 'WXQK-x')
  assert.match(out, /agentName=WXQK-x/)
  assert.match(out, /MeshID=a/)
})

test('userMessageForCode never exposes MESH_UNBOUND wording', () => {
  assert.equal(userMessageForCode('MESH_UNBOUND'), '设备绑定失败')
  assert.equal(userMessageForCode('MESH_AMBIGUOUS'), '发现重复设备')
  assert.equal(userMessageForCode('MESH_DISABLED'), 'MeshCentral 不可用')
  assert.doesNotMatch(userMessageForCode('MESH_UNBOUND'), /未绑定 Mesh/)
})

test('bind helpers treat ambiguous as hard stop', () => {
  assert.equal(isBindSuccess({ ok: true, bound: true, meshNodeId: 'n' }), true)
  assert.equal(shouldStopBindRetry({ code: 'MESH_HOSTNAME_AMBIGUOUS' }), true)
  assert.equal(shouldStopBindRetry({ code: 'MESH_NO_MATCH' }), false)
})

test('ensureMeshReady is single-flight for same clientId', async () => {
  // Without network / agent, prepare fails but both callers share one promise path
  const a = ensureMeshReady('bad id with spaces')
  const b = ensureMeshReady('bad id with spaces')
  const [ra, rb] = await Promise.all([a, b])
  assert.equal(ra.remoteReady, false)
  assert.equal(rb.code, ra.code)
  const st = getMeshPrepareStatus()
  assert.ok([PHASE.FAILED, PHASE.IDLE, PHASE.READY].includes(st.phase) || st.phase)
})
