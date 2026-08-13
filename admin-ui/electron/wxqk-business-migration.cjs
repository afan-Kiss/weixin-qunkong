'use strict'

/**
 * Migrate legacy portable business SQLite into stable userData BEFORE initStorage.
 *
 * Critical rule: stable DB with only logs / default app_settings is BOOTSTRAP_ONLY
 * and must NOT block migration of a meaningful legacy business DB (v1.99 noise case).
 */

const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const BUSINESS_MIGRATION_MARKER_V2 = '.wxqk-business-data-migrated-v2'
const BUSINESS_MIGRATION_MARKER = '.wxqk-business-data-migrated-v3'
const MARKER_SCHEMA = 3
const DB_NAME = 'wechat-control.sqlite'

/** Tables that represent real user business data. */
const MEANINGFUL_TABLES = [
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
  'blocked_chatrooms',
  'operation_history',
  'exclusion_rules',
  'risk_events',
  'remote_session_audit',
]

/** Startup noise — alone never means "already has business data". */
const BOOTSTRAP_TABLES = [
  'app_settings',
  'logs',
  'backend_session_cache',
  'wechat_api_compatibility',
  'wechat_api_runtime_samples',
]

/** @deprecated keep for callers that still count a flat list */
const COUNT_TABLES = [...new Set([...MEANINGFUL_TABLES, ...BOOTSTRAP_TABLES])]

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
      meaningfulRows: 0,
      bootstrapRows: 0,
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
      meaningfulRows: -1,
      bootstrapRows: -1,
      classification: 'unreadable',
      error: String(err?.message || err),
    }
  }

  const businessCounts = {}
  const bootstrapCounts = {}
  let meaningfulRows = 0
  let bootstrapRows = 0
  try {
    for (const table of MEANINGFUL_TABLES) {
      const n = countTable(db, table)
      businessCounts[table] = n
      meaningfulRows += n
    }
    for (const table of BOOTSTRAP_TABLES) {
      const n = countTable(db, table)
      bootstrapCounts[table] = n
      bootstrapRows += n
    }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }

  let classification = 'empty'
  if (meaningfulRows > 0) classification = 'meaningful_business'
  else if (bootstrapRows > 0) classification = 'bootstrap_only'

  return {
    exists: true,
    readable: true,
    businessCounts,
    bootstrapCounts,
    meaningfulRows,
    bootstrapRows,
    classification,
    // Back-compat fields used by older tests / logs
    counts: { ...businessCounts, ...bootstrapCounts },
    totalRows: meaningfulRows + bootstrapRows,
    empty: meaningfulRows === 0 && bootstrapRows === 0,
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

/**
 * @param {string} markerPath
 * @param {{ existsSync?: typeof fs.existsSync, readFileSync?: typeof fs.readFileSync }} [deps]
 */
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
 * Fast-skip only when a verified schema>=3 success marker exists.
 * @param {string} stableDir
 * @param {object} deps
 */
function resolveVerifiedMarker(stableDir, deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync
  const readFileSync = deps.readFileSync || fs.readFileSync
  const v3 = path.join(stableDir, BUSINESS_MIGRATION_MARKER)
  const row = readMigrationMarker(v3, { existsSync, readFileSync })
  if (
    row
    && Number(row.schema || 0) >= MARKER_SCHEMA
    && row.status === 'migrated'
    && row.verified === true
  ) {
    return { skip: true, marker: v3, row }
  }
  return { skip: false, marker: v3, row }
}

/**
 * @param {string} backupDir
 * @param {string} stableDb
 * @param {object} api
 */
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

/**
 * @param {string} backupDir
 * @param {string} stableDb
 * @param {object} api
 */
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
 * Verify meaningful table counts did not drop vs legacy.
 * @param {ReturnType<typeof classifyBusinessDb>} legacyClass
 * @param {ReturnType<typeof classifyBusinessDb>} afterClass
 */
function verifyMeaningfulCounts(legacyClass, afterClass) {
  for (const table of MEANINGFUL_TABLES) {
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

/**
 * @param {{
 *   stableUserDataDir: string,
 *   legacyPortableUserDataDir: string,
 *   log?: (level: string, msg: string, extra?: object) => void,
 *   existsSync?: typeof fs.existsSync,
 *   mkdirSync?: typeof fs.mkdirSync,
 *   copyFileSync?: typeof fs.copyFileSync,
 *   renameSync?: typeof fs.renameSync,
 *   writeFileSync?: typeof fs.writeFileSync,
 *   unlinkSync?: typeof fs.unlinkSync,
 *   readFileSync?: typeof fs.readFileSync,
 *   classifyBusinessDb?: typeof classifyBusinessDb,
 *   checkpointSqliteDb?: typeof checkpointSqliteDb,
 * }} opts
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

  const verified = resolveVerifiedMarker(stable, api)
  if (verified.skip) {
    return { migrated: false, reason: 'already_migrated', marker: verified.row }
  }

  const legacyDb = path.join(legacy, 'data', DB_NAME)
  const stableDataDir = path.join(stable, 'data')
  const stableDb = path.join(stableDataDir, DB_NAME)
  const markerV3 = path.join(stable, BUSINESS_MIGRATION_MARKER)

  if (!api.existsSync(legacyDb)) {
    try {
      api.writeFileSync(markerV3, JSON.stringify({
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

  const stableClass = api.existsSync(stableDb)
    ? classify(stableDb)
    : {
      exists: false,
      readable: true,
      businessCounts: {},
      bootstrapCounts: {},
      meaningfulRows: 0,
      bootstrapRows: 0,
      classification: 'missing',
      counts: {},
      totalRows: 0,
      empty: true,
    }

  if (!stableClass.readable && stableClass.exists) {
    return { migrated: false, reason: 'stable_unreadable', error: stableClass.error }
  }

  // No meaningful legacy — keep stable
  if (legacyClass.classification !== 'meaningful_business') {
    try {
      api.writeFileSync(markerV3, JSON.stringify({
        schema: MARKER_SCHEMA,
        status: 'skipped',
        skipped: legacyClass.classification === 'empty' ? 'legacy_empty' : 'NO_MEANINGFUL_LEGACY_DATA',
        verified: true,
        at: new Date().toISOString(),
        legacyClassification: legacyClass.classification,
        stableClassification: stableClass.classification,
        legacyMeaningfulRows: legacyClass.meaningfulRows,
        stableMeaningfulRows: stableClass.meaningfulRows,
      }, null, 2), 'utf8')
    } catch { /* ignore */ }
    return {
      migrated: false,
      reason: legacyClass.classification === 'empty' ? 'legacy_empty' : 'NO_MEANINGFUL_LEGACY_DATA',
      legacyClassification: legacyClass.classification,
      stableClassification: stableClass.classification,
    }
  }

  // True conflict: both have meaningful business data
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

  // legacy meaningful + stable missing|empty|bootstrap_only → migrate
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupKind = stableClass.classification === 'bootstrap_only'
    ? 'bootstrap'
    : (stableClass.classification === 'empty' ? 'empty' : 'missing')
  const backupDir = path.join(stableDataDir, `migration-backup-${backupKind}-${stamp}`)
  let backed = []

  log('INFO', 'migration started', {
    legacyClassification: legacyClass.classification,
    stableClassification: stableClass.classification,
    legacyMeaningful: legacyClass.meaningfulRows,
    stableBootstrap: stableClass.bootstrapRows,
  })

  try {
    if (stableClass.exists && stableClass.classification !== 'missing') {
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

    // Verify staging copy before touching live stable files
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

    // Atomic-ish replace: move live aside only after staging verified
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

    // Cleanup staging / aside (backupDir already has pre-migration stable)
    try {
      for (const name of [DB_NAME, `${DB_NAME}-wal`, `${DB_NAME}-shm`]) {
        const p = path.join(liveAside, name)
        try { if (api.existsSync(p)) api.unlinkSync(p) } catch { /* ignore */ }
        const s = path.join(stagingDir, name)
        try { if (api.existsSync(s)) api.unlinkSync(s) } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  } catch (err) {
    // Restore from backup if we had one
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
    legacyCounts: legacyClass.counts,
    stableCounts: afterClass.counts,
    legacyTotal: legacyClass.totalRows,
    stableTotal: afterClass.totalRows,
    // Note if an old v2 marker was ignored / superseded
    supersededV2Marker: api.existsSync(path.join(stable, BUSINESS_MIGRATION_MARKER_V2)),
  }

  try {
    api.writeFileSync(markerV3, JSON.stringify(summary, null, 2), 'utf8')
  } catch { /* ignore — migration already verified on disk */ }

  log('INFO', 'migration complete', {
    legacyMeaningful: legacyClass.meaningfulRows,
    stableMeaningful: afterClass.meaningfulRows,
    stableBefore: stableClass.classification,
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
  MARKER_SCHEMA,
  DB_NAME,
  COUNT_TABLES,
  MEANINGFUL_TABLES,
  BOOTSTRAP_TABLES,
  classifyBusinessDb,
  inspectSqliteDb,
  checkpointSqliteDb,
  readMigrationMarker,
  resolveVerifiedMarker,
  verifyMeaningfulCounts,
  migrateLegacyBusinessDataIfNeeded,
}
