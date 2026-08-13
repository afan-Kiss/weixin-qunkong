/**
 * Update policy resolution from signed/unsigned manifest control fields.
 * Targeted lists alone must not escalate to mandatory.
 */

const POLICY = Object.freeze({
  OPTIONAL: 'OPTIONAL',
  MANDATORY: 'MANDATORY',
  REMOTE_TARGETED_OPTIONAL: 'REMOTE_TARGETED_OPTIONAL',
  REMOTE_TARGETED_MANDATORY: 'REMOTE_TARGETED_MANDATORY',
  SECURITY_EMERGENCY: 'SECURITY_EMERGENCY',
})

/**
 * @param {unknown} ids
 * @returns {string[]}
 */
function normalizeTargetClientIds(ids) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  out.sort()
  return out
}

/**
 * @param {Record<string, unknown> | null | undefined} manifest
 * @returns {typeof POLICY[keyof typeof POLICY]}
 */
function resolveUpdatePolicy(manifest) {
  const man = manifest && typeof manifest === 'object' ? manifest : {}
  if (Boolean(man.securityEmergency)) return POLICY.SECURITY_EMERGENCY
  const targets = normalizeTargetClientIds(man.targetClientIds)
  const mandatory = Boolean(man.mandatory)
  if (targets.length) {
    return mandatory ? POLICY.REMOTE_TARGETED_MANDATORY : POLICY.REMOTE_TARGETED_OPTIONAL
  }
  return mandatory ? POLICY.MANDATORY : POLICY.OPTIONAL
}

/**
 * Whether UI / apply path should treat the update as forced (no fake「稍后」).
 * @param {string} policy
 * @returns {boolean}
 */
function isForcedPolicy(policy) {
  const p = String(policy || '')
  return p === POLICY.MANDATORY
    || p === POLICY.REMOTE_TARGETED_MANDATORY
    || p === POLICY.SECURITY_EMERGENCY
}

module.exports = {
  POLICY,
  normalizeTargetClientIds,
  resolveUpdatePolicy,
  isForcedPolicy,
}
