const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  parseInvitePreview,
  parseInvitePageText,
  mergeInvitePreview,
  buildInvitePageRequest,
  hasUsableInvitePreview,
  evaluateEnterRoomResult,
  formatInvitePreviewLine,
  findRoomId,
  findAlreadyJoinedRoom,
  isJoinApplicationRequired,
  isJoinApplicationPending,
} = require('../electron/qr-join.cjs')

test('parseInvitePreview extracts room name and member count', () => {
  const preview = parseInvitePreview({
    errCode: 1,
    data: {
      topic: '测试客户群',
      memberCount: 128,
      chatroomUserName: '44079057335@chatroom',
      fullUrl: 'https://support.weixin.qq.com/cgi-bin/mmsupport-bin/addchatroombyinvite?ticket=abc',
    },
  }, 'https://weixin.qq.com/g/short')
  assert.equal(preview.roomName, '测试客户群')
  assert.equal(preview.memberCount, 128)
  assert.equal(preview.roomId, '44079057335@chatroom')
  assert.match(preview.fullUrl, /addchatroombyinvite/)
  assert.equal(preview.expired, false)
  assert.match(formatInvitePreviewLine(preview), /测试客户群/)
  assert.match(formatInvitePreviewLine(preview), /128 人/)
  assert.doesNotMatch(formatInvitePreviewLine(preview), /@chatroom/)
  assert.doesNotMatch(formatInvitePreviewLine(preview), /44079057335/)
})

test('a8key without topic still exposes FullURL/headers for invite page fetch', () => {
  const raw = {
    errCode: 1,
    data: {
      FullURL: 'https://support.weixin.qq.com/cgi-bin/mmsupport-bin/addchatroombyinvite?ticket=xyz',
      HttpHeader: [
        { Key: 'Cookie', Value: 'wxuin=1; wxtokenkey=789' },
        { Key: 'Referer', Value: 'https://weixin.qq.com/' },
      ],
    },
  }
  const preview = parseInvitePreview(raw, 'https://weixin.qq.com/g/AQYAA-short')
  assert.equal(preview.roomName, '')
  assert.equal(preview.memberCount, 0)
  assert.match(preview.fullUrl, /addchatroombyinvite/)
  const pageReq = buildInvitePageRequest(raw, 'https://weixin.qq.com/g/AQYAA-short')
  assert.match(pageReq.url, /addchatroombyinvite/)
  assert.equal(pageReq.headers.Cookie, 'wxuin=1; wxtokenkey=789')
  assert.match(pageReq.headers['User-Agent'], /WindowsWechat/)
  assert.equal(hasUsableInvitePreview(preview), false)

  const pageHtml = `
    <html><title>邀请你加入群聊</title>
    <body>
      <strong>祥钰珠宝手镯沟通大群</strong>
      <p>326人已加入</p>
      <script>var info={"nickname":"祥钰珠宝手镯沟通大群","memberCount":326,"userName":"50442591080@chatroom"}</script>
    </body></html>
  `
  const fromPage = parseInvitePreview(pageHtml, pageReq.url)
  const merged = mergeInvitePreview(preview, fromPage)
  assert.equal(merged.roomName, '祥钰珠宝手镯沟通大群')
  assert.equal(merged.memberCount, 326)
  assert.equal(merged.roomId, '50442591080@chatroom')
  assert.equal(hasUsableInvitePreview(merged), true)
})

test('extractA8KeyHttpHeaders unwraps protobuf String Key/Value', () => {
  const { extractA8KeyHttpHeaders, a8keyResponseUseful } = require('../electron/qr-join.cjs')
  const raw = {
    data: {
      FullURL: { String: 'https://support.weixin.qq.com/cgi-bin/mmsupport-bin/addchatroombyinvite?ticket=abc' },
      HttpHeader: [
        { Key: { String: 'Cookie' }, Value: { String: 'wxuin=9; wxtokenkey=abc' } },
        { Key: { String: 'Referer' }, Value: { String: 'https://weixin.qq.com/' } },
      ],
    },
  }
  const headers = extractA8KeyHttpHeaders(raw)
  assert.equal(headers.Cookie, 'wxuin=9; wxtokenkey=abc')
  assert.equal(headers.Referer, 'https://weixin.qq.com/')
  assert.equal(a8keyResponseUseful(raw), true)

  const mapped = extractA8KeyHttpHeaders({ data: { HttpHeader: { Cookie: 'a=1; b=2', Host: 'support.weixin.qq.com' } } })
  assert.equal(mapped.Cookie, 'a=1; b=2')
  assert.equal(mapped.Host, 'support.weixin.qq.com')
})

test('parseInvitePageText reads common invite page copy', () => {
  const parsed = parseInvitePageText('邀请你加入群聊\n客户VIP群\n88人已加入')
  assert.equal(parsed.roomName, '客户VIP群')
  assert.equal(parsed.memberCount, 88)
  assert.equal(parsed.needApply, false)
})

test('invite pages that require application reason are detected', () => {
  const page = parseInvitePageText('群主已启用「群聊邀请确认」，请填写进群申请理由后再加入')
  assert.equal(page.needApply, true)
  assert.equal(isJoinApplicationRequired('请填写进群申请理由'), true)
  assert.equal(isJoinApplicationRequired('普通邀请文案无申请要求'), false)
  const preview = parseInvitePreview('邀请你加入群聊\n请填写进群申请理由\n等待群主确认', 'https://weixin.qq.com/g/x')
  assert.equal(preview.needApply, true)
  const pending = evaluateEnterRoomResult(true, { errCode: 1, data: {}, errMsg: '已提交申请，等待群主确认' })
  assert.equal(pending.pendingApply, true)
  assert.equal(pending.hardFail, false)
  assert.match(pending.reason, /等待群主确认/)
  assert.equal(isJoinApplicationPending({ msg: '申请已提交' }), true)
})

test('evaluateEnterRoomResult rejects empty errCode=1 success', () => {
  const empty = evaluateEnterRoomResult(true, { account_wxid: 'wxid_x', data: {}, errCode: 1, errMsg: '请求处理成功' })
  assert.equal(empty.ok, false)
  assert.equal(empty.hardFail, false)
  assert.match(empty.reason, /待群列表确认|空结果/)

  // 响应里带 roomId 也不能直接算成功（假成功根因）
  const withRoom = evaluateEnterRoomResult(true, { errCode: 1, data: { roomId: '12345@chatroom', topic: '已加入' } })
  assert.equal(withRoom.ok, false)
  assert.equal(withRoom.hardFail, false)
  assert.equal(withRoom.roomId, '12345@chatroom')
  assert.match(withRoom.reason, /待群列表确认/)

  const expired = evaluateEnterRoomResult(true, { errMsg: '二维码已过期', data: {} })
  assert.equal(expired.ok, false)
  assert.equal(expired.hardFail, true)
  assert.match(expired.reason, /过期|无效/)

  const neg = evaluateEnterRoomResult(true, { errCode: -2, data: { roomId: '999@chatroom' } })
  assert.equal(neg.hardFail, true)
  assert.match(neg.reason, /错误码/)
})

test('findAlreadyJoinedRoom matches by roomId or exact room name', () => {
  const rooms = [
    { roomId: '111@chatroom', name: '蓝天合击' },
    { roomId: '222@chatroom', name: '暗影之怒无充值交流' },
  ]
  const byId = findAlreadyJoinedRoom(rooms, { roomId: '111@chatroom', roomName: '' })
  assert.equal(byId?.roomId, '111@chatroom')
  assert.match(byId?.reason || '', /已在该群中/)

  const byName = findAlreadyJoinedRoom(rooms, { roomId: '', roomName: '暗影之怒无充值交流' })
  assert.equal(byName?.roomId, '222@chatroom')
  assert.match(byName?.reason || '', /按群名确认/)

  assert.equal(findAlreadyJoinedRoom(rooms, { roomId: '', roomName: '不存在的群' }), null)
  assert.equal(findAlreadyJoinedRoom(rooms, { roomId: '', roomName: '暗影' }), null)
})

test('confirmJoinedFromRoomList only accepts target room newly appearing', () => {
  const { confirmJoinedFromRoomList } = require('../electron/qr-join.cjs')
  const before = new Set(['111@chatroom'])
  const joined = confirmJoinedFromRoomList(before, new Set(['111@chatroom', '222@chatroom']), '222@chatroom')
  assert.equal(joined.status, 'JOINED')
  assert.equal(joined.roomId, '222@chatroom')

  // 任意无关新群不能顶替目标群
  const wrongNew = confirmJoinedFromRoomList(before, new Set(['111@chatroom', '333@chatroom']), '222@chatroom')
  assert.equal(wrongNew.status, 'NOT_YET')

  const already = confirmJoinedFromRoomList(new Set(['222@chatroom']), new Set(['222@chatroom']), '222@chatroom')
  assert.equal(already.status, 'ALREADY_IN')

  // 短链无群标识：恰好新增 1 个群 → 可确认
  const shortOk = confirmJoinedFromRoomList(before, new Set(['111@chatroom', '444@chatroom']), '')
  assert.equal(shortOk.status, 'JOINED')
  assert.equal(shortOk.roomId, '444@chatroom')

  // 短链无群标识：新增多群 → 轮询中继续等待（终态由 verifyJoinedRoom finalize 判 MISSING_TARGET）
  const shortAmbiguous = confirmJoinedFromRoomList(before, new Set(['111@chatroom', '333@chatroom', '444@chatroom']), '')
  assert.equal(shortAmbiguous.status, 'NOT_YET')

  // 短链无群标识：新增多群但群名唯一命中 → 可确认
  const byName = confirmJoinedFromRoomList(
    before,
    new Set(['111@chatroom', '333@chatroom', '444@chatroom']),
    '',
    {
      expectedRoomName: '目标测试群',
      roomNameById: new Map([
        ['333@chatroom', '其他群'],
        ['444@chatroom', '目标测试群'],
      ]),
    },
  )
  assert.equal(byName.status, 'JOINED')
  assert.equal(byName.roomId, '444@chatroom')

  // 短名不得靠「期望名包含短名」误命中
  const shortNameTrap = confirmJoinedFromRoomList(
    before,
    new Set(['111@chatroom', '333@chatroom', '444@chatroom']),
    '',
    {
      expectedRoomName: '创创网络15·交流群',
      roomNameById: new Map([
        ['333@chatroom', '创创'],
        ['444@chatroom', '别的群'],
      ]),
    },
  )
  assert.equal(shortNameTrap.status, 'NOT_YET')

  const shortPending = confirmJoinedFromRoomList(before, new Set(['111@chatroom']), '')
  assert.equal(shortPending.status, 'NOT_YET')
})

test('invite URL helpers detect short/expanded links and roomId in query', () => {
  const {
    isExpandedInviteUrl,
    isShortGroupInviteUrl,
    findRoomIdInUrl,
    scoreInvitePreviewCandidate,
    hasReliableJoinTarget,
  } = require('../electron/qr-join.cjs')
  assert.equal(isShortGroupInviteUrl('https://weixin.qq.com/g/AQYAA-short'), true)
  assert.equal(isExpandedInviteUrl('https://weixin.qq.com/g/AQYAA-short'), false)
  assert.equal(
    isExpandedInviteUrl('https://support.weixin.qq.com/cgi-bin/mmsupport-bin/addchatroombyinvite?ticket=abc'),
    true,
  )
  assert.equal(
    isExpandedInviteUrl('https://support.weixin.qq.com/cgi-bin/mmsupport-bin/addchatroombyqrcode?uuids=abc'),
    true,
  )
  assert.equal(
    findRoomIdInUrl('https://support.weixin.qq.com/cgi-bin/mmsupport-bin/addchatroombyinvite?username=50442591080@chatroom'),
    '50442591080@chatroom',
  )
  const shortPreview = { roomId: '', roomName: '', memberCount: 0, fullUrl: 'https://weixin.qq.com/g/x' }
  const fullPreview = {
    roomId: '50442591080@chatroom',
    roomName: '测试群',
    memberCount: 10,
    fullUrl: 'https://support.weixin.qq.com/cgi-bin/mmsupport-bin/addchatroombyinvite?ticket=1',
  }
  assert.equal(hasReliableJoinTarget(shortPreview), false)
  assert.equal(hasReliableJoinTarget(fullPreview), true)
  assert.ok(
    scoreInvitePreviewCandidate(fullPreview, { data: { FullURL: fullPreview.fullUrl } })
      > scoreInvitePreviewCandidate(shortPreview, {}),
  )
})

test('findRoomId finds nested chatroom ids', () => {
  assert.equal(findRoomId({ data: { userName: '999@chatroom' } }), '999@chatroom')
  assert.equal(findRoomId({ msg: 'no room here' }), '')
  const { findRoomIdInUrl, parseInvitePreview } = require('../electron/qr-join.cjs')
  const fromUrl = parseInvitePreview(
    { data: { FullURL: 'https://support.weixin.qq.com/cgi-bin/mmsupport-bin/addchatroombyinvite?username=88888@chatroom&ticket=t' } },
    'https://weixin.qq.com/g/x',
  )
  assert.equal(fromUrl.roomId, '88888@chatroom')
  assert.equal(findRoomIdInUrl(fromUrl.fullUrl), '88888@chatroom')
})

test('download-gate invite page is ignored', () => {
  const parsed = parseInvitePageText(`<!DOCTYPE html><html><body><script>
    window.location="http://weixin.qq.com/cgi-bin/readtemplate?check=false&t=weixin_getdownurl_sms";
  </script></body></html>`)
  assert.equal(parsed.roomName, '')
  assert.equal(parsed.memberCount, 0)
})

test('main uses Node http(s) for invite page so Cookie is kept', () => {
  const root = path.join(__dirname, '..')
  const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
  assert.match(main, /function fetchInvitePageBody/)
  assert.match(main, /Accept-Encoding/)
  assert.match(main, /require\('https'\)|require\("https"\)/)
  assert.match(main, /paramSets/)
  assert.match(main, /scoreInvitePreviewCandidate/)
  assert.match(main, /hasReliableJoinTarget|isExpandedInviteUrl/)
  assert.match(main, /勿仅因 Cookie 提前结束|Cookie 不能单独|scoreInvitePreviewCandidate/)
  assert.match(main, /method: 'POST'/)
  assert.match(main, /finalize:\s*false/)
  assert.match(main, /finalize:\s*true/)
  assert.match(main, /room_id:\s*roomId/)
  assert.match(main, /chatroomId:\s*roomId/)
  assert.doesNotMatch(main, /async function fetchInvitePageBody[\s\S]*await fetch\(target/)
})

test('main/ui wire invite preview and strict join success', () => {
  const root = path.join(__dirname, '..')
  const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8')
  const page = fs.readFileSync(path.join(root, 'src', 'pages', 'QrTasksPage.vue'), 'utf8')
  assert.match(main, /fetchInvitePreview/)
  assert.match(main, /fetchInvitePageBody/)
  assert.match(main, /buildInvitePageRequest/)
  assert.match(main, /scoreInvitePreviewCandidate/)
  assert.match(main, /evaluateEnterRoomResult/)
  assert.match(main, /confirmJoinedFromRoomList/)
  assert.match(main, /verifyJoinedRoom/)
  assert.match(main, /expectedRoomName/)
  assert.match(main, /readWechatRoomIds/)
  assert.match(main, /requestApi\(record, '\/api\/enter_room', joinRequest\)/)
  assert.match(main, /DEFAULT_QR_APPLY_TEXT/)
  assert.match(main, /requestSent/)
  assert.match(main, /进群申请已提交，等待群主确认/)
  assert.match(main, /isJoinApplicationPending/)
  assert.doesNotMatch(main, /requestApi\(record, '\/api\/enter_room', \{ url: joinUrl \}\)/)
  assert.match(main, /alreadyIn/)
  assert.match(main, /resolveQrItemLookupKey/)
  assert.match(main, /findAlreadyJoinedRoom/)
  assert.match(main, /isTaskStopRequested/)
  assert.match(main, /skippedNoRoomList/)
  assert.match(main, /确认需要真正进群后再占当日额度/)
  assert.match(main, /lastSnap/)
  assert.match(main, /apiVerdict\.hardFail/)
  assert.match(main, /qrFrequentInstanceIds/)
  assert.match(main, /仅暂停该微信本任务剩余项/)
  assert.match(main, /qr:preview-invites/)
  assert.match(main, /优先用 a8key 解析出的完整邀请 URL/)
  assert.match(main, /短链尚未解析为完整邀请链/)
  assert.match(preload, /previewQrInvites/)
  assert.match(page, /previewQrInvites/)
  assert.match(page, /创建进群任务/)
  assert.match(page, /正在解析群资料/)
  assert.match(page, /dangerouslyUseHTMLString/)
  assert.match(page, /pendingPreviewCount/)
  assert.match(page, /执行任务时仍会逐个尝试/)
  assert.doesNotMatch(page, /ID：\$\{escapeHtml\(item\.roomId\)\}/)
  assert.match(page, /个人码无法进群/)
  assert.match(page, /usableName \? \{ roomName: usableName \}/)
  assert.match(page, /qrType \? \{ qrType \}/)
  assert.match(page, /path: localPath, localPath/)
  assert.match(page, /previewByUrl\.set\(url, preview\)/)
  assert.match(main, /qrRoomStateByInstance/)
  assert.match(main, /qrHelpersFor/)
  assert.match(main, /rememberJoinedRoom/)
  // 幂等状态机
  assert.match(main, /enterRoomSubmittedByKey/)
  assert.match(main, /isEnterRoomSubmitted/)
  assert.match(main, /markEnterRoomSubmitted/)
  assert.match(main, /aliasEnterRoomTarget/)
  assert.match(main, /idempotencyTarget/)
  assert.match(main, /SUBMITTING/)
  assert.match(main, /跳过重复 enter_room/)
  assert.match(main, /不再重复 enter_room/)
  assert.match(main, /includeDetail:\s*needNameMatch/)
  assert.match(main, /整次核验最多补一次详情|出现「无名称的新群」/)
  assert.match(main, /loadRoomState,/)
  // 核验轮询禁止每轮打 readWechatRooms / get_all_room_detail
  const verifyFn = main.slice(main.indexOf('async function verifyJoinedRoom'), main.indexOf('async function applyQrOptions'))
  assert.doesNotMatch(verifyFn, /readWechatRooms\(/)
  assert.doesNotMatch(verifyFn, /get_all_room_detail/)
  assert.match(page, /previewLimit = 20/)
  assert.match(page, /避免狂打接口/)
  assert.match(page, /config-panel\.panel-scroll/)
  assert.match(page, /max-height:\s*min\(78vh/)
  assert.match(page, /targetKey = `\$\{instanceId\}::\$\{qrKey\}`/)
  assert.match(page, /sourceLabel/)
  assert.match(main, /urls\.slice\(0, 100\)/)
  assert.match(main, /normalizeQrText\(link\)/)
  assert.match(main, /进群前群资料：\$\{preview\.label\}/)
  assert.match(main, /roomName: preview\.roomName/)
  assert.match(main, /priorName && !usableQrRoomName\(preview\.roomName\)/)
  assert.doesNotMatch(main, /进群未确认[\s\S]{0,200}targetKey: item\.target_key/)
})

test('QR execution preserves a confirmed group link and retries transient control disconnects', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  assert.match(main, /applyQrOptionsWithConnectionRetry/)
  assert.match(main, /attempt <= 3/)
  assert.match(main, /resolveTaskQrType/)
  assert.match(main, /usableQrRoomName/)
  assert.match(main, /storedQr\?\.qrType === 'GROUP_LINK'/)
  assert.match(main, /effectiveDecodedText = storedGroupText \|\| decodedText/)
  assert.match(main, /pollDelays/)
  assert.match(main, /expectedRoomName/)
  assert.doesNotMatch(main, /for \(const roomId of current\) if \(!beforeRoomIds\.has\(roomId\)\) return roomId/)
})
