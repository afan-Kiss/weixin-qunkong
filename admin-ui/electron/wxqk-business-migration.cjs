'use strict'

/**
 * Migrate legacy portable business SQLite into stable userData BEFORE initStorage.
 * Never overwrite a non-empty stable DB. Never delete the legacy folder.
 */

const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const BUSINESS_MIGRATION_MARKER = '.wxqk-business-data-migrated-v2'
const DB_NAME = 'wechat-control.sqlite'
const COUNT_TABLES = [
  'app_settings',
  'wechat_instances',
  'contacts',
  'chatrooms',
  'tasks',
  'qr_items',
  'logs',
]

/**
 * @param {string} dbPath
 * @returns {{ exists: boolean, empty: boolean, counts: Record<string, number>, totalRows: number, error?: string }}
 */
function inspectSqliteDb(dbPath) {
  if (!fs.existsSync(dbPath)) {
    return { exists: false, empty: true, counts: {}, totalRows: 0 }
  }
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (err) {
    // Fall back to read-write open for inspection if readOnly fails
    try {
      db = new DatabaseSync(dbPath)
    } catch (err2) {
      return {
        exists: true,
        empty: false,
        counts: {},
        totalRows: -1,
        error: String(err2?.message || err?.message || err2),
      }
    }
  }
  const counts = {}
  let totalRows = 0
  try {
    for (const table of COUNT_TABLES) {
      try {
        const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()
        const n = Number(row?.c || 0)
        counts[table] = n
        totalRows += n
      } catch {
        counts[table] = 0
      }
    }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
  return { exists: true, empty: totalRows === 0, counts, totalRows }
}

/**
 * Prefer WAL checkpoint so we can copy the main DB alone.
 * @param {string} dbPath
 */
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
 *   inspectSqliteDb?: typeof inspectSqliteDb,
 *   checkpointSqliteDb?: typeof checkpointSqliteDb,
 * }} opts
 */
function migrateLegacyBusinessDataIfNeeded(opts) {
  const existsSync = opts.existsSync || fs.existsSync
  const mkdirSync = opts.mkdirSync || fs.mkdirSync
  const copyFileSync = opts.copyFileSync || fs.copyFileSync
  const renameSync = opts.renameSync || fs.renameSync
  const writeFileSync = opts.writeFileSync || fs.writeFileSync
  const unlinkSync = opts.unlinkSync || fs.unlinkSync
  const inspect = opts.inspectSqliteDb || inspectSqliteDb
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
  if (!stable || !legacy || !existsSync(legacy)) {
    return { migrated: false, reason: 'no_legacy' }
  }

  const marker = path.join(stable, BUSINESS_MIGRATION_MARKER)
  if (existsSync(marker)) {
    return { migrated: false, reason: 'already_migrated' }
  }

  const legacyDb = path.join(legacy, 'data', DB_NAME)
  const stableDataDir = path.join(stable, 'data')
  const stableDb = path.join(stableDataDir, DB_NAME)

  if (!existsSync(legacyDb)) {
    try {
      writeFileSync(marker, JSON.stringify({
        at: new Date().toISOString(),
        skipped: 'no_legacy_db',
        from: legacy,
      }, null, 2), 'utf8')
    } catch { /* ignore */ }
    return { migrated: false, reason: 'no_legacy_db' }
  }

  log('INFO', 'legacy db found', { pathHint: 'WXQK-Data/data/wechat-control.sqlite' })
  const legacyInfo = inspect(legacyDb)
  if (legacyInfo.error) {
    return { migrated: false, reason: 'legacy_unreadable', error: legacyInfo.error }
  }
  if (legacyInfo.empty) {
    try {
      writeFileSync(marker, JSON.stringify({
        at: new Date().toISOString(),
        skipped: 'legacy_empty',
        legacyCounts: legacyInfo.counts,
      }, null, 2), 'utf8')
    } catch { /* ignore */ }
    return { migrated: false, reason: 'legacy_empty', legacyCounts: legacyInfo.counts }
  }

  if (existsSync(stableDb)) {
    const stableInfo = inspect(stableDb)
    if (stableInfo.error) {
      return { migrated: false, reason: 'stable_unreadable', error: stableInfo.error }
    }
    if (!stableInfo.empty) {
      log('ERROR', 'LEGACY_DATA_CONFLICT — keeping both databases', {
        legacyTotal: legacyInfo.totalRows,
        stableTotal: stableInfo.totalRows,
      })
      return {
        migrated: false,
        reason: 'LEGACY_DATA_CONFLICT',
        code: 'LEGACY_DATA_CONFLICT',
        legacyCounts: legacyInfo.counts,
        stableCounts: stableInfo.counts,
      }
    }
    // Empty stable DB (premature create) — replace after backup
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupDir = path.join(stableDataDir, `migration-backup-empty-${stamp}`)
    try {
      mkdirSync(backupDir, { recursive: true })
      for (const f of dbSidecars(stableDb)) {
        if (!existsSync(f)) continue
        copyFileSync(f, path.join(backupDir, path.basename(f)))
        try { unlinkSync(f) } catch { /* ignore */ }
      }
    } catch (err) {
      return { migrated: false, reason: 'empty_stable_backup_failed', error: String(err?.message || err) }
    }
  }

  log('INFO', 'migration started', { legacyTotal: legacyInfo.totalRows })
  const cp = checkpoint(legacyDb)
  mkdirSync(stableDataDir, { recursive: true })

  // After checkpoint prefer main DB; still copy wal/shm if present (safety).
  const copied = []
  try {
    for (const src of dbSidecars(legacyDb)) {
      if (!existsSync(src)) continue
      const dest = path.join(stableDataDir, path.basename(src))
      const tmp = `${dest}.migrating`
      copyFileSync(src, tmp)
      try { if (existsSync(dest)) unlinkSync(dest) } catch { /* ignore */ }
      renameSync(tmp, dest)
      copied.push(path.basename(src))
    }
  } catch (err) {
    return {
      migrated: false,
      reason: 'copy_failed',
      error: String(err?.message || err),
      checkpointOk: cp.ok,
    }
  }

  const after = inspect(stableDb)
  if (after.error || after.empty) {
    return {
      migrated: false,
      reason: 'verify_failed',
      error: after.error || 'stable db empty after copy',
      copied,
    }
  }

  // For every legacy table that had rows, stable must not drop to 0.
  for (const table of COUNT_TABLES) {
    const beforeN = Number(legacyInfo.counts[table] || 0)
    const afterN = Number(after.counts[table] || 0)
    if (beforeN > 0 && afterN === 0) {
      return {
        migrated: false,
        reason: 'row_count_mismatch',
        table,
        legacyCount: beforeN,
        stableCount: afterN,
      }
    }
  }

  const summary = {
    at: new Date().toISOString(),
    from: legacy,
    copied,
    checkpointOk: cp.ok,
    legacyCounts: legacyInfo.counts,
    stableCounts: after.counts,
    legacyTotal: legacyInfo.totalRows,
    stableTotal: after.totalRows,
  }
  try {
    writeFileSync(marker, JSON.stringify(summary, null, 2), 'utf8')
  } catch { /* ignore */ }

  log('INFO', 'migration complete', {
    legacyTotal: legacyInfo.totalRows,
    stableTotal: after.totalRows,
    tableCounts: after.counts,
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
  DB_NAME,
  COUNT_TABLES,
  inspectSqliteDb,
  checkpointSqliteDb,
  migrateLegacyBusinessDataIfNeeded,
}
