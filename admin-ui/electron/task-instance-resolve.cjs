'use strict'

/**
 * 任务项微信实例解析：按 accountWxid 安全 rebind（可单测）。
 * @param {{ instance_id?: string, instanceId?: string, account_wxid?: string, accountWxid?: string }} item
 * @param {Map<string, { id: string, status?: string, accountWxid?: string }>} instanceMap
 * @returns {{
 *   ok: boolean,
 *   record?: object,
 *   rebound?: boolean,
 *   reason?: string,
 *   code?: 'MISSING'|'OFFLINE'|'ACCOUNT_MISMATCH'|'AMBIGUOUS_INSTANCE'|'WAITING_INSTANCE'
 * }}
 */
function resolveTaskItemInstance(item, instanceMap) {
  const instanceId = String(item?.instance_id || item?.instanceId || '').trim()
  const accountWxid = String(item?.account_wxid || item?.accountWxid || '').trim()
  const map = instanceMap instanceof Map ? instanceMap : new Map()

  const original = instanceId ? map.get(instanceId) : null
  if (original && String(original.status || '') === 'ONLINE') {
    if (accountWxid && String(original.accountWxid || '') && String(original.accountWxid) !== accountWxid) {
      return { ok: false, code: 'ACCOUNT_MISMATCH', reason: '任务账号与当前微信不一致' }
    }
    if (accountWxid && !String(original.accountWxid || '')) {
      // ONLINE 但账号未就绪：不允许盲发
      return { ok: false, code: 'WAITING_INSTANCE', reason: '微信账号身份未就绪' }
    }
    return { ok: true, record: original, rebound: false }
  }

  if (!accountWxid) {
    if (!original) {
      return { ok: false, code: 'MISSING', reason: '历史任务缺少账号身份，无法安全恢复' }
    }
    return { ok: false, code: 'OFFLINE', reason: '微信尚未登录' }
  }

  const matches = []
  for (const record of map.values()) {
    if (String(record.status || '') !== 'ONLINE') continue
    if (String(record.accountWxid || '') !== accountWxid) continue
    matches.push(record)
  }
  if (matches.length === 1) {
    return { ok: true, record: matches[0], rebound: matches[0].id !== instanceId }
  }
  if (matches.length > 1) {
    return { ok: false, code: 'AMBIGUOUS_INSTANCE', reason: '同账号存在多个在线微信，无法自动绑定' }
  }
  return { ok: false, code: 'WAITING_INSTANCE', reason: '同账号微信未在线' }
}

module.exports = { resolveTaskItemInstance }
