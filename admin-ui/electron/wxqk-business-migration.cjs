'use strict'

/**
 * Migrate legacy portable business SQLite into stable userData BEFORE initStorage.
 *
 * Classification strategy:
 * - Explicit RUNTIME_NOISE_TABLES never count as business conflict.
 * - All other known persisted tables default to meaningful (missing tables = 0).
 * - app_settings is key-level: bootstrap keys vs user/unknown keys.
 * - Marker is a hint only; missing/corrupt stable forces re-evaluation.
 */

const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const BUSINESS_MIGRATION_MARKER_V2 = '.wxqk-business-data-migrated-v2'
const BUSINESS_MIGRATION_MARKER_V3 = '.wxqk-business-data-migrated-v3'
const BUSINESS_MIGRATION_MARKER = '.wxqk-business-data-migrated-v4'
const MARKER_SCHEMA = 4
const DB_NAME = 'wechat-control.sqlite'

/**
 * Confirmed runtime noise / cache — alone never means real business data.
 * remote_session_audit is scrubbed by clearRuntimeCaches and is not portable business.
 */
const RUNTIME_NOISE_TABLES = [
  'logs',
  'backend_session_cache',
  'wechat_api_compatibility',
  'wechat_api_runtime_samples',
  'remote_session_audit',
]

/** @deprecated alias used by older callers/tests */
const BOOTSTRAP_TABLES = [...RUNTIME_NOISE_TABLES]

/**
 * Known persisted business tables (from storage.cjs). Any unknown table found in
 * sqlite_master that is not noise / app_settings is also treated as meaningful.
 */
const KNOWN_MEANINGFUL_TABLES = [
  'wechat_instances',
  'contacts',
  'chatrooms',
  'chatroom_members',
  'chatroom_sources',
  'tasks',
  'task_items',
  'qr_items',
  'message_events',
  'member_join_events',
  'friend_target_history',
  'friend_daily_attempts',
  'qr_join_daily_attempts',
  'delivered_content_history',
  'chat_add_candidates',
  'chat_add_rules',
  'kicked_group_cleanup',
  'blocked_chatrooms',
  'operation_history',
  'exclusion_rules',
  'risk_events',
]

/** @deprecated exported name kept for tests */
const MEANINGFUL_TABLES = [...KNOWN_MEANINGFUL_TABLES]

/**
 * Only auto-start / pure technical setting keys may live here.
 * Production currently has no confirmed bootstrap-only keys.
 */
const BOOTSTRAP_SETTING_KEYS = Object.freeze([])

/** Known user-facing setting keys (storage saveSetting). */
const USER_SETTING_KEYS = Object.freeze(['general', 'qrMonitor'])

const COUNT_TABLES = [...new Set([
  ...KNOWN_MEANINGFUL_TABLES,
  ...RUNTIME_NOISE_TABLES,
  'app_settings',
])]

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} table
 */
function countTable(db, table) {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()
    return Number(row?.c || 0)
  } catch {
    return 0
  }
}

/**
 * Seeded default chat_add_rules row must not alone mark a DB as meaningful.
 * @param {import('node:sqlite').DatabaseSync} db
 */
function countMeaningfulChatAddRules(db) {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS c FROM chat_add_rules
      WHERE id = 1 AND (
        COALESCE(enabled, 0) != 0
        OR TRIM(COALESCE(instance_id, '')) != ''
        OR TRIM(COALESCE(account_wxid, '')) != ''
        OR TRIM(COALESCE(exclude_text, '')) != ''
        OR TRIM(COALESCE(room_ids_json, '[]')) NOT IN ('[]', '')
        OR TRIM(COALESCE(keywords_json, '[]')) NOT IN ('[]', '')
      )
    `).get()
    return Number(row?.c || 0)
  } catch {
    // Older schema without account_wxid — fall back without that column.
    try {
      const row = db.prepare(`
        SELECT COUNT(*) AS c FROM chat_add_rules
        WHERE COALESCE(enabled, 0) != 0
          OR TRIM(COALESCE(instance_id, '')) != ''
          OR TRIM(COALESCE(exclude_text, '')) != ''
          OR TRIM(COALESCE(room_ids_json, '[]')) NOT IN ('[]', '')
          OR TRIM(COALESCE(keywords_json, '[]')) NOT IN ('[]', '')
      `).get()
      return Number(row?.c || 0)
    } catch {
      return 0
    }
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ bootstrap: Record<string, string>, user: Record<string, string>, unknown: Record<string, string>, updatedAt: Record<string, string> }}
 */
function classifyAppSettingsKeys(db) {
  const bootstrap = {}
  const user = {}
  const unknown = {}
  const updatedAt = {}
  try {
    const rows = db.prepare('SELECT key, value_json, updated_at FROM app_settings').all()
    for (const row of rows || []) {
      const key = String(row.key || '').trim()
      if (!key) continue
      const value = String(row.value_json || '')
      const at = String(row.updated_at || '')
      updatedAt[key] = at
      if (BOOTSTRAP_SETTING_KEYS.includes(key)) bootstrap[key] = value
      else if (USER_SETTING_KEYS.includes(key)) user[key] = value
      else unknown[key] = value
    }
  } catch { /* table missing */ }
  return { bootstrap, user, unknown, updatedAt }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
function listUserTables(db) {
  try {
    return db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
    `).all().map((r) => String(r.name || '')).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * @param {string} dbPath
 * @param {{ DatabaseSync?: typeof DatabaseSync, existsSync?: typeof fs.existsSync }} [deps]
 */
function classifyBusinessDb(dbPath, deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync
  const Db = deps.DatabaseSync || DatabaseSync
  if (!dbPath || !existsSync(dbPath)) {
    return {
      exists: false,
      readable: true,
      businessCounts: {},
      bootstrapCounts: {},
      settings: { bootstrapKeys: [], userKeys: [], unknownKeys: [] },
      meaningfulRows: 0,
      bootstrapRows: 0,
      userSettingRows: 0,
      classification: 'missing',
    }
  }

  let db
  try {
    try {
      db = new Db(dbPath, { readOnly: true })
    } catch {
      db = new Db(dbPath)
    }
  } catch (err) {
    return {
      exists: true,
      readable: false,
      businessCounts: {},
      bootstrapCounts: {},
      settings: { bootstrapKeys: [], userKeys: [], unknownKeys: [] },
      meaningfulRows: -1,
      bootstrapRows: -1,
      userSettingRows: -1,
      classification: 'unreadable',
      error: String(err?.message || err),
    }
  }

  const businessCounts = {}
  const bootstrapCounts = {}
  let meaningfulRows = 0
  let bootstrapRows = 0
  let userSettingRows = 0
  let settingsMeta = { bootstrapKeys: [], userKeys: [], unknownKeys: [], updatedAt: {} }

  try {
    const present = new Set(listUserTables(db))
    const noise = new Set(RUNTIME_NOISE_TABLES)

    for (const table of RUNTIME_NOISE_TABLES) {
      const n = present.has(table) ? countTable(db, table) : 0
      bootstrapCounts[table] = n
      bootstrapRows += n
    }

    const meaningfulCandidates = new Set(KNOWN_MEANINGFUL_TABLES)
    for (const name of present) {
      if (name === 'app_settings') continue
      if (noise.has(name)) continue
      meaningfulCandidates.add(name)
    }

    for (const table of meaningfulCandidates) {
      let n = 0
      if (table === 'chat_add_rules') n = countMeaningfulChatAddRules(db)
      else if (present.has(table) || KNOWN_MEANINGFUL_TABLES.includes(table)) n = countTable(db, table)
      businessCounts[table] = n
      meaningfulRows += n
    }

    if (present.has('app_settings')) {
      const classified = classifyAppSettingsKeys(db)
      settingsMeta = {
        bootstrapKeys: Object.keys(classified.bootstrap),
        userKeys: Object.keys(classified.user),
        unknownKeys: Object.keys(classified.unknown),
        updatedAt: classified.updatedAt,
      }
      const bootstrapSettingCount = settingsMeta.bootstrapKeys.length
      userSettingRows = settingsMeta.userKeys.length + settingsMeta.unknownKeys.length
      bootstrapCounts.app_settings_bootstrap_keys = bootstrapSettingCount
      bootstrapCounts.app_settings_user_keys = userSettingRows
      bootstrapRows += bootstrapSettingCount
      // Raw app_settings row count kept for logs but does not alone force conflict.
      bootstrapCounts.app_settings = countTable(db, 'app_settings')
    }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }

  let classification = 'empty'
  if (meaningfulRows > 0) classification = 'meaningful_business'
  else if (userSettingRows > 0) classification = 'user_settings_only'
  else if (bootstrapRows > 0) classification = 'bootstrap_only'

  return {
    exists: true,
    readable: true,
    businessCounts,
    bootstrapCounts,
    settings: settingsMeta,
    meaningfulRows,
    bootstrapRows,
    userSettingRows,
    classification,
    counts: { ...businessCounts, ...bootstrapCounts },
    totalRows: meaningfulRows + bootstrapRows + userSettingRows,
    empty: meaningfulRows === 0 && bootstrapRows === 0 && userSettingRows === 0,
  }
}

/** @deprecated prefer classifyBusinessDb */
function inspectSqliteDb(dbPath) {
  const c = classifyBusinessDb(dbPath)
  if (!c.exists) return { exists: false, empty: true, counts: {}, totalRows: 0 }
  if (!c.readable) {
    return {
      exists: true,
      empty: false,
      counts: {},
      totalRows: -1,
      error: c.error,
    }
  }
  return {
    exists: true,
    empty: c.empty,
    counts: c.counts,
    totalRows: c.totalRows,
    classification: c.classification,
    meaningfulRows: c.meaningfulRows,
    bootstrapRows: c.bootstrapRows,
    userSettingRows: c.userSettingRows,
  }
}

function checkpointSqliteDb(dbPath) {
  if (!fs.existsSync(dbPath)) return { ok: false, reason: 'missing' }
  let db
  try {
    db = new DatabaseSync(dbPath)
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);') } catch { /* best-effort */ }
    try { db.close() } catch { /* ignore */ }
    return { ok: true }
  } catch (err) {
    try { db?.close() } catch { /* ignore */ }
    return { ok: false, reason: String(err?.message || err) }
  }
}

function dbSidecars(dbPath) {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
}

function readMigrationMarker(markerPath, deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync
  const readFileSync = deps.readFileSync || fs.readFileSync
  if (!existsSync(markerPath)) return null
  try {
    return JSON.parse(readFileSync(markerPath, 'utf8'))
  } catch {
    return { schema: 0, status: 'corrupt' }
  }
}

/**
 * Marker is a hint. Fast-skip only when verified AND stable DB still matches summary.
 * @param {string} stableDir
 * @param {string} stableDb
 * @param {object} deps
 * @param {typeof classifyBusinessDb} [classify]
 */
function resolveVerifiedMarker(stableDir, stableDb, deps = {}, classify = classifyBusinessDb) {
  const existsSync = deps.existsSync || fs.existsSync
  const readFileSync = deps.readFileSync || fs.readFileSync
  const candidates = [
    path.join(stableDir, BUSINESS_MIGRATION_MARKER),
    path.join(stableDir, BUSINESS_MIGRATION_MARKER_V3),
  ]
  let best = null
  let markerPath = candidates[0]
  for (const p of candidates) {
    const row = readMigrationMarker(p, { existsSync, readFileSync })
    if (!row) continue
    if (
      Number(row.schema || 0) >= 3
      && row.status === 'migrated'
      && row.verified === true
    ) {
      best = row
      markerPath = p
      break
    }
  }
  if (!best) return { skip: false, marker: markerPath, row: null, reason: 'no_verified_marker' }

  // Stable missing / unreadable → must re-evaluate (disaster recovery)
  if (!existsSync(stableDb)) {
    return { skip: false, marker: markerPath, row: best, reason: 'marker_stable_missing' }
  }
  const stableClass = classify(stableDb, deps)
  if (!stableClass.readable) {
    return { skip: false, marker: markerPath, row: best, reason: 'marker_stable_unreadable' }
  }

  const recorded = best.meaningfulCounts && typeof best.meaningfulCounts === 'object'
    ? best.meaningfulCounts
    : null
  if (recorded) {
    for (const [table, expected] of Object.entries(recorded)) {
      const want = Number(expected || 0)
      if (want <= 0) continue
      const have = Number(stableClass.businessCounts?.[table] || 0)
      if (have < want) {
        return {
          skip: false,
          marker: markerPath,
          row: best,
          reason: 'marker_count_mismatch',
          table,
          expected: want,
          actual: have,
          stableClassification: stableClass.classification,
        }
      }
    }
  } else if (Number(best.legacyMeaningfulRows || 0) > 0 && stableClass.meaningfulRows <= 0) {
    return {
      skip: false,
      marker: markerPath,
      row: best,
      reason: 'marker_stable_empty_vs_legacy',
      stableClassification: stableClass.classification,
    }
  }

  // Schema 4+ markers with matching counts may fast-skip.
  // Older schema-3 markers without meaningfulCounts only skip when stable still meaningful.
  if (Number(best.schema || 0) >= MARKER_SCHEMA) {
    return { skip: true, marker: markerPath, row: best, reason: 'verified_v4' }
  }
  if (stableClass.classification === 'meaningful_business' || stableClass.classification === 'user_settings_only') {
    return { skip: true, marker: markerPath, row: best, reason: 'verified_v3_stable_ok' }
  }
  return {
    skip: false,
    marker: markerPath,
    row: best,
    reason: 'marker_needs_reeval',
    stableClassification: stableClass.classification,
  }
}

function backupStableDbFiles(backupDir, stableDb, api) {
  api.mkdirSync(backupDir, { recursive: true })
  const backed = []
  for (const f of dbSidecars(stableDb)) {
    if (!api.existsSync(f)) continue
    const dest = path.join(backupDir, path.basename(f))
    api.copyFileSync(f, dest)
    backed.push(path.basename(f))
  }
  return backed
}

function restoreStableDbFiles(backupDir, stableDb, api) {
  const dataDir = path.dirname(stableDb)
  for (const f of dbSidecars(stableDb)) {
    try { if (api.existsSync(f)) api.unlinkSync(f) } catch { /* ignore */ }
  }
  for (const name of [DB_NAME, `${DB_NAME}-wal`, `${DB_NAME}-shm`]) {
    const src = path.join(backupDir, name)
    if (!api.existsSync(src)) continue
    api.copyFileSync(src, path.join(dataDir, name))
  }
}

/**
 * Merge user/unknown app_settings from pre-migration stable backup into final stable.
 * Conflict policy: same key → newer updated_at wins; equal/missing → keep stable (newer client).
 * @param {string} backupDbPath
 * @param {string} stableDbPath
 */
function mergeUserAppSettingsFromBackup(backupDbPath, stableDbPath) {
  if (!fs.existsSync(backupDbPath) || !fs.existsSync(stableDbPath)) {
    return { merged: 0, skipped: 'missing_db' }
  }
  let backupDb
  let stableDb
  try {
    backupDb = new DatabaseSync(backupDbPath)
    stableDb = new DatabaseSync(stableDbPath)
  } catch (err) {
    try { backupDb?.close() } catch { /* ignore */ }
    try { stableDb?.close() } catch { /* ignore */ }
    return { merged: 0, error: String(err?.message || err) }
  }

  let merged = 0
  const details = []
  try {
    const fromStable = classifyAppSettingsKeys(backupDb)
    const candidates = { ...fromStable.user, ...fromStable.unknown }
    const upsert = stableDb.prepare(`
      INSERT INTO app_settings(key, value_json, updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET
        value_json=excluded.value_json,
        updated_at=excluded.updated_at
    `)
    const getExisting = stableDb.prepare('SELECT value_json, updated_at FROM app_settings WHERE key=?')

    stableDb.exec('BEGIN')
    for (const [key, valueJson] of Object.entries(candidates)) {
      const stableAt = String(fromStable.updatedAt[key] || '')
      const existing = getExisting.get(key)
      if (!existing) {
        upsert.run(key, valueJson, stableAt || new Date().toISOString())
        merged += 1
        details.push({ key, action: 'insert_from_stable' })
        continue
      }
      const legacyAt = String(existing.updated_at || '')
      // Prefer stable (newer client session) when timestamps equal or stable newer
      if (!legacyAt || (stableAt && stableAt >= legacyAt) || (!stableAt && existing.value_json !== valueJson)) {
        if (String(existing.value_json) !== valueJson) {
          upsert.run(key, valueJson, stableAt || legacyAt || new Date().toISOString())
          merged += 1
          details.push({ key, action: 'prefer_stable' })
        }
      } else {
        details.push({ key, action: 'keep_legacy' })
      }
    }
    stableDb.exec('COMMIT')
  } catch (err) {
    try { stableDb.exec('ROLLBACK') } catch { /* ignore */ }
    try { backupDb.close() } catch { /* ignore */ }
    try { stableDb.close() } catch { /* ignore */ }
    return { merged: 0, error: String(err?.message || err) }
  }
  try { backupDb.close() } catch { /* ignore */ }
  try { stableDb.close() } catch { /* ignore */ }
  return { merged, details }
}

function verifyMeaningfulCounts(legacyClass, afterClass) {
  const tables = new Set([
    ...Object.keys(legacyClass.businessCounts || {}),
    ...KNOWN_MEANINGFUL_TABLES,
  ])
  for (const table of tables) {
    const beforeN = Number(legacyClass.businessCounts?.[table] || 0)
    const afterN = Number(afterClass.businessCounts?.[table] || 0)
    if (beforeN > 0 && afterN < beforeN) {
      return { ok: false, table, legacyCount: beforeN, stableCount: afterN }
    }
  }
  if (legacyClass.meaningfulRows > 0 && afterClass.meaningfulRows <= 0) {
    return { ok: false, table: '*', legacyCount: legacyClass.meaningfulRows, stableCount: afterClass.meaningfulRows }
  }
  return { ok: true }
}

function snapshotMeaningfulCounts(classification) {
  const out = {}
  for (const [table, n] of Object.entries(classification.businessCounts || {})) {
    const v = Number(n || 0)
    if (v > 0) out[table] = v
  }
  return out
}

/**
 * @param {object} opts
 */
function migrateLegacyBusinessDataIfNeeded(opts) {
  const api = {
    existsSync: opts.existsSync || fs.existsSync,
    mkdirSync: opts.mkdirSync || fs.mkdirSync,
    copyFileSync: opts.copyFileSync || fs.copyFileSync,
    renameSync: opts.renameSync || fs.renameSync,
    writeFileSync: opts.writeFileSync || fs.writeFileSync,
    unlinkSync: opts.unlinkSync || fs.unlinkSync,
    readFileSync: opts.readFileSync || fs.readFileSync,
  }
  const classify = opts.classifyBusinessDb || classifyBusinessDb
  const checkpoint = opts.checkpointSqliteDb || checkpointSqliteDb
  const mergeSettings = opts.mergeUserAppSettingsFromBackup || mergeUserAppSettingsFromBackup
  const log = typeof opts.log === 'function'
    ? opts.log
    : (level, msg, extra) => {
      const line = `[BUSINESS-MIGRATE] ${level} ${msg}`
      if (level === 'ERROR') console.error(line, extra || '')
      else console.log(line, extra || '')
    }

  const stable = String(opts.stableUserDataDir || '').trim()
  const legacy = String(opts.legacyPortableUserDataDir || '').trim()
  if (!stable || !legacy || !api.existsSync(legacy)) {
    return { migrated: false, reason: 'no_legacy' }
  }

  const stableDataDir = path.join(stable, 'data')
  const stableDb = path.join(stableDataDir, DB_NAME)
  const markerPath = path.join(stable, BUSINESS_MIGRATION_MARKER)

  const verified = resolveVerifiedMarker(stable, stableDb, api, classify)
  if (verified.skip) {
    return { migrated: false, reason: 'already_migrated', marker: verified.row }
  }
  if (verified.reason && verified.reason.startsWith('marker_')) {
    log('WARN', 'migration marker verification failed — re-evaluating', {
      reason: verified.reason,
      table: verified.table,
    })
  }

  const legacyDb = path.join(legacy, 'data', DB_NAME)

  if (!api.existsSync(legacyDb)) {
    try {
      api.writeFileSync(markerPath, JSON.stringify({
        schema: MARKER_SCHEMA,
        status: 'skipped',
        skipped: 'no_legacy_db',
        verified: true,
        at: new Date().toISOString(),
        from: legacy,
      }, null, 2), 'utf8')
    } catch { /* ignore */ }
    return { migrated: false, reason: 'no_legacy_db' }
  }

  log('INFO', 'legacy db found', { pathHint: 'WXQK-Data/data/wechat-control.sqlite' })
  const legacyClass = classify(legacyDb)
  if (!legacyClass.readable) {
    return { migrated: false, reason: 'legacy_unreadable', error: legacyClass.error, legacyClassification: legacyClass.classification }
  }

  let stableClass = api.existsSync(stableDb)
    ? classify(stableDb)
    : {
      exists: false,
      readable: true,
      businessCounts: {},
      bootstrapCounts: {},
      settings: { bootstrapKeys: [], userKeys: [], unknownKeys: [] },
      meaningfulRows: 0,
      bootstrapRows: 0,
      userSettingRows: 0,
      classification: 'missing',
      counts: {},
      totalRows: 0,
      empty: true,
    }

  // Corrupt stable + meaningful legacy → treat as recoverable (backup then replace)
  const stableCorrupt = Boolean(stableClass.exists && !stableClass.readable)
  if (stableCorrupt) {
    log('WARN', 'stable DB unreadable — will attempt legacy recovery if safe', {
      error: stableClass.error,
    })
    stableClass = {
      ...stableClass,
      classification: 'unreadable',
      meaningfulRows: 0,
      userSettingRows: 0,
    }
  }

  if (legacyClass.classification !== 'meaningful_business') {
    try {
      api.writeFileSync(markerPath, JSON.stringify({
        schema: MARKER_SCHEMA,
        status: 'skipped',
        skipped: legacyClass.classification === 'empty' ? 'legacy_empty' : 'NO_MEANINGFUL_LEGACY_DATA',
        verified: true,
        at: new Date().toISOString(),
        legacyClassification: legacyClass.classification,
        stableClassification: stableClass.classification,
        legacyMeaningfulRows: legacyClass.meaningfulRows,
        stableMeaningfulRows: stableClass.meaningfulRows,
        meaningfulCounts: snapshotMeaningfulCounts(stableClass),
      }, null, 2), 'utf8')
    } catch { /* ignore */ }
    return {
      migrated: false,
      reason: legacyClass.classification === 'empty' ? 'legacy_empty' : 'NO_MEANINGFUL_LEGACY_DATA',
      legacyClassification: legacyClass.classification,
      stableClassification: stableClass.classification,
    }
  }

  // True conflict: both sides have meaningful *table* business (not settings-only)
  if (stableClass.classification === 'meaningful_business') {
    log('ERROR', 'LEGACY_DATA_CONFLICT — both DBs have meaningful business data', {
      legacyMeaningful: legacyClass.meaningfulRows,
      stableMeaningful: stableClass.meaningfulRows,
    })
    return {
      migrated: false,
      reason: 'LEGACY_DATA_CONFLICT',
      code: 'LEGACY_DATA_CONFLICT',
      legacyClassification: legacyClass.classification,
      stableClassification: stableClass.classification,
      legacyCounts: legacyClass.counts,
      stableCounts: stableClass.counts,
      legacyMeaningfulRows: legacyClass.meaningfulRows,
      stableMeaningfulRows: stableClass.meaningfulRows,
    }
  }

  const needsSettingsMerge = stableClass.classification === 'user_settings_only'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupKind = needsSettingsMerge
    ? 'user-settings'
    : (stableClass.classification === 'bootstrap_only'
      ? 'bootstrap'
      : (stableCorrupt ? 'corrupt' : (stableClass.classification === 'empty' ? 'empty' : 'missing')))
  const backupDir = path.join(stableDataDir, `migration-backup-${backupKind}-${stamp}`)
  let backed = []

  log('INFO', 'migration started', {
    legacyClassification: legacyClass.classification,
    stableClassification: stableClass.classification,
    legacyMeaningful: legacyClass.meaningfulRows,
    stableBootstrap: stableClass.bootstrapRows,
    stableUserSettings: stableClass.userSettingRows,
    needsSettingsMerge,
  })

  try {
    if (api.existsSync(stableDb)) {
      backed = backupStableDbFiles(backupDir, stableDb, api)
    }
  } catch (err) {
    return {
      migrated: false,
      reason: 'stable_backup_failed',
      error: String(err?.message || err),
      legacyClassification: legacyClass.classification,
      stableClassification: stableClass.classification,
    }
  }

  const cp = checkpoint(legacyDb)
  api.mkdirSync(stableDataDir, { recursive: true })

  const stagingDir = path.join(stableDataDir, `.wxqk-migrate-staging-${stamp}`)
  const copied = []
  try {
    api.mkdirSync(stagingDir, { recursive: true })
    for (const src of dbSidecars(legacyDb)) {
      if (!api.existsSync(src)) continue
      const name = path.basename(src)
      api.copyFileSync(src, path.join(stagingDir, name))
      copied.push(name)
    }

    const stagedDb = path.join(stagingDir, DB_NAME)
    const stagedClass = classify(stagedDb)
    const stagedOk = verifyMeaningfulCounts(legacyClass, stagedClass)
    if (!stagedClass.readable || !stagedOk.ok) {
      throw Object.assign(new Error('staging verify failed'), {
        code: 'verify_failed',
        detail: stagedOk,
        error: stagedClass.error,
      })
    }

    const liveAside = path.join(stableDataDir, `.wxqk-live-aside-${stamp}`)
    api.mkdirSync(liveAside, { recursive: true })
    for (const f of dbSidecars(stableDb)) {
      if (!api.existsSync(f)) continue
      api.renameSync(f, path.join(liveAside, path.basename(f)))
    }
    for (const name of copied) {
      const from = path.join(stagingDir, name)
      const to = path.join(stableDataDir, name)
      try {
        api.renameSync(from, to)
      } catch {
        api.copyFileSync(from, to)
        try { api.unlinkSync(from) } catch { /* ignore */ }
      }
    }

    try {
      for (const name of [DB_NAME, `${DB_NAME}-wal`, `${DB_NAME}-shm`]) {
        const p = path.join(liveAside, name)
        try { if (api.existsSync(p)) api.unlinkSync(p) } catch { /* ignore */ }
        const s = path.join(stagingDir, name)
        try { if (api.existsSync(s)) api.unlinkSync(s) } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  } catch (err) {
    try {
      if (backed.length > 0) restoreStableDbFiles(backupDir, stableDb, api)
    } catch { /* ignore */ }
    return {
      migrated: false,
      reason: 'LEGACY_MIGRATION_FAILED_ROLLED_BACK',
      code: 'LEGACY_MIGRATION_FAILED_ROLLED_BACK',
      error: String(err?.message || err),
      detail: err?.detail,
      checkpointOk: cp.ok,
      legacyClassification: legacyClass.classification,
      stableBeforeClassification: stableClass.classification,
      rolledBack: backed.length > 0,
    }
  }

  let settingsMerge = { merged: 0 }
  if (needsSettingsMerge && backed.length > 0) {
    const backupDbPath = path.join(backupDir, DB_NAME)
    settingsMerge = mergeSettings(backupDbPath, stableDb)
    if (settingsMerge.error) {
      log('WARN', 'app_settings merge incomplete', { error: settingsMerge.error })
    } else {
      log('INFO', 'app_settings merged from pre-migration stable', { merged: settingsMerge.merged })
    }
  }

  const afterClass = classify(stableDb)
  const verifiedCounts = verifyMeaningfulCounts(legacyClass, afterClass)
  if (!afterClass.readable || !verifiedCounts.ok) {
    try {
      if (backed.length > 0) restoreStableDbFiles(backupDir, stableDb, api)
    } catch { /* ignore */ }
    return {
      migrated: false,
      reason: 'LEGACY_MIGRATION_FAILED_ROLLED_BACK',
      code: 'LEGACY_MIGRATION_FAILED_ROLLED_BACK',
      error: afterClass.error || 'final verify failed',
      detail: verifiedCounts,
      legacyClassification: legacyClass.classification,
      stableBeforeClassification: stableClass.classification,
      rolledBack: backed.length > 0,
    }
  }

  const meaningfulCounts = snapshotMeaningfulCounts(afterClass)
  const summary = {
    schema: MARKER_SCHEMA,
    status: 'migrated',
    verified: true,
    at: new Date().toISOString(),
    from: legacy,
    copied,
    checkpointOk: cp.ok,
    backupDir: backed.length ? backupDir : '',
    backed,
    legacyClassification: legacyClass.classification,
    stableBeforeClassification: stableClass.classification,
    legacyMeaningfulRows: legacyClass.meaningfulRows,
    stableBeforeMeaningfulRows: stableClass.meaningfulRows,
    stableBeforeBootstrapRows: stableClass.bootstrapRows,
    stableBeforeUserSettingRows: stableClass.userSettingRows,
    meaningfulCounts,
    settingsMerge,
    legacyCounts: legacyClass.counts,
    stableCounts: afterClass.counts,
    legacyTotal: legacyClass.totalRows,
    stableTotal: afterClass.totalRows,
    supersededV2Marker: api.existsSync(path.join(stable, BUSINESS_MIGRATION_MARKER_V2)),
    supersededV3Marker: api.existsSync(path.join(stable, BUSINESS_MIGRATION_MARKER_V3)),
  }

  try {
    api.writeFileSync(markerPath, JSON.stringify(summary, null, 2), 'utf8')
  } catch { /* ignore — migration already verified on disk */ }

  log('INFO', 'migration complete', {
    legacyMeaningful: legacyClass.meaningfulRows,
    stableMeaningful: afterClass.meaningfulRows,
    stableBefore: stableClass.classification,
    settingsMerged: settingsMerge.merged || 0,
  })

  return {
    migrated: true,
    reason: 'copied',
    code: 'OK',
    ...summary,
  }
}

module.exports = {
  BUSINESS_MIGRATION_MARKER,
  BUSINESS_MIGRATION_MARKER_V2,
  BUSINESS_MIGRATION_MARKER_V3,
  MARKER_SCHEMA,
  DB_NAME,
  COUNT_TABLES,
  MEANINGFUL_TABLES,
  KNOWN_MEANINGFUL_TABLES,
  BOOTSTRAP_TABLES,
  RUNTIME_NOISE_TABLES,
  BOOTSTRAP_SETTING_KEYS,
  USER_SETTING_KEYS,
  classifyBusinessDb,
  classifyAppSettingsKeys,
  inspectSqliteDb,
  checkpointSqliteDb,
  readMigrationMarker,
  resolveVerifiedMarker,
  verifyMeaningfulCounts,
  mergeUserAppSettingsFromBackup,
  migrateLegacyBusinessDataIfNeeded,
}
