import { _electron as electron } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

if (process.env.ALLOW_REAL_INJECTION !== '1') {
  throw new Error('Set ALLOW_REAL_INJECTION=1 to acknowledge that this starts a real WeChat instance.')
}

const outputDir = path.resolve('test-results', 'real-injection')
await mkdir(outputDir, { recursive: true })
const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
let result
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const started = await page.evaluate(() => window.wxControl.startInstance())
  if (!started?.ok || !started.data?.id) throw new Error(started?.error || 'Instance did not start')
  await page.waitForFunction(async (id) => (await window.wxControl.listInstances()).some((item) => item.id === id && item.status === 'WAITING_LOGIN'), started.data.id, { timeout: 20000 })
  let loginQr
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.waitForTimeout(200)
    loginQr = await page.evaluate(({ id }) => window.wxControl.callApi(id, '/api/reflash_qrcode', {}, 438557508, 1000), { id: started.data.id })
    if (loginQr?.ok && loginQr.data?.baseResponse?.ret === 0) break
  }
  const instance = (await page.evaluate(() => window.wxControl.listInstances()))
    .find((item) => item.id === started.data.id)
  const login = { ok: instance?.status === 'WAITING_LOGIN', data: { status: instance?.status } }
  const qrBuffer = loginQr?.data?.qrcode?.buffer
  let qrArtifact = null
  if (typeof qrBuffer === 'string' && qrBuffer.length) {
    const bytes = Buffer.from(qrBuffer, 'base64')
    const extension = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'png'
      : bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])) ? 'jpg' : 'bin'
    qrArtifact = path.join(outputDir, `login-qrcode.${extension}`)
    await writeFile(qrArtifact, bytes)
  }
  result = { recordedAt: new Date().toISOString(), started: started.data, instance, login, loginQr, qrArtifact }
  await writeFile(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2))
  await page.evaluate((id) => window.wxControl.stopInstance(id), started.data.id)
} finally {
  await app.close()
}

if (!result?.loginQr?.ok || result.loginQr.data?.baseResponse?.ret !== 0 || !result.qrArtifact) throw new Error('Login QR smoke test failed')
console.log(JSON.stringify(result, null, 2))
