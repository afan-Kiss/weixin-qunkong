#!/usr/bin/env node
/**
 * Download branded WXQK MeshAgent binaries from YOUR MeshCentral server (pinned 1.2.4)
 * into admin-ui/resources/meshcentral/
 *
 * With domains."".agentCustomization.fileName=WXQK the download is WXQK.exe (+ WXQK.msh).
 *
 * Env:
 *   WXQK_MESH_AGENT_URL  — HTTPS URL to Windows agent exe (required)
 *   WXQK_MESH_MSH_URL    — HTTPS URL to matching .msh (optional; derived if same path)
 *   WXQK_MESH_AGENT_SHA256 — optional expected sha256 of exe
 *   WXQK_MESH_MSH_SHA256   — optional expected sha256 of msh
 *
 * TLS verification is always ON. Never commit production .msh / WXQK.exe.
 */
'use strict'

const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')
const crypto = require('crypto')
const { URL } = require('url')

const OUT_DIR = path.join(__dirname, '..', 'resources', 'meshcentral')
const EXE_NAME = 'WXQK.exe'
const MSH_NAME = 'WXQK.msh'

function fail(message, code = 1) {
  console.error(`[MESH] ERROR ${message}`)
  process.exit(code)
}

function cleanupPartial(destPath) {
  try {
    if (fs.existsSync(destPath) && fs.statSync(destPath).size === 0) {
      fs.unlinkSync(destPath)
    }
  } catch { /* ignore */ }
  try {
    const part = `${destPath}.part`
    if (fs.existsSync(part)) fs.unlinkSync(part)
  } catch { /* ignore */ }
}

function download(urlString, destPath) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(urlString)
    } catch {
      reject(new Error(`invalid URL: ${urlString}`))
      return
    }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname))) {
      reject(new Error('only https:// (or http://localhost) allowed'))
      return
    }
    const lib = u.protocol === 'https:' ? https : http
    const tmp = `${destPath}.part`
    const file = fs.createWriteStream(tmp)
    const req = lib.get(u, {
      timeout: 120000,
      headers: { 'User-Agent': 'wxqk-fetch-mesh-agent/1.0' },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close()
        fs.unlink(tmp, () => {})
        download(res.headers.location, destPath).then(resolve, reject)
        return
      }
      if (!res.statusCode || res.statusCode >= 400) {
        file.close()
        fs.unlink(tmp, () => {})
        reject(new Error(`HTTP ${res.statusCode} for ${u.hostname}${u.pathname}`))
        return
      }
      res.pipe(file)
      file.on('finish', () => {
        file.close(() => {
          try {
            const size = fs.statSync(tmp).size
            if (size <= 0) {
              fs.unlink(tmp, () => {})
              reject(new Error(`downloaded 0-byte file for ${u.hostname}${u.pathname}`))
              return
            }
            fs.renameSync(tmp, destPath)
            resolve({ bytes: size })
          } catch (err) {
            fs.unlink(tmp, () => {})
            reject(err)
          }
        })
      })
    })
    req.on('error', (err) => {
      try { file.close() } catch { /* ignore */ }
      fs.unlink(tmp, () => {})
      reject(err)
    })
    req.on('timeout', () => {
      req.destroy(new Error('timeout'))
    })
  })
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

async function main() {
  const agentUrl = String(process.env.WXQK_MESH_AGENT_URL || '').trim()
  let mshUrl = String(process.env.WXQK_MESH_MSH_URL || '').trim()
  if (!agentUrl) {
    fail('WXQK_MESH_AGENT_URL is required (download link from your MeshCentral → Add Agent)')
  }
  if (!mshUrl) {
    if (agentUrl.toLowerCase().endsWith('.exe')) {
      mshUrl = `${agentUrl.slice(0, -4)}.msh`
    }
  }
  if (!mshUrl) {
    fail('WXQK_MESH_MSH_URL is required when agent URL is not *.exe')
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const exePath = path.join(OUT_DIR, EXE_NAME)
  const mshPath = path.join(OUT_DIR, MSH_NAME)

  try {
    console.log(`[MESH] downloading agent → ${exePath}`)
    const exeInfo = await download(agentUrl, exePath)
    console.log(`[MESH] downloading msh → ${mshPath}`)
    const mshInfo = await download(mshUrl, mshPath)

    if (!fs.existsSync(exePath) || !fs.existsSync(mshPath)) {
      fail('download finished but files missing')
    }
    if (exeInfo.bytes < 1024) fail(`agent exe too small (${exeInfo.bytes} bytes)`)
    if (mshInfo.bytes < 16) fail(`msh too small (${mshInfo.bytes} bytes)`)

    const buf = fs.readFileSync(exePath)
    if (buf.length < 1024 * 100 || buf[0] !== 0x4d || buf[1] !== 0x5a) {
      fail('agent exe is not a valid Windows PE (MZ) binary — refusing to keep HTML/error page')
    }
    const head = buf.slice(0, 64).toString('utf8').toLowerCase()
    if (head.includes('<!doctype') || head.includes('<html') || head.includes('login')) {
      fail('agent download looks like an HTML login/error page')
    }

    const mshText = fs.readFileSync(mshPath, 'utf8')
    if (/<!doctype|<html|login/i.test(mshText.slice(0, 200))) {
      fail('msh download looks like an HTML login/error page')
    }
    if (!/MeshServer=/i.test(mshText) || !/ServerID=/i.test(mshText) || !/MeshID=/i.test(mshText)) {
      fail('msh content does not look like a MeshCentral pairing file (missing MeshServer/ServerID/MeshID)')
    }
    // Never invent ServerID/MeshID here — only validate official download content.
    console.log('[MESH] msh fields present (official download only; this script does not compute ServerID)')

    const expectExe = String(process.env.WXQK_MESH_AGENT_SHA256 || '').trim().toLowerCase()
    const expectMsh = String(process.env.WXQK_MESH_MSH_SHA256 || '').trim().toLowerCase()
    if (expectExe) {
      const got = sha256File(exePath)
      if (got !== expectExe) fail(`agent sha256 mismatch: got ${got}`)
    }
    if (expectMsh) {
      const got = sha256File(mshPath)
      if (got !== expectMsh) fail(`msh sha256 mismatch: got ${got}`)
    }

    console.log(`[MESH] OK agent=${exeInfo.bytes}B msh=${mshInfo.bytes}B sha256=${sha256File(exePath).slice(0, 16)}… → ${EXE_NAME} / ${MSH_NAME}`)
    console.log('[MESH] Do NOT commit WXQK.msh or WXQK.exe to public git.')
    console.log('[MESH] On Mesh host prefer: python3 deploy/meshcentral/provision_official_agent.py')
  } catch (err) {
    cleanupPartial(exePath)
    cleanupPartial(mshPath)
    fail(String(err && err.message || err))
  }
}

main().catch((err) => {
  cleanupPartial(path.join(OUT_DIR, EXE_NAME))
  cleanupPartial(path.join(OUT_DIR, MSH_NAME))
  fail(String(err && err.message || err))
})
