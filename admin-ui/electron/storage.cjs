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
    CREATE TABLE IF NOT EXISTS wechat_instances (id TEXT PRIMARY KEY, api_port INTEGER NOT NULL, tcp_port INTEGER NOT NULL, pid INTEGER, account_wxid TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_wechat_instances_api_port ON wechat_instances(api_port);
    CREATE INDEX IF NOT EXISTS idx_wechat_instances_tcp_port ON wechat_instances(tcp_port);
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
    CREATE TABLE IF NOT EXISTS task_items (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, instance_id TEXT NOT NULL, account_wxid TEXT, target_key TEXT NOT NULL, action_type TEXT NOT NULL, status TEXT NOT NULL, request_json TEXT, response_json TEXT, error TEXT, started_at TEXT, finished_at TEXT, UNIQUE(task_id, instance_id, target_key, action_type), FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE);
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
      source_room_id TEXT NOT NULL,
      source_room_name TEXT,
      source_instance_port INTEGER,
      account_wxid TEXT,
      sender_v3 TEXT,
      received_at TEXT NOT NULL,
      UNIQUE(instance_id, sender_wxid, source_room_id)
    );
    CREATE TABLE IF NOT EXISTS kicked_group_cleanup (
      instance_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      account_wxid TEXT,
      room_name TEXT,
      evidence TEXT NOT NULL,
      evidence_strength TEXT NOT NULL DEFAULT 'strong',
      confirm_count INTEGER NOT NULL DEFAULT 0,
      last_absent_at TEXT,
      unsave_status TEXT NOT NULL DEFAULT 'PENDING',
      delete_chat_status TEXT NOT NULL DEFAULT 'PENDING',
      status TEXT NOT NULL DEFAULT 'PENDING',
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(instance_id, room_id)
    );
    CREATE TABLE IF NOT EXISTS blocked_chatrooms (
      account_wxid TEXT NOT NULL,
      room_id TEXT NOT NULL,
      room_name TEXT,
      reason TEXT NOT NULL DEFAULT 'KICKED',
      evidence TEXT,
      source_instance_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(account_wxid, room_id)
    );
  `)
  // 1) base tables created above
  // 2) legacy structural migrations（字段补齐 / 旧表重建）
  migrateDirectoryOwnership(db)
  // 历史已确认清理的被踢群，迁移进永久屏蔽表（按微信号，重启实例仍生效）
  try {
    db.prepare(`INSERT OR IGNORE INTO blocked_chatrooms(account_wxid,room_id,room_name,reason,evidence,source_instance_id,created_at,updated_at)
      SELECT TRIM(account_wxid), room_id, COALESCE(room_name,''), 'KICKED', evidence, instance_id, created_at, updated_at
      FROM kicked_group_cleanup
      WHERE status='DONE' AND TRIM(COALESCE(account_wxid,''))!='' AND room_id LIKE '%@chatroom'`).run()
  } catch { /* 无历史数据时忽略 */ }
  db.prepare(`INSERT OR IGNORE INTO chat_add_rules(id,enabled,instance_id,room_ids_json,keywords_json,exclude_text,updated_at)
    VALUES(1,0,NULL,'[]','[]','',?)`).run(new Date().toISOString())
  const chatAddRuleColumns = new Set(db.prepare('PRAGMA table_info(chat_add_rules)').all().map((column) => column.name))
  if (!chatAddRuleColumns.has('account_wxid')) {
    db.exec('ALTER TABLE chat_add_rules ADD COLUMN account_wxid TEXT')
  }
  const instanceColumns = new Set(db.prepare('PRAGMA table_info(wechat_instances)').all().map((column) => column.name))
  if (!instanceColumns.has('managed')) db.exec('ALTER TABLE wechat_instances ADD COLUMN managed INTEGER NOT NULL DEFAULT 0')
  if (!instanceColumns.has('nickname')) db.exec('ALTER TABLE wechat_instances ADD COLUMN nickname TEXT')
  if (!instanceColumns.has('avatar')) db.exec('ALTER TABLE wechat_instances ADD COLUMN avatar TEXT')
  if (!instanceColumns.has('alias')) db.exec('ALTER TABLE wechat_instances ADD COLUMN alias TEXT')
  const joinColumns = new Set(db.prepare('PRAGMA table_info(member_join_events)').all().map((column) => column.name))
  if (!joinColumns.has('nickname')) db.exec('ALTER TABLE member_join_events ADD COLUMN nickname TEXT')
  if (!joinColumns.has('avatar')) db.exec('ALTER TABLE member_join_events ADD COLUMN avatar TEXT')
  if (!joinColumns.has('inviter_wxid')) db.exec('ALTER TABLE member_join_events ADD COLUMN inviter_wxid TEXT')
  if (!joinColumns.has('source')) db.exec("ALTER TABLE member_join_events ADD COLUMN source TEXT NOT NULL DEFAULT 'callback'")
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_member_join_unique ON member_join_events(instance_id, room_id, member_wxid)')
  const candidateColumns = new Set(db.prepare('PRAGMA table_info(chat_add_candidates)').all().map((column) => column.name))
  if (!candidateColumns.has('source_room_id')) {
    db.exec(`
      ALTER TABLE chat_add_candidates RENAME TO chat_add_candidates_legacy;
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
      INSERT INTO chat_add_candidates(id,instance_id,room_id,sender_wxid,nickname,message_preview,matched_keyword,status,created_at,source_room_id,received_at)
        SELECT id,instance_id,room_id,sender_wxid,nickname,message_preview,matched_keyword,status,created_at,room_id,created_at FROM chat_add_candidates_legacy;
      DROP TABLE chat_add_candidates_legacy;
    `)
  } else {
    if (!candidateColumns.has('source_room_name')) db.exec('ALTER TABLE chat_add_candidates ADD COLUMN source_room_name TEXT')
    if (!candidateColumns.has('source_instance_port')) db.exec('ALTER TABLE chat_add_candidates ADD COLUMN source_instance_port INTEGER')
    if (!candidateColumns.has('account_wxid')) db.exec('ALTER TABLE chat_add_candidates ADD COLUMN account_wxid TEXT')
    if (!candidateColumns.has('sender_v3')) db.exec('ALTER TABLE chat_add_candidates ADD COLUMN sender_v3 TEXT')
    if (!candidateColumns.has('received_at')) db.exec("ALTER TABLE chat_add_candidates ADD COLUMN received_at TEXT NOT NULL DEFAULT ''")
  }
  db.exec(`INSERT OR IGNORE INTO friend_target_history(account_key,target_id,first_task_id,first_instance_id,created_at)
    SELECT COALESCE(NULLIF(w.account_wxid,''),'instance:' || ti.instance_id),ti.target_key,ti.task_id,ti.instance_id,COALESCE(ti.started_at,t.created_at)
    FROM task_items ti JOIN tasks t ON t.id=ti.task_id LEFT JOIN wechat_instances w ON w.id=ti.instance_id
    WHERE ti.action_type='ADD_FRIEND' AND ti.target_key<>''`)
  db.exec(`INSERT OR IGNORE INTO friend_daily_attempts(item_id,account_wxid,local_date,target_id,submitted_at)
    SELECT ti.id,w.account_wxid,date(COALESCE(ti.started_at,ti.finished_at),'localtime'),ti.target_key,COALESCE(ti.started_at,ti.finished_at)
    FROM task_items ti JOIN wechat_instances w ON w.id=ti.instance_id
    WHERE ti.action_type='ADD_FRIEND' AND NULLIF(w.account_wxid,'') IS NOT NULL AND (ti.started_at IS NOT NULL OR ti.finished_at IS NOT NULL)`)
  // 3) final schema / index migrations（必须在字段补齐之后，保证新装与升级 schema 一致）
  const { runStorageSchemaMigrations } = require('./storage-schema-migrations.cjs')
  runStorageSchemaMigrations(db)
  return db
}

function database() {
  if (!db) throw new Error('SQLite 尚未初始化')
  return db
}

/** Best-effort WAL flush before update apply / exit. */
function flushDatabaseCheckpoint() {
  try {
    database().exec('PRAGMA wal_checkpoint(PASSIVE);')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}

function saveSetting(key, value) {
  database().prepare('INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at').run(key, JSON.stringify(value), new Date().toISOString())
}

function getSettings() {
  return Object.fromEntries(database().prepare('SELECT key,value_json FROM app_settings').all().map((row) => { try { return [row.key, JSON.parse(row.value_json)] } catch { return [row.key, null] } }))
}

function upsertInstance(instance) {
  const now = new Date().toISOString()
  database().prepare(`INSERT INTO wechat_instances(id,api_port,tcp_port,pid,account_wxid,status,managed,nickname,alias,avatar,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET api_port=excluded.api_port,tcp_port=excluded.tcp_port,
    pid=excluded.pid,account_wxid=excluded.account_wxid,status=excluded.status,managed=excluded.managed,nickname=excluded.nickname,alias=excluded.alias,avatar=excluded.avatar,updated_at=excluded.updated_at`)
    .run(instance.id, instance.apiPort, instance.tcpPort, instance.pid ?? null, instance.accountWxid ?? null, instance.status, instance.managed ? 1 : 0, instance.nickname ?? null, instance.alias ?? null, instance.avatar ?? null, now, now)
}

function listStoredInstances() {
  return database().prepare('SELECT id,api_port AS apiPort,tcp_port AS tcpPort,pid,account_wxid AS accountWxid,status,managed,nickname,alias,avatar FROM wechat_instances ORDER BY created_at').all()
}

function removeInstance(id) { database().prepare('DELETE FROM wechat_instances WHERE id=?').run(id) }
/** @deprecated 端口不是历史身份；保留空操作兼容旧调用，不再 DELETE metadata */
function removeInactiveInstancesByPorts(_apiPort, _tcpPort) { /* no-op: ports are runtime-only */ }

function saveLog(entry) {
  database().prepare('INSERT INTO logs(time,level,instance_id,module,message,details_json) VALUES(?,?,?,?,?,?)').run(entry.time, entry.level, entry.instanceId ?? null, entry.module ?? null, entry.message, JSON.stringify(entry.details ?? entry))
  if (!saveLog._writes) saveLog._writes = 0
  saveLog._writes += 1
  if (saveLog._writes % 200 === 0) {
    try {
      const row = database().prepare('SELECT COUNT(*) AS c FROM logs').get()
      if (Number(row?.c || 0) > 30000) {
        database().prepare('DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY id ASC LIMIT 2000)').run()
      }
    } catch { /* ignore */ }
  }
}

function listLogs(limit = 500) {
  return database().prepare('SELECT time,level,instance_id AS instanceId,module,message,details_json AS detailsJson FROM logs ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(Number(limit) || 500, 1), 5000))
}
function clearLogs() { database().exec('DELETE FROM logs') }

/**
 * 清理运行时采样/会话缓存表，保留 app_settings 与业务数据。
 * @returns {number} 删除行数估算
 */
function clearRuntimeCaches() {
  const samples = database().prepare('DELETE FROM wechat_api_runtime_samples').run().changes
  const sessions = database().prepare('DELETE FROM backend_session_cache').run().changes
  let audits = 0
  try { audits = database().prepare('DELETE FROM remote_session_audit').run().changes } catch { audits = 0 }
  return Number(samples || 0) + Number(sessions || 0) + Number(audits || 0)
}

/**
 * 仅清理 API 采样（启动防扫描用）；保留 backend_session_cache 等可能影响恢复的表。
 * @returns {number}
 */
function clearApiSamplesOnly() {
  try {
    return Number(database().prepare('DELETE FROM wechat_api_runtime_samples').run().changes || 0) || 0
  } catch {
    return 0
  }
}

/**
 * 高优先级日志：加好友/任务失败等，同步时必须优先保留。
 * @param {{ level?: string, module?: string, message?: string, detailsJson?: string }} row
 * @returns {boolean}
 */
function isHighPrioritySyncLog(row) {
  const level = String(row?.level || '').toUpperCase()
  const moduleName = String(row?.module || '')
  const message = String(row?.message || '')
  let operation = ''
  let details = {}
  try { details = JSON.parse(row?.detailsJson || '{}') } catch { details = {} }
  operation = String(details.operation || '')
  if (level === 'ERROR') return true
  if (/加好友|群聊加好友|群成员加好友|任务|被踢群清理/.test(moduleName)) return true
  if (/加好友|好友申请|凭证|资料解析|ADD_FRIEND|PROFILE_RESOLUTION|RESOLUTION_FAILED|已经频繁|安全风险|无法添加|被踢|移出群聊|清除会话|取消通讯录/.test(message)) return true
  if (/ADD_FRIEND|PROFILE_RESOLUTION|发言命中|PROFILE_RESOLUTION_RAW|ADD_FRIEND_RESULT|SYSTEM_MSG_SELF_KICKED|LEAVE_CALLBACK_SELF/.test(operation)) return true
  if (level === 'WARN' && /加好友|好友|凭证|资料|INSTANCE_MISMATCH|ROOM_FILTER|频繁|安全|被踢/.test(`${moduleName} ${message} ${operation}`)) return true
  return false
}

/**
 * 高频噪音日志（二维码监控刷屏），同步时尽量让位给高优先级记录。
 * @param {{ module?: string, message?: string }} row
 * @returns {boolean}
 */
function isNoisySyncLog(row) {
  const moduleName = String(row?.module || '')
  const message = String(row?.message || '')
  if (moduleName === '二维码监控' && /命中监控群|排队下载|已去重|无法解析下载参数/.test(message)) return true
  return false
}

/**
 * 为云端同步挑选日志：先锁定高优先级，再补近期日志，避免被二维码刷屏冲掉。
 * @param {{ total?: number, priorityMax?: number, scanLimit?: number }} [options]
 * @returns {Array<{ time: string, level: string, instanceId?: string, module?: string, message: string, detailsJson?: string }>}
 */
function selectLogsForRemoteSync(options = {}) {
  const total = Math.min(Math.max(Number(options.total) || 500, 1), 1000)
  const priorityMax = Math.min(Math.max(Number(options.priorityMax) || 300, 0), total)
  const scanLimit = Math.min(Math.max(Number(options.scanLimit) || 5000, total), 5000)
  const scan = listLogs(scanLimit)
  const selected = []
  const seen = new Set()
  const rowKey = (row) => `${row.time}\0${row.level || ''}\0${row.instanceId || ''}\0${row.module || ''}\0${row.message || ''}`

  for (const row of scan) {
    if (selected.length >= priorityMax) break
    if (!isHighPrioritySyncLog(row)) continue
    const key = rowKey(row)
    if (seen.has(key)) continue
    seen.add(key)
    selected.push(row)
  }
  for (const row of scan) {
    if (selected.length >= total) break
    const key = rowKey(row)
    if (seen.has(key)) continue
    if (isNoisySyncLog(row) && selected.length >= Math.max(priorityMax, total - 80)) continue
    seen.add(key)
    selected.push(row)
  }
  return selected.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')))
}

/**
 * 最近任务项诊断摘要（含失败原因），供云端直接查看，不依赖日志窗口。
 * @param {number} [limit]
 * @returns {Array<Record<string, string>>}
 */
function listTaskItemDiagnostics(limit = 300) {
  const size = Math.min(Math.max(Number(limit) || 300, 1), 1000)
  return database().prepare(`SELECT ti.id AS itemId, ti.task_id AS taskId, ti.instance_id AS instanceId,
      ti.target_key AS targetKey, ti.action_type AS actionType, ti.status,
      COALESCE(ti.error,'') AS error, ti.started_at AS startedAt, ti.finished_at AS finishedAt,
      t.name AS taskName, t.type AS taskType, t.status AS taskStatus
    FROM task_items ti JOIN tasks t ON t.id=ti.task_id
    WHERE ti.finished_at IS NOT NULL OR ti.status NOT IN ('QUEUED','PROFILE_PENDING','CREDENTIALS_READY','RUNNING')
    ORDER BY COALESCE(ti.finished_at, ti.started_at, t.updated_at) DESC
    LIMIT ?`).all(size)
}

const SENSITIVE_SAMPLE_KEY_RE = /^(v3|v4|encryptusername|encryptedusername|antispamticket|antispamticket|cookie|authorization|password|secret|token|accesstoken|refreshtoken)$/i
const { sanitizeApiSampleValue, sanitizeSensitiveString } = require('./sensitive-redaction.cjs')

let apiSampleWrites = 0
const API_SAMPLE_MAX = 8000

function saveApiSample(sample) {
  const sanitizedRequest = sanitizeApiSampleValue(sample.request ?? null)
  const sanitizedResponse = sanitizeApiSampleValue(sample.response ?? null)
  database().prepare('INSERT INTO wechat_api_runtime_samples(instance_id,source_id,api_path,request_json,response_json,http_status,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?)').run(
    sample.instanceId,
    sample.sourceId ?? null,
    sample.path,
    JSON.stringify(sanitizedRequest),
    JSON.stringify(sanitizedResponse),
    sample.httpStatus ?? null,
    sample.durationMs ?? null,
    new Date().toISOString(),
  )
  apiSampleWrites += 1
  if (apiSampleWrites % 200 === 0) {
    try {
      const row = database().prepare('SELECT COUNT(*) AS c FROM wechat_api_runtime_samples').get()
      if (Number(row?.c || 0) > API_SAMPLE_MAX) {
        database().prepare('DELETE FROM wechat_api_runtime_samples WHERE id IN (SELECT id FROM wechat_api_runtime_samples ORDER BY id ASC LIMIT 1500)').run()
      }
    } catch { /* ignore */ }
  }
}

/**
 * 保存微信回调事件；若为进群回调则同步写入最新入群成员表。
 * @param {string} instanceId 微信实例 ID
 * @param {unknown} event 原始回调 JSON
 * @returns {{ joinRecorded: boolean }} 是否写入了进群记录
 */
/**
 * 读取近期消息事件（供被踢历史扫描）。
 * @param {{ limit?: number, instanceId?: string }} [filters]
 * @returns {Array<{ instanceId: string, eventJson: string, createdAt: string }>}
 */
function listMessageEventsForKickScan(filters = {}) {
  const limit = Math.min(Math.max(Number(filters.limit) || 5000, 1), 20000)
  const where = []
  const params = []
  if (filters.instanceId) {
    where.push('instance_id=?')
    params.push(String(filters.instanceId))
  }
  params.push(limit)
  return database().prepare(
    `SELECT instance_id AS instanceId, event_json AS eventJson, created_at AS createdAt
     FROM message_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY id DESC LIMIT ?`,
  ).all(...params)
}

let messageEventWrites = 0

function saveEvent(instanceId, event) {
  const newMsgId = event?.newMsgId ?? event?.new_msg_id ?? event?.msgId ?? null
  database().prepare('INSERT OR IGNORE INTO message_events(instance_id,new_msg_id,event_json,created_at) VALUES(?,?,?,?)').run(instanceId, newMsgId ? String(newMsgId) : null, JSON.stringify(event), new Date().toISOString())
  // 每 200 次写入抽检裁剪，避免每条消息都 COUNT(*)
  messageEventWrites += 1
  if (messageEventWrites % 200 === 0) {
    try {
      const row = database().prepare('SELECT COUNT(*) AS c FROM message_events').get()
      if (Number(row?.c || 0) > 30000) {
        database().prepare(`DELETE FROM message_events WHERE id IN (
          SELECT id FROM message_events ORDER BY id ASC LIMIT 5000
        )`).run()
      }
    } catch { /* ignore prune errors */ }
  }
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
function listFriendAddStatuses(targets = []) {
  const pairs = (targets || []).map((item) => {
    if (item && typeof item === 'object') {
      return { instanceId: String(item.instanceId || ''), targetKey: String(item.targetKey || item.wxid || '') }
    }
    const raw = String(item || '')
    const sep = raw.indexOf('\0')
    if (sep >= 0) return { instanceId: raw.slice(0, sep), targetKey: raw.slice(sep + 1) }
    return { instanceId: '', targetKey: raw }
  }).filter((item) => item.targetKey)
  if (!pairs.length) return {}
  const clauses = []
  const params = []
  for (const pair of pairs) {
    if (pair.instanceId) {
      clauses.push('(ti.instance_id=? AND ti.target_key=?)')
      params.push(pair.instanceId, pair.targetKey)
    } else {
      clauses.push('ti.target_key=?')
      params.push(pair.targetKey)
    }
  }
  const rows = database().prepare(`SELECT ti.instance_id AS instanceId, ti.target_key AS targetKey, ti.status, COALESCE(ti.error,'') AS error,
      t.status AS taskStatus, COALESCE(ti.finished_at, ti.started_at, t.updated_at) AS updatedAt
    FROM task_items ti JOIN tasks t ON t.id=ti.task_id
    WHERE ti.action_type='ADD_FRIEND' AND (${clauses.join(' OR ')})
    ORDER BY COALESCE(ti.finished_at, ti.started_at, t.updated_at) DESC`).all(...params)
  const result = {}
  for (const row of rows) {
    const key = row.instanceId ? `${row.instanceId}\0${row.targetKey}` : String(row.targetKey)
    if (result[key]) continue
    result[key] = { status: String(row.status || ''), error: String(row.error || ''), taskStatus: String(row.taskStatus || ''), updatedAt: String(row.updatedAt || '') }
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
    const insert = database().prepare('INSERT INTO task_items(id,task_id,instance_id,account_wxid,target_key,action_type,status,request_json) VALUES(?,?,?,?,?,?,?,?)')
    for (const item of items) {
      const accountWxid = String(item.accountWxid || item.account_wxid || '').trim()
        || String(database().prepare('SELECT COALESCE(account_wxid,\'\') AS a FROM wechat_instances WHERE id=?').get(item.instanceId)?.a || '').trim()
      try {
        insert.run(item.id, task.id, item.instanceId, accountWxid || null, item.targetKey, item.actionType, item.status, JSON.stringify(item.request ?? null))
        inserted += 1
      } catch (error) {
        if (String(error?.message || error).includes('UNIQUE')) {
          duplicates += 1
          continue
        }
        throw error
      }
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

function updateTaskItemInstanceId(itemId, newInstanceId) {
  const id = String(itemId || '')
  const next = String(newInstanceId || '')
  if (!id || !next) return false
  database().prepare('UPDATE task_items SET instance_id=? WHERE id=?').run(next, id)
  return true
}

function releaseFriendDailyAttempt(itemId) {
  const id = String(itemId || '')
  if (!id) return false
  return database().prepare('DELETE FROM friend_daily_attempts WHERE item_id=?').run(id).changes > 0
}

function releaseQrJoinDailyAttempt(itemId) {
  const id = String(itemId || '')
  if (!id) return false
  return database().prepare('DELETE FROM qr_join_daily_attempts WHERE item_id=?').run(id).changes > 0
}

function migrateDirectorySnapshotToInstance(oldInstanceId, newInstanceId) {
  const { migrateDirectorySnapshotOwnership } = require('./storage-schema-migrations.cjs')
  return migrateDirectorySnapshotOwnership(database(), oldInstanceId, newInstanceId)
}

function rebindChatAddCandidatesForAccount(accountWxid, newInstanceId, onlineInstanceIds) {
  const { rebindPendingChatAddCandidates } = require('./storage-schema-migrations.cjs')
  return rebindPendingChatAddCandidates(database(), accountWxid, newInstanceId, onlineInstanceIds)
}

function listTasks() {
  return database().prepare(`SELECT t.*,
    COALESCE((SELECT group_concat(label,'、') FROM (
      SELECT DISTINCT CASE
        WHEN NULLIF(w.nickname,'') IS NOT NULL AND NULLIF(COALESCE(NULLIF(w.alias,''),w.account_wxid),'') IS NOT NULL
          THEN w.nickname || '（' || COALESCE(NULLIF(w.alias,''),w.account_wxid) || '）'
        WHEN NULLIF(w.nickname,'') IS NOT NULL THEN w.nickname
        WHEN NULLIF(COALESCE(NULLIF(w.alias,''),w.account_wxid),'') IS NOT NULL THEN COALESCE(NULLIF(w.alias,''),w.account_wxid)
        ELSE '微信资料读取中' END AS label
      FROM task_items ti LEFT JOIN wechat_instances w ON w.id=ti.instance_id WHERE ti.task_id=t.id
    )),'微信资料读取中') AS account_summary
    FROM tasks t ORDER BY t.created_at DESC`).all().map((row) => ({ ...row, config: JSON.parse(row.config_json), accountSummary: row.account_summary }))
}

/**
 * 任务明细：把 target_key（wxid / roomId）解析成可读名称，避免界面直接展示 roomId。
 * @param {string} taskId
 * @returns {Array<Record<string, unknown>>}
 */
function getTaskItems(taskId) {
  const id = String(taskId || '')
  if (!id) return []
  return database().prepare(`
    SELECT
      ti.*,
      CASE
        WHEN ti.action_type = 'KICKED_GROUP_CLEANUP' THEN COALESCE(
          NULLIF(json_extract(ti.request_json, '$.roomName'), ''),
          NULLIF(room.name, ''),
          NULLIF(kick_room.name, ''),
          '未命名群聊'
        )
        WHEN ti.target_key LIKE '%@chatroom' THEN COALESCE(
          NULLIF(room.name, ''),
          NULLIF(json_extract(ti.request_json, '$.nickname'), ''),
          NULLIF(json_extract(ti.request_json, '$.sourceRoomName'), ''),
          NULLIF(json_extract(ti.request_json, '$.roomName'), ''),
          '未命名群聊'
        )
        WHEN ti.action_type = 'QR_SCAN' THEN COALESCE(
          NULLIF(CASE WHEN json_extract(ti.request_json, '$.roomName') LIKE '%未知群名%' THEN NULL ELSE json_extract(ti.request_json, '$.roomName') END, ''),
          NULLIF(CASE WHEN json_extract(ti.request_json, '$.label') LIKE '%未知群名%' OR json_extract(ti.request_json, '$.label') LIKE '二维码%' THEN NULL ELSE json_extract(ti.request_json, '$.label') END, ''),
          NULLIF(CASE WHEN json_extract(ti.response_json, '$.preview.roomName') LIKE '%未知群名%' THEN NULL ELSE json_extract(ti.response_json, '$.preview.roomName') END, ''),
          NULLIF(CASE WHEN json_extract(ti.response_json, '$.roomName') LIKE '%未知群名%' THEN NULL ELSE json_extract(ti.response_json, '$.roomName') END, ''),
          NULLIF(CASE WHEN json_extract(ti.response_json, '$.label') LIKE '%未知群名%' OR json_extract(ti.response_json, '$.label') LIKE '二维码%' THEN NULL ELSE json_extract(ti.response_json, '$.label') END, ''),
          NULLIF(CASE WHEN json_extract(ti.response_json, '$.preview.label') LIKE '%未知群名%' OR json_extract(ti.response_json, '$.preview.label') LIKE '二维码%' THEN NULL ELSE json_extract(ti.response_json, '$.preview.label') END, ''),
          '群邀请（未解析到群名）'
        )
        ELSE COALESCE(
          NULLIF(json_extract(ti.request_json, '$.nickname'), ''),
          NULLIF(contact.remark, ''),
          NULLIF(contact.nickname, ''),
          NULLIF(member.nickname, ''),
          NULLIF(contact.alias, ''),
          ti.target_key
        )
      END AS target_label
    FROM task_items ti
    LEFT JOIN chatrooms room
      ON room.source_instance_id = ti.instance_id AND room.room_id = ti.target_key
    LEFT JOIN chatrooms kick_room
      ON kick_room.source_instance_id = ti.instance_id
      AND kick_room.room_id = COALESCE(json_extract(ti.request_json, '$.roomId'), '')
    LEFT JOIN contacts contact
      ON contact.source_instance_id = ti.instance_id AND contact.wxid = ti.target_key
    LEFT JOIN chatroom_members member
      ON member.source_instance_id = ti.instance_id AND member.member_wxid = ti.target_key
    WHERE ti.task_id = ?
    ORDER BY ti.rowid
  `).all(id).map((row) => ({
    ...row,
    targetLabel: String(row.target_label || ''),
  }))
}
function setTaskStatus(taskId, status) {
  const id = String(taskId || '')
  const next = String(status || '')
  if (!id || !next) return false
  // 已取消为终态：禁止被 RUNNING/COMPLETED 等覆盖（取消与执行循环竞态时尤其关键）
  if (next !== 'CANCELLED') {
    const row = database().prepare('SELECT status FROM tasks WHERE id=?').get(id)
    if (row && String(row.status || '') === 'CANCELLED') return false
  }
  database().prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').run(next, new Date().toISOString(), id)
  return true
}

/**
 * 合并写入任务 config_json（确认执行时写入 intervalMs 等）。
 * @param {string} taskId
 * @param {Record<string, unknown>} patch
 */
function patchTaskConfig(taskId, patch) {
  const id = String(taskId || '').trim()
  if (!id || !patch || typeof patch !== 'object') return false
  const row = database().prepare('SELECT config_json AS configJson FROM tasks WHERE id=?').get(id)
  if (!row) return false
  let config = {}
  try { config = JSON.parse(String(row.configJson || '{}')) || {} } catch { config = {} }
  if (!config || typeof config !== 'object' || Array.isArray(config)) config = {}
  const next = { ...config, ...patch }
  database().prepare('UPDATE tasks SET config_json=?,updated_at=? WHERE id=?')
    .run(JSON.stringify(next), new Date().toISOString(), id)
  return true
}

/**
 * 取消任务：任务标 CANCELLED，并终止尚未开始的明细（执行中单项仍可能跑完当前 API）。
 * @param {string} taskId 任务 ID
 * @returns {{ released: number }}
 */
function cancelTask(taskId) {
  const id = String(taskId || '')
  if (!id) return { released: 0 }
  setTaskStatus(id, 'CANCELLED')
  const now = new Date().toISOString()
  const result = database().prepare(`
    UPDATE task_items
    SET status='CANCELLED',
        error=COALESCE(NULLIF(error,''),'任务已取消'),
        finished_at=COALESCE(finished_at, ?)
    WHERE task_id=? AND status IN ('QUEUED','PROFILE_PENDING','CREDENTIALS_READY')
  `).run(now, id)
  const row = database().prepare(`
    SELECT SUM(status IN ('COMPLETED','SUBMITTED','REQUEST_SENT')) success,
           SUM(status IN ('FAILED','FREQUENT','RESOLUTION_FAILED','UNSAFE_RESUME')) failed,
           SUM(status IN ('SKIPPED','CANCELLED')) skipped
    FROM task_items WHERE task_id=?
  `).get(id)
  database().prepare('UPDATE tasks SET success=?,failed=?,skipped=?,updated_at=? WHERE id=?')
    .run(Number(row?.success || 0), Number(row?.failed || 0), Number(row?.skipped || 0), now, id)
  return { released: Number(result.changes || 0) }
}
function setTaskItemStatus(id, status) { database().prepare('UPDATE task_items SET status=? WHERE id=?').run(String(status), String(id)) }
/**
 * 合并写入任务项 request_json（用于进群后回填群名等展示字段）。
 * @param {string} id
 * @param {Record<string, unknown>} patch
 */
function patchTaskItemRequest(id, patch) {
  const itemId = String(id || '')
  if (!itemId || !patch || typeof patch !== 'object') return false
  const row = database().prepare('SELECT request_json FROM task_items WHERE id=?').get(itemId)
  if (!row) return false
  let current = {}
  try { current = JSON.parse(row.request_json || '{}') } catch { current = {} }
  const next = { ...(current && typeof current === 'object' ? current : {}), ...patch }
  database().prepare('UPDATE task_items SET request_json=? WHERE id=?').run(JSON.stringify(next), itemId)
  return true
}
function setTaskItemStarted(id) { database().prepare("UPDATE task_items SET status='RUNNING',started_at=? WHERE id=? AND status IN ('QUEUED','PROFILE_PENDING','CREDENTIALS_READY')").run(new Date().toISOString(), id) }
function setTaskItemResult(id, status, response, error) {
  database().prepare('UPDATE task_items SET status=?,response_json=?,error=?,finished_at=? WHERE id=?').run(status, JSON.stringify(response ?? null), error ?? null, new Date().toISOString(), id)
  // FREQUENT 不计 success；CANCELLED 计入 skipped，避免取消后进度对不上
  const row = database().prepare(`SELECT SUM(status IN ('COMPLETED','SUBMITTED','REQUEST_SENT')) success,SUM(status IN ('FAILED','FREQUENT','RESOLUTION_FAILED','UNSAFE_RESUME')) failed,SUM(status IN ('SKIPPED','CANCELLED')) skipped FROM task_items WHERE task_id=(SELECT task_id FROM task_items WHERE id=?)`).get(id)
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
    success=(SELECT COUNT(*) FROM task_items WHERE task_id=tasks.id AND status IN ('COMPLETED','SUBMITTED','REQUEST_SENT')),
    failed=(SELECT COUNT(*) FROM task_items WHERE task_id=tasks.id AND status IN ('FAILED','FREQUENT','RESOLUTION_FAILED','UNSAFE_RESUME')),
    skipped=(SELECT COUNT(*) FROM task_items WHERE task_id=tasks.id AND status IN ('SKIPPED','CANCELLED')),
    status=CASE WHEN (SELECT COUNT(*) FROM task_items WHERE task_id=tasks.id AND status IN ('FAILED','FREQUENT','RESOLUTION_FAILED','UNSAFE_RESUME'))=0 THEN 'COMPLETED' ELSE 'PARTIAL_FAILED' END,
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

/**
 * @param {string} instanceId
 * @returns {string}
 */
function resolveInstanceAccountWxid(instanceId) {
  const id = String(instanceId || '')
  if (!id) return ''
  return String(database().prepare('SELECT COALESCE(account_wxid,\'\') AS accountWxid FROM wechat_instances WHERE id=?').get(id)?.accountWxid || '').trim()
}

/**
 * 永久屏蔽被踢群（按微信号 + 群 ID，实例重启仍生效）。
 * @param {{ accountWxid: string, roomId: string, roomName?: string, reason?: string, evidence?: string, sourceInstanceId?: string }} row
 */
function markChatroomBlocked(row) {
  const accountWxid = String(row.accountWxid || '').trim()
  const roomId = String(row.roomId || '').trim()
  if (!accountWxid || !roomId.endsWith('@chatroom')) return false
  const now = new Date().toISOString()
  database().prepare(`INSERT INTO blocked_chatrooms(account_wxid,room_id,room_name,reason,evidence,source_instance_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(account_wxid,room_id) DO UPDATE SET
      room_name=CASE WHEN excluded.room_name!='' THEN excluded.room_name ELSE blocked_chatrooms.room_name END,
      reason=excluded.reason,
      evidence=CASE WHEN excluded.evidence!='' THEN excluded.evidence ELSE blocked_chatrooms.evidence END,
      source_instance_id=CASE WHEN excluded.source_instance_id!='' THEN excluded.source_instance_id ELSE blocked_chatrooms.source_instance_id END,
      updated_at=excluded.updated_at
  `).run(
    accountWxid,
    roomId,
    String(row.roomName || ''),
    String(row.reason || 'KICKED'),
    String(row.evidence || ''),
    String(row.sourceInstanceId || ''),
    now,
    now,
  )
  return true
}

/**
 * @param {string} accountWxid
 * @param {string} roomId
 */
function isChatroomBlocked(accountWxid, roomId) {
  const account = String(accountWxid || '').trim()
  const room = String(roomId || '').trim()
  if (!account || !room.endsWith('@chatroom')) return false
  return Boolean(database().prepare('SELECT 1 FROM blocked_chatrooms WHERE account_wxid=? AND room_id=?').get(account, room))
}

/**
 * @param {string} instanceId
 * @param {string} roomId
 */
function isChatroomBlockedForInstance(instanceId, roomId) {
  const account = resolveInstanceAccountWxid(instanceId)
  if (!account) return false
  return isChatroomBlocked(account, roomId)
}

/**
 * @param {string} accountWxid
 * @returns {Set<string>}
 */
function loadBlockedRoomIdSet(accountWxid) {
  const account = String(accountWxid || '').trim()
  if (!account) return new Set()
  return new Set(
    database().prepare('SELECT room_id AS roomId FROM blocked_chatrooms WHERE account_wxid=?').all(account)
      .map((row) => String(row.roomId || ''))
      .filter((id) => id.endsWith('@chatroom')),
  )
}

/**
 * @param {string} instanceId
 * @returns {Set<string>}
 */
function loadBlockedRoomIdSetForInstance(instanceId) {
  return loadBlockedRoomIdSet(resolveInstanceAccountWxid(instanceId))
}

/**
 * 目录/群聊加好友不应再加载的群：永久屏蔽 ∪ 已清理(DONE) ∪ 强证据待清理(系统踢人 PENDING)。
 * 弱证据（退群回调）PENDING 不排除，避免误判把仍在群里的会话藏掉。
 * @param {string} instanceId
 * @returns {Set<string>}
 */
function loadDirectoryExcludedRoomIdSetForInstance(instanceId) {
  const id = String(instanceId || '').trim()
  const excluded = loadBlockedRoomIdSetForInstance(id)
  if (!id) return excluded
  const account = resolveInstanceAccountWxid(id)
  const rows = database().prepare(`
    SELECT room_id AS roomId FROM kicked_group_cleanup
    WHERE (instance_id=? OR (?!='' AND account_wxid=?))
      AND (
        status='DONE'
        OR (status='PENDING' AND evidence='SYSTEM_MSG_SELF_KICKED')
        OR (status='PENDING' AND evidence='LEAVE_CALLBACK_SELF' AND COALESCE(confirm_count,0) >= 1)
      )
  `).all(id, account, account)
  for (const row of rows) {
    const roomId = String(row.roomId || '')
    if (roomId.endsWith('@chatroom')) excluded.add(roomId)
  }
  return excluded
}

/**
 * @param {{ accountWxid?: string }} [filters]
 */
function listBlockedChatrooms(filters = {}) {
  const where = []
  const params = []
  if (filters.accountWxid) { where.push('account_wxid=?'); params.push(String(filters.accountWxid)) }
  const sql = `SELECT account_wxid AS accountWxid, room_id AS roomId, COALESCE(room_name,'') AS roomName,
    reason, COALESCE(evidence,'') AS evidence, COALESCE(source_instance_id,'') AS sourceInstanceId,
    created_at AS createdAt, updated_at AS updatedAt
    FROM blocked_chatrooms ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY updated_at DESC`
  return database().prepare(sql).all(...params)
}

function hasDirectoryOwnership(instanceId, targetId, isGroup) {
  if (isGroup) {
    if (!database().prepare('SELECT 1 FROM chatrooms WHERE source_instance_id=? AND room_id=?').get(instanceId, targetId)) return false
    if (loadDirectoryExcludedRoomIdSetForInstance(instanceId).has(String(targetId || ''))) return false
    return true
  }
  return Boolean(database().prepare('SELECT 1 FROM contacts WHERE source_instance_id=? AND wxid=? AND is_group=0').get(instanceId, targetId))
}

/**
 * 按实例一次性加载归属集合，供群发创建任务时批量校验（避免两千级逐条 SQL）。
 * @param {string} instanceId
 * @param {boolean} isGroup
 * @returns {Set<string>}
 */
function loadDirectoryOwnershipSet(instanceId, isGroup) {
  const key = String(instanceId || '')
  if (!key) return new Set()
  if (isGroup) {
    const blocked = loadDirectoryExcludedRoomIdSetForInstance(key)
    const rows = database().prepare('SELECT room_id AS id FROM chatrooms WHERE source_instance_id=?').all(key)
    return new Set(rows.map((row) => String(row.id || '')).filter((id) => id && !blocked.has(id)))
  }
  const rows = database().prepare('SELECT wxid AS id FROM contacts WHERE source_instance_id=? AND is_group=0').all(key)
  return new Set(rows.map((row) => String(row.id || '')).filter(Boolean))
}

function syncDirectorySnapshot(payload) {
  const contacts = Array.isArray(payload?.contacts) ? payload.contacts : []
  const groups = Array.isArray(payload?.groups) ? payload.groups : []
  const members = Array.isArray(payload?.members) ? payload.members : []
  const replacement = payload?.replacement && typeof payload.replacement === 'object' ? payload.replacement : {}
  const contactInstanceIds = Array.isArray(replacement.contactInstanceIds) ? [...new Set(replacement.contactInstanceIds.map(String).filter(Boolean))] : []
  const groupInstanceIds = Array.isArray(replacement.groupInstanceIds) ? [...new Set(replacement.groupInstanceIds.map(String).filter(Boolean))] : []
  const memberRooms = Array.isArray(replacement.memberRooms) ? replacement.memberRooms.filter((item) => item && item.instanceId && item.roomId) : []
  const blockedByInstance = new Map()
  const blockedFor = (instanceId) => {
    const key = String(instanceId || '')
    if (!blockedByInstance.has(key)) blockedByInstance.set(key, loadDirectoryExcludedRoomIdSetForInstance(key))
    return blockedByInstance.get(key)
  }
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
      if (blockedFor(instanceId).has(roomId)) continue
      const previousWxids = previousMembers.all(instanceId, roomId).map((row) => row.wxid)
      const roomMembers = members.filter((row) => String(row.sourceInstanceId || '') === instanceId && String(row.roomId || '') === roomId)
      for (const added of diffNewMembers(previousWxids, roomMembers)) {
        snapshotJoins.push({ instanceId, roomId, ...added })
      }
      deleteRoomMembers.run(instanceId, roomId)
    }
    const contact = database().prepare(`INSERT INTO contacts(wxid,source_instance_id,nickname,remark,alias,avatar,is_group,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(wxid,source_instance_id) DO UPDATE SET nickname=excluded.nickname,remark=excluded.remark,alias=excluded.alias,avatar=excluded.avatar,is_group=excluded.is_group,updated_at=excluded.updated_at`)
    for (const row of contacts) {
      const wxid = String(row.wxid || '')
      const instanceId = String(row.sourceInstanceId || '')
      if (row.isGroup && blockedFor(instanceId).has(wxid)) continue
      contact.run(wxid, instanceId, String(row.nickname || ''), String(row.remark || ''), String(row.alias || ''), String(row.avatar || ''), row.isGroup ? 1 : 0, now)
    }
    const group = database().prepare(`INSERT INTO chatrooms(room_id,source_instance_id,name,member_count,owner_wxid,saved,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(room_id,source_instance_id) DO UPDATE SET name=excluded.name,member_count=excluded.member_count,owner_wxid=excluded.owner_wxid,saved=excluded.saved,updated_at=excluded.updated_at`)
    const source = database().prepare('INSERT INTO chatroom_sources(room_id,instance_id,updated_at) VALUES(?,?,?) ON CONFLICT(room_id,instance_id) DO UPDATE SET updated_at=excluded.updated_at')
    for (const row of groups) {
      const roomId = String(row.roomId || '')
      const instanceId = String(row.sourceInstanceId || '')
      if (blockedFor(instanceId).has(roomId)) continue
      group.run(roomId, instanceId, String(row.name || ''), Number(row.members ?? -1), String(row.owner || ''), row.saved ? 1 : 0, now)
      source.run(roomId, instanceId, now)
    }
    for (const instanceId of groupInstanceIds) deleteOrphanMembers.run(instanceId)
    const member = database().prepare(`INSERT INTO chatroom_members(room_id,source_instance_id,member_wxid,nickname,avatar,inviter_wxid,member_flag,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(room_id,source_instance_id,member_wxid) DO UPDATE SET nickname=excluded.nickname,avatar=excluded.avatar,inviter_wxid=excluded.inviter_wxid,member_flag=excluded.member_flag,updated_at=excluded.updated_at`)
    for (const row of members) {
      const roomId = String(row.roomId || '')
      const instanceId = String(row.sourceInstanceId || '')
      if (blockedFor(instanceId).has(roomId)) continue
      member.run(roomId, instanceId, String(row.wxid || ''), String(row.nickname || ''), String(row.avatar || ''), String(row.inviter || ''), Number(row.flag || 0), now)
    }
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

function formatLogForRemoteSync(row) {
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
    taskId: String(details.taskId || '').slice(0, 100) || undefined,
    sourceId: details.sourceId === undefined || details.sourceId === null ? undefined : details.sourceId,
    path: String(details.path || '').slice(0, 200) || undefined,
    status: Number(details.status) || undefined,
    durationMs: Number(details.durationMs) || undefined,
    code: details.code === undefined || details.code === null ? undefined : details.code,
    businessCode: details.businessCode === undefined || details.businessCode === null ? undefined : details.businessCode,
    result: String(details.result || '').slice(0, 80) || undefined,
    injectionFailed: typeof details.injectionFailed === 'boolean' ? details.injectionFailed : undefined,
    succeeded: typeof details.succeeded === 'boolean' ? details.succeeded : undefined,
    failed: typeof details.failed === 'boolean' ? details.failed : undefined,
    output: typeof details.output === 'string' ? details.output.slice(-1500) : undefined,
    error: typeof details.error === 'string' ? details.error.slice(0, 500) : undefined,
    apiPort: Number(details.apiPort) || undefined,
    tcpPort: Number(details.tcpPort) || undefined,
    pid: Number(details.pid) || undefined,
    targetWxid: String(details.targetWxid || '').slice(0, 160) || undefined,
    accountWxid: String(details.accountWxid || '').slice(0, 160) || undefined,
    senderWxid: String(details.senderWxid || '').slice(0, 160) || undefined,
    roomId: String(details.roomId || '').slice(0, 160) || undefined,
    missing: String(details.missing || '').slice(0, 80) || undefined,
    attempts: String(details.attempts || '').slice(0, 300) || undefined,
    endpoint: String(details.endpoint || '').slice(0, 160) || undefined,
    httpStatus: Number(details.httpStatus) || undefined,
    baseRet: details.baseRet === undefined || details.baseRet === null ? undefined : Number(details.baseRet),
    contactCount: details.contactCount === undefined || details.contactCount === null ? undefined : Number(details.contactCount),
    contactListLength: details.contactListLength === undefined || details.contactListLength === null ? undefined : Number(details.contactListLength),
    matchedContact: typeof details.matchedContact === 'boolean' ? details.matchedContact : undefined,
    matchedTicket: typeof details.matchedTicket === 'boolean' ? details.matchedTicket : undefined,
    hasV3: typeof details.hasV3 === 'boolean' ? details.hasV3 : undefined,
    v3Prefix: String(details.v3Prefix || '').slice(0, 12) || undefined,
    v3Length: Number(details.v3Length) || 0,
    hasV4: typeof details.hasV4 === 'boolean' ? details.hasV4 : undefined,
    v4Prefix: String(details.v4Prefix || '').slice(0, 12) || undefined,
    v4Length: Number(details.v4Length) || 0,
    attempt: Number(details.attempt) || undefined,
    elapsedMs: Number(details.elapsedMs) || undefined,
    nextAction: String(details.nextAction || '').slice(0, 80) || undefined,
    parserVersion: String(details.parserVersion || '').slice(0, 40) || undefined,
    sourceRoomId: String(details.sourceRoomId || '').slice(0, 160) || undefined,
    sourceRoomName: String(details.sourceRoomName || '').slice(0, 160) || undefined,
    sourceInstanceId: String(details.sourceInstanceId || '').slice(0, 160) || undefined,
    sourceInstancePort: Number(details.sourceInstancePort) || undefined,
    instancePort: Number(details.instancePort) || undefined,
    requestUrl: String(details.requestUrl || '').slice(0, 300) || undefined,
    requestBodyWxid: String(details.requestBodyWxid || '').slice(0, 160) || undefined,
    requestBodyRoomId: String(details.requestBodyRoomId || '').slice(0, 160) || undefined,
    rawType: String(details.rawType || '').slice(0, 40) || undefined,
    rawTopLevelKeys: String(details.rawTopLevelKeys || '').slice(0, 500) || undefined,
    dataType: String(details.dataType || '').slice(0, 40) || undefined,
    dataTopLevelKeys: String(details.dataTopLevelKeys || '').slice(0, 500) || undefined,
    bodyLength: Number(details.bodyLength) || 0,
    rawPreview: String(details.rawPreview || '').slice(0, 5000) || undefined,
    diagnosticId: String(details.diagnosticId || '').slice(0, 80) || undefined,
    clientVersion: String(details.clientVersion || '').slice(0, 40) || undefined,
    wechatVersion: String(details.wechatVersion || '').slice(0, 40) || undefined,
    dllPath: String(details.dllPath || '').slice(0, 300) || undefined,
    dllSha256: String(details.dllSha256 || '').slice(0, 80) || undefined,
    matchedIdentity: details.matchedIdentity,
    matchedContactBy: String(details.matchedContactBy || '').slice(0, 80) || undefined,
    identityMatched: typeof details.identityMatched === 'boolean' ? details.identityMatched : undefined,
    finalClassification: String(details.finalClassification || '').slice(0, 80) || undefined,
    credentialSource: String(details.credentialSource || '').slice(0, 160) || undefined,
  }
}

function remoteSyncSnapshot() {
  const diagnostics = selectLogsForRemoteSync({ total: 500, priorityMax: 300, scanLimit: 5000 }).map(formatLogForRemoteSync)
  const taskItems = listTaskItemDiagnostics(300).map((row) => ({
    itemId: String(row.itemId || ''),
    taskId: String(row.taskId || ''),
    taskName: String(row.taskName || '').slice(0, 160),
    taskType: String(row.taskType || '').slice(0, 40),
    taskStatus: String(row.taskStatus || '').slice(0, 40),
    instanceId: String(row.instanceId || ''),
    targetKey: String(row.targetKey || '').slice(0, 160),
    actionType: String(row.actionType || '').slice(0, 40),
    status: String(row.status || '').slice(0, 40),
    error: String(row.error || '').slice(0, 500),
    startedAt: String(row.startedAt || '') || undefined,
    finishedAt: String(row.finishedAt || '') || undefined,
  }))
  return {
    capturedAt: new Date().toISOString(),
    instances: listStoredInstances().map(({ id, accountWxid, nickname, alias, avatar, status }) => ({ id, accountWxid, nickname, alias, avatar, status })),
    contacts: database().prepare('SELECT wxid,nickname,remark,alias,avatar,is_group AS isGroup,source_instance_id AS sourceInstanceId FROM contacts ORDER BY nickname LIMIT 20000').all(),
    groups: database().prepare('SELECT room_id AS roomId,name,member_count AS members,owner_wxid AS owner,saved,source_instance_id AS sourceInstanceId FROM chatrooms ORDER BY name LIMIT 5000').all(),
    members: database().prepare('SELECT room_id AS roomId,source_instance_id AS sourceInstanceId,member_wxid AS wxid,nickname,avatar,inviter_wxid AS inviter,member_flag AS flag FROM chatroom_members ORDER BY room_id,nickname LIMIT 50000').all(),
    tasks: listTasks().slice(0, 500).map(({ id, name, type, status, total, success, failed, skipped, created_at, updated_at }) => ({ id, name, type, status, total, success, failed, skipped, createdAt: created_at, updatedAt: updated_at })),
    taskItems,
    logs: diagnostics,
  }
}

function saveQrItem(item) {
  const now = new Date().toISOString()
  database().prepare('INSERT INTO qr_items(id,sha256,source,local_path,decoded_text,qr_type,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(sha256) DO UPDATE SET source=excluded.source,local_path=COALESCE(excluded.local_path,qr_items.local_path),decoded_text=COALESCE(excluded.decoded_text,qr_items.decoded_text),qr_type=excluded.qr_type,status=excluded.status,updated_at=excluded.updated_at').run(item.id, item.sha256 ?? null, item.source, item.localPath ?? null, item.decodedText ?? null, item.qrType ?? 'UNKNOWN', item.status, now, now)
}

/**
 * 是否已有相同内容哈希（含历史 dup: 前缀记录）。
 * @param {string} sha contentHash
 * @returns {boolean}
 */
function hasQrContentHash(sha) {
  const key = String(sha || '').trim().toUpperCase()
  if (!key) return false
  const row = database().prepare(`
    SELECT 1 AS ok FROM qr_items
    WHERE upper(sha256)=?
       OR sha256 LIKE ('dup:' || ? || ':%')
    LIMIT 1
  `).get(key, key)
  return Boolean(row)
}

function listQrItems() { return database().prepare('SELECT id,sha256,source,local_path AS localPath,decoded_text AS decodedText,qr_type AS qrType,status,created_at AS createdAt FROM qr_items ORDER BY created_at DESC').all() }
function deleteQrItems(ids) { const remove = database().prepare('DELETE FROM qr_items WHERE id=?'); database().exec('BEGIN'); try { for (const id of ids) remove.run(id); database().exec('COMMIT') } catch (error) { database().exec('ROLLBACK'); throw error } }

/**
 * 手动修正二维码分类（任务勾选进群依赖此字段）。
 * @param {string} id 记录 id
 * @param {string} qrType GROUP_LINK | PERSONAL_LINK | QQ_GROUP_LINK | UNKNOWN | INVALID
 * @returns {boolean}
 */
function updateQrItemType(id, qrType) {
  const itemId = String(id || '').trim()
  const allowed = new Set(['GROUP_LINK', 'PERSONAL_LINK', 'QQ_GROUP_LINK', 'UNKNOWN', 'INVALID'])
  const nextType = String(qrType || '').trim()
  if (!itemId || !allowed.has(nextType)) return false
  const result = database().prepare('UPDATE qr_items SET qr_type=?, updated_at=? WHERE id=?')
    .run(nextType, new Date().toISOString(), itemId)
  return Number(result.changes || 0) > 0
}

function updateQrScanResult(targetKey, response, success) {
  const decoded = response?.data?.scan_res ?? response?.scan_res ?? ''
  const status = success ? 'SCANNED' : 'SCAN_FAILED'
  const existing = database().prepare('SELECT decoded_text AS decodedText, qr_type AS qrType FROM qr_items WHERE sha256=? OR id=? LIMIT 1')
    .get(targetKey, targetKey)
  // 多码海报的微信扫码接口只返回其中一个码，不能用随机扫到的个人码/未知码
  // 覆盖采集阶段已经离线确认的微信群链接。
  const scannedType = classifyStoredQr(decoded)
  const preserveGroup = existing?.qrType === 'GROUP_LINK' && scannedType !== 'GROUP_LINK'
  const finalDecoded = preserveGroup ? existing.decodedText : (decoded ? String(decoded) : null)
  const finalType = preserveGroup ? existing.qrType : scannedType
  database().prepare('UPDATE qr_items SET decoded_text=?,qr_type=?,status=?,updated_at=? WHERE sha256=? OR id=?')
    .run(finalDecoded, finalType, status, new Date().toISOString(), targetKey, targetKey)
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
 * @returns {{ enabled: boolean, instanceId: string, accountWxid: string, roomIds: string[], keywords: string[], excludeText: string, updatedAt: string }}
 */
function getChatAddRule() {
  const row = database().prepare(`SELECT enabled, instance_id AS instanceId, account_wxid AS accountWxid,
      room_ids_json AS roomIdsJson, keywords_json AS keywordsJson, exclude_text AS excludeText, updated_at AS updatedAt
    FROM chat_add_rules WHERE id=1`).get()
  if (!row) {
    return { enabled: false, instanceId: '', accountWxid: '', roomIds: [], keywords: [], excludeText: '', updatedAt: '' }
  }
  let roomIds = []
  let keywords = []
  try { roomIds = JSON.parse(row.roomIdsJson || '[]') } catch { roomIds = [] }
  try { keywords = JSON.parse(row.keywordsJson || '[]') } catch { keywords = [] }
  return {
    enabled: Boolean(row.enabled),
    instanceId: String(row.instanceId || ''),
    accountWxid: String(row.accountWxid || ''),
    roomIds: Array.isArray(roomIds) ? roomIds.map(String).filter(Boolean) : [],
    keywords: Array.isArray(keywords) ? keywords.map(String).filter(Boolean) : [],
    excludeText: String(row.excludeText || ''),
    updatedAt: String(row.updatedAt || ''),
  }
}

/**
 * 保存群聊发言加好友监听规则。
 * @param {{ enabled?: boolean, instanceId?: string, accountWxid?: string, roomIds?: string[], keywords?: string[]|string, excludeText?: string }} rule
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
  const previous = getChatAddRule()
  const incomingWxid = String(rule.accountWxid || '').trim()
  // 空 wxid 不覆盖已有锚点（探测未完成时的草稿保存）
  const accountWxid = incomingWxid || previous.accountWxid || null
  const now = new Date().toISOString()
  database().prepare(`INSERT INTO chat_add_rules(id,enabled,instance_id,account_wxid,room_ids_json,keywords_json,exclude_text,updated_at)
    VALUES(1,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,instance_id=excluded.instance_id,
      account_wxid=excluded.account_wxid,
      room_ids_json=excluded.room_ids_json,keywords_json=excluded.keywords_json,
      exclude_text=excluded.exclude_text,updated_at=excluded.updated_at`)
    .run(rule.enabled ? 1 : 0, String(rule.instanceId || '') || null, accountWxid || null, JSON.stringify(roomIds), JSON.stringify(keywords), excludeText, now)
  return getChatAddRule()
}

/**
 * 写入或刷新群聊发言加好友候选（同实例同人只保留一条）。
 * @param {{ instanceId: string, roomId: string, senderWxid: string, nickname?: string, messagePreview?: string, matchedKeyword?: string }} hit
 * @returns {{ accepted: boolean, reason?: string, id?: number }}
 */
function upsertChatAddCandidate(hit) {
  const instanceId = String(hit?.instanceId || '')
  const roomId = String(hit?.sourceRoomId || hit?.roomId || '')
  const senderWxid = String(hit?.senderWxid || '')
  if (!instanceId || !roomId || !senderWxid) return { accepted: false, reason: 'INVALID' }
  const nickname = String(hit.nickname || '')
  const messagePreview = String(hit.messagePreview || '').slice(0, 200)
  const matchedKeyword = String(hit.matchedKeyword || '')
  const now = String(hit.receivedAt || '') || new Date().toISOString()
  const sourceRoomName = String(hit.sourceRoomName || database().prepare('SELECT name FROM chatrooms WHERE source_instance_id=? AND room_id=?').get(instanceId, roomId)?.name || '')
  const sourceInstancePort = Number(hit.sourceInstancePort) || null
  const accountWxid = String(hit.accountWxid || '')
  const senderV3 = String(hit.senderV3 || '')
  let existing = null
  if (accountWxid) {
    existing = database().prepare(
      "SELECT id, status FROM chat_add_candidates WHERE account_wxid=? AND sender_wxid=? AND source_room_id=? AND account_wxid!=''",
    ).get(accountWxid, senderWxid, roomId)
  }
  if (!existing) {
    existing = database().prepare('SELECT id, status FROM chat_add_candidates WHERE instance_id=? AND sender_wxid=? AND source_room_id=?').get(instanceId, senderWxid, roomId)
  }
  if (existing) {
    // 已入过任务的候选仍可刷新消息，并回到待创建，允许再次创建同一任务
    database().prepare(`UPDATE chat_add_candidates SET instance_id=?, room_id=?, nickname=?, message_preview=?, matched_keyword=?, status='PENDING', created_at=?,
      source_room_name=?,source_instance_port=?,account_wxid=?,sender_v3=?,received_at=? WHERE id=?`)
      .run(instanceId, roomId, nickname || null, messagePreview || null, matchedKeyword || null, now, sourceRoomName || null, sourceInstancePort, accountWxid || null, senderV3 || null, now, existing.id)
    return { accepted: true, id: existing.id }
  }
  try {
    const result = database().prepare(`INSERT INTO chat_add_candidates(instance_id,room_id,sender_wxid,nickname,message_preview,matched_keyword,status,created_at,
      source_room_id,source_room_name,source_instance_port,account_wxid,sender_v3,received_at) VALUES(?,?,?,?,?,?, 'PENDING', ?,?,?,?,?,?,?)`)
      .run(instanceId, roomId, senderWxid, nickname || null, messagePreview || null, matchedKeyword || null, now, roomId, sourceRoomName || null, sourceInstancePort, accountWxid || null, senderV3 || null, now)
    return { accepted: true, id: Number(result.lastInsertRowid) }
  } catch (error) {
    const msg = String(error?.message || error || '')
    if (!/UNIQUE/i.test(msg)) throw error
    const raced = accountWxid
      ? database().prepare(
        "SELECT id FROM chat_add_candidates WHERE account_wxid=? AND sender_wxid=? AND source_room_id=? AND account_wxid!=''",
      ).get(accountWxid, senderWxid, roomId)
      : database().prepare('SELECT id FROM chat_add_candidates WHERE instance_id=? AND sender_wxid=? AND source_room_id=?').get(instanceId, senderWxid, roomId)
    if (raced?.id) {
      database().prepare(`UPDATE chat_add_candidates SET instance_id=?, room_id=?, nickname=?, message_preview=?, matched_keyword=?, status='PENDING', created_at=?,
        source_room_name=?,source_instance_port=?,account_wxid=?,sender_v3=?,received_at=? WHERE id=?`)
        .run(instanceId, roomId, nickname || null, messagePreview || null, matchedKeyword || null, now, sourceRoomName || null, sourceInstancePort, accountWxid || null, senderV3 || null, now, raced.id)
      return { accepted: true, id: raced.id }
    }
    return { accepted: false, reason: 'UNIQUE_CONFLICT' }
  }
}

/**
 * 列出群聊发言加好友候选。
 * @param {{ status?: string, instanceId?: string, roomIds?: string[], since?: string, limit?: number }} [filters]
 * @returns {Array<{ id: number, instanceId: string, roomId: string, senderWxid: string, nickname: string, messagePreview: string, matchedKeyword: string, status: string, createdAt: string }>}
 */
function listChatAddCandidates(filters = {}) {
  const clauses = []
  const params = []
  if (filters.status) {
    clauses.push('status=?')
    params.push(String(filters.status))
  }
  if (filters.instanceId) {
    clauses.push('(instance_id=? OR (account_wxid!=\'\' AND account_wxid=(SELECT COALESCE(account_wxid,\'\') FROM wechat_instances WHERE id=?)))')
    params.push(String(filters.instanceId), String(filters.instanceId))
  }
  if (filters.accountWxid) {
    clauses.push('account_wxid=?')
    params.push(String(filters.accountWxid))
  }
  if (Array.isArray(filters.roomIds)) {
    const roomIds = [...new Set(filters.roomIds.map(String).filter(Boolean))]
    if (!roomIds.length) return []
    clauses.push(`room_id IN (${roomIds.map(() => '?').join(',')})`)
    params.push(...roomIds)
  }
  if (filters.since) {
    clauses.push('created_at>=?')
    params.push(String(filters.since))
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = Math.min(Math.max(Number(filters.limit) || 2000, 1), 20000)
  return database().prepare(`SELECT id, instance_id AS instanceId, room_id AS roomId, sender_wxid AS senderWxid,
      source_room_id AS sourceRoomId, COALESCE(source_room_name,'') AS sourceRoomName,
      source_instance_port AS sourceInstancePort, COALESCE(account_wxid,'') AS accountWxid,
      COALESCE(sender_v3,'') AS senderV3, received_at AS receivedAt,
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
  const stmt = database().prepare(`UPDATE chat_add_candidates SET status='TASKED' WHERE id=?`)
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

/**
 * 被踢证据优先级：系统踢人文案 > 退群回调本人 > 其它。
 * @param {string} current
 * @param {string} incoming
 * @returns {string}
 */
function preferKickEvidence(current, incoming) {
  const rank = (value) => {
    if (value === 'SYSTEM_MSG_SELF_KICKED') return 3
    if (value === 'LEAVE_CALLBACK_SELF') return 2
    if (value) return 1
    return 0
  }
  const cur = String(current || '')
  const next = String(incoming || '')
  return rank(next) >= rank(cur) ? next : cur
}

/**
 * 登记被踢群待清理项（已存在则保留更强证据；CANCELLED 可被新证据重新拉起）。
 * @param {{ instanceId: string, roomId: string, accountWxid?: string, roomName?: string, evidence: string, evidenceStrength?: string }} row
 */
function upsertKickedGroupPending(row) {
  const instanceId = String(row.instanceId || '')
  const roomId = String(row.roomId || '')
  if (!instanceId || !roomId.endsWith('@chatroom')) return false
  const now = new Date().toISOString()
  const existing = database().prepare(
    'SELECT evidence, status FROM kicked_group_cleanup WHERE instance_id=? AND room_id=?',
  ).get(instanceId, roomId)
  const evidence = preferKickEvidence(existing?.evidence || '', String(row.evidence || 'UNKNOWN'))
  const strength = String(row.evidenceStrength || 'strong')
  const accountWxid = String(row.accountWxid || '')
  const roomName = String(row.roomName || '')
  database().prepare(`INSERT INTO kicked_group_cleanup(
      instance_id,room_id,account_wxid,room_name,evidence,evidence_strength,confirm_count,unsave_status,delete_chat_status,status,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,0,'PENDING','PENDING','PENDING',?,?)
    ON CONFLICT(instance_id,room_id) DO UPDATE SET
      account_wxid=CASE WHEN excluded.account_wxid!='' THEN excluded.account_wxid ELSE kicked_group_cleanup.account_wxid END,
      room_name=CASE WHEN excluded.room_name!='' THEN excluded.room_name ELSE kicked_group_cleanup.room_name END,
      evidence=excluded.evidence,
      evidence_strength='strong',
      -- 重复回调不得清零确认次数，否则永远凑不齐 2 次巡检
      confirm_count=kicked_group_cleanup.confirm_count,
      unsave_status=kicked_group_cleanup.unsave_status,
      delete_chat_status=kicked_group_cleanup.delete_chat_status,
      status=CASE WHEN kicked_group_cleanup.status='DONE' THEN 'DONE' ELSE 'PENDING' END,
      last_error=CASE WHEN kicked_group_cleanup.status='DONE' THEN kicked_group_cleanup.last_error ELSE NULL END,
      updated_at=excluded.updated_at
  `).run(instanceId, roomId, accountWxid, roomName, evidence, strength, now, now)
  return true
}

/**
 * 读取单条被踢清理记录（任务执行时合并最新状态）。
 * @param {string} instanceId
 * @param {string} roomId
 */
function getKickedGroupCleanup(instanceId, roomId) {
  const id = String(instanceId || '').trim()
  const room = String(roomId || '').trim()
  if (!id || !room) return null
  return database().prepare(`
    SELECT instance_id AS instanceId, room_id AS roomId, COALESCE(account_wxid,'') AS accountWxid,
      COALESCE(room_name,'') AS roomName, evidence, evidence_strength AS evidenceStrength,
      confirm_count AS confirmCount, last_absent_at AS lastAbsentAt,
      unsave_status AS unsaveStatus, delete_chat_status AS deleteChatStatus,
      status, COALESCE(last_error,'') AS lastError, created_at AS createdAt, updated_at AS updatedAt
    FROM kicked_group_cleanup WHERE instance_id=? AND room_id=?
  `).get(id, room) || null
}

/**
 * 已在任务中心排队/执行中的被踢清理目标（避免重复建任务）。
 * @returns {Array<{ instanceId: string, roomId: string }>}
 */
function listActiveKickedCleanupTargets() {
  return database().prepare(`
    SELECT ti.instance_id AS instanceId,
      TRIM(COALESCE(
        NULLIF(json_extract(ti.request_json, '$.roomId'), ''),
        CASE
          WHEN ti.target_key LIKE '%@chatroom' THEN ti.target_key
          WHEN INSTR(ti.target_key, '::') > 0 THEN SUBSTR(ti.target_key, INSTR(ti.target_key, '::') + 2)
          ELSE ti.target_key
        END
      )) AS roomId
    FROM task_items ti
    JOIN tasks t ON t.id = ti.task_id
    WHERE ti.action_type = 'KICKED_GROUP_CLEANUP'
      AND t.status IN ('WAITING_CONFIRMATION','QUEUED','RUNNING','PAUSED','COOLING_DOWN')
      AND ti.status IN ('QUEUED','RUNNING','PROFILE_PENDING','CREDENTIALS_READY')
  `).all().map((row) => ({
    instanceId: String(row.instanceId || ''),
    roomId: String(row.roomId || ''),
  })).filter((row) => row.instanceId && row.roomId.endsWith('@chatroom'))
}

/**
 * @param {{ instanceId?: string, accountWxid?: string, status?: string }} [filters]
 */
function listKickedGroupPending(filters = {}) {
  const where = []
  const params = []
  if (filters.instanceId) { where.push('instance_id=?'); params.push(String(filters.instanceId)) }
  if (filters.accountWxid) { where.push('account_wxid=?'); params.push(String(filters.accountWxid)) }
  if (filters.status) { where.push('status=?'); params.push(String(filters.status)) }
  else { where.push("status='PENDING'") }
  const sql = `SELECT instance_id AS instanceId, room_id AS roomId, COALESCE(account_wxid,'') AS accountWxid,
    COALESCE(room_name,'') AS roomName, evidence, evidence_strength AS evidenceStrength,
    confirm_count AS confirmCount, last_absent_at AS lastAbsentAt,
    unsave_status AS unsaveStatus, delete_chat_status AS deleteChatStatus,
    status, COALESCE(last_error,'') AS lastError, created_at AS createdAt, updated_at AS updatedAt
    FROM kicked_group_cleanup ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at ASC`
  return database().prepare(sql).all(...params)
}

/**
 * 重启/重开实例后 instanceId 会变：把同微信号上仍 PENDING 的被踢清理任务迁到当前实例。
 * 不迁则启动巡检按新 instanceId 查库永远为空，表现为“启动后不清理被踢群”。
 * @param {string} newInstanceId
 * @param {string} [accountWxid]
 * @returns {number} 迁移条数
 */
function rebindKickedGroupPendingToInstance(newInstanceId, accountWxid = '') {
  const instanceId = String(newInstanceId || '').trim()
  const account = String(accountWxid || '').trim()
  if (!instanceId || !account) return 0
  const liveIds = new Set(
    listStoredInstances().map((row) => String(row.id || '').trim()).filter(Boolean),
  )
  liveIds.add(instanceId)
  const pending = database().prepare(
    `SELECT instance_id AS instanceId, room_id AS roomId, COALESCE(account_wxid,'') AS accountWxid,
      COALESCE(room_name,'') AS roomName, evidence, evidence_strength AS evidenceStrength,
      confirm_count AS confirmCount, last_absent_at AS lastAbsentAt,
      unsave_status AS unsaveStatus, delete_chat_status AS deleteChatStatus,
      COALESCE(last_error,'') AS lastError
     FROM kicked_group_cleanup
     WHERE status='PENDING' AND instance_id!=? AND TRIM(COALESCE(account_wxid,''))=?`,
  ).all(instanceId, account)
  if (!pending.length) return 0

  const del = database().prepare('DELETE FROM kicked_group_cleanup WHERE instance_id=? AND room_id=?')
  const existingStatus = database().prepare(
    'SELECT status FROM kicked_group_cleanup WHERE instance_id=? AND room_id=?',
  )
  let moved = 0
  for (const row of pending) {
    const oldId = String(row.instanceId || '')
    // 仅迁移：同微信号，且旧实例已不在库 / 或仍挂在别的历史 id 上
    if (liveIds.has(oldId) && oldId !== instanceId) {
      // 旧实例记录还在：仍迁，避免双开同号残留；真正双开同号极少见
    }
    const cur = existingStatus.get(instanceId, row.roomId)
    if (cur?.status === 'DONE') {
      del.run(oldId, row.roomId)
      moved += 1
      continue
    }
    upsertKickedGroupPending({
      instanceId,
      roomId: row.roomId,
      accountWxid: account,
      roomName: row.roomName || '',
      evidence: row.evidence || 'UNKNOWN',
      evidenceStrength: row.evidenceStrength || 'strong',
    })
    updateKickedGroupCleanup(instanceId, row.roomId, {
      confirmCount: Math.max(Number(row.confirmCount) || 0, 0),
      lastAbsentAt: row.lastAbsentAt || null,
      unsaveStatus: row.unsaveStatus || 'PENDING',
      deleteChatStatus: row.deleteChatStatus || 'PENDING',
      status: 'PENDING',
      lastError: row.lastError || null,
    })
    del.run(oldId, row.roomId)
    moved += 1
  }
  return moved
}

/**
 * @param {string} instanceId
 * @param {string} roomId
 * @param {Record<string, unknown>} patch
 */
function updateKickedGroupCleanup(instanceId, roomId, patch = {}) {
  const fields = []
  const params = []
  const map = {
    accountWxid: 'account_wxid',
    roomName: 'room_name',
    evidence: 'evidence',
    evidenceStrength: 'evidence_strength',
    confirmCount: 'confirm_count',
    lastAbsentAt: 'last_absent_at',
    unsaveStatus: 'unsave_status',
    deleteChatStatus: 'delete_chat_status',
    status: 'status',
    lastError: 'last_error',
  }
  for (const [key, column] of Object.entries(map)) {
    if (patch[key] === undefined) continue
    fields.push(`${column}=?`)
    params.push(patch[key])
  }
  if (!fields.length) return 0
  fields.push('updated_at=?')
  params.push(new Date().toISOString())
  params.push(String(instanceId), String(roomId))
  return database().prepare(`UPDATE kicked_group_cleanup SET ${fields.join(',')} WHERE instance_id=? AND room_id=?`).run(...params).changes
}

/**
 * 删除本地某实例对该群的归属缓存（通讯录群/群列表/成员）。
 * @param {string} instanceId
 * @param {string} roomId
 */
function removeLocalChatroomOwnership(instanceId, roomId) {
  const iid = String(instanceId || '')
  const rid = String(roomId || '')
  if (!iid || !rid.endsWith('@chatroom')) return 0
  database().exec('BEGIN IMMEDIATE')
  try {
    const a = database().prepare('DELETE FROM chatroom_members WHERE source_instance_id=? AND room_id=?').run(iid, rid).changes
    const b = database().prepare('DELETE FROM chatroom_sources WHERE instance_id=? AND room_id=?').run(iid, rid).changes
    const c = database().prepare('DELETE FROM chatrooms WHERE source_instance_id=? AND room_id=?').run(iid, rid).changes
    const d = database().prepare('DELETE FROM contacts WHERE source_instance_id=? AND wxid=? AND is_group=1').run(iid, rid).changes
    database().exec('COMMIT')
    return a + b + c + d
  } catch (error) {
    database().exec('ROLLBACK')
    throw error
  }
}

/**
 * @param {string} instanceId
 * @returns {Array<{ roomId: string, name: string, saved: number }>}
 */
function listOwnedChatrooms(instanceId) {
  return database().prepare(`SELECT room_id AS roomId, COALESCE(name,'') AS name, saved
    FROM chatrooms WHERE source_instance_id=? ORDER BY name`).all(String(instanceId || ''))
}

module.exports = {
  initStorage, database, flushDatabaseCheckpoint, saveSetting, getSettings, upsertInstance, listStoredInstances, removeInstance, removeInactiveInstancesByPorts,
  saveLog, listLogs, clearLogs, clearRuntimeCaches, clearApiSamplesOnly, saveApiSample, sanitizeApiSampleValue, saveEvent, listMessageEventsForKickScan, recordMemberJoin, listMemberJoins, listFriendAddStatuses,
  createTask, listTasks, getTaskItems, setTaskStatus, cancelTask, setTaskItemStatus, setTaskItemStarted, setTaskItemResult, patchTaskItemRequest, patchTaskConfig, recoverInterruptedTasks,
  repairConfirmedSendTextResults, reserveFriendDailyAttempt, reserveQrJoinDailyAttempt, releaseFriendDailyAttempt, releaseQrJoinDailyAttempt, updateTaskItemInstanceId, migrateDirectorySnapshotToInstance, rebindChatAddCandidatesForAccount, hasDeliveredContent, recordDeliveredContent,
  hasDirectoryOwnership, loadDirectoryOwnershipSet, syncDirectorySnapshot, remoteSyncSnapshot, saveQrItem, listQrItems, deleteQrItems, updateQrScanResult, updateQrItemType,
  getChatAddRule, saveChatAddRule, upsertChatAddCandidate, listChatAddCandidates, markChatAddCandidatesTasked, clearChatAddCandidates,
  upsertKickedGroupPending, getKickedGroupCleanup, listKickedGroupPending, listActiveKickedCleanupTargets, rebindKickedGroupPendingToInstance, updateKickedGroupCleanup, removeLocalChatroomOwnership, listOwnedChatrooms,
  markChatroomBlocked, isChatroomBlocked, isChatroomBlockedForInstance, loadBlockedRoomIdSet, loadBlockedRoomIdSetForInstance, loadDirectoryExcludedRoomIdSetForInstance, listBlockedChatrooms,
  hasQrContentHash, isHighPrioritySyncLog, isNoisySyncLog, selectLogsForRemoteSync, listTaskItemDiagnostics, formatLogForRemoteSync,
}
