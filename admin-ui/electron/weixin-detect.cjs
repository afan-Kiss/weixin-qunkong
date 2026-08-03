/**
 * 本机微信（Weixin.exe）安装路径与版本自动探测。
 * 用途：软件启动时写入设置，避免用户手动指定路径。
 */

const { execFileSync } = require('child_process')
const { existsSync } = require('fs')
const path = require('path')

/**
 * 判断路径是否为可用的 Weixin.exe。
 * @param {string} exePath 候选路径
 * @returns {boolean}
 */
function isWeixinExe(exePath) {
  if (!exePath || typeof exePath !== 'string') return false
  const resolved = path.resolve(exePath.trim())
  return path.basename(resolved).toLowerCase() === 'weixin.exe' && existsSync(resolved)
}

/** 版本号内存缓存，避免启动时反复拉起 PowerShell（冷启动可达数秒） */
const versionCache = new Map()

/**
 * 读取 exe 文件版本号。
 * @param {string} exePath Weixin.exe 路径
 * @returns {string} 版本号，失败为空串
 */
function readFileVersion(exePath) {
  if (!isWeixinExe(exePath)) return ''
  const resolved = path.resolve(exePath.trim())
  const cached = versionCache.get(resolved.toLowerCase())
  if (cached !== undefined) return cached
  try {
    const escaped = String(resolved).replace(/'/g, "''")
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `(Get-Item -LiteralPath '${escaped}').VersionInfo.FileVersion`],
      { encoding: 'utf8', windowsHide: true, timeout: 4000 },
    )
    const version = String(out || '').trim()
    versionCache.set(resolved.toLowerCase(), version)
    return version
  } catch {
    versionCache.set(resolved.toLowerCase(), '')
    return ''
  }
}

/**
 * 比较版本号，越大越新。
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareVersion(left, right) {
  const a = String(left || '').split(/[^\d]+/).map((part) => Number(part) || 0)
  const b = String(right || '').split(/[^\d]+/).map((part) => Number(part) || 0)
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0)
    if (diff) return diff
  }
  return 0
}

/**
 * 常见安装目录候选。
 * @returns {string[]}
 */
function commonCandidatePaths() {
  const env = process.env
  return [
    path.join(env.LOCALAPPDATA || '', 'Tencent', 'Weixin', 'Weixin.exe'),
    path.join(env.LOCALAPPDATA || '', 'Programs', 'Tencent', 'Weixin', 'Weixin.exe'),
    path.join(env.PROGRAMFILES || 'C:\\Program Files', 'Tencent', 'Weixin', 'Weixin.exe'),
    path.join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Tencent', 'Weixin', 'Weixin.exe'),
    'C:\\Weixin\\Weixin.exe',
    'D:\\Weixin\\Weixin.exe',
    'E:\\Weixin\\Weixin.exe',
    'C:\\weixin\\Weixin.exe',
    'D:\\weixin\\Weixin.exe',
    'E:\\weixin\\Weixin.exe',
  ].filter(Boolean)
}

/**
 * 从注册表卸载项 / 腾讯键探测安装路径。
 * @returns {string[]}
 */
function registryCandidatePaths() {
  if (process.platform !== 'win32') return []
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$paths = New-Object System.Collections.Generic.List[string]
function Add-Exe([string]$p) {
  if (-not $p) { return }
  $clean = $p.Trim().Trim('"')
  if ($clean -match ',\\d+$') { $clean = ($clean -split ',')[0] }
  if ((Split-Path -Leaf $clean) -ieq 'Weixin.exe' -and (Test-Path -LiteralPath $clean)) { [void]$paths.Add((Resolve-Path -LiteralPath $clean).Path) }
  elseif (Test-Path -LiteralPath $clean -PathType Container) {
    $exe = Join-Path $clean 'Weixin.exe'
    if (Test-Path -LiteralPath $exe) { [void]$paths.Add((Resolve-Path -LiteralPath $exe).Path) }
  }
}
$uninstall = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
Get-ItemProperty $uninstall | Where-Object { $_.DisplayName -match '微信|WeChat|Weixin' } | ForEach-Object {
  Add-Exe $_.InstallLocation
  Add-Exe $_.DisplayIcon
  Add-Exe $_.InstallSource
}
foreach ($key in @(
  'HKCU:\\Software\\Tencent\\Weixin',
  'HKCU:\\Software\\Tencent\\WeChat',
  'HKLM:\\SOFTWARE\\Tencent\\Weixin',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Tencent\\Weixin'
)) {
  $item = Get-ItemProperty $key
  if ($item) {
    foreach ($name in @('InstallPath','InstallDir','Path','AppPath')) { Add-Exe $item.$name }
  }
}
$appPath = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Weixin.exe'
if ($appPath) { Add-Exe $appPath.'(default)'; Add-Exe $appPath.Path }
$paths | Select-Object -Unique | ConvertTo-Json -Compress
`
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 },
    )
    const text = String(out || '').trim()
    if (!text) return []
    const parsed = JSON.parse(text)
    return (Array.isArray(parsed) ? parsed : [parsed]).map(String).filter(isWeixinExe)
  } catch {
    return []
  }
}

/**
 * 汇总并排序本机微信安装候选。
 * @returns {Array<{ exePath: string, version: string, source: string }>}
 */
function detectWeixinInstalls() {
  const found = new Map()
  const add = (exePath, source) => {
    if (!isWeixinExe(exePath)) return
    const resolved = path.resolve(exePath)
    if (found.has(resolved.toLowerCase())) return
    found.set(resolved.toLowerCase(), {
      exePath: resolved,
      version: readFileVersion(resolved),
      source,
    })
  }
  for (const candidate of registryCandidatePaths()) add(candidate, 'registry')
  for (const candidate of commonCandidatePaths()) add(candidate, 'common')
  return [...found.values()].sort((left, right) => compareVersion(right.version, left.version) || left.exePath.localeCompare(right.exePath))
}

/**
 * 返回优先使用的微信路径（版本最新且存在）。
 * @returns {{ exePath: string, version: string, source: string, candidates: Array<{ exePath: string, version: string, source: string }> } | null}
 */
function detectPreferredWeixin() {
  const candidates = detectWeixinInstalls()
  if (!candidates.length) return null
  const preferred = candidates[0]
  return { ...preferred, candidates }
}

module.exports = {
  isWeixinExe,
  readFileVersion,
  compareVersion,
  commonCandidatePaths,
  detectWeixinInstalls,
  detectPreferredWeixin,
}
