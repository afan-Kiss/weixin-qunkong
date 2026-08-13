'use strict'

/**
 * Packaged vs installed WXQK.exe artifact fingerprint (sha256).
 * Metadata is diagnostic only — runtime truth is always the real EXE hash.
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

/** @type {Map<string, { mtimeMs: number, size: number, sha256: string }>} */
const shaCache = new Map()

/**
 * @param {string} filePath
 * @param {{ fs?: typeof fs }} [deps]
 */
function sha256FileSync(filePath, deps = {}) {
  const fsApi = deps.fs || fs
  const st = fsApi.statSync(filePath)
  const cached = shaCache.get(filePath)
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size && cached.sha256) {
    return cached.sha256
  }
  const hash = crypto.createHash('sha256')
  const buf = fsApi.readFileSync(filePath)
  hash.update(buf)
  const sha256 = hash.digest('hex')
  shaCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, sha256 })
  return sha256
}

/**
 * @param {string} filePath
 * @param {{ fs?: typeof fs }} [deps]
 */
async function sha256File(filePath, deps = {}) {
  return sha256FileSync(filePath, deps)
}

/**
 * Write agent-artifact.json next to packaged exe (no secrets).
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
 * Verify meta matches real exe. Throws / returns mismatch for strict packaging.
 * @param {string} meshDir
 * @param {string} exePath
 * @param {{ fs?: typeof fs, strict?: boolean }} [deps]
 */
function assertPackagedArtifactMetaMatchesExe(meshDir, exePath, deps = {}) {
  const fsApi = deps.fs || fs
  const metaPath = path.join(meshDir, 'agent-artifact.json')
  if (!fsApi.existsSync(exePath)) {
    return { ok: false, code: 'MESH_AGENT_EXE_MISSING', message: 'WXQK.exe missing' }
  }
  const actual = sha256FileSync(exePath, { fs: fsApi }).toLowerCase()
  if (!fsApi.existsSync(metaPath)) {
    if (deps.strict) {
      return { ok: false, code: 'MESH_AGENT_ARTIFACT_META_MISSING', message: 'agent-artifact.json missing' }
    }
    return { ok: true, code: 'META_MISSING_OK', actualSha: actual }
  }
  let meta
  try {
    meta = JSON.parse(fsApi.readFileSync(metaPath, 'utf8'))
  } catch {
    return { ok: false, code: 'MESH_AGENT_ARTIFACT_META_CORRUPT', message: 'agent-artifact.json unreadable' }
  }
  const expected = String(meta?.sha256 || '').toLowerCase()
  if (!expected) {
    return { ok: false, code: 'MESH_AGENT_ARTIFACT_META_CORRUPT', message: 'agent-artifact.json missing sha256' }
  }
  if (expected !== actual) {
    return {
      ok: false,
      code: 'MESH_AGENT_ARTIFACT_META_MISMATCH',
      message: 'agent-artifact.json sha256 does not match real WXQK.exe',
      expectedSha: expected,
      actualSha: actual,
    }
  }
  return { ok: true, code: 'OK', actualSha: actual, expectedSha: expected, size: Number(meta.size) || 0 }
}

/**
 * Runtime fingerprint: ALWAYS hash the real packaged EXE.
 * Meta is only used for diagnostics / mismatch detection.
 * @param {string} meshDir
 * @param {string} exePath
 * @param {{ fs?: typeof fs }} [deps]
 */
function readPackagedArtifactFingerprint(meshDir, exePath, deps = {}) {
  const fsApi = deps.fs || fs
  if (!fsApi.existsSync(exePath)) {
    return { sha256: '', source: 'missing', size: 0, metaMismatch: false }
  }
  const actual = sha256FileSync(exePath, { fs: fsApi })
  const st = fsApi.statSync(exePath)
  const metaPath = path.join(meshDir, 'agent-artifact.json')
  let metaMismatch = false
  let metaSha = ''
  if (fsApi.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fsApi.readFileSync(metaPath, 'utf8'))
      metaSha = String(meta?.sha256 || '').toLowerCase()
      if (metaSha && metaSha !== actual.toLowerCase()) metaMismatch = true
    } catch {
      metaMismatch = true
    }
  }
  return {
    sha256: actual.toLowerCase(),
    source: 'computed',
    size: st.size,
    metaSha,
    metaMismatch,
  }
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
    sha256: sha256FileSync(installedExePath, { fs: fsApi }).toLowerCase(),
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
  return p !== i
}

function clearShaCacheForTest() {
  shaCache.clear()
}

module.exports = {
  sha256File,
  sha256FileSync,
  writePackagedArtifactMeta,
  assertPackagedArtifactMetaMatchesExe,
  readPackagedArtifactFingerprint,
  readInstalledArtifactFingerprint,
  isArtifactOutdated,
  clearShaCacheForTest,
}
