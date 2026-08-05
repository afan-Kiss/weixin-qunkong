const test = require('node:test')
const assert = require('node:assert/strict')
const { readdirSync, readFileSync, statSync } = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const FORBIDDEN = [
  /xiangyuzhubao/i,
  /facai888/i,
  /发财888/,
  /\/api\/ws\/agent/,
  /wxqkReleaseSequence/,
  /wxqk-electron-/,
  /wxqk-client-update/,
  /DEFAULT_BASE\s*=\s*['"]https?:\/\//,
]

/**
 * @param {string} dir
 * @param {(name: string) => boolean} filter
 * @returns {string[]}
 */
function walkFiles(dir, filter) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'release-v19' || name === 'diagnostics') continue
      out.push(...walkFiles(full, filter))
    } else if (filter(name)) out.push(full)
  }
  return out
}

test('shipped client sources must not contain scannable backend fingerprints', () => {
  const files = [
    ...walkFiles(path.join(ROOT, 'electron'), (name) => name.endsWith('.cjs')),
    ...walkFiles(path.join(ROOT, 'src'), (name) => /\.(ts|vue|css)$/.test(name)),
  ]
  assert.ok(files.length > 20, 'expected client source files')
  const hits = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const pattern of FORBIDDEN) {
      if (pattern.test(text)) hits.push(`${path.relative(ROOT, file)} :: ${pattern}`)
    }
  }
  assert.deepEqual(hits, [])
})

test('package.json uses neutral releaseSequence field', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(typeof pkg.releaseSequence, 'number')
  assert.equal(pkg.wxqkReleaseSequence, undefined)
})
