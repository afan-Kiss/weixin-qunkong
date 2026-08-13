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
const EXE_NAME = 'WXQK.exe'
const MSH_NAME = 'WXQK.msh'
const exePath = path.join(meshDir, EXE_NAME)
const mshPath = path.join(meshDir, MSH_NAME)
const strict = process.argv.includes('--strict') || process.env.WXQK_MESH_CHECK_STRICT === '1'

const problems = []
const warnings = []

if (!fs.existsSync(exePath)) {
  const msg = `missing ${exePath}`
  if (strict) problems.push(msg)
  else warnings.push(msg)
} else {
  try {
    const size = fs.statSync(exePath).size
    if (size < 1024) {
      problems.push(`${EXE_NAME} too small (${size} bytes) — refuse packaging a broken agent`)
    } else {
      try {
        const {
          writePackagedArtifactMeta,
          assertPackagedArtifactMetaMatchesExe,
          sha256FileSync,
        } = require('../electron/mesh-agent-artifact.cjs')
        // Always regenerate meta from the real EXE before packaging.
        const meta = writePackagedArtifactMeta(meshDir, exePath)
        const check = assertPackagedArtifactMetaMatchesExe(meshDir, exePath, { strict: true })
        if (!check.ok) {
          problems.push(`${check.code}: ${check.message}`)
        } else {
          const actual = sha256FileSync(exePath)
          if (String(meta.sha256).toLowerCase() !== actual.toLowerCase()) {
            problems.push('MESH_AGENT_ARTIFACT_META_MISMATCH: regenerated meta still mismatches exe')
          }
          console.log(`[MESH] agent-artifact.json sha256=${String(meta.sha256).slice(0, 16)}… size=${meta.size}`)
        }
      } catch (err) {
        if (strict) problems.push(`agent-artifact.json failed: ${err.message}`)
        else warnings.push(`agent-artifact.json not written: ${err.message}`)
      }
    }
  } catch (err) {
    problems.push(`cannot stat ${EXE_NAME}: ${err.message}`)
  }
}

if (!fs.existsSync(mshPath)) {
  const msg = `missing ${mshPath}`
  if (strict) problems.push(msg)
  else warnings.push(msg)
} else {
  try {
    const size = fs.statSync(mshPath).size
    if (size < 16) {
      problems.push(`${MSH_NAME} too small (${size} bytes)`)
    }
    const text = fs.readFileSync(mshPath, 'utf8')
    if (!/MeshServer|ServerID|MeshID/i.test(text)) {
      problems.push(`${MSH_NAME} does not contain MeshServer/ServerID/MeshID markers`)
    }
  } catch (err) {
    problems.push(`cannot read msh: ${err.message}`)
  }
}

// Legacy filenames must not be the only packaged agent (strict release gate)
const legacyExe = path.join(meshDir, 'meshagent.exe')
if (fs.existsSync(legacyExe) && !fs.existsSync(exePath)) {
  const msg = `found legacy meshagent.exe but missing branded ${EXE_NAME}`
  if (strict) problems.push(msg)
  else warnings.push(msg)
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
    const custom = cfg.domains && cfg.domains[''] && cfg.domains[''].agentCustomization
    if (!custom || custom.fileName !== 'WXQK' || custom.serviceName !== 'WXQK' || custom.companyName !== 'WXQK') {
      problems.push('config.example.json must set domains."".agentCustomization fileName/serviceName/companyName=WXQK')
    }
    if (custom && /remote/i.test(JSON.stringify(custom))) {
      problems.push('agentCustomization must not contain Remote')
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
