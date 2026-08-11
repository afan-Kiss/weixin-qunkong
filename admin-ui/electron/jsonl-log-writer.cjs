'use strict'

const { appendFileSync, statSync, renameSync, unlinkSync, existsSync, mkdirSync } = require('fs')
const path = require('path')
const { sanitizeLogEntry } = require('./sensitive-redaction.cjs')

const LOG_MAX_BYTES = 20 * 1024 * 1024
const LOG_MAX_FILES = 5
const LOG_BASENAME = 'wechat-control.jsonl'
const LOG_MAX_LINE_BYTES = 1024 * 1024

/** @type {Map<string, number>} cacheKey → cached main file size */
const sizeByDir = new Map()

function resolveBasename(options = {}) {
  const name = String(options.basename || LOG_BASENAME).trim() || LOG_BASENAME
  return name.endsWith('.jsonl') ? name : `${name}.jsonl`
}

function cacheKey(logDir, basename) {
  return `${logDir}\0${basename}`
}

function logMainPath(logDir, basename = LOG_BASENAME) {
  return path.join(logDir, basename)
}

function initLogSize(logDir, basename = LOG_BASENAME) {
  const key = cacheKey(logDir, basename)
  const mainPath = logMainPath(logDir, basename)
  if (!existsSync(mainPath)) {
    sizeByDir.set(key, 0)
    return 0
  }
  try {
    const size = statSync(mainPath).size
    sizeByDir.set(key, size)
    return size
  } catch {
    sizeByDir.set(key, 0)
    return 0
  }
}

/**
 * @param {string} logDir
 * @param {number} [maxFiles]
 * @param {string} [basename]
 */
function rotateLogFile(logDir, maxFiles = LOG_MAX_FILES, basename = LOG_BASENAME) {
  const files = Math.min(20, Math.max(1, Math.floor(Number(maxFiles) || LOG_MAX_FILES)))
  const stem = basename.replace(/\.jsonl$/i, '')
  const base = path.join(logDir, stem)
  const oldest = `${base}.${files}.jsonl`
  try { if (existsSync(oldest)) unlinkSync(oldest) } catch { /* ignore */ }
  for (let i = files - 1; i >= 1; i -= 1) {
    const from = `${base}.${i}.jsonl`
    const to = `${base}.${i + 1}.jsonl`
    try { if (existsSync(from)) renameSync(from, to) } catch { /* ignore */ }
  }
  // main → .1
  try {
    const main = logMainPath(logDir, basename)
    if (existsSync(main)) renameSync(main, `${base}.1.jsonl`)
  } catch { /* ignore */ }
  sizeByDir.set(cacheKey(logDir, basename), 0)
}

/**
 * 追加一行 JSONL 日志；超过大小阈值时轮转。
 * @param {string} logDir
 * @param {Record<string, unknown>} entry
 * @param {{ maxBytes?: number, maxFiles?: number, basename?: string, maxLineBytes?: number }} [options]
 */
function appendJsonlLog(logDir, entry, options = {}) {
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : LOG_MAX_BYTES
  const maxFiles = Number(options.maxFiles) > 0
    ? Math.min(20, Math.max(1, Math.floor(Number(options.maxFiles))))
    : LOG_MAX_FILES
  const maxLineBytes = Number(options.maxLineBytes) > 0 ? Number(options.maxLineBytes) : LOG_MAX_LINE_BYTES
  const basename = resolveBasename(options)
  try {
    mkdirSync(logDir, { recursive: true })
    const key = cacheKey(logDir, basename)
    if (!sizeByDir.has(key)) initLogSize(logDir, basename)
    let sanitized = sanitizeLogEntry(entry)
    let line = `${JSON.stringify(sanitized)}\n`
    let bytes = Buffer.byteLength(line, 'utf8')
    if (bytes > maxLineBytes) {
      sanitized = {
        ...(typeof sanitized === 'object' && sanitized ? sanitized : {}),
        truncated: true,
        originalBytes: bytes,
        message: String(sanitized?.message || entry?.message || '').slice(0, 500),
        details: '[truncated]',
      }
      line = `${JSON.stringify(sanitized)}\n`
      bytes = Buffer.byteLength(line, 'utf8')
    }
    let size = sizeByDir.get(key) ?? 0
    if (size + bytes > maxBytes) rotateLogFile(logDir, maxFiles, basename)
    appendFileSync(logMainPath(logDir, basename), line, 'utf8')
    size = (sizeByDir.get(key) ?? 0) + bytes
    sizeByDir.set(key, size)
  } catch {
    /* 日志失败不能影响主流程 */
  }
}

function resetLogWriterStateForTests() {
  sizeByDir.clear()
}

module.exports = {
  LOG_MAX_BYTES,
  LOG_MAX_FILES,
  LOG_BASENAME,
  LOG_MAX_LINE_BYTES,
  appendJsonlLog,
  rotateLogFile,
  initLogSize,
  resetLogWriterStateForTests,
}
