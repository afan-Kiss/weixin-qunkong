'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  parseArgs,
  assertTriggerSafety,
  assertOptionalHostAccount,
  evaluateGoodManifestSanity,
} = require('../scripts/legacy-update-bridge-check.cjs')

test('trigger without clientId fails', () => {
  const gate = assertTriggerSafety({ trigger: true, clientId: '', confirmTarget: true })
  assert.equal(gate.ok, false)
  assert.equal(gate.code, 'TRIGGER_REQUIRES_EXPLICIT_CLIENT_ID')
})

test('trigger without confirm-target fails', () => {
  const gate = assertTriggerSafety({ trigger: true, clientId: 'abc', confirmTarget: false })
  assert.equal(gate.ok, false)
  assert.equal(gate.code, 'TRIGGER_REQUIRES_CONFIRM_TARGET')
})

test('parseArgs does not invent clientId from online devices', () => {
  const args = parseArgs(['node', 'x', '--trigger'])
  assert.equal(args.clientId, '')
  assert.equal(args.trigger, true)
})

test('hostname mismatch blocks trigger helpers', () => {
  const gate = assertOptionalHostAccount(
    { expectedHostname: 'PC-001' },
    { hostname: 'PC-OTHER' },
  )
  assert.equal(gate.ok, false)
  assert.equal(gate.code, 'TARGET_HOSTNAME_MISMATCH')
})

test('empty hostname with expected does not hard-fail', () => {
  const gate = assertOptionalHostAccount(
    { expectedHostname: 'PC-001' },
    { hostname: '' },
  )
  assert.equal(gate.ok, true)
  assert.equal(gate.code, 'HOSTNAME_UNAVAILABLE')
})

test('good manifest sanity requires both signatures when expectations set', () => {
  const man = {
    version: '1.106',
    releaseSequence: 102,
    sha256: 'aa'.repeat(32),
    targetClientIds: ['x'],
    securityEmergency: false,
  }
  const fail = evaluateGoodManifestSanity(man, { signatureV1Valid: true, signatureV2Valid: false }, {
    version: '1.106',
    releaseSequence: 102,
    sha256: 'aa'.repeat(32),
  })
  assert.match(fail, /^FAIL/)
  const pass = evaluateGoodManifestSanity(man, { signatureV1Valid: true, signatureV2Valid: true }, {
    version: '1.106',
    releaseSequence: 102,
    sha256: 'aa'.repeat(32),
  })
  assert.equal(pass, 'PASS')
})
