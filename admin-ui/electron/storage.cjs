const { DatabaseSync } = require('node:sqlite')
const path = require('path')
const { mkdirSync } = require('fs')
const { extractMemberJoins, diffNewMembers } = require('./member-join.cjs')

let db

function migrateDirectoryOwnership(database) {
  const contactPk = database.prepare('PRAGMA table_info(contacts)').all().filter((column) => column.pk).map((column) => column.name)
  const roomColumns = new Set(database.prepare('PRAGMA table_info(chatrooms)').all().map((column) => column.name))
  const memberColumns = new Set(database.prepare('PRAGMA table_info(chatroom_members)').all().map((column) => column.name))
  database.exec('BEGIN IMMEDIATE')
  try {
    if (!contactPk.includes('source_instance_id')) {
      database.exec(`ALTER TABLE contacts RENAME TO contacts_legacy;
        CREATE TABLE contacts (wxid TEXT NOT NULL, source_instance_id TEXT NOT NULL, nickname TEXT, remark TEXT, alias TEXT, avatar TEXT, is_group INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(wxid,source_instance_id));
        INSERT OR IGNORE INTO contacts(wxid,source_instance_id,nickname,remark,alias,avatar,is_group,updated_at)
          SELECT wxid,COALESCE(source_instance_id,''),nickname,remark,alias,avatar,is_group,updated_at FROM contacts_legacy;
        DROP TABLE contacts_legacy;`)
    }
    if (!roomColumns.has('source_instance_id')) {
      database.exec(`ALTER TABLE chatrooms RENAME TO chatrooms_legacy;
        CREATE TABLE chatrooms (room_id TEXT NOT NULL, source_instance_id TEXT NOT NULL, name TEXT, member_count INTEGER, owner_wxid TEXT, saved INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(room_id,source_instance_id));
        INSERT OR IGNORE INTO chatrooms(room_id,source_instance_id,name,member_count,owner_wxid,saved,updated_at)
          SELECT c.room_id,COALESCE(s.instance_id,''),c.name,c.member_count,c.owner_wxid,c.saved,c.updated_at FROM chatrooms_legacy c LEFT JOIN chatroom_sources s ON s.room_id=c.room_id;
        DROP TABLE chatrooms_legacy;`)
    }
    if (!memberColumns.has('source_instance_id')) {
      database.exec(`ALTER TABLE chatroom_members RENAME TO chatroom_members_legacy;
        CREATE TABLE chatroom_members (room_id TEXT NOT NULL, source_instance_id TEXT NOT NULL, member_wxid TEXT NOT NULL, nickname TEXT, avatar TEXT, inviter_wxid TEXT, member_flag INTEGER, updated_at TEXT NOT NULL, PRIMARY KEY(room_id,source_instance_id,member_wxid));
        INSERT OR IGNORE INTO chatroom_members(room_id,source_instance_id,member_wxid,nickname,avatar,inviter_wxid,member_flag,updated_at)
          SELECT m.room_id,COALESCE(s.instance_id,''),m.member_wxid,m.nickname,m.avatar,m.inviter_wxid,m.member_flag,m.updated_at FROM chatroom_members_legacy m LEFT JOIN chatroom_sources s ON s.room_id=m.room_id;
        DROP TABLE chatroom_members_legacy;`)
    }
    database.exec('COMMIT')
  } catch (error) { database.exec('ROLLBACK'); throw error }
}

function initStorage(userDataPath) {
  const dataDir = path.join(userDataPath, 'data')
  mkdirSync(dataDir, { recursive: true })
  db = new DatabaseSync(path.join(dataDir, 'wechat-control.sqlite'))
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wechat_instances (id TEXT PRIMARY KEY, api_port INTEGER UNIQUE NOT NULL, tcp_port INTEGER UNIQUE NOT NULL, pid INTEGER, account_wxid TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wechat_api_compatibility (source_id INTEGER PRIMARY KEY, api_path TEXT NOT NULL, adapter_version TEXT NOT NULL, status TEXT NOT NULL, accepted_field TEXT, verified_at TEXT, note TEXT);
    CREATE TABLE IF NOT EXISTS wechat_api_runtime_samples (id INTEGER PRIMARY KEY AUTOINCREMENT, instance_id TEXT NOT NULL, source_id INTEGER, api_path TEXT NOT NULL, request_json TEXT, response_json TEXT, http_status INTEGER, duration_ms INTEGER, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS contacts (wxid TEXT NOT NULL, source_instance_id TEXT NOT NULL, nickname TEXT, remark TEXT, alias TEXT, avatar TEXT, is_group INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(wxid,source_instance_id));
    CREATE TABLE IF NOT EXISTS chatrooms (room_id TEXT NOT NULL, source_instance_id TEXT NOT NULL, name TEXT, member_count INTEGER, owner_wxid TEXT, saved INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(room_id,source_instance_id));
    CREATE TABLE IF NOT EXISTS chatroom_sources (room_id TEXT NOT NULL, instance_id TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(room_id, instance_id));
    CREATE TABLE IF NOT EXISTS chatroom_members (room_id TEXT NOT NULL, source_instance_id TEXT NOT NULL, member_wxid TEXT NOT NULL, nickname TEXT, avatar TEXT, inviter_wxid TEXT, member_flag INTEGER, updated_at TEXT NOT NULL, PRIMARY KEY(room_id,source_instance_id,member_wxid));
    CREATE TABLE IF NOT EXISTS message_events (id INTEGER PRIMARY KEY AUTOINCREMENT, instance_id TEXT NOT NULL, new_msg_id TEXT, event_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(instance_id, new_msg_id));
    CREATE TABLE IF NOT EXISTS member_join_events (id INTEGER PRIMARY KEY AUTOINCREMENT, instance_id TEXT NOT NULL, room_id TEXT, member_wxid TEXT, event_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS qr_items (id TEXT PRIMARY KEY, sha256 TEXT UNIQUE, source TEXT, local_path TEXT, decoded_text TEXT, qr_type TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS exclusion_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, rule_type TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(rule_type, value));
    CREATE TABLE IF NOT EXISTS operation_history (id INTEGER PRIMARY KEY AUTOINCREMENT, account_wxid TEXT NOT NULL, target_id TEXT NOT NULL, operation_type TEXT NOT NULL, idempotency_key TEXT NOT NULL, result_json TEXT, created_at TEXT NOT NULL, UNIQUE(account_wxid, target_id, operation_type, idempotency_key));
    CREATE TABLE IF NOT EXISTS friend_target_history (account_key TEXT NOT NULL, target_id TEXT NOT NULL, first_task_id TEXT NOT NULL, first_instance_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(account_key,target_id));
    CREATE TABLE IF NOT EXISTS friend_daily_attempts (item_id TEXT PRIMARY KEY, account_wxid TEXT NOT NULL, local_date TEXT NOT NULL, target_id TEXT NOT NULL, submitted_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_friend_daily_attempts_account_date ON friend_daily_attempts(account_wxid,local_date);
    CREATE TABLE IF NOT EXISTS qr_join_daily_attempts (item_id TEXT PRIMARY KEY, account_wxid TEXT NOT NULL, local_date TEXT NOT NULL, target_id TEXT NOT NULL, submitted_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_qr_join_daily_attempts_account_date ON qr_join_daily_attempts(account_wxid,local_date);
    CREATE TABLE IF NOT EXISTS delivered_content_history (account_wxid TEXT NOT NULL, target_id TEXT NOT NULL, content_hash TEXT NOT NULL, first_item_id TEXT NOT NULL, delivered_at TEXT NOT NULL, PRIMARY KEY(account_wxid,target_id,content_hash));
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, config_json TEXT NOT NULL, total INTEGER NOT NULL DEFAULT 0, success INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_items (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, instance_id TEXT NOT NULL, target_key TEXT NOT NULL, action_type TEXT NOT NULL, status TEXT NOT NULL, request_json TEXT, response_json TEXT, error TEXT, started_at TEXT, finished_at TEXT, UNIQUE(task_id, target_key, action_type), FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS risk_events (id INTEGER PRIMARY KEY AUTOINCREMENT, instance_id TEXT NOT NULL, risk_type TEXT NOT NULL, evidence TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, level TEXT NOT NULL, instance_id TEXT, module TEXT, message TEXT NOT NULL, details_json TEXT);
    CREATE TABLE IF NOT EXISTS backend_session_cache (id TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS remote_session_audit (id TEXT PRIMARY KEY, device_id TEXT, permission TEXT, started_at TEXT, ended_at TEXT, result TEXT);
    CREATE TABLE IF NOT EXISTS chat_add_rules (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      instance_id TEXT,
      room_ids_json TEXT NOT NULL DEFAULT '[]',
      keywords_json TEXT NOT NULL DEFAULT '[]',
      exclude_text TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_add_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      sender_wxid TEXT NOT NULL,
      nickname TEXT,
      message_preview TEXT,
      matched_keyword TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TEXT NOT NULL,
      UNIQUE(instance_id, sender_wxid)
    );
  `)
  migrateDirectoryOwnership(db)
  db.prepare(`INSERT OR IGNORE INTO chat_add_rules(id,enabled,instance_id,room_ids_json,keywords_json,exclude_text,updated_at)
    VALUES(1,0,NULL,'[]','[]','',?)`).run(new Date().toISOString())
  const instanceColumns = new Set(db.prepare('PRAGMA table_info(wechat_instances)').all().map((column) => column.name))
  if (!instanceColumns.has('managed')) db.exec('ALTER TABLE wechat_instances ADD COLUMN managed INTEGER NOT NULL DEFAULT 0')
  if (!instanceColumns.has('nickname')) db.exec('ALTER TABLE wechat_instances ADD COLUMN nickname TEXT')
  if (!instanceColumns.has('avatar')) db.exec('ALTER TABLE wechat_instances ADD COLUMN avatar TEXT')
  const joinColumns = new Set(db.prepare('PRAGMA table_info(member_join_events)').all().map((column) => column.name))
  if (!joinColumns.has('nickname')) db.exec('ALTER TABLE member_join_events ADD COLUMN nickname TEXT')
  if (!joinColumns.has('avatar')) db.exec('ALTER TABLE member_join_events ADD COLUMN avatar TEXT')
  if (!joinColumns.has('inviter_wxid')) db.exec('ALTER TABLE member_join_events ADD COLUMN inviter_wxid TEXT')
  if (!joinColumns.has('source')) db.exec("ALTER TABLE member_join_events ADD COLUMN source TEXT NOT NULL DEFAULT 'callback'")
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_member_join_unique ON member_join_events(instance_id, room_id, member_wxid)')
  db.exec(`INSERT OR IGNORE INTO friend_target_history(account_key,target_id,first_task_id,first_instance_id,created_at)
    SELECT COALESCE(NULLIF(w.account_wxid,''),'instance:' || ti.instance_id),ti.target_key,ti.task_id,ti.instance_id,COALESCE(ti.started_at,t.created_at)
    FROM task_items ti JOIN tasks t ON t.id=ti.task_id LEFT JOIN wechat_instances w ON w.id=ti.instance_id
    WHERE ti.action_type='ADD_FRIEND' AND ti.target_key<>''`)
  db.exec(`INSERT OR IGNORE INTO friend_daily_attempts(item_id,account_wxid,local_date,target_id,submitted_at)
    SELECT ti.id,w.account_wxid,date(COALESCE(ti.started_at,ti.finished_at),'localtime'),ti.target_key,COALESCE(ti.started_at,ti.finished_at)
    FROM task_items ti JOIN wechat_instances w ON w.id=ti.instance_id
    WHERE ti.action_type='ADD_FRIEND' AND NULLIF(w.account_wxid,'') IS NOT NULL AND (ti.started_at IS NOT NULL OR ti.finished_at IS NOT NULL)`)
  return db
}

function database() {
  if (!db) throw new Error('SQLite 尚未初始化')
  return db
}

function saveSetting(key, value) {
  database().prepare('INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at').run(key, JSON.stringify(value), new Date().toISOString())
}

function getSettings() {
  return Object.fromEntries(database().prepare('SELECT key,value_json FROM app_settings').all().map((row) => { try { return [row.key, JSON.parse(row.value_json)] } catch { return [row.key, null] } }))
}

function upsertInstance(instance) {
  const now = new Date().toISOString()
  database().prepare(`INSERT INTO wechat_instances(id,api_port,tcp_port,pid,account_wxid,status,managed,nickname,avatar,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET api_port=excluded.api_port,tcp_port=excluded.tcp_port,
    pid=excluded.pid,account_wxid=excluded.account_wxid,status=excluded.status,managed=excluded.managed,nickname=excluded.nickname,avatar=excluded.avatar,updated_at=excluded.updated_at`)
    .run(instance.id, instance.apiPort, instance.tcpPort, instance.pid ?? null, instance.accountWxid ?? null, instance.status, instance.managed ? 1 : 0, instance.nickname ?? null, instance.avatar ?? null, now, now)
}

function listStoredInstances() {
  return database().prepare('SELECT id,api_port AS apiPort,tcp_port AS tcpPort,pid,account_wxid AS accountWxid,status,managed,nickname,avatar FROM wechat_instances ORDER BY created_at').all()
}

function removeInstance(id) { database().prepare('DELETE FROM wechat_instances WHERE id=?').run(id) }
function removeInactiveInstancesByPorts(apiPort, tcpPort) { database().prepare('DELETE FROM wechat_instances WHERE api_port=? OR tcp_port=?').run(apiPort, tcpPort) }

function saveLog(entry) {
  database().prepare('INSERT INTO logs(time,level,instance_id,module,message,details_json) VALUES(?,?,?,?,?,?)').run(entry.time, entry.level, entry.instanceId ?? null, entry.module ?? null, entry.message, JSON.stringify(entry))
}

function listLogs(limit = 500) {
  return database().prepare('SELECT time,level,instance_id AS instanceId,module,message,details_json AS detailsJson FROM logs ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(Number(limit) || 500, 1), 5000))
}
function clearLogs() { database().exec('DELETE FROM logs') }

function saveApiSample(sample) {
  database().prepare('INSERT INTO wechat_api_runtime_samples(instance_id,source_id,api_path,request_json,response_json,http_status,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?)').run(sample.instanceId, sample.sourceId ?? null, sample.path, JSON.stringify(sample.request ?? null), JSON.stringify(sample.response ?? null), sample.httpStatus ?? null, sample.durationMs ?? null, new Date().toISOString())
}

/**
 * 保存微信回调事件；若为进群回调则同步写入最新入群成员表。
 * @param {string} instanceId 微信实例 ID
 * @param {unknown} event 原始回调 JSON
 * @returns {{ joinRecorded: boolean }} 是否写入了进群记录
 */
function saveEvent(instanceId, event) {
  const newMsgId = event?.newMsgId ?? event?.new_msg_id ?? event?.msgId ?? null
  database().prepare('INSERT OR IGNORE INTO message_events(instance_id,new_msg_id,event_json,created_at) VALUES(?,?,?,?)').run(instanceId, newMsgId ? String(newMsgId) : null, JSON.stringify(event), new Date().toISOString())
  const joins = extractMemberJoins(event)
  if (!joins.length) return { joinRecorded: false, joinCount: 0 }
  for (const join of joins) {
    recordMemberJoin({
      instanceId,
      roomId: join.roomId,
      memberWxid: join.memberWxid,
      nickname: join.nickname,
      avatar: join.avatar,
      inviter: join.inviter,
      joinAt: join.joinAt,
      source: 'callback',
      event,
    })
  }
  return { joinRecorded: true, joinCount: joins.length }
}

/**
 * 记录一名最新入群成员（回调或快照差分）。
 * @param {{ instanceId: string, roomId: string, memberWxid: string, nickname?: string, avatar?: string, inviter?: string, joinAt?: string, source?: string, event?: unknown }} row
 * @returns {boolean} 是否为新插入（已存在则更新资料并返回 false）
 */
function recordMemberJoin(row) {
  const instanceId = String(row.instanceId || '')
  const roomId = String(row.roomId || '')
  const memberWxid = String(row.memberWxid || '')
  if (!instanceId || !roomId || !memberWxid) return false
  const joinAt = String(row.joinAt || new Date().toISOString())
  const source = String(row.source || 'callback')
  const nickname = String(row.nickname || '')
  const avatar = String(row.avatar || '')
  const inviter = String(row.inviter || '')
  const eventJson = JSON.stringify(row.event ?? { source, roomId, memberWxid, joinAt })
  const existing = database().prepare('SELECT id, created_at AS createdAt FROM member_join_events WHERE instance_id=? AND room_id=? AND member_wxid=?').get(instanceId, roomId, memberWxid)
  if (existing) {
    // 回调再次进群时刷新入群时间；快照差分不覆盖已有入群时间
    const nextCreatedAt = source === 'callback' ? joinAt : existing.createdAt
    database().prepare('UPDATE member_join_events SET nickname=?,avatar=?,inviter_wxid=?,source=?,event_json=?,created_at=? WHERE id=?')
      .run(nickname || null, avatar || null, inviter || null, source, eventJson, nextCreatedAt, existing.id)
    return false
  }
  database().prepare('INSERT INTO member_join_events(instance_id,room_id,member_wxid,nickname,avatar,inviter_wxid,source,event_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(instanceId, roomId, memberWxid, nickname || null, avatar || null, inviter || null, source, eventJson, joinAt)
  return true
}

/**
 * 查询最新入群成员记录，按入群时间倒序。
 * @param {{ instanceIds?: string[], roomIds?: string[], limit?: number, sinceHours?: number }} [filters]
 * @returns {Array<{ id: number, instanceId: string, roomId: string, wxid: string, nickname: string, avatar: string, inviter: string, source: string, joinAt: string }>}
 */
function listMemberJoins(filters = {}) {
  const clauses = []
  const params = []
  const instanceIds = Array.isArray(filters.instanceIds) ? filters.instanceIds.map(String).filter(Boolean) : []
  const roomIds = Array.isArray(filters.roomIds) ? filters.roomIds.map(String).filter(Boolean) : []
  if (instanceIds.length) {
    clauses.push(`instance_id IN (${instanceIds.map(() => '?').join(',')})`)
    params.push(...instanceIds)
  }
  if (roomIds.length) {
    clauses.push(`room_id IN (${roomIds.map(() => '?').join(',')})`)
    params.push(...roomIds)
  }
  const sinceHours = Number(filters.sinceHours)
  if (Number.isFinite(sinceHours) && sinceHours > 0) {
    clauses.push('created_at >= ?')
    params.push(new Date(Date.now() - Math.floor(sinceHours) * 3600000).toISOString())
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = Math.min(Math.max(Number(filters.limit) || 2000, 1), 20000)
  return database().prepare(`SELECT id, instance_id AS instanceId, room_id AS roomId, member_wxid AS wxid,
      COALESCE(nickname,'') AS nickname, COALESCE(avatar,'') AS avatar, COALESCE(inviter_wxid,'') AS inviter,
      COALESCE(source,'callback') AS source, created_at AS joinAt
    FROM member_join_events ${where}
    ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params, limit)
}

/**
 * 查询成员最近一次加好友任务状态，供页面展示“添加状态/频繁”。
 * @param {string[]} targetKeys 成员 wxid 列表
 * @returns {Record<string, { status: string, error: string, taskStatus: string, updatedAt: string }>}
 */
function listFriendAddStatuses(targetKeys = []) {
  const keys = [...new Set((targetKeys || []).map(String).filter(Boolean))]
  if (!keys.length) return {}
  const rows = database().prepare(`SELECT ti.target_key AS targetKey, ti.status, COALESCE(ti.error,'') AS error,
      t.status AS taskStatus, COALESCE(ti.finished_at, ti.started_at, t.updated_at) AS updatedAt
    FROM task_items ti JOIN tasks t ON t.id=ti.task_id
    WHERE ti.action_type='ADD_FRIEND' AND ti.target_key IN (${keys.map(() => '?').join(',')})
    ORDER BY COALESCE(ti.finished_at, ti.started_at, t.updated_at) DESC`).all(...keys)
  const result = {}
  for (const row of rows) {
    if (result[row.targetKey]) continue
    result[row.targetKey] = { status: String(row.status || ''), error: String(row.error || ''), taskStatus: String(row.taskStatus || ''), updatedAt: String(row.updatedAt || '') }
  }
  return result
}

function createTask(task, items) {
  const now = new Date().toISOString()
  let inserted = 0
  let duplicates = 0
  database().exec('BEGIN IMMEDIATE')
  try {
    database().prepare('INSERT INTO tasks(id,name,type,status,config_json,total,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(task.id, task.name, task.type, task.status, JSON.stringify(task.config), 0, now, now)
    const insert = database().prepare('INSERT INTO task_items(id,task_id,instance_id,target_key,action_type,status,request_json) VALUES(?,?,?,?,?,?,?)')
    const account = database().prepare("SELECT COALESCE(NULLIF(account_wxid,''),'instance:' || id) AS account_key FROM wechat_instances WHERE id=?")
    const reserveFriend = database().prepare('INSERT OR IGNORE INTO friend_target_history(account_key,target_id,first_task_id,first_instance_id,created_at) VALUES(?,?,?,?,?)')
    for (const item of items) {
      if (item.actionType === 'ADD_FRIEND') {
        const accountKey = account.get(item.instanceId)?.account_key || `instance:${item.instanceId}`
        if (!reserveFriend.run(accountKey, item.targetKey, task.id, item.instanceId, now).changes) { duplicates += 1; continue }
      }
      insert.run(item.id, task.id, item.instanceId, item.targetKey, item.actionType, item.status, JSON.stringify(item.request ?? null))
      inserted += 1
    }
    if (!inserted) {
      database().prepare('DELETE FROM tasks WHERE id=?').run(task.id)
      database().exec('COMMIT')
      return { inserted, duplicates }
    }
    database().prepare('UPDATE tasks SET total=? WHERE id=?').run(inserted, task.id)
    database().exec('COMMIT')
    return { inserted, duplicates }
  } catch (error) { database().exec('ROLLBACK'); throw error }
}

function listTasks() {
  return database().prepare(`SELECT t.*,
    COALESCE((SELECT group_concat(label,'、') FROM (
      SELECT DISTINCT CASE
        WHEN NULLIF(w.nickname,'') IS NOT NULL AND NULLIF(w.account_wxid,'') IS NOT NULL THEN w.nickname || '（' || w.account_wxid || '）'
        WHEN NULLIF(w.nickname,'') IS NOT NULL THEN w.nickname
        WHEN NULLIF(w.account_wxid,'') IS NOT NULL THEN w.account_wxid
        ELSE '微信资料读取中' END AS label
      FROM task_items ti LEFT JOIN wechat_instances w ON w.id=ti.instance_id WHERE ti.task_id=t.id
    )),'微信资料读取中') AS account_summary
    FROM tasks t ORDER BY t.created_at DESC`).all().map((row) => ({ ...row, config: JSON.parse(row.config_json), accountSummary: row.account_summary }))
}

function getTaskItems(taskId) { return database().prepare('SELECT * FROM task_items WHERE task_id=? ORDER BY rowid').all(taskId) }
function setTaskStatus(taskId, status) { database().prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').run(status, new Date().toISOString(), taskId) }

/**
 * 取消任务；对尚未开始的加好友项释放「只加一次」占用，避免取消后永远无法再创建。
 * @param {string} taskId 任务 ID
 * @returns {{ released: number }} 释放的去重占用数
 */
function cancelTask(taskId) {
  const id = String(taskId || '')
  if (!id) return { released: 0 }
  setTaskStatus(id, 'CANCELLED')
  const result = database().prepare(`DELETE FROM friend_target_history
    WHERE first_task_id=? AND target_id IN (
      SELECT target_key FROM task_items
      WHERE task_id=? AND action_type='ADD_FRIEND' AND status='QUEUED' AND started_at IS NULL
    )`).run(id, id)
  return { released: Number(result.changes || 0) }
}
function setTaskItemStarted(id) { database().prepare("UPDATE task_items SET status='RUNNING',started_at=? WHERE id=? AND status='QUEUED'").run(new Date().toISOString(), id) }
function setTaskItemResult(id, status, response, error) {
  database().prepare('UPDATE task_items SET status=?,response_json=?,error=?,finished_at=? WHERE id=?').run(status, JSON.stringify(response ?? null), error ?? null, new Date().toISOString(), id)
  // FREQUENT 不计 success，避免“已经频繁”被当成已添加
  const row = database().prepare(`SELECT SUM(status IN ('COMPLETED','SUBMITTED')) success,SUM(status IN ('FAILED','FREQUENT')) failed,SUM(status='SKIPPED') skipped FROM task_items WHERE task_id=(SELECT task_id FROM task_items WHERE id=?)`).get(id)
  database().prepare('UPDATE tasks SET success=?,failed=?,skipped=?,updated_at=? WHERE id=(SELECT task_id FROM task_items WHERE id=?)').run(Number(row.success), Number(row.failed), Number(row.skipped), new Date().toISOString(), id)
}

function recoverInterruptedTasks() {
  const now = new Date().toISOString()
  database().exec('BEGIN IMMEDIATE')
  try {
    database().prepare("UPDATE task_items SET status='UNSAFE_RESUME',error=COALESCE(error,'应用退出时请求结果不确定，禁止自动重放'),finished_at=? WHERE status='RUNNING'").run(now)
    database().prepare("UPDATE tasks SET status='UNSAFE_RESUME',updated_at=? WHERE status='RUNNING'").run(now)
    database().prepare("UPDATE tasks SET status='WAITING_CONFIRMATION',updated_at=? WHERE status='QUEUED' AND COALESCE(json_extract(config_json,'$.scheduledAt'),'')=''").run(now)
    database().exec('COMMIT')
  } catch (error) { database().exec('ROLLBACK'); throw error }
}

function repairConfirmedSendTextResults() {
  const rows = database().prepare("SELECT id,task_id,response_json FROM task_items WHERE action_type='SEND_TEXT' AND status='FAILED' AND response_json IS NOT NULL").all()
  const affected = new Set()
  const update = database().prepare("UPDATE task_items SET status='COMPLETED',error=NULL WHERE id=?")
  for (const row of rows) {
    let response
    try { response = JSON.parse(row.response_json) } catch { continue }
    if (response?.errCode === 1 || response?.code === 1) { update.run(row.id); affected.add(row.task_id) }
  }
  const summarize = database().prepare(`UPDATE tasks SET
    success=(SELECT COUNT(*) FROM task_items WHERE task_id=tasks.id AND status='COMPLETED'),
    failed=(SELECT COUNT(*) FROM task_items WHERE task_id=tasks.id AND status='FAILED'),
    skipped=(SELECT COUNT(*) FROM task_items WHERE task_id=tasks.id AND status='SKIPPED'),
    status=CASE WHEN (SELECT COUNT(*) FROM task_items WHERE task_id=tasks.id AND status='FAILED')=0 THEN 'COMPLETED' ELSE 'PARTIAL_FAILED' END,
    updated_at=? WHERE id=?`)
  for (const taskId of affected) summarize.run(new Date().toISOString(), taskId)
  return affected.size
}

function reserveFriendDailyAttempt(accountWxid, itemId, targetId, limit) {
  const account = String(accountWxid || '').trim()
  if (!account) return { accepted: false, reason: 'ACCOUNT_REQUIRED', count: 0 }
  const localDate = new Date().toLocaleDateString('en-CA')
  database().exec('BEGIN IMMEDIATE')
  try {
    const existing = database().prepare('SELECT 1 FROM friend_daily_attempts WHERE item_id=?').get(itemId)
    const count = Number(database().prepare('SELECT COUNT(*) AS count FROM friend_daily_attempts WHERE account_wxid=? AND local_date=?').get(account, localDate)?.count || 0)
    if (!existing && count >= Math.max(Number(limit) || 1, 1)) { database().exec('COMMIT'); return { accepted: false, reason: 'LIMIT_REACHED', count } }
    if (!existing) database().prepare('INSERT INTO friend_daily_attempts(item_id,account_wxid,local_date,target_id,submitted_at) VALUES(?,?,?,?,?)').run(itemId, account, localDate, targetId, new Date().toISOString())
    database().exec('COMMIT')
    return { accepted: true, count: existing ? count : count + 1 }
  } catch (error) { database().exec('ROLLBACK'); throw error }
}

function reserveQrJoinDailyAttempt(accountWxid, itemId, targetId, limit) {
  const account = String(accountWxid || '').trim()
  if (!account) return { accepted: false, reason: 'ACCOUNT_REQUIRED', count: 0 }
  const localDate = new Date().toLocaleDateString('en-CA')
  database().exec('BEGIN IMMEDIATE')
  try {
    const existing = database().prepare('SELECT 1 FROM qr_join_daily_attempts WHERE item_id=?').get(itemId)
    const count = Number(database().prepare('SELECT COUNT(*) AS count FROM qr_join_daily_attempts WHERE account_wxid=? AND local_date=?').get(account, localDate)?.count || 0)
    if (!existing && count >= Math.max(Number(limit) || 1, 1)) { database().exec('COMMIT'); return { accepted: false, reason: 'LIMIT_REACHED', count } }
    if (!existing) database().prepare('INSERT INTO qr_join_daily_attempts(item_id,account_wxid,local_date,target_id,submitted_at) VALUES(?,?,?,?,?)').run(itemId, account, localDate, targetId, new Date().toISOString())
    database().exec('COMMIT')
    return { accepted: true, count: existing ? count : count + 1 }
  } catch (error) { database().exec('ROLLBACK'); throw error }
}

function hasDeliveredContent(accountWxid, targetId, contentHash) {
  return Boolean(database().prepare('SELECT 1 FROM delivered_content_history WHERE account_wxid=? AND target_id=? AND content_hash=?').get(accountWxid, targetId, contentHash))
}

function recordDeliveredContent(accountWxid, targetId, contentHash, itemId) {
  if (!accountWxid || !contentHash) return
  database().prepare('INSERT OR IGNORE INTO delivered_content_history(account_wxid,target_id,content_hash,first_item_id,delivered_at) VALUES(?,?,?,?,?)').run(accountWxid, targetId, contentHash, itemId, new Date().toISOString())
}

function hasDirectoryOwnership(instanceId, targetId, isGroup) {
  if (isGroup) return Boolean(database().prepare('SELECT 1 FROM chatrooms WHERE source_instance_id=? AND room_id=?').get(instanceId, targetId))
  return Boolean(database().prepare('SELECT 1 FROM contacts WHERE source_instance_id=? AND wxid=? AND is_group=0').get(instanceId, targetId))
}

function syncDirectorySnapshot(payload) {
  const contacts = Array.isArray(payload?.contacts) ? payload.contacts : []
  const groups = Array.isArray(payload?.groups) ? payload.groups : []
  const members = Array.isArray(payload?.members) ? payload.members : []
  const replacement = payload?.replacement && typeof payload.replacement === 'object' ? payload.replacement : {}
  const contactInstanceIds = Array.isArray(replacement.contactInstanceIds) ? [...new Set(replacement.contactInstanceIds.map(String).filter(Boolean))] : []
  const groupInstanceIds = Array.isArray(replacement.groupInstanceIds) ? [...new Set(replacement.groupInstanceIds.map(String).filter(Boolean))] : []
  const memberRooms = Array.isArray(replacement.memberRooms) ? replacement.memberRooms.filter((item) => item && item.instanceId && item.roomId) : []
  const now = new Date().toISOString()
  database().exec('BEGIN IMMEDIATE')
  try {
    const deleteContacts = database().prepare('DELETE FROM contacts WHERE source_instance_id=?')
    for (const instanceId of contactInstanceIds) deleteContacts.run(instanceId)
    const deleteGroups = database().prepare('DELETE FROM chatrooms WHERE source_instance_id=?')
    const deleteSources = database().prepare('DELETE FROM chatroom_sources WHERE instance_id=?')
    const deleteOrphanMembers = database().prepare('DELETE FROM chatroom_members WHERE source_instance_id=? AND NOT EXISTS (SELECT 1 FROM chatrooms c WHERE c.source_instance_id=chatroom_members.source_instance_id AND c.room_id=chatroom_members.room_id)')
    for (const instanceId of groupInstanceIds) { deleteGroups.run(instanceId); deleteSources.run(instanceId) }
    const deleteRoomMembers = database().prepare('DELETE FROM chatroom_members WHERE source_instance_id=? AND room_id=?')
    const previousMembers = database().prepare('SELECT member_wxid AS wxid FROM chatroom_members WHERE source_instance_id=? AND room_id=?')
    const snapshotJoins = []
    for (const item of memberRooms) {
      const instanceId = String(item.instanceId)
      const roomId = String(item.roomId)
      const previousWxids = previousMembers.all(instanceId, roomId).map((row) => row.wxid)
      const roomMembers = members.filter((row) => String(row.sourceInstanceId || '') === instanceId && String(row.roomId || '') === roomId)
      for (const added of diffNewMembers(previousWxids, roomMembers)) {
        snapshotJoins.push({ instanceId, roomId, ...added })
      }
      deleteRoomMembers.run(instanceId, roomId)
    }
    const contact = database().prepare(`INSERT INTO contacts(wxid,source_instance_id,nickname,remark,alias,avatar,is_group,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(wxid,source_instance_id) DO UPDATE SET nickname=excluded.nickname,remark=excluded.remark,alias=excluded.alias,avatar=excluded.avatar,is_group=excluded.is_group,updated_at=excluded.updated_at`)
    for (const row of contacts) contact.run(String(row.wxid || ''), String(row.sourceInstanceId || ''), String(row.nickname || ''), String(row.remark || ''), String(row.alias || ''), String(row.avatar || ''), row.isGroup ? 1 : 0, now)
    const group = database().prepare(`INSERT INTO chatrooms(room_id,source_instance_id,name,member_count,owner_wxid,saved,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(room_id,source_instance_id) DO UPDATE SET name=excluded.name,member_count=excluded.member_count,owner_wxid=excluded.owner_wxid,saved=excluded.saved,updated_at=excluded.updated_at`)
    const source = database().prepare('INSERT INTO chatroom_sources(room_id,instance_id,updated_at) VALUES(?,?,?) ON CONFLICT(room_id,instance_id) DO UPDATE SET updated_at=excluded.updated_at')
    for (const row of groups) { group.run(String(row.roomId || ''), String(row.sourceInstanceId || ''), String(row.name || ''), Number(row.members ?? -1), String(row.owner || ''), row.saved ? 1 : 0, now); source.run(String(row.roomId || ''), String(row.sourceInstanceId || ''), now) }
    for (const instanceId of groupInstanceIds) deleteOrphanMembers.run(instanceId)
    const member = database().prepare(`INSERT INTO chatroom_members(room_id,source_instance_id,member_wxid,nickname,avatar,inviter_wxid,member_flag,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(room_id,source_instance_id,member_wxid) DO UPDATE SET nickname=excluded.nickname,avatar=excluded.avatar,inviter_wxid=excluded.inviter_wxid,member_flag=excluded.member_flag,updated_at=excluded.updated_at`)
    for (const row of members) member.run(String(row.roomId || ''), String(row.sourceInstanceId || ''), String(row.wxid || ''), String(row.nickname || ''), String(row.avatar || ''), String(row.inviter || ''), Number(row.flag || 0), now)
    for (const join of snapshotJoins) {
      recordMemberJoin({
        instanceId: join.instanceId,
        roomId: join.roomId,
        memberWxid: join.wxid,
        nickname: join.nickname,
        avatar: join.avatar,
        inviter: join.inviter,
        joinAt: now,
        source: 'snapshot',
        event: { source: 'snapshot', roomId: join.roomId, memberWxid: join.wxid },
      })
    }
    database().exec('COMMIT')
  } catch (error) { database().exec('ROLLBACK'); throw error }
}

function remoteSyncSnapshot() {
  const diagnostics = listLogs(200).map((row) => {
    let details = {}
    try { details = JSON.parse(row.detailsJson || '{}') } catch {}
    // 同步排查字段：注入失败需要 output/injectionFailed/code，不能只留 reason
    return {
      time: row.time,
      level: row.level,
      instanceId: row.instanceId || details.instanceId || undefined,
      module: row.module,
      message: row.message,
      reason: String(details.reason || details.error || '').slice(0, 500),
      operation: String(details.operation || '').slice(0, 100),
      status: Number(details.status) || undefined,
      durationMs: Number(details.durationMs) || undefined,
      code: details.code === undefined || details.code === null ? undefined : details.code,
      injectionFailed: typeof details.injectionFailed === 'boolean' ? details.injectionFailed : undefined,
      succeeded: typeof details.succeeded === 'boolean' ? details.succeeded : undefined,
      failed: typeof details.failed === 'boolean' ? details.failed : undefined,
      output: typeof details.output === 'string' ? details.output.slice(-1500) : undefined,
      error: typeof details.error === 'string' ? details.error.slice(0, 500) : undefined,
      apiPort: Number(details.apiPort) || undefined,
      tcpPort: Number(details.tcpPort) || undefined,
      pid: Number(details.pid) || undefined,
    }
  })
  return {
    capturedAt: new Date().toISOString(),
    instances: listStoredInstances().map(({ id, accountWxid, nickname, avatar, status }) => ({ id, accountWxid, nickname, avatar, status })),
    contacts: database().prepare('SELECT wxid,nickname,remark,alias,avatar,is_group AS isGroup,source_instance_id AS sourceInstanceId FROM contacts ORDER BY nickname LIMIT 20000').all(),
    groups: database().prepare('SELECT room_id AS roomId,name,member_count AS members,owner_wxid AS owner,saved,source_instance_id AS sourceInstanceId FROM chatrooms ORDER BY name LIMIT 5000').all(),
    members: database().prepare('SELECT room_id AS roomId,source_instance_id AS sourceInstanceId,member_wxid AS wxid,nickname,avatar,inviter_wxid AS inviter,member_flag AS flag FROM chatroom_members ORDER BY room_id,nickname LIMIT 50000').all(),
    tasks: listTasks().slice(0, 500).map(({ id, name, type, status, total, success, failed, skipped, created_at, updated_at }) => ({ id, name, type, status, total, success, failed, skipped, createdAt: created_at, updatedAt: updated_at })),
    logs: diagnostics,
  }
}

function saveQrItem(item) {
  const now = new Date().toISOString()
  database().prepare('INSERT INTO qr_items(id,sha256,source,local_path,decoded_text,qr_type,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(sha256) DO UPDATE SET source=excluded.source,local_path=COALESCE(excluded.local_path,qr_items.local_path),decoded_text=COALESCE(excluded.decoded_text,qr_items.decoded_text),qr_type=excluded.qr_type,status=excluded.status,updated_at=excluded.updated_at').run(item.id, item.sha256 ?? null, item.source, item.localPath ?? null, item.decodedText ?? null, item.qrType ?? 'UNKNOWN', item.status, now, now)
}
function listQrItems() { return database().prepare('SELECT id,sha256,source,local_path AS localPath,decoded_text AS decodedText,qr_type AS qrType,status,created_at AS createdAt FROM qr_items ORDER BY created_at DESC').all() }
function deleteQrItems(ids) { const remove = database().prepare('DELETE FROM qr_items WHERE id=?'); database().exec('BEGIN'); try { for (const id of ids) remove.run(id); database().exec('COMMIT') } catch (error) { database().exec('ROLLBACK'); throw error } }
function updateQrScanResult(targetKey, response, success) {
  const decoded = response?.data?.scan_res ?? response?.scan_res ?? ''
  const status = success ? 'SCANNED' : 'SCAN_FAILED'
  database().prepare('UPDATE qr_items SET decoded_text=?,qr_type=?,status=?,updated_at=? WHERE sha256=? OR id=?')
    .run(decoded ? String(decoded) : null, classifyStoredQr(decoded), status, new Date().toISOString(), targetKey, targetKey)
}
/**
 * 与 qr-collector.classifyQrText 对齐的落库分类（避免扫码结果把 QQ 群等标成 UNKNOWN）。
 * @param {string} text 解码文本
 * @returns {string}
 */
function classifyStoredQr(text) {
  const value = String(text || '').trim()
  if (!value) return 'INVALID'
  if (/qun\.qq\.com|qm\.qq\.com|jq\.qq\.com|qq\.com\/q\/|mqqapi:\/\/card\/show_pslcard[^\s]*(?:card_type=group|group_code=|src_type=internal)/i.test(value)) {
    return 'QQ_GROUP_LINK'
  }
  if (/addchatroombyinvite|weixin\.qq\.com\/g\/|wechat\.com\/g\//i.test(value)) return 'GROUP_LINK'
  if (/u\.wechat\.com|weixin\.qq\.com\/r\/|weixin\.qq\.com\/[a-z]\/|wx\.qq\.com\//i.test(value)) return 'PERSONAL_LINK'
  return 'UNKNOWN'
}

/**
 * 读取群聊发言加好友监听规则（单行全局规则）。
 * @returns {{ enabled: boolean, instanceId: string, roomIds: string[], keywords: string[], excludeText: string, updatedAt: string }}
 */
function getChatAddRule() {
  const row = database().prepare(`SELECT enabled, instance_id AS instanceId, room_ids_json AS roomIdsJson,
      keywords_json AS keywordsJson, exclude_text AS excludeText, updated_at AS updatedAt
    FROM chat_add_rules WHERE id=1`).get()
  if (!row) {
    return { enabled: false, instanceId: '', roomIds: [], keywords: [], excludeText: '', updatedAt: '' }
  }
  let roomIds = []
  let keywords = []
  try { roomIds = JSON.parse(row.roomIdsJson || '[]') } catch { roomIds = [] }
  try { keywords = JSON.parse(row.keywordsJson || '[]') } catch { keywords = [] }
  return {
    enabled: Boolean(row.enabled),
    instanceId: String(row.instanceId || ''),
    roomIds: Array.isArray(roomIds) ? roomIds.map(String).filter(Boolean) : [],
    keywords: Array.isArray(keywords) ? keywords.map(String).filter(Boolean) : [],
    excludeText: String(row.excludeText || ''),
    updatedAt: String(row.updatedAt || ''),
  }
}

/**
 * 保存群聊发言加好友监听规则。
 * @param {{ enabled?: boolean, instanceId?: string, roomIds?: string[], keywords?: string[]|string, excludeText?: string }} rule
 * @returns {ReturnType<typeof getChatAddRule>}
 */
function saveChatAddRule(rule = {}) {
  const roomIds = Array.isArray(rule.roomIds) ? [...new Set(rule.roomIds.map(String).filter(Boolean))] : []
  let keywords = []
  if (Array.isArray(rule.keywords)) keywords = rule.keywords.map(String).map((item) => item.trim()).filter(Boolean)
  else {
    keywords = String(rule.keywords || '').split(/[\r\n,，]+/).map((item) => item.trim()).filter(Boolean)
  }
  const excludeText = String(rule.excludeText ?? '')
  const now = new Date().toISOString()
  database().prepare(`INSERT INTO chat_add_rules(id,enabled,instance_id,room_ids_json,keywords_json,exclude_text,updated_at)
    VALUES(1,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,instance_id=excluded.instance_id,
      room_ids_json=excluded.room_ids_json,keywords_json=excluded.keywords_json,
      exclude_text=excluded.exclude_text,updated_at=excluded.updated_at`)
    .run(rule.enabled ? 1 : 0, String(rule.instanceId || '') || null, JSON.stringify(roomIds), JSON.stringify(keywords), excludeText, now)
  return getChatAddRule()
}

/**
 * 写入或刷新群聊发言加好友候选（同实例同人只保留一条）。
 * @param {{ instanceId: string, roomId: string, senderWxid: string, nickname?: string, messagePreview?: string, matchedKeyword?: string }} hit
 * @returns {{ accepted: boolean, reason?: string, id?: number }}
 */
function upsertChatAddCandidate(hit) {
  const instanceId = String(hit?.instanceId || '')
  const roomId = String(hit?.roomId || '')
  const senderWxid = String(hit?.senderWxid || '')
  if (!instanceId || !roomId || !senderWxid) return { accepted: false, reason: 'INVALID' }
  const nickname = String(hit.nickname || '')
  const messagePreview = String(hit.messagePreview || '').slice(0, 200)
  const matchedKeyword = String(hit.matchedKeyword || '')
  const now = new Date().toISOString()
  const existing = database().prepare('SELECT id, status FROM chat_add_candidates WHERE instance_id=? AND sender_wxid=?').get(instanceId, senderWxid)
  if (existing) {
    if (String(existing.status) === 'TASKED') return { accepted: false, reason: 'ALREADY_TASKED', id: existing.id }
    database().prepare(`UPDATE chat_add_candidates SET room_id=?, nickname=?, message_preview=?, matched_keyword=?, status='PENDING', created_at=?
      WHERE id=?`).run(roomId, nickname || null, messagePreview || null, matchedKeyword || null, now, existing.id)
    return { accepted: true, id: existing.id }
  }
  const result = database().prepare(`INSERT INTO chat_add_candidates(instance_id,room_id,sender_wxid,nickname,message_preview,matched_keyword,status,created_at)
    VALUES(?,?,?,?,?,?, 'PENDING', ?)`).run(instanceId, roomId, senderWxid, nickname || null, messagePreview || null, matchedKeyword || null, now)
  return { accepted: true, id: Number(result.lastInsertRowid) }
}

/**
 * 列出群聊发言加好友候选。
 * @param {{ status?: string, limit?: number }} [filters]
 * @returns {Array<{ id: number, instanceId: string, roomId: string, senderWxid: string, nickname: string, messagePreview: string, matchedKeyword: string, status: string, createdAt: string }>}
 */
function listChatAddCandidates(filters = {}) {
  const clauses = []
  const params = []
  if (filters.status) {
    clauses.push('status=?')
    params.push(String(filters.status))
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = Math.min(Math.max(Number(filters.limit) || 2000, 1), 20000)
  return database().prepare(`SELECT id, instance_id AS instanceId, room_id AS roomId, sender_wxid AS senderWxid,
      COALESCE(nickname,'') AS nickname, COALESCE(message_preview,'') AS messagePreview,
      COALESCE(matched_keyword,'') AS matchedKeyword, status, created_at AS createdAt
    FROM chat_add_candidates ${where}
    ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params, limit)
}

/**
 * 将候选标记为已入任务。
 * @param {number[]} ids 候选 ID 列表
 * @returns {number} 更新行数
 */
function markChatAddCandidatesTasked(ids = []) {
  const list = [...new Set((ids || []).map(Number).filter((id) => Number.isFinite(id) && id > 0))]
  if (!list.length) return 0
  const stmt = database().prepare(`UPDATE chat_add_candidates SET status='TASKED' WHERE id=? AND status='PENDING'`)
  let count = 0
  database().exec('BEGIN IMMEDIATE')
  try {
    for (const id of list) count += stmt.run(id).changes
    database().exec('COMMIT')
  } catch (error) {
    database().exec('ROLLBACK')
    throw error
  }
  return count
}

/**
 * 清空候选（可按状态）。
 * @param {{ status?: string }} [filters]
 * @returns {number}
 */
function clearChatAddCandidates(filters = {}) {
  if (filters.status) {
    return database().prepare('DELETE FROM chat_add_candidates WHERE status=?').run(String(filters.status)).changes
  }
  return database().prepare('DELETE FROM chat_add_candidates').run().changes
}

module.exports = {
  initStorage, database, saveSetting, getSettings, upsertInstance, listStoredInstances, removeInstance, removeInactiveInstancesByPorts,
  saveLog, listLogs, clearLogs, saveApiSample, saveEvent, recordMemberJoin, listMemberJoins, listFriendAddStatuses,
  createTask, listTasks, getTaskItems, setTaskStatus, cancelTask, setTaskItemStarted, setTaskItemResult, recoverInterruptedTasks,
  repairConfirmedSendTextResults, reserveFriendDailyAttempt, reserveQrJoinDailyAttempt, hasDeliveredContent, recordDeliveredContent,
  hasDirectoryOwnership, syncDirectorySnapshot, remoteSyncSnapshot, saveQrItem, listQrItems, deleteQrItems, updateQrScanResult,
  getChatAddRule, saveChatAddRule, upsertChatAddCandidate, listChatAddCandidates, markChatAddCandidatesTasked, clearChatAddCandidates,
}
