'use strict'

/**
 * SQLite schema migrations for multi-instance task / instance / candidate ownership.
 * @param {import('node:sqlite').DatabaseSync} database
 */
function migrateTaskItemsUnique(database) {
  const indexes = database.prepare("PRAGMA index_list('task_items')").all()
  let needs = false
  for (const idx of indexes) {
    if (!idx.unique) continue
    const cols = database.prepare(`PRAGMA index_info('${idx.name}')`).all().map((c) => c.name)
    // Old UNIQUE(task_id, target_key, action_type) — 3 cols without instance_id
    if (cols.length === 3 && cols.includes('task_id') && cols.includes('target_key') && cols.includes('action_type') && !cols.includes('instance_id')) {
      needs = true
      break
    }
  }
  const columns = new Set(database.prepare('PRAGMA table_info(task_items)').all().map((c) => c.name))
  if (!columns.has('account_wxid')) needs = true
  if (!needs) {
    // Still ensure account_wxid column if somehow unique already correct
    if (!columns.has('account_wxid')) {
      database.exec('ALTER TABLE task_items ADD COLUMN account_wxid TEXT')
    }
    return false
  }
  database.exec('BEGIN IMMEDIATE')
  try {
    const legacyCols = new Set(database.prepare('PRAGMA table_info(task_items)').all().map((c) => c.name))
    const accountSelect = legacyCols.has('account_wxid')
      ? `COALESCE(NULLIF(account_wxid,''), (
          SELECT NULLIF(w.account_wxid,'') FROM wechat_instances w WHERE w.id=task_items_legacy.instance_id
        ))`
      : `(SELECT NULLIF(w.account_wxid,'') FROM wechat_instances w WHERE w.id=task_items_legacy.instance_id)`
    database.exec(`
      ALTER TABLE task_items RENAME TO task_items_legacy;
      CREATE TABLE task_items (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        account_wxid TEXT,
        target_key TEXT NOT NULL,
        action_type TEXT NOT NULL,
        status TEXT NOT NULL,
        request_json TEXT,
        response_json TEXT,
        error TEXT,
        started_at TEXT,
        finished_at TEXT,
        UNIQUE(task_id, instance_id, target_key, action_type),
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      INSERT OR IGNORE INTO task_items(
        id, task_id, instance_id, account_wxid, target_key, action_type, status,
        request_json, response_json, error, started_at, finished_at
      )
      SELECT
        id, task_id, instance_id,
        ${accountSelect},
        target_key, action_type, status,
        request_json, response_json, error, started_at, finished_at
      FROM task_items_legacy;
      DROP TABLE task_items_legacy;
      CREATE INDEX IF NOT EXISTS idx_task_items_task ON task_items(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_items_account ON task_items(account_wxid);
    `)
    database.exec('COMMIT')
    return true
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

/**
 * Remove UNIQUE on wechat_instances api_port/tcp_port while keeping rows.
 * @param {import('node:sqlite').DatabaseSync} database
 */
function migrateWechatInstancesPortUnique(database) {
  const indexes = database.prepare("PRAGMA index_list('wechat_instances')").all()
  let hasPortUnique = false
  for (const idx of indexes) {
    if (!idx.unique) continue
    const cols = database.prepare(`PRAGMA index_info('${idx.name}')`).all().map((c) => c.name)
    if (cols.length === 1 && (cols[0] === 'api_port' || cols[0] === 'tcp_port')) {
      hasPortUnique = true
      break
    }
  }
  // Also check CREATE TABLE inline UNIQUE via table_info — SQLite may auto-index
  if (!hasPortUnique) {
    // Fresh DB created with UNIQUE — index_list usually shows sqlite_autoindex
    for (const idx of indexes) {
      if (!idx.unique) continue
      const cols = database.prepare(`PRAGMA index_info('${idx.name}')`).all().map((c) => c.name)
      if (cols.includes('api_port') || cols.includes('tcp_port')) {
        hasPortUnique = true
        break
      }
    }
  }
  if (!hasPortUnique) return false
  const columns = new Set(database.prepare('PRAGMA table_info(wechat_instances)').all().map((c) => c.name))
  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec(`
      ALTER TABLE wechat_instances RENAME TO wechat_instances_legacy;
      CREATE TABLE wechat_instances (
        id TEXT PRIMARY KEY,
        api_port INTEGER NOT NULL,
        tcp_port INTEGER NOT NULL,
        pid INTEGER,
        account_wxid TEXT,
        status TEXT NOT NULL,
        managed INTEGER NOT NULL DEFAULT 0,
        nickname TEXT,
        alias TEXT,
        avatar TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wechat_instances_api_port ON wechat_instances(api_port);
      CREATE INDEX IF NOT EXISTS idx_wechat_instances_tcp_port ON wechat_instances(tcp_port);
      CREATE INDEX IF NOT EXISTS idx_wechat_instances_account ON wechat_instances(account_wxid);
    `)
    const selectCols = [
      'id', 'api_port', 'tcp_port', 'pid', 'account_wxid', 'status',
      columns.has('managed') ? 'managed' : '0',
      columns.has('nickname') ? 'nickname' : 'NULL',
      columns.has('alias') ? 'alias' : 'NULL',
      columns.has('avatar') ? 'avatar' : 'NULL',
      'created_at', 'updated_at',
    ]
    database.exec(`
      INSERT OR IGNORE INTO wechat_instances(
        id, api_port, tcp_port, pid, account_wxid, status, managed, nickname, alias, avatar, created_at, updated_at
      )
      SELECT ${selectCols.join(', ')} FROM wechat_instances_legacy;
      DROP TABLE wechat_instances_legacy;
    `)
    database.exec('COMMIT')
    return true
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

/**
 * chat_add_candidates: prefer UNIQUE(account_wxid, sender_wxid, source_room_id) when account known.
 * @param {import('node:sqlite').DatabaseSync} database
 */
function migrateChatAddCandidatesAccountUnique(database) {
  const columns = new Set(database.prepare('PRAGMA table_info(chat_add_candidates)').all().map((c) => c.name))
  if (!columns.has('account_wxid') || !columns.has('source_room_id')) return false
  const indexes = database.prepare("PRAGMA index_list('chat_add_candidates')").all()
  for (const idx of indexes) {
    if (!idx.unique) continue
    const cols = database.prepare(`PRAGMA index_info('${idx.name}')`).all().map((c) => c.name)
    if (cols.includes('account_wxid') && cols.includes('sender_wxid') && cols.includes('source_room_id')) {
      return false
    }
  }
  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec(`
      ALTER TABLE chat_add_candidates RENAME TO chat_add_candidates_legacy2;
      CREATE TABLE chat_add_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        sender_wxid TEXT NOT NULL,
        nickname TEXT,
        message_preview TEXT,
        matched_keyword TEXT,
        status TEXT NOT NULL DEFAULT 'PENDING',
        created_at TEXT NOT NULL,
        source_room_id TEXT NOT NULL,
        source_room_name TEXT,
        source_instance_port INTEGER,
        account_wxid TEXT,
        sender_v3 TEXT,
        received_at TEXT NOT NULL,
        UNIQUE(instance_id, sender_wxid, source_room_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_add_cand_account
        ON chat_add_candidates(account_wxid, sender_wxid, source_room_id)
        WHERE account_wxid IS NOT NULL AND account_wxid != '';
      INSERT OR IGNORE INTO chat_add_candidates(
        id, instance_id, room_id, sender_wxid, nickname, message_preview, matched_keyword, status, created_at,
        source_room_id, source_room_name, source_instance_port, account_wxid, sender_v3, received_at
      )
      SELECT
        id, instance_id, room_id, sender_wxid, nickname, message_preview, matched_keyword, status, created_at,
        source_room_id, source_room_name, source_instance_port, account_wxid, sender_v3, received_at
      FROM chat_add_candidates_legacy2;
      DROP TABLE chat_add_candidates_legacy2;
    `)
    database.exec('COMMIT')
    return true
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

/**
 * Migrate current directory snapshot ownership AAA → BBB (same account).
 * New BBB rows win; AAA fills gaps then AAA snapshot rows deleted.
 */
function migrateDirectorySnapshotOwnership(database, oldInstanceId, newInstanceId) {
  const oldId = String(oldInstanceId || '').trim()
  const newId = String(newInstanceId || '').trim()
  if (!oldId || !newId || oldId === newId) return { ok: false, reason: 'INVALID' }
  const now = new Date().toISOString()
  database.exec('BEGIN IMMEDIATE')
  try {
    // contacts: insert missing into new, then delete old
    database.prepare(`
      INSERT OR IGNORE INTO contacts(wxid,source_instance_id,nickname,remark,alias,avatar,is_group,updated_at)
      SELECT wxid, ?, nickname, remark, alias, avatar, is_group, ?
      FROM contacts WHERE source_instance_id=?
    `).run(newId, now, oldId)
    database.prepare('DELETE FROM contacts WHERE source_instance_id=?').run(oldId)

    database.prepare(`
      INSERT OR IGNORE INTO chatrooms(room_id,source_instance_id,name,member_count,owner_wxid,saved,updated_at)
      SELECT room_id, ?, name, member_count, owner_wxid, saved, ?
      FROM chatrooms WHERE source_instance_id=?
    `).run(newId, now, oldId)
    database.prepare('DELETE FROM chatrooms WHERE source_instance_id=?').run(oldId)

    database.prepare(`
      INSERT OR IGNORE INTO chatroom_sources(room_id,instance_id,updated_at)
      SELECT room_id, ?, ? FROM chatroom_sources WHERE instance_id=?
    `).run(newId, now, oldId)
    database.prepare('DELETE FROM chatroom_sources WHERE instance_id=?').run(oldId)

    database.prepare(`
      INSERT OR IGNORE INTO chatroom_members(room_id,source_instance_id,member_wxid,nickname,avatar,inviter_wxid,member_flag,updated_at)
      SELECT room_id, ?, member_wxid, nickname, avatar, inviter_wxid, member_flag, ?
      FROM chatroom_members WHERE source_instance_id=?
    `).run(newId, now, oldId)
    database.prepare('DELETE FROM chatroom_members WHERE source_instance_id=?').run(oldId)

    database.exec('COMMIT')
    return { ok: true }
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

/**
 * Rebind PENDING chat-add candidates from old STOPPED instances to new ONLINE instance.
 */
function rebindPendingChatAddCandidates(database, accountWxid, newInstanceId, onlineInstanceIds) {
  const account = String(accountWxid || '').trim()
  const newId = String(newInstanceId || '').trim()
  if (!account || !newId) return 0
  const online = new Set((onlineInstanceIds || []).map(String))
  const rows = database.prepare(`
    SELECT id, instance_id FROM chat_add_candidates
    WHERE status='PENDING' AND account_wxid=? AND instance_id!=?
  `).all(account, newId)
  let n = 0
  const update = database.prepare('UPDATE chat_add_candidates SET instance_id=? WHERE id=?')
  for (const row of rows) {
    if (online.has(String(row.instance_id))) continue
    update.run(newId, row.id)
    n += 1
  }
  return n
}

function runStorageSchemaMigrations(database) {
  migrateWechatInstancesPortUnique(database)
  migrateTaskItemsUnique(database)
  migrateChatAddCandidatesAccountUnique(database)
}

module.exports = {
  migrateTaskItemsUnique,
  migrateWechatInstancesPortUnique,
  migrateChatAddCandidatesAccountUnique,
  migrateDirectorySnapshotOwnership,
  rebindPendingChatAddCandidates,
  runStorageSchemaMigrations,
}
