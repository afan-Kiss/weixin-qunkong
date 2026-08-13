'use strict'

/**
 * CLI: full READY validation via Node validateReadyAck (single source of truth).
 * Usage:
 *   electron.exe handoff-validate.cjs --user-data <dir> --update-id <id> --expected-new-pid <pid> [--json]
 * Exit 0 = ok, 1 = invalid.
 */

const path = require('path')
const { readPrepared, readReady, validateReadyAck } = require('./update-state.cjs')

function parseArgs(argv) {
  const out = { userData: '', updateId: '', expectedNewPid: 0, json: false }
  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] || '')
    if (a === '--user-data' && argv[i + 1]) { out.userData = String(argv[++i]); continue }
    if (a.startsWith('--user-data=')) { out.userData = a.slice('--user-data='.length); continue }
    if (a === '--update-id' && argv[i + 1]) { out.updateId = String(argv[++i]); continue }
    if (a.startsWith('--update-id=')) { out.updateId = a.slice('--update-id='.length); continue }
    if (a === '--expected-new-pid' && argv[i + 1]) { out.expectedNewPid = Number(argv[++i]) || 0; continue }
    if (a.startsWith('--expected-new-pid=')) { out.expectedNewPid = Number(a.slice('--expected-new-pid='.length)) || 0; continue }
    if (a === '--json') out.json = true
  }
  return out
}

function main() {
  const args = parseArgs(process.argv)
  const prepared = readPrepared(args.userData)
  const ready = readReady(args.userData)
  if (!prepared) {
    const row = { ok: false, reason: 'READY_INVALID_prepared_missing' }
    if (args.json) console.log(JSON.stringify(row))
    process.exit(1)
  }
  if (args.updateId && String(prepared.updateId) !== String(args.updateId)) {
    const row = { ok: false, reason: 'READY_INVALID_updateId_mismatch' }
    if (args.json) console.log(JSON.stringify(row))
    process.exit(1)
  }
  // Stale ready for other updateId: treat as not yet ready (caller may continue waiting).
  // Helper only calls us after a marker appears; if wrong updateId, fail closed.
  if (ready && args.updateId && String(ready.updateId || '') && String(ready.updateId) !== String(args.updateId)) {
    const row = { ok: false, reason: 'READY_INVALID_stale_updateId' }
    if (args.json) console.log(JSON.stringify(row))
    process.exit(1)
  }
  const check = validateReadyAck(prepared, ready, {
    expectedNewPid: args.expectedNewPid > 0 ? args.expectedNewPid : undefined,
  })
  const row = check.ok
    ? { ok: true }
    : { ok: false, reason: `READY_INVALID_${check.reason}` }
  if (args.json) console.log(JSON.stringify(row))
  process.exit(check.ok ? 0 : 1)
}

main()
