const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')

test('instance management uses native WeChat login and never requests a login QR through the DLL', () => {
  const page = readFileSync(path.join(__dirname, '..', 'src', 'pages', 'InstancesPage.vue'), 'utf8')
  assert.doesNotMatch(page, /reflash_qrcode|getLoginQr|loginQr|qrBusy|登录二维码/)
  assert.match(page, /请在微信原生窗口中扫码登录/)
})

test('new instances start a fast login probe and status refresh does not depend on directory refresh', () => {
  const page = readFileSync(path.join(__dirname, '..', 'src', 'pages', 'InstancesPage.vue'), 'utf8')
  const main = readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  const refreshBody = page.slice(page.indexOf('async function refresh()'), page.indexOf('async function refreshDirectoryQuietly'))
  assert.doesNotMatch(refreshBody, /refreshDirectory/)
  assert.match(main, /startProbeLoop\(record, 2000\)/)
  assert.match(main, /setTimeout\(\(\) => probeInstance\(record\), 1000\)/)
  assert.match(main, /loggedIn \? 10000 : 2000/)
})
