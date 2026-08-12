'use strict'
/**
 * 生成 electron-builder portable splashImage 所需的 24-bit BMP（非零 DPI）。
 */
const { execFileSync } = require('child_process')
const { existsSync } = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const outBmp = path.join(root, 'build', 'portable-splash.bmp')
const pyPath = path.join(__dirname, '_gen_portable_splash.py')

execFileSync('python', [pyPath], { cwd: root, stdio: 'inherit' })
if (!existsSync(outBmp)) {
  console.error('failed to generate portable splash bmp')
  process.exit(1)
}
console.log('portable splash ready:', outBmp)
