/**
 * 群聊加好友：按接口能力逐级解析/补齐 V3/V4。
 * 成功路径（本机已跑通）：群成员拿新鲜 V4 + update_single_profile 拿 V3，执行前即时组装。
 * 消息里的 senderV3 不可信，绝不用来跳过补凭证。
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function validV3(value) {
  return /^v3_/i.test(String(value || '')) ? String(value) : ''
}

function validV4(value) {
  return /^v4_/i.test(String(value || '')) ? String(value) : ''
}

/**
 * @param {{
 *   targetWxid: string,
 *   sourceRoomId: string,
 *   fetchProfile: (endpoint: string, body: Record<string, string>, sourceId: number, attempt: number) => Promise<{ parsed: { v3?: string, v4?: string } }>,
 *   delays?: number[],
 *   profileRetries?: number,
 *   v4RetryDelays?: number[],
 * }} input
 */
async function resolveFriendProfileCredentials(input = {}) {
  const targetWxid = String(input.targetWxid || '')
  const sourceRoomId = String(input.sourceRoomId || '')
  const fetchProfile = input.fetchProfile
  const delays = Array.isArray(input.delays) && input.delays.length ? input.delays : [0, 400, 1000]
  const profileRetries = Math.max(Number(input.profileRetries) || 3, 1)
  const v4RetryDelays = Array.isArray(input.v4RetryDelays) && input.v4RetryDelays.length
    ? input.v4RetryDelays
    : [1500, 3000]
  if (typeof fetchProfile !== 'function') {
    return { ok: false, v3: '', v4: '', missing: ['fetch'], credentialSource: '', reason: '缺少资料拉取函数' }
  }

  let v3 = ''
  let v4 = ''
  let credentialSource = ''
  let attempt = 0

  const pullGroupMember = async (body) => {
    attempt += 1
    return fetchProfile('/api/get_group_member_contact', body, 438557510, attempt)
  }

  // 群成员接口：优先拿新鲜 V4（票会轮换，必须执行前现取）
  for (let index = 0; index < delays.length; index += 1) {
    if (delays[index]) await sleep(delays[index])
    const group = await pullGroupMember({ wxid: targetWxid, roomId: sourceRoomId })
    v3 = validV3(group?.parsed?.v3) || v3
    v4 = validV4(group?.parsed?.v4) || v4
    if (v3 && v4) {
      credentialSource = 'GROUP_MEMBER_CONTACT'
      break
    }
    if (v4) break
  }

  if ((!v3 || !v4)) {
    attempt += 1
    const contact = await fetchProfile('/api/get_contact', { wxid: targetWxid }, 438557509, attempt)
    v3 = validV3(contact?.parsed?.v3) || v3
    v4 = validV4(contact?.parsed?.v4) || v4
    if (v3 && v4 && !credentialSource) credentialSource = 'CONTACT'
  }

  // 群接口常仅有 V4；资料接口补 V3（可重试，避免偶发空 encryptUserName）
  if (!v3) {
    for (let round = 1; round <= profileRetries; round += 1) {
      if (round > 1) await sleep(round === 2 ? 500 : 1000)
      attempt += 1
      const profile = await fetchProfile('/api/update_single_profile', { wxid: targetWxid }, 438557572, attempt)
      const profileV3 = validV3(profile?.parsed?.v3)
      const profileV4 = validV4(profile?.parsed?.v4)
      if (profileV3) {
        v3 = profileV3
        v4 = v4 || profileV4
        if (!credentialSource) credentialSource = v4 ? 'GROUP_MEMBER_CONTACT+UPDATE_SINGLE_PROFILE' : 'UPDATE_SINGLE_PROFILE'
        else if (credentialSource === 'GROUP_MEMBER_CONTACT') credentialSource = 'GROUP_MEMBER_CONTACT+UPDATE_SINGLE_PROFILE'
        else if (!credentialSource.includes('UPDATE_SINGLE_PROFILE')) credentialSource = `${credentialSource}+UPDATE_SINGLE_PROFILE`
        break
      }
    }
  }

  // 仍缺 V4：加长间隔再拉群成员（含 room_id 兼容字段），覆盖偶发空票
  if (!v4 && sourceRoomId.endsWith('@chatroom')) {
    const bodies = [
      { wxid: targetWxid, roomId: sourceRoomId },
      { wxid: targetWxid, room_id: sourceRoomId },
      { userName: targetWxid, roomId: sourceRoomId },
    ]
    for (let index = 0; index < v4RetryDelays.length; index += 1) {
      await sleep(v4RetryDelays[index])
      const body = bodies[index % bodies.length]
      const group = await pullGroupMember(body)
      v4 = validV4(group?.parsed?.v4) || v4
      v3 = validV3(group?.parsed?.v3) || v3
      if (v4) {
        if (!credentialSource) credentialSource = 'GROUP_MEMBER_CONTACT_RETRY'
        else if (!credentialSource.includes('GROUP_MEMBER')) credentialSource = `${credentialSource}+GROUP_MEMBER_CONTACT_RETRY`
        break
      }
    }
  }

  const missing = [v3 ? '' : 'v3', v4 ? '' : 'v4'].filter(Boolean)
  return {
    ok: !missing.length,
    v3,
    v4,
    missing,
    credentialSource,
    mixedPairUnverified: false,
    reason: missing.length ? `凭证解析失败：缺少 ${missing.join('、')}` : '',
  }
}

module.exports = { resolveFriendProfileCredentials, validV3, validV4 }
