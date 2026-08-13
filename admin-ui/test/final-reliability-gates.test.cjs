'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const {
  migrateLegacyBusinessDataIfNeeded,
  inspectSqliteDb,
  BUSINESS_MIGRATION_MARKER,
} = require('../electron/wxqk-business-migration.cjs')
const paths = require('../electron/wxqk-data-paths.cjs')
const machine = require('../electron/machine-identity.cjs')
const serviceHealth = require('../electron/mesh-service-health.cjs')
const artifact = require('../electron/mesh-agent-artifact.cjs')
const { generateKeyPairSync, createHash } = require('node:crypto')

function makeDb(dbPath, seed = {}) {
  mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wechat_instances (id TEXT PRIMARY KEY, api_port INTEGER NOT NULL, tcp_port INTEGER NOT NULL, pid INTEGER, account_wxid TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS contacts (wxid TEXT NOT NULL, source_instance_id TEXT NOT NULL, nickname TEXT, remark TEXT, alias TEXT, avatar TEXT, is_group INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(wxid,source_instance_id));
    CREATE TABLE IF NOT EXISTS chatrooms (room_id TEXT NOT NULL, source_instance_id TEXT NOT NULL, name TEXT, member_count INTEGER, owner_wxid TEXT, saved INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(room_id,source_instance_id));
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, config_json TEXT NOT NULL, total INTEGER NOT NULL DEFAULT 0, success INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS qr_items (id TEXT PRIMARY KEY, sha256 TEXT UNIQUE, source TEXT, local_path TEXT, decoded_text TEXT, qr_type TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, level TEXT NOT NULL, instance_id TEXT, module TEXT, message TEXT NOT NULL, details_json TEXT);
  `)
  if (seed.settings) {
    db.prepare('INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)')
      .run('general', JSON.stringify(seed.settings), new Date().toISOString())
  }
  if (seed.instance) {
    db.prepare('INSERT INTO wechat_instances(id,api_port,tcp_port,status,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run('inst-1', 19001, 19002, 'online', new Date().toISOString(), new Date().toISOString())
  }
  if (seed.task) {
    db.prepare('INSERT INTO tasks(id,name,type,status,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('task-1', 't', 'friend', 'done', '{}', new Date().toISOString(), new Date().toISOString())
  }
  if (seed.qr) {
    db.prepare('INSERT INTO qr_items(id,sha256,status,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run('qr-1', 'abc', 'pending', new Date().toISOString(), new Date().toISOString())
  }
  db.close()
}

test('business DB migrates before marker and preserves row counts', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'biz-mig-'))
  const stable = path.join(root, 'stable')
  const legacy = path.join(root, 'legacy')
  makeDb(path.join(legacy, 'data', 'wechat-control.sqlite'), {
    settings: { theme: 'dark' },
    instance: true,
    task: true,
    qr: true,
  })
  const result = migrateLegacyBusinessDataIfNeeded({
    stableUserDataDir: stable,
    legacyPortableUserDataDir: legacy,
  })
  assert.equal(result.migrated, true)
  assert.ok(existsSync(path.join(stable, 'data', 'wechat-control.sqlite')))
  assert.ok(existsSync(path.join(stable, BUSINESS_MIGRATION_MARKER)))
  const after = inspectSqliteDb(path.join(stable, 'data', 'wechat-control.sqlite'))
  assert.ok(after.counts.app_settings >= 1)
  assert.ok(after.counts.wechat_instances >= 1)
  assert.ok(after.counts.tasks >= 1)
  assert.ok(after.counts.qr_items >= 1)
  // Idempotent
  const second = migrateLegacyBusinessDataIfNeeded({
    stableUserDataDir: stable,
    legacyPortableUserDataDir: legacy,
  })
  assert.equal(second.reason, 'already_migrated')
  // Legacy still present (not deleted)
  assert.ok(existsSync(path.join(legacy, 'data', 'wechat-control.sqlite')))
  try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('business DB conflict does not overwrite when BOTH have meaningful business', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'biz-conflict-'))
  const stable = path.join(root, 'stable')
  const legacy = path.join(root, 'legacy')
  makeDb(path.join(legacy, 'data', 'wechat-control.sqlite'), { task: true, instance: true })
  makeDb(path.join(stable, 'data', 'wechat-control.sqlite'), { task: true, qr: true })
  const result = migrateLegacyBusinessDataIfNeeded({
    stableUserDataDir: stable,
    legacyPortableUserDataDir: legacy,
  })
  assert.equal(result.code, 'LEGACY_DATA_CONFLICT')
  const stableInfo = inspectSqliteDb(path.join(stable, 'data', 'wechat-control.sqlite'))
  assert.ok(stableInfo.counts.tasks >= 1)
  assert.ok(stableInfo.counts.qr_items >= 1)
  // Legacy untouched
  assert.ok(existsSync(path.join(legacy, 'data', 'wechat-control.sqlite')))
  try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('v1.99 bootstrap-only stable yields to meaningful legacy (logs+settings noise)', () => {
  const {
    classifyBusinessDb,
    BUSINESS_MIGRATION_MARKER_V2,
  } = require('../electron/wxqk-business-migration.cjs')
  const root = mkdtempSync(path.join(tmpdir(), 'biz-v199-'))
  const stable = path.join(root, 'stable')
  const legacy = path.join(root, 'legacy')

  // Legacy: real business
  const legacyDb = path.join(legacy, 'data', 'wechat-control.sqlite')
  makeDb(legacyDb, { instance: true, task: true, qr: true })
  const ldb = new DatabaseSync(legacyDb)
  for (let i = 0; i < 5; i += 1) {
    ldb.prepare('INSERT INTO contacts(wxid,source_instance_id,updated_at) VALUES(?,?,?)')
      .run(`wx${i}`, 'inst-1', new Date().toISOString())
  }
  for (let i = 0; i < 20; i += 1) {
    ldb.prepare('INSERT INTO logs(time,level,message) VALUES(?,?,?)')
      .run(new Date().toISOString(), 'INFO', `legacy-log-${i}`)
  }
  ldb.close()

  // Stable: v1.99 bootstrap noise only
  const stableDb = path.join(stable, 'data', 'wechat-control.sqlite')
  makeDb(stableDb, { settings: { general: { lang: 'zh' } } })
  const sdb = new DatabaseSync(stableDb)
  for (let i = 0; i < 50; i += 1) {
    sdb.prepare('INSERT INTO logs(time,level,message) VALUES(?,?,?)')
      .run(new Date().toISOString(), 'INFO', `boot-${i}`)
  }
  sdb.close()

  const legacyClass = classifyBusinessDb(legacyDb)
  const stableClass = classifyBusinessDb(stableDb)
  assert.equal(legacyClass.classification, 'meaningful_business')
  assert.equal(stableClass.classification, 'bootstrap_only')
  assert.ok(stableClass.bootstrapRows > 0)
  assert.equal(stableClass.meaningfulRows, 0)

  // Old v2 marker must NOT permanently block recovery
  writeFileSync(path.join(stable, BUSINESS_MIGRATION_MARKER_V2), JSON.stringify({
    at: '2026-01-01T00:00:00.000Z',
    skipped: 'stable_identity_exists',
  }), 'utf8')

  const result = migrateLegacyBusinessDataIfNeeded({
    stableUserDataDir: stable,
    legacyPortableUserDataDir: legacy,
  })
  assert.equal(result.migrated, true)
  assert.equal(result.code, 'OK')
  assert.equal(result.stableBeforeClassification, 'bootstrap_only')
  assert.equal(result.legacyClassification, 'meaningful_business')
  assert.ok(result.backupDir)
  assert.ok(existsSync(path.join(stable, BUSINESS_MIGRATION_MARKER)))

  const after = classifyBusinessDb(path.join(stable, 'data', 'wechat-control.sqlite'))
  assert.equal(after.classification, 'meaningful_business')
  assert.ok(after.businessCounts.wechat_instances >= 1)
  assert.ok(after.businessCounts.tasks >= 1)
  assert.ok(after.businessCounts.qr_items >= 1)
  assert.ok(after.businessCounts.contacts >= 5)

  const marker = JSON.parse(readFileSync(path.join(stable, BUSINESS_MIGRATION_MARKER), 'utf8'))
  assert.equal(marker.schema, 3)
  assert.equal(marker.status, 'migrated')
  assert.equal(marker.verified, true)

  // Verified marker → idempotent skip
  const second = migrateLegacyBusinessDataIfNeeded({
    stableUserDataDir: stable,
    legacyPortableUserDataDir: legacy,
  })
  assert.equal(second.reason, 'already_migrated')

  try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('stable only logs (no settings) still migrates meaningful legacy', () => {
  const { classifyBusinessDb } = require('../electron/wxqk-business-migration.cjs')
  const root = mkdtempSync(path.join(tmpdir(), 'biz-logs-only-'))
  const stable = path.join(root, 'stable')
  const legacy = path.join(root, 'legacy')
  makeDb(path.join(legacy, 'data', 'wechat-control.sqlite'), { instance: true, task: true })
  makeDb(path.join(stable, 'data', 'wechat-control.sqlite'), {})
  const sdb = new DatabaseSync(path.join(stable, 'data', 'wechat-control.sqlite'))
  for (let i = 0; i < 100; i += 1) {
    sdb.prepare('INSERT INTO logs(time,level,message) VALUES(?,?,?)')
      .run(new Date().toISOString(), 'INFO', `n-${i}`)
  }
  sdb.close()
  assert.equal(classifyBusinessDb(path.join(stable, 'data', 'wechat-control.sqlite')).classification, 'bootstrap_only')
  const result = migrateLegacyBusinessDataIfNeeded({
    stableUserDataDir: stable,
    legacyPortableUserDataDir: legacy,
  })
  assert.equal(result.migrated, true)
  const after = classifyBusinessDb(path.join(stable, 'data', 'wechat-control.sqlite'))
  assert.ok(after.businessCounts.wechat_instances >= 1)
  assert.ok(after.businessCounts.tasks >= 1)
  try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('migration copy failure rolls back bootstrap stable and does not write success marker', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'biz-rollback-'))
  const stable = path.join(root, 'stable')
  const legacy = path.join(root, 'legacy')
  makeDb(path.join(legacy, 'data', 'wechat-control.sqlite'), { instance: true })
  makeDb(path.join(stable, 'data', 'wechat-control.sqlite'), { settings: { x: 1 } })
  const sdb = new DatabaseSync(path.join(stable, 'data', 'wechat-control.sqlite'))
  sdb.prepare('INSERT INTO logs(time,level,message) VALUES(?,?,?)')
    .run(new Date().toISOString(), 'INFO', 'keep-me')
  sdb.close()

  let copyCalls = 0
  const result = migrateLegacyBusinessDataIfNeeded({
    stableUserDataDir: stable,
    legacyPortableUserDataDir: legacy,
    copyFileSync: (src, dest) => {
      copyCalls += 1
      // Allow backup copies, fail when staging the main legacy sqlite
      if (String(dest).includes('.wxqk-migrate-staging') && String(src).endsWith('wechat-control.sqlite')) {
        throw new Error('simulated copy fail')
      }
      return require('node:fs').copyFileSync(src, dest)
    },
  })
  assert.equal(result.code, 'LEGACY_MIGRATION_FAILED_ROLLED_BACK')
  assert.equal(existsSync(path.join(stable, BUSINESS_MIGRATION_MARKER)), false)
  const stableAfter = inspectSqliteDb(path.join(stable, 'data', 'wechat-control.sqlite'))
  assert.ok(stableAfter.counts.app_settings >= 1)
  assert.equal(stableAfter.counts.wechat_instances || 0, 0)
  assert.ok(copyCalls >= 1)
  try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('packaged production ignores WXQK_USER_DATA_DIR', () => {
  const evil = mkdtempSync(path.join(tmpdir(), 'evil-udata-'))
  process.env.WXQK_USER_DATA_DIR = evil
  const resolved = paths.resolveStableUserDataRoot({ app: { isPackaged: true } })
  assert.notEqual(resolved, path.resolve(evil))
  assert.match(resolved.replace(/\//g, '\\'), /WXQK$/i)
  delete process.env.WXQK_USER_DATA_DIR
  try { rmSync(evil, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('dev/test can still override WXQK_USER_DATA_DIR', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-udata-'))
  process.env.WXQK_USER_DATA_DIR = dir
  const resolved = paths.resolveStableUserDataRoot({ app: { isPackaged: false } })
  assert.equal(resolved, path.resolve(dir))
  delete process.env.WXQK_USER_DATA_DIR
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('process gate rejects PID=0 and accepts positive PID', () => {
  assert.equal(serviceHealth.evaluateProcessGate({ state: 'running', processId: 0, source: 'cim' }).gate, 'FAIL')
  assert.equal(serviceHealth.evaluateProcessGate({ state: 'running', processId: 0, source: 'cim' }).code, 'PID_ZERO')
  assert.equal(serviceHealth.evaluateProcessGate({ state: 'running', processId: 123, source: 'cim' }).gate, 'PASS')
  assert.equal(serviceHealth.evaluateProcessGate({ state: 'running', processId: 0, source: 'sc' }).gate, 'WAIT')
  assert.equal(serviceHealth.evaluateProcessGate({
    state: 'running',
    processId: 9,
    source: 'cim',
    executablePath: 'C:\\Windows\\notepad.exe',
    expectedExePath: 'C:\\Program Files\\WXQK\\WXQK.exe',
  }).code, 'PROCESS_MISMATCH')
  assert.equal(serviceHealth.evaluateProcessGate({
    state: 'running',
    processId: 9,
    source: 'cim',
    executablePath: 'C:\\Program Files\\WXQK\\WXQK.exe',
    expectedExePath: 'C:\\Program Files\\WXQK\\WXQK.exe',
  }).gate, 'PASS')
})

test('artifact meta mismatch fails assert and runtime uses real exe sha', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'art-meta-'))
  const exe = path.join(dir, 'WXQK.exe')
  writeFileSync(exe, 'REAL-BYTES-AAA')
  artifact.writePackagedArtifactMeta(dir, exe)
  writeFileSync(path.join(dir, 'agent-artifact.json'), JSON.stringify({
    sha256: 'deadbeef',
    size: 1,
    fileDescription: 'WXQK',
    originalFilename: 'WXQK.exe',
  }), 'utf8')
  const check = artifact.assertPackagedArtifactMetaMatchesExe(dir, exe, { strict: true })
  assert.equal(check.ok, false)
  assert.equal(check.code, 'MESH_AGENT_ARTIFACT_META_MISMATCH')
  const fp = artifact.readPackagedArtifactFingerprint(dir, exe)
  assert.equal(fp.source, 'computed')
  assert.equal(fp.metaMismatch, true)
  assert.notEqual(fp.sha256, 'deadbeef')
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('machine identity shared across simulated users via ProgramData', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'machine-id-'))
  process.env.WXQK_MACHINE_DATA_DIR = root
  machine.setMachineIdentityDepsForTest({
    platform: 'linux',
    hardenAcl: () => ({ ok: true }),
  })
  const a = machine.loadOrCreateMachineIdentity({})
  const b = machine.loadOrCreateMachineIdentity({})
  assert.equal(a.clientId, b.clientId)
  assert.equal(a.deviceId, b.deviceId)
  assert.ok(existsSync(path.join(root, 'machine', 'device-identity.json')))
  assert.ok(existsSync(path.join(root, 'machine', 'device-identity.secret')))
  const meta = JSON.parse(readFileSync(path.join(root, 'machine', 'device-identity.json'), 'utf8'))
  assert.equal(meta.privateKeyPem, undefined)
  assert.equal(meta.privateKeyEnc, undefined)
  machine.resetMachineIdentityDepsForTest()
  delete process.env.WXQK_MACHINE_DATA_DIR
  try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('machine identity adopts candidate and refuses corrupt reset', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'machine-adopt-'))
  process.env.WXQK_MACHINE_DATA_DIR = root
  machine.setMachineIdentityDepsForTest({
    platform: 'linux',
    hardenAcl: () => ({ ok: true }),
  })
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pubDer = publicKey.export({ type: 'spki', format: 'der' })
  const pubRaw = pubDer.subarray(pubDer.length - 32)
  const publicKeyB64 = Buffer.from(pubRaw).toString('base64')
  const deviceId = createHash('sha256').update(pubRaw).digest('hex')
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const adopted = machine.adoptIdentityIntoMachineStore({
    publicKeyB64,
    deviceId,
    clientId: deviceId,
    privateKeyPem,
  })
  assert.equal(adopted.ok, true)
  assert.equal(adopted.identity.clientId, deviceId)

  // Corrupt secret → UNREADABLE, not silent recreate
  writeFileSync(path.join(root, 'machine', 'device-identity.secret'), '{bad', 'utf8')
  assert.throws(
    () => machine.loadOrCreateMachineIdentity({}),
    (err) => err && err.code === 'DEVICE_IDENTITY_UNREADABLE',
  )
  machine.resetMachineIdentityDepsForTest()
  delete process.env.WXQK_MACHINE_DATA_DIR
  try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
})
