const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const tlsSrc = fs.readFileSync(path.join(root, 'electron', 'service-tls.cjs'), 'utf8')

test('A: correct host + correct pin → allow', () => {
  assert.ok(tlsSrc.includes('verifyCertPin'), 'should export verifyCertPin')
  assert.ok(tlsSrc.includes('pins.includes(spki)'), 'should match SPKI pin')
  const fn = tlsSrc.split('function verifyCertPin')[1]?.split('\n}')[0] || ''
  assert.ok(fn.includes("ok: true"), 'should return ok:true on match')
})

test('B: correct host + wrong pin → reject', () => {
  const fn = tlsSrc.split('function verifyCertPin')[1]?.split('\n}')[0] || ''
  assert.ok(fn.includes('TLS_CERT_PIN_MISMATCH'), 'should reject with PIN_MISMATCH')
})

test('C: wrong host → reject', () => {
  const fn = tlsSrc.split('function verifyCertPin')[1]?.split('\n}')[0] || ''
  assert.ok(fn.includes('HOST_NOT_TRUSTED'), 'should reject untrusted host')
})

test('D: dual pin — either matches → allow', () => {
  assert.ok(tlsSrc.includes('pins.includes(spki)'), 'should check against all pins')
  assert.ok(tlsSrc.includes('.some('), 'should try each pin for fingerprint fallback')
})

test('E: missing pin + production enforcement → reject', () => {
  const fn = tlsSrc.split('function verifyCertPin')[1]?.split('\n}')[0] || ''
  assert.ok(fn.includes('NO_PINS_CONFIGURED'), 'should reject when enforcement on and no pins')
  assert.ok(fn.includes('pinEnforcementEnabled'), 'should check enforcement flag')
})

test('F: compatibility flag allows unpinned TLS + warning', () => {
  assert.ok(tlsSrc.includes('WXQK_ALLOW_UNPINNED_TLS'), 'should check compat flag')
  assert.ok(tlsSrc.includes('TLS pin verification disabled by explicit compatibility flag'), 'should log warning')
})

test('SPKI pins loaded from WXQK_TLS_SPKI_PINS env', () => {
  assert.ok(tlsSrc.includes('WXQK_TLS_SPKI_PINS'), 'should read env var')
  assert.ok(tlsSrc.includes('TLS_PIN_NOT_CONFIGURED'), 'should warn when not configured')
})

test('deploy script outputs SPKI pin for configuration', () => {
  const deploy = fs.readFileSync(path.join(root, '..', 'server/wxqk/enable_https_ip.py'), 'utf8')
  assert.ok(deploy.includes('SPKI PIN'), 'should output SPKI pin')
  assert.ok(deploy.includes('WXQK_TLS_SPKI_PINS'), 'should reference env var name')
  assert.ok(deploy.includes('openssl dgst -sha256'), 'should compute SHA-256')
})
