'use strict'

/**
 * Production MeshCentral identity guard.
 * Prevents bootstrap from creating a fresh Mesh identity when production
 * markers / mapping history exist but meshcentral-data was wiped.
 *
 * Server-only. Do not ship to clients. Do not log secrets.
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const MANIFEST_NAME = 'wxqk-mesh-production-identity.json'
const MARKER_NAME = '.wxqk-production-mesh'

const MESH_IDENTITY_FILES = [
  'agentserver-cert-public.crt',
  'agentserver-cert-private.key',
  'server-cert-public.crt',
  'server-cert-private.key',
  'meshcentral.db',
  'meshcentral.db.bak',
]

/**
 * @param {string} deployDir deploy/meshcentral
 */
function resolveManifestPath(deployDir) {
  return path.join(deployDir, 'data', MANIFEST_NAME)
}

/**
 * @param {string} deployDir
 */
function resolveMarkerPath(deployDir) {
  return path.join(deployDir, MARKER_NAME)
}

/**
 * @param {string} value
 */
function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16)
}

/**
 * @param {string} deployDir
 * @param {{
 *   serverId?: string,
 *   meshId?: string,
 *   agentEndpoint?: string,
 *   agentPort?: number|string,
 * }} identity
 */
function writeProductionIdentityManifest(deployDir, identity) {
  const dataDir = path.join(deployDir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  const row = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    serverIdFingerprint: identity.serverId ? fingerprint(identity.serverId) : '',
    meshIdFingerprint: identity.meshId ? fingerprint(identity.meshId) : '',
    agentEndpoint: String(identity.agentEndpoint || ''),
    agentPort: Number(identity.agentPort) || 0,
  }
  fs.writeFileSync(resolveManifestPath(deployDir), JSON.stringify(row, null, 2), 'utf8')
  fs.writeFileSync(resolveMarkerPath(deployDir), row.updatedAt, 'utf8')
  return row
}

/**
 * @param {string} dataDir
 * @param {{ existsSync?: typeof fs.existsSync, readdirSync?: typeof fs.readdirSync }} deps
 */
function meshcentralDataHasIdentity(dataDir, deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync
  const readdirSync = deps.readdirSync || fs.readdirSync
  for (const name of MESH_IDENTITY_FILES) {
    if (existsSync(path.join(dataDir, name))) return true
  }
  if (!existsSync(dataDir)) return false
  try {
    for (const name of readdirSync(dataDir)) {
      if (String(name).startsWith('.')) continue
      if (name === MANIFEST_NAME) continue
      const lower = String(name).toLowerCase()
      if (lower.endsWith('.crt') || lower.endsWith('.key') || lower.endsWith('.db') || lower.endsWith('.bak')) {
        return true
      }
    }
  } catch {
    return false
  }
  return false
}

/**
 * Fail closed when production was previously initialized but data dir is empty.
 * @param {string} deployDir
 * @param {{
 *   existsSync?: typeof fs.existsSync,
 *   readdirSync?: typeof fs.readdirSync,
 *   hasWxqkMappingDb?: boolean,
 *   hasProductionNodesHistory?: boolean,
 *   hasBackupArchive?: boolean,
 * }} [deps]
 */
function assertProductionIdentitySafeToBootstrap(deployDir, deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync
  const readdirSync = deps.readdirSync || fs.readdirSync
  const marker = resolveMarkerPath(deployDir)
  const manifest = resolveManifestPath(deployDir)
  const dataDir = path.join(deployDir, 'data')
  const hadProduction = existsSync(marker) || existsSync(manifest)
    || Boolean(deps.hasWxqkMappingDb)
    || Boolean(deps.hasProductionNodesHistory)
    || Boolean(deps.hasBackupArchive)

  const hasIdentity = meshcentralDataHasIdentity(dataDir, { existsSync, readdirSync })

  if (hadProduction && !hasIdentity) {
    return {
      ok: false,
      code: 'MESH_PRODUCTION_IDENTITY_MISSING',
      message: 'Production MeshCentral identity evidence present but meshcentral-data identity files are missing. Restore backup; do not bootstrap a new ServerID/MeshID.',
    }
  }
  return { ok: true, code: 'OK' }
}

module.exports = {
  MANIFEST_NAME,
  MARKER_NAME,
  MESH_IDENTITY_FILES,
  resolveManifestPath,
  resolveMarkerPath,
  fingerprint,
  writeProductionIdentityManifest,
  meshcentralDataHasIdentity,
  assertProductionIdentitySafeToBootstrap,
}
