'use strict'

/**
 * Print canonical production service BaseUrl (not a secret).
 * Used by publish-release.ps1 when -BaseUrl is omitted.
 */
const { getServiceBase } = require('../electron/secure-config.cjs')

function main() {
  const base = String(getServiceBase() || '').trim().replace(/\/+$/, '')
  if (!base || !/^https:\/\//i.test(base)) {
    console.error('Failed to resolve production BaseUrl from secure-config')
    process.exit(1)
  }
  process.stdout.write(`${base}\n`)
}

main()
