function isRecord(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function parseJson(value) {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!text || (!text.startsWith('{') && !text.startsWith('['))) return value
  try { return JSON.parse(text) } catch { return value }
}
function readString(value) {
  const parsed = parseJson(value)
  if (typeof parsed === 'string') return parsed.trim()
  if (!isRecord(parsed)) return ''
  for (const key of ['String', 'string', 'value']) if (typeof parsed[key] === 'string' && parsed[key].trim()) return parsed[key].trim()
  return ''
}
function records(value) {
  const parsed = parseJson(value)
  if (Array.isArray(parsed)) return parsed.filter(isRecord)
  return isRecord(parsed) ? [parsed] : []
}
function payloadLayers(raw) {
  const result = []
  const queue = [raw]
  const seen = new Set()
  while (queue.length) {
    const value = parseJson(queue.shift())
    if (!value || seen.has(value)) continue
    if (typeof value === 'object') seen.add(value)
    if (isRecord(value)) {
      result.push(value)
      for (const key of ['data', 'body', 'result', 'response']) if (key in value) queue.push(value[key])
      if (isRecord(value.JsApiResponse) && 'RespJson' in value.JsApiResponse) queue.push(value.JsApiResponse.RespJson)
    }
  }
  return result
}
function parseProfileCredentials(raw, targetWxid, roomId) {
  let v3 = ''
  let v4 = ''
  let baseRet
  let contactCount = 0
  let contactListLength = 0
  let matchedContact = false
  let matchedTicket = false
  const target = String(targetWxid || '')
  for (const payload of payloadLayers(raw)) {
    const base = isRecord(payload.baseResponse) ? payload.baseResponse : null
    if (base && baseRet === undefined && (typeof base.ret === 'number' || typeof base.ret === 'string')) baseRet = Number(base.ret)
    const contacts = records(payload.contactList)
    if (contacts.length) {
      contactListLength = Math.max(contactListLength, contacts.length)
      contactCount = Math.max(contactCount, Number(payload.contactCount) || contacts.length)
      // 指定目标时禁止回落到其他人的 contact，避免错配 V3
      let contact = contacts.find((item) => readString(item.userName) === target || readString(item.friendUserName) === target)
      if (!contact && contacts.length === 1) {
        const only = contacts[0]
        const onlyName = readString(only.userName) || readString(only.friendUserName)
        if (!target || !onlyName || onlyName === target) contact = only
      }
      if (!contact && !target) contact = contacts[0]
      matchedContact = Boolean(contact)
      const candidate = readString(contact?.encryptUserName) || readString(contact?.userName)
      if (!v3 && /^v3_/i.test(candidate)) v3 = candidate
    }
    // update_single_profile / get_contact_fast 等扁平联系人响应：顶层 encryptUserName
    const flatUserName = readString(payload.userName)
    const flatEncrypt = readString(payload.encryptUserName)
    if (flatEncrypt && /^v3_/i.test(flatEncrypt)) {
      if (!target || !flatUserName || flatUserName === target) {
        matchedContact = true
        if (!v3) v3 = flatEncrypt
      }
    }
    const tickets = records(payload.verifyUserValidTicketList)
    if (tickets.length) {
      // 指定目标时禁止回落到其他人的 ticket，避免错配 V4 → Invalid argument
      let ticket = tickets.find((item) => readString(item.username) === target)
      if (!ticket && tickets.length === 1) {
        const onlyName = readString(tickets[0].username)
        if (!target || !onlyName || onlyName === target) ticket = tickets[0]
      }
      if (!ticket && !target) ticket = tickets[0]
      matchedTicket = Boolean(ticket)
      const candidate = readString(ticket?.antispamticket) || readString(ticket?.antispamTicket)
      if (!v4 && /^v4_/i.test(candidate)) v4 = candidate
    }
    const topV4 = readString(payload.antispamticket) || readString(payload.antispamTicket)
    if (!v4 && /^v4_/i.test(topV4)) v4 = topV4
  }
  return { targetWxid, roomId, v3, v4, baseRet, contactCount, contactListLength, matchedContact, matchedTicket, missing: [v3 ? '' : 'v3', v4 ? '' : 'v4'].filter(Boolean) }
}
function redactPreview(raw) {
  let text
  try { text = typeof raw === 'string' ? raw : JSON.stringify(raw) } catch { text = String(raw) }
  return text.replace(/v3_[^"'\s<>]+/gi, (v) => `${v.slice(0, 10)}...[${v.length}]`).replace(/v4_[^"'\s<>]+/gi, (v) => `${v.slice(0, 10)}...[${v.length}]`).slice(0, 2000)
}
function rawStructure(raw) {
  const parsed = parseJson(raw)
  const data = isRecord(parsed) ? parseJson(parsed.data) : undefined
  const body = (() => { try { return typeof raw === 'string' ? raw : JSON.stringify(raw) } catch { return String(raw) } })()
  return {
    rawType: Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed,
    rawTopLevelKeys: isRecord(parsed) ? Object.keys(parsed).slice(0, 40).join(',') : '',
    dataType: Array.isArray(data) ? 'array' : data === null ? 'null' : typeof data,
    dataTopLevelKeys: isRecord(data) ? Object.keys(data).slice(0, 40).join(',') : '',
    bodyLength: body.length,
    rawPreview: redactPreview(raw),
  }
}
module.exports = { parseProfileCredentials, rawStructure, readString, payloadLayers }
