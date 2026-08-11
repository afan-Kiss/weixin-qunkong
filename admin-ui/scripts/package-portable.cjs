'use strict'
/**
 * 稳定打包便携版：
 * - electron 国内镜像
 * - win-unpacked/app.asar 常被 Cursor 索引锁住：自动换旁路/时间戳目录
 * - 避免反复卡在同一个 release-v19*
 */
const { spawnSync } = require('child_process')
const { existsSync, mkdirSync, rmSync, openSync, closeSync, unlinkSync } = require('fs')
const os = require('os')
const path = require('path')

const root = path.join(__dirname, '..')
const pkg = require('../package.json')
const preferred = (pkg.build && pkg.build.directories && pkg.build.directories.output) || 'release-v19'

if (!process.env.ELECTRON_MIRROR) {
  process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** @param {string} filePath */
function isFileLocked(filePath) {
  if (!existsSync(filePath)) return false
  try {
    const fd = openSync(filePath, 'r+')
    closeSync(fd)
    return false
  } catch {
    return true
  }
}

/** @param {string} dirName relative to admin-ui, or absolute */
function canUseOutputDir(dirName) {
  const abs = path.isAbsolute(dirName) ? dirName : path.join(root, dirName)
  const unpacked = path.join(abs, 'win-unpacked')
  const asar = path.join(unpacked, 'resources', 'app.asar')
  if (isFileLocked(asar)) return false
  if (!existsSync(unpacked)) {
    try { mkdirSync(abs, { recursive: true }) } catch { return false }
    return true
  }
  try {
    rmSync(unpacked, { recursive: true, force: true })
    return !existsSync(unpacked) || !isFileLocked(asar)
  } catch {
    return false
  }
}

function resolveOutputDir() {
  const candidates = [
    preferred,
    `${preferred}-build`,
    `${preferred}-tmp`,
    `${preferred}-${stamp()}`,
  ]
  for (const name of candidates) {
    if (canUseOutputDir(name)) {
      if (name !== preferred) {
        console.log(`win-unpacked/app.asar locked or busy; using output ${name}`)
      }
      return name
    }
    console.log(`skip locked output: ${name}`)
  }
  // 最后手段：写到系统临时目录，彻底避开 Cursor 工作区索引锁
  const outside = path.join(os.tmpdir(), `wxqk-release-${stamp()}`)
  mkdirSync(outside, { recursive: true })
  console.log(`all workspace release dirs locked (often Cursor indexing app.asar); using ${outside}`)
  return outside
}

const outputDir = resolveOutputDir()
console.log(`electron-builder output=${outputDir} mirror=${process.env.ELECTRON_MIRROR}`)
console.log('hint: if packaging keeps failing, exclude admin-ui/release-v19* in .cursorignore and reload Cursor window')

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron-builder', '--win', 'portable', `--config.directories.output=${outputDir}`],
  { cwd: root, env: process.env, stdio: 'inherit', shell: true },
)
process.exit(result.status == null ? 1 : result.status)
