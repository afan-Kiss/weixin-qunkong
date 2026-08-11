'use strict'

const SENSITIVE_KEY_RE = /^(v3|v4|encryptusername|encryptedusername|antispamticket|antispamticket|cookie|authorization|password|secret|token|accesstoken|refreshtoken)$/i

/**
 * 脱敏字符串内嵌的 v3/v4/token 等高置信敏感片段。
 * @param {unknown} value
 * @returns {unknown}
 */
function sanitizeSensitiveString(value) {
  if (typeof value !== 'string' || !value) return value
  return value
    .replace(/v3_[^"'\s<>]+/gi, (match) => `v3_[REDACTED:${match.length}]`)
    .replace(/v4_[^"'\s<>]+/gi, (match) => `v4_[REDACTED:${match.length}]`)
    .replace(/\bBearer\s+[A-Za-z0-9._\-+/=]+/gi, (match) => `Bearer [REDACTED:${match.length}]`)
    .replace(/(?:access_token|refresh_token|authorization)\s*[:=]\s*[^\s&"'<>]+/gi, (match) => {
      const sep = match.includes('=') ? '=' : ':'
      const key = match.split(sep)[0]
      return `${key}${sep}[REDACTED]`
    })
    .replace(/\btoken\s*[:=]\s*[^\s&"'<>]+/gi, (match) => `token${match.includes('=') ? '=' : ':'}[REDACTED]`)
}

function sanitizeApiSampleValue(value, depth = 0) {
  if (depth > 8) return '[depth]'
  if (value == null) return value
  if (typeof value === 'string') return sanitizeSensitiveString(value)
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => sanitizeApiSampleValue(item, depth + 1))
  const out = {}
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(String(key))) {
      const text = String(nested ?? '')
      out[key] = { redacted: true, prefix: text.slice(0, 4), length: text.length }
    } else {
      out[key] = sanitizeApiSampleValue(nested, depth + 1)
    }
  }
  return out
}

/**
 * 日志/JSONL 条目脱敏（保留结构，去掉完整敏感值）。
 * @param {Record<string, unknown>} entry
 * @returns {Record<string, unknown>}
 */
function sanitizeLogEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry
  const out = {}
  for (const [key, value] of Object.entries(entry)) {
    if (SENSITIVE_KEY_RE.test(String(key))) {
      const text = String(value ?? '')
      out[key] = { redacted: true, prefix: text.slice(0, 4), length: text.length }
    } else if (typeof value === 'string') {
      out[key] = sanitizeSensitiveString(value)
    } else if (value && typeof value === 'object') {
      out[key] = sanitizeApiSampleValue(value)
    } else {
      out[key] = value
    }
  }
  return out
}

module.exports = {
  SENSITIVE_KEY_RE,
  sanitizeSensitiveString,
  sanitizeApiSampleValue,
  sanitizeLogEntry,
}
