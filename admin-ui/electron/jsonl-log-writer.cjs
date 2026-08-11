'use strict'

const { appendFileSync, statSync, renameSync, unlinkSync, existsSync, mkdirSync } = require('fs')
const path = require('path')
const { sanitizeLogEntry } = require('./sensitive-redaction.cjs')

const LOG_MAX_BYTES = 20 * 1024 * 1024
const LOG_MAX_FILES = 5
const LOG_BASENAME = 'wechat-control.jsonl'

/** @type {Map<string, number>} logDir → cached main file size */
const sizeByDir = new Map()

function logMainPath(logDir) {
  return path.join(logDir, LOG_BASENAME)
}

function initLogSize(logDir) {
  const mainPath = logMainPath(logDir)
  if (!existsSync(mainPath)) {
    sizeByDir.set(logDir, 0)
    return 0
  }
  try {
    const size = statSync(mainPath).size
    sizeByDir.set(logDir, size)
    return size
  } catch {
    sizeByDir.set(logDir, 0)
    return 0
  }
}

function rotateLogFile(logDir) {
  const base = path.join(logDir, LOG_BASENAME.replace('.jsonl', ''))
  const oldest = `${base}.${LOG_MAX_FILES}.jsonl`
  try { if (existsSync(oldest)) unlinkSync(oldest) } catch { /* ignore */ }
  for (let i = LOG_MAX_FILES - 1; i >= 1; i -= 1) {
    const from = i === 1 ? logMainPath(logDir) : `${base}.${i}.jsonl`
    const to = `${base}.${i + 1}.jsonl`
    try { if (existsSync(from)) renameSync(from, to) } catch { /* ignore */ }
  }
  sizeByDir.set(logDir, 0)
}

/**
 * 追加一行 JSONL 日志；超过大小阈值时轮转。
 * @param {string} logDir
 * @param {Record<string, unknown>} entry
 * @param {{ maxBytes?: number, maxFiles?: number }} [options]
 */
function appendJsonlLog(logDir, entry, options = {}) {
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : LOG_MAX_BYTES
  try {
    mkdirSync(logDir, { recursive: true })
    if (!sizeByDir.has(logDir)) initLogSize(logDir)
    const sanitized = sanitizeLogEntry(entry)
    const line = `${JSON.stringify(sanitized)}\n`
    const bytes = Buffer.byteLength(line, 'utf8')
    let size = sizeByDir.get(logDir) ?? 0
    if (size + bytes > maxBytes) rotateLogFile(logDir)
    appendFileSync(logMainPath(logDir), line, 'utf8')
    size = (sizeByDir.get(logDir) ?? 0) + bytes
    sizeByDir.set(logDir, size)
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
  appendJsonlLog,
  rotateLogFile,
  initLogSize,
  resetLogWriterStateForTests,
}
