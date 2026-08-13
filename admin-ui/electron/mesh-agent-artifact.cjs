'use strict'

/**
 * Packaged vs installed WXQK.exe artifact fingerprint (sha256).
 * Do NOT hash installed .msh wholesale (agentName is per-client).
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

/**
 * @param {string} filePath
 * @param {{ fs?: typeof fs }} [deps]
 */
function sha256FileSync(filePath, deps = {}) {
  const fsApi = deps.fs || fs
  const hash = crypto.createHash('sha256')
  const buf = fsApi.readFileSync(filePath)
  hash.update(buf)
  return hash.digest('hex')
}

/**
 * @param {string} filePath
 * @param {{ fs?: typeof fs }} [deps]
 */
async function sha256File(filePath, deps = {}) {
  return sha256FileSync(filePath, deps)
}

/**
 * Write/read optional agent-artifact.json next to packaged exe (no secrets).
 * @param {string} meshDir resources/meshcentral
 * @param {string} exePath
 */
function writePackagedArtifactMeta(meshDir, exePath) {
  const metaPath = path.join(meshDir, 'agent-artifact.json')
  const sha256 = sha256FileSync(exePath)
  const st = fs.statSync(exePath)
  const meta = {
    sha256,
    size: st.size,
    fileDescription: 'WXQK',
    originalFilename: 'WXQK.exe',
    generatedAt: new Date().toISOString(),
  }
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8')
  return meta
}

/**
 * @param {string} meshDir
 * @param {string} exePath
 * @param {{ fs?: typeof fs }} [deps]
 */
function readPackagedArtifactFingerprint(meshDir, exePath, deps = {}) {
  const fsApi = deps.fs || fs
  const metaPath = path.join(meshDir, 'agent-artifact.json')
  if (fsApi.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fsApi.readFileSync(metaPath, 'utf8'))
      if (meta && meta.sha256) {
        return { sha256: String(meta.sha256).toLowerCase(), source: 'meta', size: Number(meta.size) || 0 }
      }
    } catch { /* fall through */ }
  }
  if (!fsApi.existsSync(exePath)) {
    return { sha256: '', source: 'missing', size: 0 }
  }
  // Tiny test doubles: hash content
  const sha256 = sha256FileSync(exePath, { fs: fsApi })
  return { sha256, source: 'computed', size: fsApi.statSync(exePath).size }
}

/**
 * @param {string} installedExePath
 * @param {{ fs?: typeof fs }} [deps]
 */
function readInstalledArtifactFingerprint(installedExePath, deps = {}) {
  const fsApi = deps.fs || fs
  if (!fsApi.existsSync(installedExePath)) {
    return { sha256: '', source: 'missing', size: 0 }
  }
  return {
    sha256: sha256FileSync(installedExePath, { fs: fsApi }),
    source: 'computed',
    size: fsApi.statSync(installedExePath).size,
  }
}

/**
 * @param {{ sha256?: string }} packaged
 * @param {{ sha256?: string }} installed
 */
function isArtifactOutdated(packaged, installed) {
  const p = String(packaged?.sha256 || '').toLowerCase()
  const i = String(installed?.sha256 || '').toLowerCase()
  if (!p || !i) return false
  // Ignore tiny fake 'fake' test doubles that match each other
  return p !== i
}

module.exports = {
  sha256File,
  sha256FileSync,
  writePackagedArtifactMeta,
  readPackagedArtifactFingerprint,
  readInstalledArtifactFingerprint,
  isArtifactOutdated,
}
