/**
 * 二维码监控群列表：合并 / 规范化（可单测）。
 */

/**
 * 监控群唯一键：instanceId + roomId（多微信可拥有相同 roomId）。
 * @param {string} instanceId
 * @param {string} roomId
 * @returns {string}
 */
function monitorRoomKey(instanceId, roomId) {
  return `${String(instanceId || '').trim()}\u0000${String(roomId || '').trim()}`
}

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
 * 将新群合并进已有监控列表（按 instanceId+roomId 去重；同 pair 更新 name）。
 * @param {unknown[]} existing
 * @param {unknown[]} incoming
 * @returns {{ rooms: Array<{ instanceId: string, roomId: string, name: string }>, added: Array<{ instanceId: string, roomId: string, name: string }> }}
 */
function mergeMonitorRooms(existing = [], incoming = []) {
  const map = new Map()
  for (const item of Array.isArray(existing) ? existing : []) {
    const room = normalizeMonitorRoom(item)
    if (room) map.set(monitorRoomKey(room.instanceId, room.roomId), room)
  }
  const added = []
  for (const item of Array.isArray(incoming) ? incoming : []) {
    const room = normalizeMonitorRoom(item)
    if (!room) continue
    const key = monitorRoomKey(room.instanceId, room.roomId)
    const prev = map.get(key)
    if (!prev) {
      map.set(key, room)
      added.push(room)
      continue
    }
    map.set(key, {
      instanceId: prev.instanceId,
      roomId: prev.roomId,
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
      const key = roomId
      if (!found.has(key) || (name && name !== '群聊' && found.get(key).name === '群聊')) {
        found.set(key, { roomId, name })
      }
    }
    for (const child of Object.values(row)) walk(child, depth + 1)
  }
  walk(raw)
  return [...found.values()]
}

module.exports = {
  monitorRoomKey,
  normalizeMonitorRoom,
  mergeMonitorRooms,
  extractRoomsFromApiRaw,
}
