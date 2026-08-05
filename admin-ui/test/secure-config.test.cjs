const test = require('node:test')
const assert = require('node:assert/strict')
const {
  getServiceBase,
  getAllowedHosts,
  getPublishPublicKeyB64,
  getProtocol,
  getLegacyManifestDefaults,
  getAgentWsPath,
  getDesktopHashPath,
  getBuildIdPrefix,
  isLegacyBrandDownloadUrl,
  isLegacyBrandFileName,
  _decodeForTest,
} = require('../electron/secure-config.cjs')

test('secure-config decodes service endpoints without storing plaintext literals in module source', () => {
  const { readFileSync } = require('node:fs')
  const path = require('node:path')
  const src = readFileSync(path.join(__dirname, '..', 'electron', 'secure-config.cjs'), 'utf8')
  assert.doesNotMatch(src, /xiangyuzhubao/)
  assert.doesNotMatch(src, /facai888/)
  assert.doesNotMatch(src, /发财888/)
  assert.doesNotMatch(src, /\/api\/ws\/agent/)

  const base = getServiceBase()
  assert.match(base, /^https:\/\//)
  assert.ok(base.includes('/'))
  assert.equal(getAgentWsPath().startsWith('/api/'), true)
  assert.equal(getDesktopHashPath().startsWith('/'), true)
  assert.ok(getBuildIdPrefix().endsWith('-'))
  assert.equal(getPublishPublicKeyB64().endsWith('='), true)
  assert.equal(getAllowedHosts().size >= 2, true)
})

test('protocol headers stay wire-compatible with production gate', () => {
  const proto = getProtocol()
  assert.equal(proto.protocolVersion, 'facai888-v1')
  assert.equal(proto.securityProtocolVersion, 'security-v1')
  assert.equal(proto.desktopProtocolVersion, 'desktop-webrtc-v1')
  assert.equal(proto.updaterProtocolVersion, 'updater-v1')
  assert.equal(getBuildIdPrefix(), 'wxqk-electron-')
  const legacy = getLegacyManifestDefaults()
  assert.equal(legacy.protocolVersion, _decodeForTest('legacyProto'))
  assert.equal(legacy.signingKeyId, legacy.protocolVersion)
})

test('legacy brand helpers detect old download paths and file names', () => {
  const base = getServiceBase()
  const host = [...getAllowedHosts()][0]
  const brand = _decodeForTest('legacyBrand')
  assert.equal(isLegacyBrandDownloadUrl(`${base}/api/update/package/a`), false)
  assert.equal(isLegacyBrandDownloadUrl(`https://${host}/${brand}/api/update/package/a`), true)
  assert.equal(isLegacyBrandDownloadUrl(`https://${host}/other/api/update/package/a`), true)
  assert.equal(isLegacyBrandFileName(`微信群控系统v1.0.exe`), false)
  assert.equal(isLegacyBrandFileName(`${brand}系统.exe`), true)
  assert.equal(isLegacyBrandFileName('开云客户端.exe'), true)
})
