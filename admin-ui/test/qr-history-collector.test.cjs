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
  normalizeQrText,
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

test('normalizeQrText collapses tracking params and same-group invite variants', () => {
  assert.equal(
    normalizeQrText('https://u.wechat.com/EIF7yWpV8W8TElETfjXL9f4?s=2'),
    'https://u.wechat.com/EIF7yWpV8W8TElETfjXL9f4',
  )
  assert.equal(
    contentHash('https://u.wechat.com/EIF7yWpV8W8TElETfjXL9f4?s=2'),
    contentHash('https://u.wechat.com/EIF7yWpV8W8TElETfjXL9f4'),
  )
  assert.equal(
    normalizeQrText('HTTPS://weixin.qq.com/g/AQYAAtoken123?from=group'),
    'https://weixin.qq.com/g/AQYAAtoken123',
  )
  assert.equal(
    contentHash('https://weixin.qq.com/g/AQYAAtoken123'),
    contentHash('HTTPS://weixin.qq.com/g/AQYAAtoken123/?s=1'),
  )
  // 同图贴两个相同码：归一化后哈希一致
  const a = contentHash('https://weixin.qq.com/g/sameInvite')
  const b = contentHash(' https://weixin.qq.com/g/sameInvite\n')
  assert.equal(a, b)
})

test('saveClassifiedQrImage keeps multiple QR records but writes one physical image per poster', () => {
  const main = readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  assert.match(main, /seenInImage/)
  assert.match(main, /先占位/)
  assert.match(main, /hasQrContentHash/)
  assert.match(main, /const imageFileHash = await sha256\(sourcePath\)/)
  assert.match(main, /let sharedDestination = ''/)
  assert.match(main, /整张图片哈希/)
  assert.doesNotMatch(main, /\$\{String\(hash\)\.slice\(0, 16\)/)
  assert.doesNotMatch(main, /status: 'DUPLICATE'/)
  assert.doesNotMatch(main, /dup:\$\{hash\}:\$\{randomUUID\(\)\}/)
})

test('local image import decodes every QR and creates one record per link', () => {
  const main = readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  const importBody = main.slice(main.indexOf("ipcMain.handle('qr:import-files'"), main.indexOf("ipcMain.handle('qr:import-links'"))
  assert.match(importBody, /decodeNativeImages/)
  assert.match(importBody, /mode: 'full'/)
  assert.match(importBody, /recognized = new Map/)
  assert.match(importBody, /decodedText: item\.decodedText/)
  assert.match(importBody, /status: 'READY'/)
})

test('fast history decoding does not return after the first QR in a poster', () => {
  const collector = readFileSync(path.join(__dirname, '..', 'electron', 'qr-collector.cjs'), 'utf8')
  const fastBody = collector.slice(collector.indexOf("if (mode === 'fast')"), collector.indexOf('// —— 完整模式'))
  assert.doesNotMatch(fastBody, /if \(hit\) return/)
  assert.doesNotMatch(fastBody, /if \(decoded\.size\) return/)
})

test('scan result cannot replace a confirmed group link with another code from the same poster', () => {
  const storage = readFileSync(path.join(__dirname, '..', 'electron', 'storage.cjs'), 'utf8')
  const updateBody = storage.slice(storage.indexOf('function updateQrScanResult'), storage.indexOf('function classifyStoredQr'))
  assert.match(updateBody, /preserveGroup/)
  assert.match(updateBody, /existing\?\.qrType === 'GROUP_LINK'/)
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
  const storage = readFileSync(path.join(root, 'electron/storage.cjs'), 'utf8')
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
  assert.match(page, /revealQrImage/)
  assert.match(page, /revealInFolder/)
  assert.match(page, /@dblclick\.stop="revealQrImage/)
  assert.match(page, /setTypeFilter|typeFilter|qrTypeFilterChips/)
  assert.match(page, /群二维码/)
  assert.doesNotMatch(page, /changeQrType|qrTypeOptions/)
  assert.doesNotMatch(page, /@change="\(value: string\) => changeQrType/)
  assert.match(preload, /revealInFolder/)
  assert.match(preload, /qr:update-type|updateQrItemType/)
  assert.match(main, /files:reveal-in-folder/)
  assert.match(main, /showItemInFolder/)
  assert.match(main, /qr:update-type/)
  assert.match(storage, /function updateQrItemType/)
  assert.match(page, /请先勾选要执行的二维码记录/)
  assert.match(page, /request:\s*\{\s*url/)
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
  assert.match(main, /同图内先按归一化内容去重|内容哈希去重/)
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
  assert.match(storage, /QQ_GROUP_LINK/)
  const collectorBody = main.slice(main.indexOf('async function collectRoomQrImages'), main.indexOf('function loadApiContracts'))
  assert.doesNotMatch(collectorBody, /\/api\/qrscan/)
})
