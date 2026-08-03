import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const baseUrl = process.env.UI_AUDIT_URL || 'http://127.0.0.1:5173'
const edgePath = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const outputDir = path.resolve('test-results', 'ui-audit')
const routes = [
  '/dashboard', '/instances', '/groups', '/qr-tasks', '/broadcast',
  '/contacts', '/wxids', '/tasks', '/monitor', '/settings',
]
const viewports = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1600, height: 900 },
]

await mkdir(outputDir, { recursive: true })
const browser = await chromium.launch({ executablePath: edgePath, headless: true })
const findings = []

for (const viewport of viewports) {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  for (const route of routes) {
    const consoleErrors = []
    const onConsole = (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    }
    page.on('console', onConsole)
    await page.goto(`${baseUrl}/#${route}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(150)

    const issues = await page.evaluate(() => {
      const visible = (element) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
      }
      const label = (element) => (element.innerText || element.getAttribute('aria-label') || element.tagName)
        .trim().replace(/\s+/g, ' ').slice(0, 80)
      const all = [...document.querySelectorAll('body *')].filter(visible)
      const clippedText = all.filter((element) => {
        if (!element.textContent?.trim() || element.children.length > 0) return false
        const style = getComputedStyle(element)
        if (style.overflow === 'visible' && style.textOverflow !== 'ellipsis') return false
        return element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1
      }).map((element) => ({ kind: 'clipped-text', element: label(element) }))
      const controls = [...document.querySelectorAll('button, input, textarea, select, [role="button"], a')].filter(visible)
      const overlaps = []
      for (let i = 0; i < controls.length; i += 1) {
        const a = controls[i].getBoundingClientRect()
        for (let j = i + 1; j < controls.length; j += 1) {
          const b = controls[j].getBoundingClientRect()
          const intersection = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
            * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
          if (intersection > 4 && !controls[i].contains(controls[j]) && !controls[j].contains(controls[i])) {
            overlaps.push({ kind: 'control-overlap', elements: [label(controls[i]), label(controls[j])] })
          }
        }
      }
      return {
        documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        clippedText,
        overlaps,
      }
    })
    const result = { route, viewport, consoleErrors, ...issues }
    if (consoleErrors.length || issues.documentOverflow || issues.clippedText.length || issues.overlaps.length) findings.push(result)
    await page.screenshot({ path: path.join(outputDir, `${viewport.width}x${viewport.height}-${route.slice(1) || 'root'}.png`), fullPage: true })
    page.off('console', onConsole)
  }
  await context.close()
}

await browser.close()
await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ baseUrl, findings }, null, 2))
console.log(JSON.stringify({ pagesChecked: routes.length * viewports.length, findings: findings.length, outputDir }, null, 2))
process.exitCode = findings.length ? 1 : 0
