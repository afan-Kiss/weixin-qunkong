'use strict'

const DIAGNOSTIC_PROCESSING_TTL_MS = 10 * 60 * 1000
const DIAGNOSTIC_DONE_TTL_MS = 24 * 60 * 60 * 1000
const DIAGNOSTIC_MAX = 5000

/** @type {Map<string, { status: 'PROCESSING'|'DONE', expiresAt: number }>} */
const diagnosticIdempotency = new Map()

function pruneDiagnosticIdempotency(now = Date.now()) {
  for (const [key, entry] of diagnosticIdempotency) {
    if (!entry || Number(entry.expiresAt) <= now) diagnosticIdempotency.delete(key)
  }
  while (diagnosticIdempotency.size > DIAGNOSTIC_MAX) {
    let oldestKey = null
    let oldestAt = Infinity
    for (const [key, entry] of diagnosticIdempotency) {
      const expiresAt = Number(entry?.expiresAt || 0)
      if (expiresAt < oldestAt) { oldestAt = expiresAt; oldestKey = key }
    }
    if (!oldestKey) break
    diagnosticIdempotency.delete(oldestKey)
  }
}

/**
 * @param {string} key
 * @returns {boolean}
 */
function hasDiagnosticIdempotency(key) {
  const id = String(key || '').trim()
  if (!id) return false
  const now = Date.now()
  const entry = diagnosticIdempotency.get(id)
  if (!entry) return false
  if (Number(entry.expiresAt) <= now) {
    diagnosticIdempotency.delete(id)
    return false
  }
  return true
}

/**
 * @param {string} key
 * @returns {boolean} false if already active/done
 */
function markDiagnosticProcessing(key) {
  const id = String(key || '').trim()
  if (!id) return true
  pruneDiagnosticIdempotency()
  if (hasDiagnosticIdempotency(id)) return false
  diagnosticIdempotency.set(id, {
    status: 'PROCESSING',
    expiresAt: Date.now() + DIAGNOSTIC_PROCESSING_TTL_MS,
  })
  return true
}

/**
 * @param {string} key
 */
function markDiagnosticDone(key) {
  const id = String(key || '').trim()
  if (!id) return
  diagnosticIdempotency.set(id, {
    status: 'DONE',
    expiresAt: Date.now() + DIAGNOSTIC_DONE_TTL_MS,
  })
  pruneDiagnosticIdempotency()
}

/**
 * @param {string} key
 */
function clearDiagnosticProcessing(key) {
  const id = String(key || '').trim()
  if (!id) return
  const entry = diagnosticIdempotency.get(id)
  if (entry?.status === 'PROCESSING') diagnosticIdempotency.delete(id)
}

function cleanupDiagnosticIdempotency(now = Date.now()) {
  pruneDiagnosticIdempotency(now)
}

function resetDiagnosticIdempotencyForTests() {
  diagnosticIdempotency.clear()
}

function getDiagnosticIdempotencySizeForTests() {
  return diagnosticIdempotency.size
}

module.exports = {
  DIAGNOSTIC_PROCESSING_TTL_MS,
  DIAGNOSTIC_DONE_TTL_MS,
  DIAGNOSTIC_MAX,
  hasDiagnosticIdempotency,
  markDiagnosticProcessing,
  markDiagnosticDone,
  clearDiagnosticProcessing,
  cleanupDiagnosticIdempotency,
  resetDiagnosticIdempotencyForTests,
  getDiagnosticIdempotencySizeForTests,
}
