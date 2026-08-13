'use strict'

/**
 * Isolated E2E: simulate v1.99 bootstrap-only stable + meaningful legacy portable DB.
 * Does NOT touch the real %LOCALAPPDATA%\WXQK user store.
 *
 * Usage: node scripts/v199-business-recovery-gate.cjs
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const { DatabaseSync } = require('node:sqlite')
const {
  migrateLegacyBusinessDataIfNeeded,
  classifyBusinessDb,
  BUSINESS_MIGRATION_MARKER,
  BUSINESS_MIGRATION_MARKER_V2,
} = require('../electron/wxqk-business-migration.cjs')

function makeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wechat_instances (id TEXT PRIMARY KEY, api_port INTEGER NOT NULL, tcp_port INTEGER NOT NULL, pid INTEGER, account_wxid TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS contacts (wxid TEXT NOT NULL, source_instance_id TEXT NOT NULL, nickname TEXT, remark TEXT, alias TEXT, avatar TEXT, is_group INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(wxid,source_instance_id));
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, config_json TEXT NOT NULL, total INTEGER NOT NULL DEFAULT 0, success INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS qr_items (id TEXT PRIMARY KEY, sha256 TEXT UNIQUE, source TEXT, local_path TEXT, decoded_text TEXT, qr_type TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, level TEXT NOT NULL, instance_id TEXT, module TEXT, message TEXT NOT NULL, details_json TEXT);
  `)
}

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wxqk-v199-recovery-'))
  const stable = path.join(root, 'LOCALAPPDATA-WXQK')
  const legacy = path.join(root, 'portable-WXQK-Data')
  const report = { root, ok: false }

  try {
    // Machine identity fingerprint (must not be written by this gate)
    const machineBefore = fs.existsSync(path.join(process.env.ProgramData || '', 'WXQK', 'machine', 'device-identity.json'))
      ? fs.readFileSync(path.join(process.env.ProgramData, 'WXQK', 'machine', 'device-identity.json'), 'utf8')
      : ''

    // Legacy meaningful business
    const legacyDb = path.join(legacy, 'data', 'wechat-control.sqlite')
    fs.mkdirSync(path.dirname(legacyDb), { recursive: true })
    let db = new DatabaseSync(legacyDb)
    makeSchema(db)
    const now = new Date().toISOString()
    db.prepare('INSERT INTO wechat_instances(id,api_port,tcp_port,status,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run('inst-a', 19001, 19002, 'online', now, now)
    db.prepare('INSERT INTO wechat_instances(id,api_port,tcp_port,status,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run('inst-b', 19003, 19004, 'online', now, now)
    for (let i = 0; i < 20; i += 1) {
      db.prepare('INSERT INTO contacts(wxid,source_instance_id,updated_at) VALUES(?,?,?)')
        .run(`c${i}`, 'inst-a', now)
    }
    for (let i = 0; i < 3; i += 1) {
      db.prepare('INSERT INTO tasks(id,name,type,status,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(`task-${i}`, 't', 'friend', 'done', '{}', now, now)
    }
    for (let i = 0; i < 5; i += 1) {
      db.prepare('INSERT INTO qr_items(id,sha256,status,created_at,updated_at) VALUES(?,?,?,?,?)')
        .run(`qr-${i}`, `sha-${i}`, 'pending', now, now)
    }
    for (let i = 0; i < 100; i += 1) {
      db.prepare('INSERT INTO logs(time,level,message) VALUES(?,?,?)').run(now, 'INFO', `legacy-${i}`)
    }
    db.close()

    // Stable bootstrap-only (v1.99 opened once)
    const stableDb = path.join(stable, 'data', 'wechat-control.sqlite')
    fs.mkdirSync(path.dirname(stableDb), { recursive: true })
    db = new DatabaseSync(stableDb)
    makeSchema(db)
    db.prepare('INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)')
      .run('general', JSON.stringify({ lang: 'zh' }), now)
    for (let i = 0; i < 50; i += 1) {
      db.prepare('INSERT INTO logs(time,level,message) VALUES(?,?,?)').run(now, 'INFO', `boot-${i}`)
    }
    db.close()

    // Simulate mistaken v2 marker from earlier client
    fs.writeFileSync(path.join(stable, BUSINESS_MIGRATION_MARKER_V2), JSON.stringify({
      at: now,
      note: 'simulated-old-marker',
    }), 'utf8')

    const beforeLegacy = classifyBusinessDb(legacyDb)
    const beforeStable = classifyBusinessDb(stableDb)
    report.before = {
      legacyClassification: beforeLegacy.classification,
      legacyInstances: beforeLegacy.businessCounts.wechat_instances,
      legacyTasks: beforeLegacy.businessCounts.tasks,
      legacyQr: beforeLegacy.businessCounts.qr_items,
      stableClassification: beforeStable.classification,
      stableLogs: beforeStable.bootstrapCounts.logs,
      stableSettings: beforeStable.bootstrapCounts.app_settings
        || beforeStable.userSettingRows
        || 0,
      stableBusiness: beforeStable.meaningfulRows,
      stableUserSettingRows: beforeStable.userSettingRows,
    }

    const result = migrateLegacyBusinessDataIfNeeded({
      stableUserDataDir: stable,
      legacyPortableUserDataDir: legacy,
    })
    report.migration = {
      migrated: result.migrated,
      code: result.code,
      reason: result.reason,
      stableBeforeClassification: result.stableBeforeClassification,
      legacyClassification: result.legacyClassification,
      backupDir: Boolean(result.backupDir),
    }

    const after = classifyBusinessDb(path.join(stable, 'data', 'wechat-control.sqlite'))
    report.after = {
      classification: after.classification,
      wechat_instances: after.businessCounts.wechat_instances,
      tasks: after.businessCounts.tasks,
      qr_items: after.businessCounts.qr_items,
      contacts: after.businessCounts.contacts,
      markerV3: fs.existsSync(path.join(stable, BUSINESS_MIGRATION_MARKER)),
    }

    const machineAfter = fs.existsSync(path.join(process.env.ProgramData || '', 'WXQK', 'machine', 'device-identity.json'))
      ? fs.readFileSync(path.join(process.env.ProgramData, 'WXQK', 'machine', 'device-identity.json'), 'utf8')
      : ''
    report.identityUnchanged = machineBefore === machineAfter

    report.ok = Boolean(
      result.migrated
      && result.code === 'OK'
      && beforeLegacy.classification === 'meaningful_business'
      && (beforeStable.classification === 'bootstrap_only' || beforeStable.classification === 'user_settings_only')
      && beforeStable.meaningfulRows === 0
      && after.businessCounts.wechat_instances === 2
      && after.businessCounts.tasks === 3
      && after.businessCounts.qr_items === 5
      && after.businessCounts.contacts === 20
      && report.identityUnchanged,
    )
    report.gate = report.ok ? 'V199_TO_CURRENT_DATA_RECOVERY_GATE=PASS' : 'V199_TO_CURRENT_DATA_RECOVERY_GATE=FAIL'
  } catch (err) {
    report.error = String(err?.message || err)
    report.gate = 'V199_TO_CURRENT_DATA_RECOVERY_GATE=FAIL'
  }

  console.log(JSON.stringify(report, null, 2))
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(report.ok ? 0 : 1)
}

main()
