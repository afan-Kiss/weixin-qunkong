/**
 * 打包前版本 +1，并同步递增 releaseSequence（对齐服务端 releaseSequence）。
 * - package.json 使用合法 semver：1.0.0 → 1.1.0 → 1.2.0（electron-builder 要求）
 * - 产物文件名/界面只显示一位小数：微信群控系统v1.1.exe
 * - releaseSequence：取 max(本地+1, 远端清单+1)，避免发版后客户端序号落后
 */
const { readFileSync, writeFileSync } = require('fs')
const https = require('https')
const path = require('path')
const { getServiceBase } = require('../electron/secure-config.cjs')

const pkgPath = path.join(__dirname, '..', 'package.json')
const lockPath = path.join(__dirname, '..', 'package-lock.json')
const MANIFEST_URL = `${getServiceBase()}/api/update/manifest`

/**
 * 拉取远端 releaseSequence；失败返回 0。
 * @returns {Promise<number>}
 */
function fetchRemoteReleaseSequence() {
  return new Promise((resolve) => {
    const req = https.get(MANIFEST_URL, { timeout: 8000 }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try {
          if ((res.statusCode || 0) >= 300) return resolve(0)
          const wrap = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          const seq = Number(wrap?.manifest?.releaseSequence || 0) || 0
          resolve(seq > 0 ? seq : 0)
        } catch {
          resolve(0)
        }
      })
    })
    req.on('error', () => resolve(0))
    req.on('timeout', () => { req.destroy(); resolve(0) })
  })
}

/**
 * 执行版本与序号递增并写回 package.json / package-lock.json。
 * @returns {Promise<void>}
 */
async function main() {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const match = String(pkg.version || '1.0.0').match(/^(\d+)\.(\d+)/)
  const major = match ? Number(match[1]) : 1
  const minor = match ? Number(match[2]) : 0
  const nextMinor = minor + 1
  const next = `${major}.${nextMinor}.0`
  const display = `${major}.${nextMinor}`

  const localSeq = Number(pkg.releaseSequence || pkg.wxqkReleaseSequence || 0) || 0
  const remoteSeq = await fetchRemoteReleaseSequence()
  const nextSeq = Math.max(localSeq + 1, remoteSeq + 1, 1)

  pkg.version = next
  pkg.releaseSequence = nextSeq
  delete pkg.wxqkReleaseSequence
  if (!pkg.build) pkg.build = {}
  if (!pkg.build.win) pkg.build.win = {}
  pkg.build.win.artifactName = `微信群控系统v${display}.\${ext}`
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
    lock.version = next
    if (lock.packages && lock.packages['']) {
      lock.packages[''].version = next
      lock.packages[''].releaseSequence = nextSeq
      delete lock.packages[''].wxqkReleaseSequence
    }
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8')
  } catch { /* lock 可选 */ }

  console.log(`version -> ${next} (文件名 微信群控系统v${display}.exe) releaseSequence -> ${nextSeq}`
    + (remoteSeq ? ` (远端 ${remoteSeq})` : ' (远端不可用，本地递增)'))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
