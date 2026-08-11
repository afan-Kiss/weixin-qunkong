const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const https = require('node:https')
const {
  createHash,
  X509Certificate,
} = require('node:crypto')
const {
  TLS_TEST_CERT_PEM,
  TLS_TEST_KEY_PEM,
  TLS_TEST_SPKI_PIN,
  TLS_TEST_HOST,
} = require('./fixtures/tls-selfsigned-127.cjs')

const tlsModPath = path.join(__dirname, '..', 'electron', 'service-tls.cjs')

function loadTlsFresh() {
  delete require.cache[require.resolve(tlsModPath)]
  return require(tlsModPath)
}

function expectedSpkiPin(certPem) {
  const x509 = new X509Certificate(certPem)
  const spkiDer = x509.publicKey.export({ type: 'spki', format: 'der' })
  const hash = createHash('sha256').update(spkiDer).digest('base64')
  return `sha256/${hash}`
}

test('1: computeSpkiHash matches X509Certificate SPKI DER hash', () => {
  const tls = loadTlsFresh()
  const expected = expectedSpkiPin(TLS_TEST_CERT_PEM).slice('sha256/'.length)
  assert.equal(tls.computeSpkiHash(TLS_TEST_CERT_PEM), expected)
  assert.equal(tls.computeSpkiHash(TLS_TEST_CERT_PEM), TLS_TEST_SPKI_PIN.slice('sha256/'.length))
})

test('2: correct hostname + correct SPKI → allow', () => {
  const tls = loadTlsFresh()
  tls.resetTlsStateForTests()
  tls.addTrustedHostForTests(TLS_TEST_HOST)
  tls.setCertPins(TLS_TEST_HOST, [TLS_TEST_SPKI_PIN])
  const result = tls.verifyCertPin(TLS_TEST_HOST, TLS_TEST_CERT_PEM)
  assert.equal(result.ok, true)
})

test('3: correct hostname + wrong SPKI → TLS_CERT_PIN_MISMATCH', () => {
  const tls = loadTlsFresh()
  tls.resetTlsStateForTests()
  tls.addTrustedHostForTests(TLS_TEST_HOST)
  tls.setCertPins(TLS_TEST_HOST, ['sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='])
  const result = tls.verifyCertPin(TLS_TEST_HOST, TLS_TEST_CERT_PEM)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'TLS_CERT_PIN_MISMATCH')
})

test('4: correct pin + wrong hostname → TLS_HOSTNAME_MISMATCH', () => {
  const tls = loadTlsFresh()
  tls.resetTlsStateForTests()
  tls.addTrustedHostForTests('10.0.0.99')
  tls.setCertPins('10.0.0.99', [TLS_TEST_SPKI_PIN])
  const wrongHost = tls.verifyCertPin('10.0.0.99', TLS_TEST_CERT_PEM)
  assert.equal(wrongHost.ok, false)
  assert.equal(wrongHost.reason, 'TLS_HOSTNAME_MISMATCH')
})

test('5: dual pin — second pin matches → allow', () => {
  const tls = loadTlsFresh()
  tls.resetTlsStateForTests()
  tls.addTrustedHostForTests(TLS_TEST_HOST)
  tls.setCertPins(TLS_TEST_HOST, [
    'sha256/OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLD=',
    TLS_TEST_SPKI_PIN,
  ])
  const result = tls.verifyCertPin(TLS_TEST_HOST, TLS_TEST_CERT_PEM)
  assert.equal(result.ok, true)
})

test('6: no pin + no compat flag → reject', () => {
  const tls = loadTlsFresh()
  tls.resetTlsStateForTests()
  const prev = process.env.WXQK_ALLOW_UNPINNED_TLS
  delete process.env.WXQK_ALLOW_UNPINNED_TLS
  try {
    tls.addTrustedHostForTests(TLS_TEST_HOST)
    const result = tls.verifyCertPin(TLS_TEST_HOST, TLS_TEST_CERT_PEM)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'TLS_PIN_NOT_CONFIGURED')
    assert.throws(() => tls.insecureTlsForService(TLS_TEST_HOST), (err) => err.code === 'TLS_PIN_NOT_CONFIGURED')
  } finally {
    if (prev === undefined) delete process.env.WXQK_ALLOW_UNPINNED_TLS
    else process.env.WXQK_ALLOW_UNPINNED_TLS = prev
  }
})

test('7: no pin + WXQK_ALLOW_UNPINNED_TLS=1 → compat allow', () => {
  const tls = loadTlsFresh()
  tls.resetTlsStateForTests()
  const prev = process.env.WXQK_ALLOW_UNPINNED_TLS
  process.env.WXQK_ALLOW_UNPINNED_TLS = '1'
  try {
    tls.addTrustedHostForTests(TLS_TEST_HOST)
    const result = tls.verifyCertPin(TLS_TEST_HOST, TLS_TEST_CERT_PEM)
    assert.equal(result.ok, true)
    const opts = tls.insecureTlsForService(TLS_TEST_HOST)
    assert.equal(opts.rejectUnauthorized, false)
  } finally {
    if (prev === undefined) delete process.env.WXQK_ALLOW_UNPINNED_TLS
    else process.env.WXQK_ALLOW_UNPINNED_TLS = prev
  }
})

test('8: pinned HTTPS agent accepts correct pin and rejects wrong pin', async () => {
  const tls = loadTlsFresh()
  tls.resetTlsStateForTests()
  const prevPins = process.env.WXQK_TLS_SPKI_PINS
  delete process.env.WXQK_ALLOW_UNPINNED_TLS
  delete process.env.WXQK_TLS_SPKI_PINS

  const server = https.createServer({ key: TLS_TEST_KEY_PEM, cert: TLS_TEST_CERT_PEM }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, TLS_TEST_HOST, resolve)
  })
  const port = server.address().port

  try {
    tls.resetTlsStateForTests()
    tls.addTrustedHostForTests(TLS_TEST_HOST)
    tls.setCertPins(TLS_TEST_HOST, [TLS_TEST_SPKI_PIN])

    const okBody = await new Promise((resolve, reject) => {
      const req = https.get(`https://${TLS_TEST_HOST}:${port}/`, tls.insecureTlsForService(TLS_TEST_HOST), (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => resolve(data))
      })
      req.on('error', reject)
    })
    assert.equal(okBody, 'ok')

    tls.setCertPins(TLS_TEST_HOST, ['sha256/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='])
    await assert.rejects(() => new Promise((resolve, reject) => {
      const req = https.get(`https://${TLS_TEST_HOST}:${port}/`, tls.insecureTlsForService(TLS_TEST_HOST), (res) => {
        resolve(res.statusCode)
      })
      req.on('error', reject)
    }))
  } finally {
    await new Promise((resolve) => server.close(resolve))
    if (prevPins === undefined) delete process.env.WXQK_TLS_SPKI_PINS
    else process.env.WXQK_TLS_SPKI_PINS = prevPins
  }
})

test('deploy script outputs SPKI pin for configuration', () => {
  const deploy = readFileSync(path.join(__dirname, '..', '..', 'server/wxqk/enable_https_ip.py'), 'utf8')
  assert.match(deploy, /SPKI PIN/)
  assert.match(deploy, /WXQK_TLS_SPKI_PINS/)
  assert.match(deploy, /openssl dgst -sha256/)
})
