const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const {
  safeFolderName,
  classifyQrText,
  qrTypeLabel,
  contentHash,
  messageTableName,
  rowsFromApi,
  cdnDownloadRequest,
  decodeWcdbField,
  accurateFileName,
  buildScanTiles,
} = require('../electron/qr-collector.cjs')

test('QR history collector classifies and deduplicates by decoded content', () => {
  assert.equal(classifyQrText('https://weixin.qq.com/g/abc'), 'GROUP_LINK')
  assert.equal(classifyQrText('https://u.wechat.com/abc'), 'PERSONAL_LINK')
  assert.equal(classifyQrText('https://qm.qq.com/q/abc'), 'QQ_GROUP_LINK')
  assert.equal(classifyQrText('https://jq.qq.com/?_wv=1027&k=abc'), 'QQ_GROUP_LINK')
  assert.equal(classifyQrText('https://example.com'), 'UNKNOWN')
  assert.equal(qrTypeLabel('GROUP_LINK'), '微信群二维码')
  assert.equal(qrTypeLabel('PERSONAL_LINK'), '微信个人二维码')
  assert.equal(qrTypeLabel('QQ_GROUP_LINK'), 'QQ群二维码')
  assert.equal(contentHash('same-code'), contentHash('same-code'))
  assert.notEqual(contentHash('same-code'), contentHash('another-code'))
})

test('QR history collector derives the room message table and accurate file names', () => {
  assert.match(messageTableName('123@chatroom'), /^Msg_[a-f0-9]{32}$/)
  assert.equal(safeFolderName('客户/二维码:*?'), '客户_二维码___')
  assert.deepEqual(rowsFromApi({ data: [{ name: 'message_0.db' }] }), [{ name: 'message_0.db' }])
  assert.deepEqual(cdnDownloadRequest({ content: '<img aeskey="secret" cdnmidimgurl="file-id" />' }, 'D:\\out.jpg'), { fileid: 'file-id', asekey: 'secret', imgType: 2, out: 'D:\\out.jpg' })
  assert.deepEqual(cdnDownloadRequest({ content: '<img aeskey="secret" cdnbigimgurl="big-id" />' }, 'D:\\out.jpg'), { fileid: 'big-id', asekey: 'secret', imgType: 1, out: 'D:\\out.jpg' })
  const xml = '<?xml version="1.0"?><msg><img aeskey="aabbccddeeff00112233445566778899" cdnmidimgurl="305f0201mid" length="100" /></msg>'
  const zstdB64 = zlib.zstdCompressSync(Buffer.from(xml, 'utf8')).toString('base64')
  assert.match(decodeWcdbField(zstdB64), /aeskey="aabbccddeeff00112233445566778899"/)
  assert.deepEqual(
    cdnDownloadRequest({ message_content: zstdB64 }, 'D:\\out.jpg'),
    { fileid: '305f0201mid', asekey: 'aabbccddeeff00112233445566778899', imgType: 2, out: 'D:\\out.jpg' },
  )
  // 自己发送图片回调：CDN 字段在顶层 camelCase，不在 XML
  assert.deepEqual(
    cdnDownloadRequest({
      messageDesc: '自己发送的图片消息',
      msgType: 3,
      aeskey: '05f8f6033dcfbc67af458799dda91bce',
      cdnmidImgUrl: '305702010004selfmid',
      cdnbigImgUrl: '305702010004selfbig',
      fromUserName: { String: 'wxid_self' },
      toUserName: { String: '123@chatroom' },
    }, 'D:\\self.jpg'),
    { fileid: '305702010004selfmid', asekey: '05f8f6033dcfbc67af458799dda91bce', imgType: 2, out: 'D:\\self.jpg' },
  )
  const fixed = new Date(2026, 7, 2, 12, 0, 0).getTime()
  const name = accurateFileName('微信群二维码', '测试/群', '123', 'ABCDEF1234567890', '.jpg', fixed)
  assert.equal(name, '微信群二维码_测试_群_123_20260802120000_ABCDEF123456.jpg')
  const tiles = buildScanTiles(800, 600)
  assert.ok(tiles.length >= 5)
  assert.ok(tiles.some((tile) => tile.x === 0 && tile.width <= 400))
  assert.ok(tiles.some((tile) => tile.x > 0))
})

test('QR history UI supports multi-room collection and offline decoding', () => {
  const root = path.join(__dirname, '..')
  const page = readFileSync(path.join(root, 'src/pages/QrTasksPage.vue'), 'utf8')
  const main = readFileSync(path.join(root, 'electron/main.cjs'), 'utf8')
  const preload = readFileSync(path.join(root, 'electron/preload.cjs'), 'utf8')
  const collector = readFileSync(path.join(root, 'electron/qr-collector.cjs'), 'utf8')
  assert.match(page, /采集群聊历史二维码/)
  assert.match(page, /collectProgressText|onQrCollectProgress/)
  assert.match(page, /队列准备中|队列 \$\{detail\.roomIndex/)
  assert.match(page, /formatCacheTime|cacheTime/)
  assert.match(page, /selectedGroupIds.*multiple/s)
  assert.match(main, /queueRooms/)
  assert.match(main, /byInstance/)
  assert.match(main, /Promise\.all/)
  assert.doesNotMatch(main, /一次最多 8 个群/)
  assert.doesNotMatch(page, /一次最多采集 8 个群/)
  assert.match(page, /clearHistoryGroups|startMonitorQueuePolling/)
  const selectUtil = readFileSync(path.join(root, 'src/utils/searchableSelect.ts'), 'utf8')
  assert.match(selectUtil, /SELECTED_OPTION_RENDER_CAP/)
  assert.match(page, /保存文件夹/)
  assert.match(page, /分组名称/)
  assert.match(page, /function isExecutableQr/)
  assert.match(page, /请先勾选要执行的二维码记录/)
  assert.match(page, /request: \{ url:/)
  assert.match(preload, /qr:collect-history/)
  assert.match(main, /\/api\/get_db_handle/)
  assert.match(main, /\/api\/sqlite3_exec/)
  assert.match(main, /\/api\/download_img/)
  assert.match(main, /decodeNativeImages\(nativeImage\.createFromPath/)
  assert.match(main, /qr:monitor-start/)
  assert.match(main, /handleQrMonitorEvent\(record, event\)/)
  assert.match(main, /resolveQrMonitorRoom/)
  assert.match(main, /rebuildQrMonitorRoomIndex/)
  assert.match(main, /enqueueQrMonitorJob/)
  assert.match(main, /QR_MONITOR_CONCURRENCY/)
  assert.match(main, /extractEventRoomIds/)
  assert.match(main, /looksLikeImageEvent/)
  assert.match(main, /tryDownloadQrImageViaCdn/)
  assert.match(main, /isQrLinkCurrentlyValid/)
  assert.match(main, /validateLinks: false/)
  assert.match(main, /decodeMode: 'fast'/)
  assert.match(main, /cdnmidImgUrl\+aeskey/)
  assert.match(page, /flushMonitorResultBucket|monitorResultBucket/)
  assert.match(page, /队列并发下载|150\+|全部图片消息/)
  assert.match(page, /maxImages: 0/)
  assert.doesNotMatch(page, /每群最多检查图片/)
  assert.match(main, /unlimited \? 0/)
  assert.match(main, /limitSql/)
  assert.match(collector, /cdnmidImgUrl/)
  assert.match(main, /qr:collect-progress/)
  assert.match(main, /historyCollectRunning/)
  assert.match(collector, /decodeWcdbField/)
  assert.match(collector, /zstdDecompressSync/)
  assert.match(collector, /prepareHistoryMessageRow/)
  assert.match(collector, /mode === 'fast'/)
  assert.match(preload, /onQrCollectProgress/)
  assert.match(main, /qrType === 'PERSONAL_LINK'/)
  assert.match(main, /仅明确过期才拒绝/)
  assert.match(main, /qrTypeLabel/)
  assert.match(main, /同图多码各自一份文件/)
  assert.match(main, /QQ_GROUP_LINK/)
  assert.match(collector, /downscaleForScan/)
  assert.match(collector, /mode === 'fast'/)
  assert.match(collector, /buildScanTiles/)
  assert.match(main, /不回传全量 records/)
  assert.match(main, /二维码已过期或无法确认有效，未保存/)
  assert.match(main, /joinResult\.frequent/)
  assert.match(main, /'FREQUENT'/)
  assert.match(main, /joinResult\.scannedOnly \|\| !joinResult\.joinSubmitted/)
  assert.match(main, /非微信群二维码，已跳过/)
  assert.match(preload, /onQrMonitorResult/)
  const storage = readFileSync(path.join(root, 'electron/storage.cjs'), 'utf8')
  assert.match(storage, /QQ_GROUP_LINK/)
  const collectorBody = main.slice(main.indexOf('async function collectRoomQrImages'), main.indexOf('function loadApiContracts'))
  assert.doesNotMatch(collectorBody, /\/api\/qrscan/)
})
