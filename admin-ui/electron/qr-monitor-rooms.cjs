/**
 * 二维码监控群列表：合并 / 规范化（可单测）。
 */

/**
 * 规范化监控群条目。
 * @param {unknown} room
 * @returns {{ instanceId: string, roomId: string, name: string } | null}
 */
function normalizeMonitorRoom(room) {
  if (!room || typeof room !== 'object') return null
  const instanceId = String(room.instanceId || '').trim()
  const roomId = String(room.roomId || '').trim()
  const name = String(room.name || '群聊').trim() || '群聊'
  if (!instanceId || !roomId.endsWith('@chatroom')) return null
  return { instanceId, roomId, name }
}

/**
 * 将新群合并进已有监控列表（按 roomId 去重；已存在则更新 instanceId/name）。
 * @param {unknown[]} existing
 * @param {unknown[]} incoming
 * @returns {{ rooms: Array<{ instanceId: string, roomId: string, name: string }>, added: Array<{ instanceId: string, roomId: string, name: string }> }}
 */
function mergeMonitorRooms(existing = [], incoming = []) {
  const map = new Map()
  for (const item of Array.isArray(existing) ? existing : []) {
    const room = normalizeMonitorRoom(item)
    if (room) map.set(room.roomId, room)
  }
  const added = []
  for (const item of Array.isArray(incoming) ? incoming : []) {
    const room = normalizeMonitorRoom(item)
    if (!room) continue
    const prev = map.get(room.roomId)
    if (!prev) {
      map.set(room.roomId, room)
      added.push(room)
      continue
    }
    // 微信重启后 instanceId 会变；名称以非空新名为准
    map.set(room.roomId, {
      instanceId: room.instanceId || prev.instanceId,
      roomId: room.roomId,
      name: room.name && room.name !== '群聊' ? room.name : prev.name,
    })
  }
  return { rooms: [...map.values()], added }
}

/**
 * 从微信接口原始响应中尽量提取群 roomId + 名称。
 * @param {unknown} raw
 * @returns {Array<{ roomId: string, name: string }>}
 */
function extractRoomsFromApiRaw(raw) {
  const found = new Map()
  const seen = new Set()
  const walk = (value, depth = 0) => {
    if (value == null || depth > 8) return
    if (typeof value !== 'object') return
    if (seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    const row = value
    const roomId = String(
      row.roomId || row.room_id || row.chatroomId || row.chatRoomId
      || row.userName || row.username || row.UserName || row.wxid || '',
    ).trim()
    if (roomId.endsWith('@chatroom')) {
      const name = String(
        row.nickName || row.nickname || row.nick_name || row.displayName
        || row.remark || row.roomName || row.name || '群聊',
      ).trim() || '群聊'
      if (!found.has(roomId) || (name && name !== '群聊' && found.get(roomId).name === '群聊')) {
        found.set(roomId, { roomId, name })
      }
    }
    for (const child of Object.values(row)) walk(child, depth + 1)
  }
  walk(raw)
  return [...found.values()]
}

module.exports = {
  normalizeMonitorRoom,
  mergeMonitorRooms,
  extractRoomsFromApiRaw,
}
