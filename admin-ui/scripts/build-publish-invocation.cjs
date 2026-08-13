'use strict'

/**
 * Build child publish args WITHOUT embedding publish password.
 * Used by unit tests for PUBLISH_SECRET_HANDLING_GATE.
 */

function buildPublishChildArgs({
  baseUrl,
  exePath,
  concurrency = 4,
  preferredChunkMB = 4,
  mandatory = false,
  insecureTls = false,
  targetClientIds = [],
  scriptPath = '_publish-release-once.ps1',
} = {}) {
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-BaseUrl',
    String(baseUrl || ''),
    '-ExePath',
    String(exePath || ''),
    '-Concurrency',
    String(concurrency),
    '-PreferredChunkMB',
    String(preferredChunkMB),
  ]
  if (mandatory) args.push('-Mandatory')
  if (insecureTls) args.push('-InsecureTls')
  if (Array.isArray(targetClientIds) && targetClientIds.length) {
    args.push('-TargetClientIds')
    for (const id of targetClientIds) args.push(String(id))
  }
  return args
}

function assertNoSecretInArgs(args, secret) {
  const joined = (Array.isArray(args) ? args : []).join('\0')
  if (secret && joined.includes(String(secret))) {
    return { ok: false, reason: 'secret_in_args' }
  }
  if (joined.includes('-Password')) {
    return { ok: false, reason: 'password_flag_present' }
  }
  return { ok: true }
}

module.exports = {
  buildPublishChildArgs,
  assertNoSecretInArgs,
}
