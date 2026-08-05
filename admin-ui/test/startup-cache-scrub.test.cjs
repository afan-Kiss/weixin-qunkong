const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const {
  scrubLegacyCachesOnStartup,
  scrubUserDataCaches,
} = require('../electron/startup-cache-scrub.cjs')
const { getLegacyTempDirNames } = require('../electron/secure-config.cjs')

test('scrubUserDataCaches removes cache/diagnostics/logs but keeps settings paths', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'scrub-ud-'))
  mkdirSync(path.join(root, 'cache', 'clipboard-images'), { recursive: true })
  mkdirSync(path.join(root, 'friend-diagnostics'), { recursive: true })
  mkdirSync(path.join(root, 'logs'), { recursive: true })
  mkdirSync(path.join(root, 'Cache'), { recursive: true })
  mkdirSync(path.join(root, 'data'), { recursive: true })
  mkdirSync(path.join(root, 'security'), { recursive: true })
  writeFileSync(path.join(root, 'cache', 'clipboard-images', 'a.png'), 'x')
  writeFileSync(path.join(root, 'friend-diagnostics', 'a.json'), '{}')
  writeFileSync(path.join(root, 'logs', 'wechat-control.jsonl'), '{}\n')
  writeFileSync(path.join(root, 'Cache', 'f'), 'c')
  writeFileSync(path.join(root, 'data', 'wechat-control.sqlite'), 'db')
  writeFileSync(path.join(root, 'security', 'device-identity.json'), '{}')
  writeFileSync(path.join(root, 'account-session.bin'), 'tok')

  scrubUserDataCaches(root)

  assert.equal(existsSync(path.join(root, 'cache')), false)
  assert.equal(existsSync(path.join(root, 'friend-diagnostics')), false)
  assert.equal(existsSync(path.join(root, 'logs')), false)
  assert.equal(existsSync(path.join(root, 'Cache')), false)
  assert.equal(existsSync(path.join(root, 'data', 'wechat-control.sqlite')), true)
  assert.equal(existsSync(path.join(root, 'security', 'device-identity.json')), true)
  assert.equal(existsSync(path.join(root, 'account-session.bin')), true)
  try { rmSync(root, { recursive: true, force: true }) } catch {}
})

test('scrubLegacyCachesOnStartup runs once per version and only clears api samples safely', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'scrub-once-'))
  mkdirSync(path.join(root, 'friend-diagnostics'), { recursive: true })
  writeFileSync(path.join(root, 'friend-diagnostics', 'x.json'), '{}')
  let cleared = 0
  const first = scrubLegacyCachesOnStartup({
    userDataDir: root,
    version: '1.50.0',
    storage: { clearApiSamplesOnly: () => { cleared += 3; return 3 } },
  })
  assert.equal(first.skipped, false)
  assert.equal(first.dbRows, 3)
  assert.equal(existsSync(path.join(root, 'friend-diagnostics')), false)
  assert.equal(existsSync(path.join(root, '.cache-scrubbed-1.50.0')), true)

  const second = scrubLegacyCachesOnStartup({
    userDataDir: root,
    version: '1.50.0',
    storage: { clearApiSamplesOnly: () => { cleared += 9; return 9 } },
  })
  assert.equal(second.skipped, true)
  assert.equal(cleared, 3)

  // 没有 clearApiSamplesOnly 时不得调用全量 clearRuntimeCaches
  let dangerous = 0
  scrubLegacyCachesOnStartup({
    userDataDir: root,
    version: '1.51.0',
    storage: { clearRuntimeCaches: () => { dangerous += 1; return 1 } },
  })
  assert.equal(dangerous, 0)
  try { rmSync(root, { recursive: true, force: true }) } catch {}
})

test('main wires startup cache scrub after storage init', () => {
  const main = readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  assert.match(main, /scrubLegacyCachesOnStartup/)
  assert.match(main, /clearApiSamplesOnly/)
  assert.match(main, /已清理旧版缓存目录/)
  assert.ok(getLegacyTempDirNames().some((name) => name.includes('update')))
})
