#!/usr/bin/env node
'use strict'

/**
 * Secret scan gate — fail if known compromised publish seeds / private PEMs enter tracked files.
 * Usage: node scripts/secret-scan.cjs
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
// Compromised seed marker split so this scanner file itself does not trip the gate.
const COMPROMISED_SEED = ['TIwR8GPTQsAO49IXWjfXok0xHouo', 'HGFbkTsi5B4Pf9A='].join('')
const FORBIDDEN_PATTERNS = [
  { re: /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/, name: 'private_pem' },
  { re: /FACAI888_PUBLISH_KEY_B64\s*=\s*[A-Za-z0-9+/=]{40,}/, name: 'publish_seed_env' },
  { re: /WXQK_PUBLISH_KEY_B64\s*=\s*[A-Za-z0-9+/=]{40,}/, name: 'publish_seed_env' },
  { re: /WXQK_MESH_LOGIN_KEY\s*=\s*[0-9a-fA-F]{32,}/, name: 'mesh_login_key' },
  { re: /WXQK_SSH_PASSWORD\s*=\s*(?!\s*$)(?!#)(\S+)/, name: 'ssh_password' },
]

const SCAN_DIRS = [
  path.join(ROOT, 'admin-ui'),
  path.join(ROOT, 'server'),
  path.join(ROOT, 'deploy'),
]

const SKIP_DIR_NAMES = new Set([
  'node_modules', '.git', 'dist', 'release-v19', 'win-unpacked', '__pycache__', '.venv',
  'fixtures', '.local-secrets',
])

const SKIP_FILE_GLOBS = [
  /secret-scan\.cjs$/i,
  /[/\\]test[/\\]/i,
  /[/\\]scripts[/\\]fetch-wxqk-/i,
  /\.example$/i,
  /\.env\.example$/i,
]

const ALLOW_EXT = new Set([
  '.cjs', '.js', '.mjs', '.ts', '.tsx', '.py', '.ps1', '.sh', '.md', '.json', '.yml', '.yaml',
  '.env', '.example', '.txt', '.service', '.conf',
])

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIR_NAMES.has(name)) continue
    const full = path.join(dir, name)
    let st
    try { st = fs.statSync(full) } catch { continue }
    if (st.isDirectory()) walk(full, out)
    else if (st.isFile()) {
      const ext = path.extname(name).toLowerCase()
      if (ALLOW_EXT.has(ext) || name.endsWith('.env.example') || name === 'UNIT' || name.includes('deploy')) {
        out.push(full)
      }
    }
  }
  return out
}

function shouldSkip(rel) {
  const norm = rel.replace(/\\/g, '/')
  return SKIP_FILE_GLOBS.some((re) => re.test(norm))
}

function main() {
  const hits = []
  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/')
      if (shouldSkip(rel)) continue
      let text = ''
      try { text = fs.readFileSync(file, 'utf8') } catch { continue }
      if (text.includes(COMPROMISED_SEED)) hits.push({ file: rel, reason: 'compromised_publish_seed' })
      for (const { re, name } of FORBIDDEN_PATTERNS) {
        if (re.test(text)) hits.push({ file: rel, reason: name })
      }
    }
  }
  if (hits.length) {
    console.error('SECRET_SCAN_GATE=FAIL')
    for (const h of hits.slice(0, 50)) console.error(`- ${h.file}: ${h.reason}`)
    process.exit(1)
  }
  console.log('SECRET_SCAN_GATE=PASS')
}

main()
