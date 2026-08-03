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

test('parseInvitePageText reads common invite page copy', () => {
  const parsed = parseInvitePageText('邀请你加入群聊\n客户VIP群\n88人已加入')
  assert.equal(parsed.roomName, '客户VIP群')
  assert.equal(parsed.memberCount, 88)
})

test('evaluateEnterRoomResult rejects empty errCode=1 success', () => {
  const empty = evaluateEnterRoomResult(true, { account_wxid: 'wxid_x', data: {}, errCode: 1, errMsg: '请求处理成功' })
  assert.equal(empty.ok, false)
  assert.match(empty.reason, /空结果|未确认/)

  const ok = evaluateEnterRoomResult(true, { errCode: 1, data: { roomId: '12345@chatroom', topic: '已加入' } })
  assert.equal(ok.ok, true)
  assert.equal(ok.roomId, '12345@chatroom')

  const expired = evaluateEnterRoomResult(true, { errMsg: '二维码已过期', data: {} })
  assert.equal(expired.ok, false)
  assert.match(expired.reason, /过期|无效/)
})

test('findRoomId finds nested chatroom ids', () => {
  assert.equal(findRoomId({ data: { userName: '999@chatroom' } }), '999@chatroom')
  assert.equal(findRoomId({ msg: 'no room here' }), '')
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
  assert.match(main, /evaluateEnterRoomResult/)
  assert.match(main, /qr:preview-invites/)
  assert.match(main, /优先用 a8key 解析出的完整邀请 URL/)
  assert.match(preload, /previewQrInvites/)
  assert.match(page, /previewQrInvites/)
  assert.match(page, /确认进群目标/)
  assert.match(page, /正在解析群资料/)
  assert.match(page, /dangerouslyUseHTMLString/)
})
