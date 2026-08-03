import { _electron as electron } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

if (process.env.ALLOW_REAL_INJECTION !== '1') throw new Error('Set ALLOW_REAL_INJECTION=1 to run the real pre-login UI smoke test.')

const outputDir = path.resolve('test-results', 'prelogin-ui')
await mkdir(outputDir, { recursive: true })
const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
let result
let startedInstanceId
try {
  const page = await app.firstWindow()
  page.on('console', (message) => { if (message.type() === 'error') console.error('renderer:', message.text()) })
  await page.waitForLoadState('domcontentloaded')
  await page.locator('.sidebar .menu').waitFor()
  await page.locator('.menu__item').filter({ hasText: '微信实例' }).click()
  await page.waitForURL('**/#/instances')
  await page.locator('.tool-card button').filter({ hasText: '新增实例' }).click()
  await page.waitForFunction(async () => (await window.wxControl.listInstances()).some((item) => item.status === 'WAITING_LOGIN'), null, { timeout: 20000 })
  startedInstanceId = await page.evaluate(async () => (await window.wxControl.listInstances()).find((item) => item.status === 'WAITING_LOGIN')?.id)
  await page.locator('.el-table__body').first().getByText('待登录', { exact: true }).waitFor()
  await page.getByRole('button', { name: '登录二维码', exact: true }).click()
  const image = page.locator('.login-qr')
  await image.waitFor({ timeout: 30000 })
  const qr = await image.evaluate((element) => ({ naturalWidth: element.naturalWidth, naturalHeight: element.naturalHeight, srcLength: element.src.length }))
  const instances = await page.evaluate(() => window.wxControl.listInstances())
  result = { recordedAt: new Date().toISOString(), qr, instances }
  await page.screenshot({ path: path.join(outputDir, 'instances-login-qrcode.png'), fullPage: true })
  await writeFile(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2))
  await page.getByRole('button', { name: '关闭', exact: true }).first().click()
  startedInstanceId = undefined
  await page.waitForTimeout(1000)
} finally {
  if (startedInstanceId) {
    const windows = app.windows()
    if (windows[0]) await windows[0].evaluate((id) => window.wxControl.stopInstance(id, true), startedInstanceId).catch(() => undefined)
  }
  await app.close()
}

console.log(JSON.stringify(result, null, 2))
