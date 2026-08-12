#!/usr/bin/env node
/**
 * Pre-package MeshCentral readiness check.
 *
 * Usage:
 *   node scripts/check-mesh.cjs           # warn if agent missing (dev OK)
 *   node scripts/check-mesh.cjs --strict  # fail if agent missing (release)
 */
'use strict'

const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const meshDir = path.join(root, 'resources', 'meshcentral')
const exePath = path.join(meshDir, 'meshagent.exe')
const mshPath = path.join(meshDir, 'meshagent.msh')
const strict = process.argv.includes('--strict') || process.env.WXQK_MESH_CHECK_STRICT === '1'

const problems = []
const warnings = []

if (!fs.existsSync(exePath)) {
  const msg = `missing ${exePath}`
  if (strict) problems.push(msg)
  else warnings.push(msg)
}
if (!fs.existsSync(mshPath)) {
  const msg = `missing ${mshPath}`
  if (strict) problems.push(msg)
  else warnings.push(msg)
} else {
  try {
    const text = fs.readFileSync(mshPath, 'utf8')
    if (!/MeshServer|ServerID|MeshID/i.test(text)) {
      problems.push('meshagent.msh does not contain MeshServer/ServerID/MeshID markers')
    }
  } catch (err) {
    problems.push(`cannot read msh: ${err.message}`)
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const extra = (pkg.build && pkg.build.extraResources) || []
const hasMeshResource = extra.some((e) => String(e.from || '').includes('meshcentral') || String(e.to || '') === 'meshcentral')
if (!hasMeshResource) {
  problems.push('package.json build.extraResources missing meshcentral mapping')
}

const deployCfg = path.join(root, '..', 'deploy', 'meshcentral', 'config.example.json')
const versionFile = path.join(root, '..', 'deploy', 'meshcentral', 'VERSION')
const composeFile = path.join(root, '..', 'deploy', 'meshcentral', 'docker-compose.yml')

if (fs.existsSync(versionFile)) {
  const verText = fs.readFileSync(versionFile, 'utf8')
  if (!/MESHCENTRAL_VERSION\s*=\s*1\.2\.4\b/.test(verText)) {
    problems.push('deploy/meshcentral/VERSION must pin MESHCENTRAL_VERSION=1.2.4')
  }
} else {
  problems.push('deploy/meshcentral/VERSION missing')
}

if (fs.existsSync(composeFile)) {
  const compose = fs.readFileSync(composeFile, 'utf8')
  if (/meshcentral:latest\b/.test(compose) || /MESHCENTRAL_VERSION:-latest/.test(compose)) {
    problems.push('docker-compose.yml must not use :latest')
  }
  if (!/1\.2\.4/.test(compose)) {
    problems.push('docker-compose.yml must pin MeshCentral 1.2.4')
  }
}

if (fs.existsSync(deployCfg)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(deployCfg, 'utf8'))
    if (cfg.settings && cfg.settings.webRTC !== false) {
      problems.push('deploy/meshcentral/config.example.json must have settings.webRTC=false')
    }
    if (cfg.settings && cfg.settings.allowLoginToken !== true) {
      problems.push('deploy/meshcentral/config.example.json must have allowLoginToken=true')
    }
  } catch (err) {
    problems.push(`cannot parse config.example.json: ${err.message}`)
  }
}

for (const w of warnings) console.warn(`[MESH] WARN ${w}`)
for (const p of problems) console.error(`[MESH] FAIL ${p}`)

if (problems.length) {
  console.error('[MESH] check:mesh failed')
  process.exit(1)
}

if (warnings.length) {
  console.log('[MESH] check:mesh OK (agent binaries missing — OK for dev; use --strict before release)')
  console.log('[MESH] fetch with: npm run fetch:mesh-agent')
} else {
  console.log('[MESH] check:mesh OK')
}
process.exit(0)
