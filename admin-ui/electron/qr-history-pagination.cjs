'use strict'

/**
 * 历史图片消息 keyset 分页（可单测，不依赖微信）。
 * 注意：微信 sqlite3_exec 多数路径不支持 bind，故 afterLocalId 内联为数字。
 * @param {{ orderColumn: string, typeColumn: string, table: string, pageSize: number, afterLocalId?: number|null, maxRemaining?: number|null }} opts
 * @returns {{ sql: string, params: unknown[], limit: number }}
 */
function buildHistoryImagePageSql(opts) {
  const table = String(opts.table || '')
  const typeColumn = String(opts.typeColumn || 'type')
  const orderColumn = String(opts.orderColumn || 'local_id')
  const pageSize = Math.min(Math.max(Math.floor(Number(opts.pageSize) || 300), 1), 500)
  const maxRemaining = opts.maxRemaining == null ? null : Math.max(0, Math.floor(Number(opts.maxRemaining)))
  const limit = maxRemaining == null ? pageSize : Math.min(pageSize, maxRemaining)
  const after = opts.afterLocalId
  const quote = (name) => `"${String(name).replace(/"/g, '""')}"`
  let sql = `SELECT * FROM ${quote(table)} WHERE ${quote(typeColumn)}=3`
  if (after != null && after !== '' && Number.isFinite(Number(after))) {
    sql += ` AND ${quote(orderColumn)} < ${Number(after)}`
  }
  sql += ` ORDER BY ${quote(orderColumn)} DESC LIMIT ${limit}`
  return { sql, params: [], limit }
}

module.exports = { buildHistoryImagePageSql }
