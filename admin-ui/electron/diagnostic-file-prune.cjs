'use strict'

const { readdirSync, statSync, unlinkSync, existsSync } = require('fs')
const path = require('path')

const DIAGNOSTIC_JSON_MAX = 300
const DIAGNOSTIC_JSON_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * 清理 friend-diagnostics 下独立 JSON 报告（不删 diagnostics*.jsonl）。
 * @param {string} dir
 * @param {{ maxFiles?: number, ttlMs?: number, now?: number }} [options]
 */
function pruneDiagnosticReportFiles(dir, options = {}) {
  const maxFiles = Number(options.maxFiles) > 0 ? Math.floor(Number(options.maxFiles)) : DIAGNOSTIC_JSON_MAX
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DIAGNOSTIC_JSON_TTL_MS
  const now = Number(options.now) > 0 ? Number(options.now) : Date.now()
  try {
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.json') && !/^diagnostics/i.test(name))
      .map((name) => {
        const full = path.join(dir, name)
        let mtimeMs = 0
        try { mtimeMs = statSync(full).mtimeMs } catch { mtimeMs = 0 }
        return { name, full, mtimeMs }
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const file of files) {
      if (now - file.mtimeMs > ttlMs) {
        try { unlinkSync(file.full) } catch { /* ignore */ }
      }
    }
    const remaining = files.filter((file) => existsSync(file.full))
    while (remaining.length > maxFiles) {
      const oldest = remaining.shift()
      if (!oldest) break
      try { unlinkSync(oldest.full) } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

module.exports = {
  DIAGNOSTIC_JSON_MAX,
  DIAGNOSTIC_JSON_TTL_MS,
  pruneDiagnosticReportFiles,
}
