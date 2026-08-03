const { createHash } = require('crypto')
const { existsSync } = require('fs')
const path = require('path')
const zlib = require('zlib')
const jsQR = require('jsqr')
let zbarPromise

/** zstd 帧魔数（微信 WCDB 压缩内容常见） */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function safeFolderName(value, fallback = '未命名') {
  const text = String(value || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '').trim()
  return (text || fallback).slice(0, 80)
}

/**
 * 识别二维码文本类型（微信群 / 微信个人 / QQ 群）。
 * @param {string} text 解码文本
 * @returns {'QQ_GROUP_LINK'|'GROUP_LINK'|'PERSONAL_LINK'|'UNKNOWN'}
 */
function classifyQrText(text) {
  const value = String(text || '').trim()
  if (!value) return 'UNKNOWN'
  // QQ 群优先：避免被通用链接规则误伤
  if (/qun\.qq\.com|qm\.qq\.com|jq\.qq\.com|qq\.com\/q\/|mqqapi:\/\/card\/show_pslcard[^\s]*(?:card_type=group|group_code=|src_type=internal)/i.test(value)) {
    return 'QQ_GROUP_LINK'
  }
  if (/addchatroombyinvite|weixin\.qq\.com\/g\/|wechat\.com\/g\//i.test(value)) return 'GROUP_LINK'
  if (/u\.wechat\.com|weixin\.qq\.com\/r\/|weixin\.qq\.com\/[a-z]\/|wx\.qq\.com\//i.test(value)) return 'PERSONAL_LINK'
  return 'UNKNOWN'
}

/**
 * 类型枚举对应的中文文件夹/文件名前缀。
 * @param {string} qrType classifyQrText 结果
 * @returns {string}
 */
function qrTypeLabel(qrType) {
  return ({
    GROUP_LINK: '微信群二维码',
    PERSONAL_LINK: '微信个人二维码',
    QQ_GROUP_LINK: 'QQ群二维码',
  })[qrType] || '未知二维码'
}

/**
 * 归一化二维码解码文本，避免同链不同写法产生不同哈希。
 * - 去空白、统一小写协议/主机
 * - 微信群短链只保留 /g/{token}
 * - 个人名片去掉追踪参数（如 ?s=2）
 * @param {string} text 原始解码
 * @returns {string}
 */
function normalizeQrText(text) {
  let value = String(text || '').trim()
  if (!value) return ''
  // 解码结果里偶夹杂不可见字符 / 全角空格
  value = value.replace(/[\u0000-\u001F\u007F\u00A0\u200B-\u200D\uFEFF]/g, '').trim()
  const urlMatch = value.match(/https?:\/\/[^\s<>"']+/i)
  if (urlMatch) value = urlMatch[0]
  value = value.replace(/[),.;，。]+$/g, '')

  try {
    const parsed = new URL(value)
    const host = parsed.hostname.toLowerCase()
    const pathName = parsed.pathname || ''

    // 微信群邀请：https://weixin.qq.com/g/TOKEN
    if ((host === 'weixin.qq.com' || host === 'www.weixin.qq.com' || host === 'wechat.com') && /^\/g\//i.test(pathName)) {
      const token = pathName.split('/').filter(Boolean)[1] || ''
      if (token) return `https://weixin.qq.com/g/${token}`
    }

    // 个人名片：https://u.wechat.com/xxx 忽略 query
    if (host === 'u.wechat.com' || host === 'www.u.wechat.com') {
      const id = pathName.replace(/^\//, '').split('/')[0] || ''
      if (id) return `https://u.wechat.com/${id}`
    }

    // QQ 群：保留关键参数 k / group_code
    if (/qq\.com$/i.test(host) || host.endsWith('.qq.com')) {
      const key = parsed.searchParams.get('k') || parsed.searchParams.get('group_code') || ''
      if (key) return `https://qm.qq.com/q/${key}`
      if (/^\/q\//i.test(pathName)) {
        const id = pathName.split('/').filter(Boolean)[1] || ''
        if (id) return `https://qm.qq.com/q/${id}`
      }
    }

    parsed.hash = ''
    // 去掉常见追踪参数
    for (const drop of ['s', 'from', 'scene', 'subscene', 'clicktime', 'ascene']) {
      parsed.searchParams.delete(drop)
    }
    return parsed.toString()
  } catch {
    return value
  }
}

function contentHash(text) {
  return createHash('sha256').update(normalizeQrText(text) || String(text || '').trim()).digest('hex').toUpperCase()
}

function messageTableName(roomId) {
  return `Msg_${createHash('md5').update(String(roomId)).digest('hex')}`
}

function rowsFromApi(raw) {
  if (Array.isArray(raw)) return raw
  if (Array.isArray(raw?.data)) return raw.data
  if (Array.isArray(raw?.data?.rows)) return raw.data.rows
  if (Array.isArray(raw?.rows)) return raw.rows
  return []
}

function valueOf(row, names, seen = new Set()) {
  if (!row || typeof row !== 'object' || seen.has(row)) return undefined
  seen.add(row)
  const entries = Object.entries(row || {})
  for (const name of names) {
    const found = entries.find(([key]) => key.toLowerCase() === name.toLowerCase())
    if (found && found[1] !== undefined && found[1] !== null) return found[1]
  }
  for (const [, child] of entries) {
    const found = valueOf(child, names, seen)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * 解开微信回调里常见的 { String: "xxx" } 包装，得到纯字符串。
 * @param {unknown} value
 * @returns {string}
 */
function unwrapString(value) {
  if (value == null) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object') {
    if (typeof value.String === 'string' || typeof value.String === 'number') return String(value.String)
    if (typeof value.string === 'string' || typeof value.string === 'number') return String(value.string)
    if (typeof value.str === 'string' || typeof value.str === 'number') return String(value.str)
  }
  return ''
}

/**
 * 从对象字段读取字符串（兼容 camelCase / snake_case / {String} 包装）。
 * @param {unknown} row
 * @param {string[]} names
 * @returns {string}
 */
function fieldString(row, names) {
  const raw = valueOf(row, names)
  const text = unwrapString(raw)
  if (text) return text
  if (typeof raw === 'string') return raw
  return raw == null ? '' : String(raw)
}

function existingImagePath(row, seen = new Set()) {
  if (!row || typeof row !== 'object' || seen.has(row)) return ''
  seen.add(row)
  for (const value of Object.values(row)) {
    if (typeof value !== 'string') continue
    for (const candidate of value.match(/[A-Za-z]:\\[^\r\n"<>|]+?\.(?:png|jpe?g|bmp|gif|webp)/ig) || []) {
      if (existsSync(candidate)) return candidate
    }
  }
  for (const value of Object.values(row)) {
    const found = existingImagePath(value, seen)
    if (found) return found
  }
  return ''
}

function xmlNumber(text, names) {
  for (const name of names) {
    const match = String(text || '').match(new RegExp(`${name}=["'](\\d+)["']|<${name}>(\\d+)<\\/${name}>`, 'i'))
    if (match) return Number(match[1] || match[2])
  }
  return 0
}

function xmlString(text, names) {
  for (const name of names) {
    const match = String(text || '').match(new RegExp(`${name}=["']([^"']+)["']|<${name}>([^<]+)<\\/${name}>`, 'i'))
    if (match) return match[1] || match[2] || ''
  }
  return ''
}

/**
 * 还原常见 HTML 实体，便于从转义后的消息 XML 里抽取 aeskey / CDN 字段。
 * @param {string} text 原始文本
 * @returns {string}
 */
function unescapeXmlEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * 解压微信 WCDB 字段：sqlite3_exec 常把 zstd 二进制以 Base64（KLUv/…）返回。
 * @param {unknown} value 字段值
 * @returns {string} 解压后的文本；失败则返回原字符串
 */
function decodeWcdbField(value) {
  if (value == null) return ''
  if (Buffer.isBuffer(value)) {
    try {
      if (value.length >= 4 && value.subarray(0, 4).equals(ZSTD_MAGIC) && typeof zlib.zstdDecompressSync === 'function') {
        return unescapeXmlEntities(zlib.zstdDecompressSync(value).toString('utf8'))
      }
      return unescapeXmlEntities(value.toString('utf8'))
    } catch {
      return ''
    }
  }
  const text = String(value)
  if (!text) return ''
  if (/[<](?:\?xml|msg|img)\b/i.test(text) || /aeskey\s*=/i.test(text)) return unescapeXmlEntities(text)
  const trimmed = text.trim()
  // Base64(zstd)：魔数 28 B5 2F FD → "KLUv/..."
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(trimmed) && trimmed.length >= 16) {
    try {
      const buf = Buffer.from(trimmed.replace(/\s+/g, ''), 'base64')
      if (buf.length >= 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC) && typeof zlib.zstdDecompressSync === 'function') {
        return unescapeXmlEntities(zlib.zstdDecompressSync(buf).toString('utf8'))
      }
    } catch { /* 非压缩 Base64 时保留原文 */ }
  }
  return unescapeXmlEntities(text)
}

/**
 * 从消息行提取可能含图片 XML 的字段（避免递归解压整行导致卡顿）。
 * @param {unknown} row 消息行或事件
 * @returns {string[]}
 */
function extractContentCandidates(row) {
  if (!row || typeof row !== 'object') {
    const decoded = decodeWcdbField(row)
    return decoded ? [decoded] : []
  }
  const preferredNames = [
    'message_content', 'content', 'compress_content', 'source',
    'msg', 'xml', 'imageXml', 'img', 'data',
  ]
  const out = []
  const entries = Object.entries(row)
  for (const [key, value] of entries) {
    if (preferredNames.some((name) => key.toLowerCase() === name.toLowerCase())) {
      if (typeof value === 'string' || Buffer.isBuffer(value)) {
        const decoded = decodeWcdbField(value)
        if (decoded) out.push(decoded)
      } else if (value && typeof value === 'object') {
        out.push(...extractContentCandidates(value))
      }
    }
  }
  // 回调事件常把 XML 挂在深层 content；若首选字段没有 aeskey，再浅扫一层字符串
  if (!out.some((text) => /aeskey|cdnmidimgurl|cdnbigimgurl/i.test(text))) {
    for (const [, value] of entries) {
      if (typeof value === 'string' && value.length >= 16 && value.length <= 20000) {
        const decoded = decodeWcdbField(value)
        if (decoded && /aeskey|cdnmidimgurl|<img\b/i.test(decoded)) out.push(decoded)
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const child of Object.values(value)) {
          if (typeof child === 'string' && child.length >= 16 && child.length <= 20000) {
            const decoded = decodeWcdbField(child)
            if (decoded && /aeskey|cdnmidimgurl|<img\b/i.test(decoded)) out.push(decoded)
          }
        }
      }
    }
  }
  return out
}

/**
 * 拼接消息文本（已解压），供 CDN / 下载参数解析。
 * @param {unknown} row 消息行或回调事件
 * @returns {string}
 */
function messageTextBlob(row) {
  return extractContentCandidates(row).join('\n')
}

/**
 * 历史采集专用：只解压 message_content / source，避免整行递归解压拖死主进程。
 * @param {Record<string, unknown>} row sqlite 消息行
 * @returns {{ local_id: unknown, server_id: unknown, message_content: string, source: string, _decodedBlob: string }}
 */
function prepareHistoryMessageRow(row) {
  const raw = row && typeof row === 'object' ? row : {}
  const messageContent = decodeWcdbField(raw.message_content ?? raw.Message_Content ?? '')
  const source = decodeWcdbField(raw.source ?? raw.Source ?? '')
  return {
    local_id: raw.local_id ?? raw.localId,
    server_id: raw.server_id ?? raw.serverId,
    message_content: messageContent,
    source,
    _decodedBlob: [messageContent, source].filter(Boolean).join('\n'),
  }
}

/** 让出主线程，避免历史采集时界面假死（setTimeout 比 setImmediate 更能泵 UI）。 */
function yieldMain() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * 根据消息 XML 或「自己发送图片」回调顶层字段构造 /api/cdn_download 请求。
 * 自己发图回调常见：cdnmidImgUrl / aeskey（camelCase，不在 XML 里）。
 * @param {unknown} row 消息行或回调事件
 * @param {string} outputPath 落盘路径
 * @returns {{ fileid: string, asekey: string, imgType: number, out: string } | null}
 */
function cdnDownloadRequest(row, outputPath) {
  const joined = row && typeof row === 'object' && typeof row._decodedBlob === 'string'
    ? row._decodedBlob
    : messageTextBlob(row)
  const mid = xmlString(joined, ['cdnmidimgurl'])
    || fieldString(row, ['cdnmidImgUrl', 'cdnmidimgurl', 'cdn_mid_img_url', 'cdnMidImgUrl'])
  const big = xmlString(joined, ['cdnbigimgurl'])
    || fieldString(row, ['cdnbigImgUrl', 'cdnbigimgurl', 'cdn_big_img_url', 'cdnBigImgUrl'])
  const thumb = xmlString(joined, ['cdnthumburl'])
    || fieldString(row, ['cdnthumbImgUrl', 'cdnthumburl', 'cdn_thumb_img_url', 'cdnThumbImgUrl'])
  const fileid = mid || big || thumb || xmlString(joined, ['fileid', 'cdndataurl']) || fieldString(row, ['fileid', 'fileId', 'cdndataurl'])
  const asekey = xmlString(joined, ['aeskey', 'cdnthumbaeskey'])
    || fieldString(row, ['aeskey', 'aesKey', 'cdnthumbAeskey', 'cdnthumbaeskey', 'cdnThumbAeskey'])
  if (!fileid || !asekey) return null
  // 1 高清 2 普通 3 缩略图（与接口说明一致）；历史采集优先普通图更快
  let imgType = 2
  if (fileid === big && big && !mid) imgType = 1
  else if (fileid === thumb && !mid && !big) imgType = 3
  return { fileid, asekey, imgType, out: outputPath }
}

/**
 * 选取 download_img 可用的 MsgId（避免 64 位 server_id 超出 JS 安全整数）。
 * @param {unknown} row 消息行
 * @param {string} joined 已解压文本
 * @returns {number}
 */
function pickDownloadMsgId(row, joined) {
  const localId = Number(valueOf(row, ['local_id']))
  const candidates = [
    valueOf(row, ['msg_svr_id', 'msgid', 'msg_id']),
    valueOf(row, ['server_id']),
    xmlNumber(joined, ['msgid', 'msgsvrid']),
    localId,
  ]
  for (const raw of candidates) {
    const num = Number(raw)
    if (Number.isSafeInteger(num) && num > 0) return num
  }
  return Number.isFinite(localId) && localId > 0 ? localId : 0
}

/**
 * 构造 /api/download_img 请求（CDN 失败时的兜底）。
 * @param {unknown} row 消息行
 * @param {string} roomId 群 ID
 * @param {string} accountWxid 本机微信号
 * @param {string} outputPath 落盘路径
 * @returns {object | null}
 */
function downloadRequest(row, roomId, accountWxid, outputPath) {
  const joined = row && typeof row === 'object' && typeof row._decodedBlob === 'string'
    ? row._decodedBlob
    : messageTextBlob(row)
  const msgId = pickDownloadMsgId(row, joined)
  const totalLen = Number(fieldString(row, ['totalLen', 'total_len', 'total_length', 'length', 'cdnmidImgSize', 'dataLen']))
    || Number(valueOf(row, ['total_len', 'total_length', 'length']))
    || xmlNumber(joined, ['hdlength', 'length', 'hevc_mid_size'])
  if (!msgId || !totalLen || !accountWxid) return null
  // 自己发到群：from=自己 to=群；别人发：from=群。download_img 的 from_user 用会话方（群 ID）
  const toName = fieldString(row, ['toUserName', 'to_user_name', 'to_user'])
  const fromName = fieldString(row, ['fromUserName', 'from_user_name', 'from_user'])
  const peer = String(roomId || '').endsWith('@chatroom')
    ? String(roomId)
    : (toName.endsWith('@chatroom') ? toName : (fromName.endsWith('@chatroom') ? fromName : String(roomId || '')))
  return { to_user: accountWxid, from_user: peer || roomId, start_pos: 0, total_len: totalLen, data_len: totalLen, compress_type: 0, MsgId: msgId, path: outputPath }
}

function nativeImageRgba(image) {
  if (!image || image.isEmpty()) return ''
  const size = image.getSize()
  if (!size.width || !size.height) return ''
  const bitmap = image.toBitmap()
  const rgba = new Uint8ClampedArray(bitmap.length)
  for (let i = 0; i < bitmap.length; i += 4) {
    rgba[i] = bitmap[i + 2]
    rgba[i + 1] = bitmap[i + 1]
    rgba[i + 2] = bitmap[i]
    rgba[i + 3] = bitmap[i + 3]
  }
  return { rgba, width: size.width, height: size.height }
}

/**
 * 生成更密的裁剪窗口，便于同一张图里多个二维码（如微信群码 + QQ 群码）都被扫到。
 * @param {number} width 原图宽
 * @param {number} height 原图高
 * @returns {Array<{ x: number, y: number, width: number, height: number }>}
 */
function buildScanTiles(width, height) {
  const tiles = [{ x: 0, y: 0, width, height }]
  const ratios = [0.55, 0.4]
  for (const ratio of ratios) {
    const tileWidth = Math.max(Math.round(width * ratio), 24)
    const tileHeight = Math.max(Math.round(height * ratio), 24)
    const xSteps = width <= tileWidth ? [0] : [0, Math.round((width - tileWidth) / 2), width - tileWidth]
    const ySteps = height <= tileHeight ? [0] : [0, Math.round((height - tileHeight) / 2), height - tileHeight]
    for (const x of xSteps) {
      for (const y of ySteps) tiles.push({ x, y, width: tileWidth, height: tileHeight })
    }
    // 左右半幅：常见「左微信群码 / 右 QQ 群码」拼图
    const halfW = Math.max(Math.round(width / 2), 24)
    tiles.push({ x: 0, y: 0, width: halfW, height })
    tiles.push({ x: width - halfW, y: 0, width: halfW, height })
    const halfH = Math.max(Math.round(height / 2), 24)
    tiles.push({ x: 0, y: 0, width, height: halfH })
    tiles.push({ x: 0, y: height - halfH, width, height: halfH })
  }
  const uniq = new Map()
  for (const tile of tiles) uniq.set(`${tile.x},${tile.y},${tile.width},${tile.height}`, tile)
  return [...uniq.values()]
}

/**
 * 从 zbar 符号列表提取 QR 文本。
 * @param {Array<{ typeName?: string, decode: () => string }>} symbols
 * @returns {string[]}
 */
function textsFromZbarSymbols(symbols) {
  return (symbols || [])
    .filter((symbol) => /QR.*CODE/i.test(String(symbol.typeName || '')))
    .map((symbol) => {
      try { return String(symbol.decode() || '').trim() } catch { return '' }
    })
    .filter(Boolean)
}

/**
 * 将图片缩放到最长边不超过 maxEdge，显著降低 jsQR/zbar 耗时。
 * @param {import('electron').NativeImage} image
 * @param {number} maxEdge
 * @returns {import('electron').NativeImage}
 */
function downscaleForScan(image, maxEdge = 720) {
  if (!image || image.isEmpty()) return image
  const size = image.getSize()
  const edge = Math.max(size.width || 0, size.height || 0)
  if (!edge || edge <= maxEdge) return image
  const scale = maxEdge / edge
  try {
    return image.resize({
      width: Math.max(24, Math.round(size.width * scale)),
      height: Math.max(24, Math.round(size.height * scale)),
      quality: 'good',
    })
  } catch {
    return image
  }
}

/**
 * 解码图片中全部二维码文本（同一张图多个码都会返回，不去重类型、按内容去重）。
 * @param {import('electron').NativeImage} image Electron 图片
 * @param {{ mode?: 'fast'|'full' }} [options] fast=历史批量（缩略快扫）；full=监控/导入（同图多码）
 * @returns {Promise<string[]>}
 */
async function decodeNativeImages(image, options = {}) {
  const mode = options.mode === 'fast' ? 'fast' : 'full'
  if (!image || image.isEmpty()) return []
  const decoded = new Set()
  const pushAll = (values) => {
    for (const value of values || []) {
      const text = String(value || '').trim()
      if (text) decoded.add(text)
    }
  }
  /** 让出事件循环，避免界面假死。 */
  async function yieldUi() {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  // —— 历史批量：只扫缩略图，先 jsQR 再可选 zbar；绝不大图 2x/多窗 ——
  if (mode === 'fast') {
    await yieldUi()
    const small = downscaleForScan(image, 720)
    const rgba = nativeImageRgba(small)
    if (!rgba) return []
    try {
      const hit = jsQR(rgba.rgba, rgba.width, rgba.height, { inversionAttempts: 'dontInvert' })?.data || ''
      if (hit) decoded.add(String(hit).trim())
    } catch { /* continue */ }
    await yieldUi()
    // 宽图再试左右半幅（常见双码拼图），仍基于缩略图
    if (rgba.width >= rgba.height * 1.25) {
      try {
        const half = Math.max(Math.round(rgba.width / 2), 24)
        const left = small.crop({ x: 0, y: 0, width: half, height: rgba.height })
        const right = small.crop({ x: rgba.width - half, y: 0, width: half, height: rgba.height })
        for (const part of [left, right]) {
          const partRgba = nativeImageRgba(part)
          if (!partRgba) continue
          const hit = jsQR(partRgba.rgba, partRgba.width, partRgba.height, { inversionAttempts: 'dontInvert' })?.data || ''
          if (hit) decoded.add(String(hit).trim())
          await yieldUi()
        }
      } catch { /* ignore */ }
    }
    try {
      zbarPromise ||= Promise.resolve().then(() => {
        const root = path.dirname(require.resolve('@undecaf/zbar-wasm/package.json'))
        return require(path.join(root, 'dist', 'inlined', 'main.cjs'))
      })
      const zbar = await zbarPromise
      pushAll(textsFromZbarSymbols(await zbar.scanRGBABuffer(rgba.rgba.buffer, rgba.width, rgba.height)))
    } catch { /* ignore */ }
    await yieldUi()
    return [...decoded]
  }

  // —— 完整模式：监控/导入，保留同图多码能力 ——
  const initial = nativeImageRgba(image)
  if (!initial) return []
  try {
    zbarPromise ||= Promise.resolve().then(() => {
      const root = path.dirname(require.resolve('@undecaf/zbar-wasm/package.json'))
      return require(path.join(root, 'dist', 'inlined', 'main.cjs'))
    })
    const zbar = await zbarPromise
    const attempts = [downscaleForScan(image, 1200)]
    if (initial.width < 1400 || initial.height < 1400) {
      attempts.push(image.resize({ width: initial.width * 2, height: initial.height * 2, quality: 'best' }))
    }
    for (const tile of buildScanTiles(initial.width, initial.height).slice(0, 12)) {
      try {
        const cropped = image.crop(tile)
        attempts.push(cropped)
      } catch { /* crop 越界时跳过 */ }
    }
    let scanned = 0
    for (const candidate of attempts) {
      const converted = nativeImageRgba(candidate)
      if (!converted) continue
      try {
        const symbols = await zbar.scanRGBABuffer(converted.rgba.buffer, converted.width, converted.height)
        pushAll(textsFromZbarSymbols(symbols))
      } catch { /* 单次扫描失败继续 */ }
      const fallback = jsQR(converted.rgba, converted.width, converted.height, { inversionAttempts: 'attemptBoth' })?.data || ''
      if (fallback) decoded.add(String(fallback).trim())
      scanned += 1
      if (scanned % 2 === 0) await yieldUi()
      if (decoded.size >= 2) break
    }
    if (decoded.size) return [...decoded]
  } catch {}
  const fallback = jsQR(initial.rgba, initial.width, initial.height, { inversionAttempts: 'attemptBoth' })?.data || ''
  return fallback ? [fallback] : []
}

/**
 * 生成准确文件名：类型_来源群_消息ID_时间_内容哈希。
 * @param {string} typeLabel 中文类型
 * @param {string} roomName 群名
 * @param {string|number} messageId 消息 ID
 * @param {string} hash 内容 SHA-256
 * @param {string} extension 扩展名（含点）
 * @param {string|number} [savedAt] 可选时间戳
 * @returns {string}
 */
function accurateFileName(typeLabel, roomName, messageId, hash, extension, savedAt = Date.now()) {
  const time = new Date(Number(savedAt) || Date.now())
  const stamp = [
    time.getFullYear(),
    String(time.getMonth() + 1).padStart(2, '0'),
    String(time.getDate()).padStart(2, '0'),
    String(time.getHours()).padStart(2, '0'),
    String(time.getMinutes()).padStart(2, '0'),
    String(time.getSeconds()).padStart(2, '0'),
  ].join('')
  const ext = String(extension || '.jpg').startsWith('.') ? String(extension || '.jpg') : `.${extension || 'jpg'}`
  return [
    safeFolderName(typeLabel, '未知类型'),
    safeFolderName(roomName, '未知群聊'),
    safeFolderName(messageId, '未知消息'),
    stamp,
    String(hash || 'NOHASH').slice(0, 12).toUpperCase(),
  ].join('_') + ext
}

module.exports = {
  safeFolderName,
  classifyQrText,
  qrTypeLabel,
  normalizeQrText,
  contentHash,
  messageTableName,
  rowsFromApi,
  valueOf,
  unwrapString,
  fieldString,
  existingImagePath,
  decodeWcdbField,
  messageTextBlob,
  prepareHistoryMessageRow,
  cdnDownloadRequest,
  downloadRequest,
  nativeImageRgba,
  buildScanTiles,
  decodeNativeImages,
  accurateFileName,
  yieldMain,
}
