/**
 * 打包/开发前确保注入组件在 admin-ui/resources/hook 下，避免依赖本机绝对路径。
 */
const { copyFileSync, existsSync, mkdirSync } = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const destDir = path.join(root, 'resources', 'hook', '4.1.8.27')
const sources = [
  path.join(root, '..', '4.1.8.27', '4.1.8.27'),
  path.join(root, 'resources', 'hook', '4.1.8.27'),
]
const files = ['inject.exe', 'libGLESv1.dll']

/**
 * 确保 hook 文件存在于 resources 目录。
 * @returns {{ ok: boolean, dir: string, message?: string }}
 */
function ensureHooks() {
  mkdirSync(destDir, { recursive: true })
  const sourceDir = sources.find((dir) => files.every((name) => existsSync(path.join(dir, name))))
  if (!sourceDir) {
    return {
      ok: false,
      dir: destDir,
      message: '找不到 inject.exe / libGLESv1.dll，请把 4.1.8.27 组件放到仓库 4.1.8.27/4.1.8.27 或 admin-ui/resources/hook/4.1.8.27',
    }
  }
  for (const name of files) {
    const from = path.join(sourceDir, name)
    const to = path.join(destDir, name)
    if (path.resolve(from) !== path.resolve(to)) copyFileSync(from, to)
  }
  return { ok: true, dir: destDir }
}

if (require.main === module) {
  const result = ensureHooks()
  if (!result.ok) {
    console.error(result.message)
    process.exit(1)
  }
  console.log(`hook 组件已就绪：${result.dir}`)
}

module.exports = { ensureHooks }
