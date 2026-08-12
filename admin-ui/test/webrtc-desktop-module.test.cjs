const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const root = path.resolve(__dirname, '..')

test('duplicate runtime files must be in sync with electron/ versions', () => {
  for (const name of ['remote-agent.cjs', 'webrtc-desktop.cjs']) {
    const electronPath = path.join(root, 'electron', name)
    const rootPath = path.join(root, name)
    if (!fs.existsSync(rootPath)) continue
    const h1 = createHash('sha256').update(fs.readFileSync(electronPath)).digest('hex')
    const h2 = createHash('sha256').update(fs.readFileSync(rootPath)).digest('hex')
    assert.equal(h1, h2, `${name}: electron/ and root copies have drifted`)
  }
})

test('webrtc publisher files are packaged under electron/', () => {
  for (const rel of [
    'electron/webrtc-desktop.cjs',
    'electron/webrtc-publisher.html',
    'electron/webrtc-publisher-preload.cjs',
    'electron/vendor/livekit-client.umd.js',
  ]) {
    assert.equal(fs.existsSync(path.join(root, rel)), true, rel)
  }
})

test('livekit publisher guards: reuse room, timeout cleanup, reconnect soft-state', () => {
  const html = fs.readFileSync(path.join(root, 'electron/webrtc-publisher.html'), 'utf8')
  const mod = fs.readFileSync(path.join(root, 'electron/webrtc-desktop.cjs'), 'utf8')
  const agent = fs.readFileSync(path.join(root, 'electron/remote-agent.cjs'), 'utf8')
  assert.match(html, /livekit-client\.umd\.js/)
  assert.match(html, /LK\.Room/)
  assert.match(html, /getDisplayMedia_timeout/)
  assert.match(html, /settled/)
  assert.match(html, /clearTimeout\(captureTimer\)/)
  assert.match(html, /captureTimer = null/)
  assert.match(html, /25000/)
  assert.match(html, /stream\.getTracks\(\)\.forEach/)
  assert.match(html, /reused: true/)
  assert.match(html, /publishedTrack\.readyState === 'live'/)
  assert.match(html, /signalReconnecting/)
  assert.match(html, /maxBitrate: 900_000|maxBitrate: 900000/)
  assert.match(html, /contentHint = 'detail'/)
  assert.match(html, /cmdChain/)
  assert.match(html, /dynacast: false/)
  assert.match(html, /adaptiveStream: false/)
  assert.match(html, /room !== nextRoom/)
  assert.match(html, /keepStream/)
  assert.match(html, /roomEpoch/)
  assert.match(html, /scheduleAutoReconnect/)
  assert.match(html, /reconnectAttempt/)
  assert.match(html, /Math\.pow\(1\.7/)
  assert.match(html, /intentionalStop/)
  assert.match(html, /skipUnpublish/)
  assert.match(html, /connectionState: 'capturing'/)
  assert.match(html, /captureTimeout/)
  assert.match(mod, /soft = /)
  assert.match(mod, /getDisplayMedia_timeout/)
  assert.match(mod, /CAPTURE_FAIL_RECYCLE_AT/)
  assert.match(mod, /recyclePublisherWindow/)
  assert.match(mod, /scheduleJpegResume/)
  assert.match(mod, /isWebRtcMediaConnected/)
  assert.match(mod, /isWebRtcDesktopActive/)
  assert.match(mod, /isWebRtcCaptureBusy/)
  assert.match(mod, /isWebRtcStarting/)
  assert.match(mod, /markWebRtcStarting/)
  assert.match(mod, /STARTING_GUARD_MS/)
  assert.match(mod, /captureBusy/)
  assert.match(mod, /queuedStart/)
  assert.match(mod, /clearStopWaitTimer/)
  assert.match(mod, /activeRoomName/)
  assert.match(mod, /wantForce/)
  assert.match(mod, /opts\.forceRestart \|\| opts\.kick \|\| opts\.force/)
  assert.match(mod, /captureBusy = false\s*\n\s*markWebRtcStarting\(false\)\s*\n\s*return \{ ok: true, reused: true \}/)
  assert.match(mod, /scheduleJpegResume\(8000\)/)
  assert.match(mod, /重连期间可能再次 getDisplayMedia/)
  assert.match(mod, /mediaConnected = false\s*\n\s*captureBusy = false\s*\n\s*markWebRtcStarting\(false\)/)
  assert.match(mod, /DUPLICATE_IDENTITY/)
  assert.match(mod, /reconnecting/)
  assert.match(mod, /destroy\(\)/)
  assert.match(mod, /jpegResumeTimer|clearJpegResumeTimer/)
  assert.match(agent, /isWebRtcMediaConnected\(\)/)
  assert.match(agent, /isWebRtcDesktopActive\(\)/)
  assert.match(agent, /isWebRtcCaptureBusy\(\)/)
  assert.match(agent, /isWebRtcStarting\(\)/)
  assert.match(agent, /markWebRtcStarting\(true\)/)
  assert.match(agent, /agentMsgChain/)
  assert.match(agent, /stopWebRtcDesktop\(\)/)
  assert.match(agent, /jpeg_snapshot/)
  assert.match(agent, /!state\.watching/)
  assert.match(agent, /forceRestart: !isWebRtcMediaConnected\(\)/)
  assert.match(agent, /handleControlPayload\(message\.payload/)
  assert.match(agent, /JPEG_SNAPSHOT_INTERVAL_MS/)
  assert.doesNotMatch(agent, /JPEG_SNAPSHOT_INTERVAL_MS \* 6/)
})

// ---- Behavioral tests for ensureStream timeout logic ----
// Simulate the exact Promise/timer pattern from webrtc-publisher.html

function makeCaptureRace(getDisplayMediaFn, timeoutMs) {
  let settled = false
  let captureTimer = null
  const trackStops = []
  return new Promise(function (resolve, reject) {
    captureTimer = setTimeout(function () {
      captureTimer = null
      if (settled) return
      settled = true
      reject(new Error('getDisplayMedia_timeout'))
      getDisplayMediaFn.__promise.then(function (s) {
        if (s) s.getTracks().forEach(function (t) { t.stop(); trackStops.push(t) })
      }, function () {})
    }, timeoutMs)
    getDisplayMediaFn.__promise.then(function (stream) {
      if (settled) {
        if (stream) stream.getTracks().forEach(function (t) { t.stop(); trackStops.push(t) })
        return
      }
      settled = true
      if (captureTimer) { clearTimeout(captureTimer); captureTimer = null }
      resolve(stream)
    }, function (err) {
      if (settled) return
      settled = true
      if (captureTimer) { clearTimeout(captureTimer); captureTimer = null }
      reject(err)
    })
  }).then(
    (s) => ({ ok: true, stream: s, trackStops }),
    (e) => ({ ok: false, error: e, trackStops })
  )
}

function makeTrack() {
  let stopped = false
  return { readyState: 'live', stop() { stopped = true; this.readyState = 'ended' }, get _stopped() { return stopped } }
}
function makeStream(tracks) {
  return { getTracks() { return tracks }, getVideoTracks() { return tracks.filter(t => t.readyState !== undefined) } }
}
function makeDelayedCapture(delayMs, result) {
  let resolveFn, rejectFn
  const p = new Promise((res, rej) => { resolveFn = res; rejectFn = rej })
  const fn = {}
  fn.__promise = p
  if (result instanceof Error) {
    setTimeout(() => rejectFn(result), delayMs)
  } else {
    setTimeout(() => resolveFn(result), delayMs)
  }
  return fn
}

test('A: getDisplayMedia succeeds at 1s, track.stop not called at 30s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const track = makeTrack()
  const stream = makeStream([track])
  const cap = makeDelayedCapture(0, stream)

  // Resolve getDisplayMedia immediately
  t.mock.timers.tick(0)
  const raceP = makeCaptureRace(cap, 25000)
  // Let the microtask resolve
  await new Promise(r => setImmediate(r))
  t.mock.timers.tick(1000)
  await new Promise(r => setImmediate(r))

  const result = await raceP
  assert.equal(result.ok, true)
  assert.equal(result.stream, stream)

  // Advance past 25s timeout — track must NOT be stopped
  t.mock.timers.tick(30000)
  await new Promise(r => setImmediate(r))
  assert.equal(track._stopped, false, 'track.stop must not be called after successful capture')
  assert.equal(result.trackStops.length, 0)
})

test('B: getDisplayMedia exceeds 25s, late stream must be stopped', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const track = makeTrack()
  const stream = makeStream([track])
  let resolveCapture
  const p = new Promise((res) => { resolveCapture = res })
  const cap = { __promise: p }

  const raceP = makeCaptureRace(cap, 25000)
  // Timeout fires at 25s
  t.mock.timers.tick(25001)
  await new Promise(r => setImmediate(r))

  const result = await raceP
  assert.equal(result.ok, false)
  assert.match(result.error.message, /getDisplayMedia_timeout/)

  // Late stream arrives at 30s — must be stopped
  resolveCapture(stream)
  await new Promise(r => setImmediate(r))
  t.mock.timers.tick(5000)
  await new Promise(r => setImmediate(r))
  assert.equal(track._stopped, true, 'late stream must be stopped')
})

test('C: getDisplayMedia rejects immediately, timer cleaned', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const cap = makeDelayedCapture(0, new Error('permission_denied'))
  t.mock.timers.tick(0)
  const raceP = makeCaptureRace(cap, 25000)
  await new Promise(r => setImmediate(r))
  t.mock.timers.tick(1)
  await new Promise(r => setImmediate(r))

  const result = await raceP
  assert.equal(result.ok, false)
  assert.match(result.error.message, /permission_denied/)

  // Advance past 25s — no second timeout error
  t.mock.timers.tick(30000)
  await new Promise(r => setImmediate(r))
  assert.equal(result.trackStops.length, 0)
})

test('D: restart/stop clears old timer, new session unaffected', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // Session 1: start capture, then "stop" before it completes (simulated by clearing)
  let resolveCapture1
  const p1 = new Promise((res) => { resolveCapture1 = res })
  const cap1 = { __promise: p1 }
  const race1P = makeCaptureRace(cap1, 25000)

  // "Stop/restart" — we don't await race1P, start session 2
  const track2 = makeTrack()
  const stream2 = makeStream([track2])
  const cap2 = makeDelayedCapture(0, stream2)
  t.mock.timers.tick(0)
  const race2P = makeCaptureRace(cap2, 25000)
  await new Promise(r => setImmediate(r))
  t.mock.timers.tick(1)
  await new Promise(r => setImmediate(r))

  const result2 = await race2P
  assert.equal(result2.ok, true)
  assert.equal(result2.stream, stream2)

  // Advance past both timers — session 2's track must remain live
  t.mock.timers.tick(30000)
  await new Promise(r => setImmediate(r))
  assert.equal(track2._stopped, false, 'new session track must not be stopped by old timer')
})

test('E: successful capture stays alive for 60s without internal stop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const track = makeTrack()
  const stream = makeStream([track])
  const cap = makeDelayedCapture(0, stream)
  t.mock.timers.tick(0)
  const raceP = makeCaptureRace(cap, 25000)
  await new Promise(r => setImmediate(r))
  t.mock.timers.tick(1)
  await new Promise(r => setImmediate(r))

  const result = await raceP
  assert.equal(result.ok, true)

  // 60 seconds of simulated time
  t.mock.timers.tick(60000)
  await new Promise(r => setImmediate(r))
  assert.equal(track._stopped, false, 'track must stay live for 60s')
  assert.equal(track.readyState, 'live')
})

test('screen wall slows webrtc hard-kick to protect getDisplayMedia recovery', () => {
  const portal = fs.readFileSync(path.join(root, '..', 'server/wxqk/deploy_rd_portal_888.py'), 'utf8')
  assert.match(portal, /START_COOLDOWN_MS = 45000/)
  assert.match(portal, /kickGap = src\.preferWebRtc \? 90000/)
  assert.match(portal, /tryingAge < WEBRTC_CONNECT_TIMEOUT_MS/)
  assert.match(portal, /isLivekitVideoFresh\(c\)/)
  assert.match(portal, /假死最后一帧必须允许/)
  assert.match(portal, /> 90000/)
})

test('server force coalesce drops duplicate hard kicks (no demote-to-soft swallow)', () => {
  const py = fs.readFileSync(path.join(root, '..', 'server/wxqk/server.py'), 'utf8')
  assert.match(py, /_DESKTOP_FORCE_RESTART_MIN_SEC = 45/)
  assert.match(py, /_DESKTOP_LIVEKIT_START_COALESCE_SEC = 45/)
  assert.match(py, /since_soft < 15\.0/)
  // 同房短窗内必须直接 return，禁止 demote 后再被 token_unchanged 吞掉
  assert.match(py, /since_force < _DESKTOP_FORCE_RESTART_MIN_SEC and already/)
  assert.match(py, /return True\n            meta\["last_force"\] = now/s)
  assert.doesNotMatch(py, /demoted = True/)
  assert.doesNotMatch(py, /if demoted:/)
})

test('publisher auto-reconnect uses restart to escape fake-connected freeze', () => {
  const pub = fs.readFileSync(path.join(root, 'electron', 'webrtc-publisher.html'), 'utf8')
  assert.match(pub, /op: 'restart'/)
  assert.match(pub, /startPublishHealthWatch/)
  assert.match(pub, /publish_frames_stalled|framesStallStrike/)
  const reconnect = pub.split('function scheduleAutoReconnect')[1]?.split('function clearPublishHealthWatch')[0] || ''
  assert.match(reconnect, /op: 'restart'/)
  assert.doesNotMatch(reconnect, /op: 'start'/)
})

test('screen wall refresh detaches viewers without stopping agents', () => {
  const portal = fs.readFileSync(path.join(root, '..', 'server/wxqk/deploy_rd_portal_888.py'), 'utf8')
  const py = fs.readFileSync(path.join(root, '..', 'server/wxqk/server.py'), 'utf8')
  assert.match(portal, /function detachAllViewers/)
  assert.match(portal, /pagehide[\s\S]*detachAllViewers/)
  assert.match(portal, /beforeunload[\s\S]*detachAllViewers/)
  assert.match(py, /def schedule_stop_desktop_if_idle\(cid: str, delay_sec: float = 8\.0\)/)
  assert.match(py, /schedule_stop_desktop_if_idle\(cid, delay_sec=8\.0\)/)
})

test('server livekit session helper is present for desktop transport', () => {
  const py = fs.readFileSync(path.join(root, '..', 'server/wxqk/livekit_session.py'), 'utf8')
  const sess = fs.readFileSync(path.join(root, '..', 'server/wxqk/webrtc_session.py'), 'utf8')
  assert.match(py, /def mint_token|def issue_token|livekit/)
  assert.match(sess, /livekit/)
  assert.match(sess, /def create_session|def create/)
})

test('agent token refresh: remote-agent schedules proactive refresh', () => {
  const agent = fs.readFileSync(path.join(root, 'electron', 'remote-agent.cjs'), 'utf8')
  assert.ok(agent.includes('ensureTokenRefreshScheduled'), 'should have ensureTokenRefreshScheduled')
  assert.ok(agent.includes('refreshAgentToken'), 'should have refreshAgentToken')
  assert.ok(agent.includes('AGENT_TOKEN_TTL_MS'), 'should define token TTL')
  assert.ok(agent.includes('AGENT_TOKEN_REFRESH_BEFORE_MS'), 'should define refresh window')
  assert.ok(agent.includes('token_refresh_ack'), 'should handle server ack')
  assert.ok(agent.includes('updateAgentToken'), 'should push token to publisher')
})

test('agent token refresh: publisher accepts update-token without stopping', () => {
  const pub = fs.readFileSync(path.join(root, 'electron', 'webrtc-publisher.html'), 'utf8')
  assert.ok(pub.includes("op === 'update-token'"), 'should handle update-token op')
  const handler = pub.split("op === 'update-token'")[1]?.split('return')[0] || ''
  assert.ok(handler.includes('lastToken'), 'should update lastToken')
  assert.ok(!handler.includes('stopMedia'), 'should not stop media')
  assert.ok(!handler.includes('disconnect'), 'should not disconnect')
})

test('agent token refresh: webrtc-desktop exports updateAgentToken', () => {
  const mod = fs.readFileSync(path.join(root, 'electron', 'webrtc-desktop.cjs'), 'utf8')
  assert.ok(mod.includes('updateAgentToken'), 'should export updateAgentToken')
  assert.ok(mod.includes("op: 'update-token'"), 'should send update-token command')
})

test('agent token refresh: reconnect uses lastToken which can be refreshed', () => {
  const pub = fs.readFileSync(path.join(root, 'electron', 'webrtc-publisher.html'), 'utf8')
  const reconnect = pub.split('scheduleAutoReconnect')[1]?.split('function ')[0] || ''
  assert.ok(reconnect.includes('lastToken'), 'reconnect should use lastToken')
})

test('agent token refresh: single reconnect loop (no duplicate timers)', () => {
  const pub = fs.readFileSync(path.join(root, 'electron', 'webrtc-publisher.html'), 'utf8')
  assert.ok(pub.includes('clearAutoReconnect()'), 'should clear before scheduling')
  const agent = fs.readFileSync(path.join(root, 'electron', 'remote-agent.cjs'), 'utf8')
  assert.ok(agent.includes('if (stopping || !state.running || reconnectTimer) return'), 'should guard against duplicate reconnect')
})

test('agent token refresh: server handles request_token_refresh', () => {
  const srv = fs.readFileSync(path.join(root, '..', 'server/wxqk/server.py'), 'utf8')
  assert.ok(srv.includes('request_token_refresh'), 'should handle token refresh request')
  assert.ok(srv.includes('token_refresh_ack'), 'should send ack with token')
})

test('agent token refresh: stopRemoteAgent clears tokenRefreshTimer', () => {
  const agent = fs.readFileSync(path.join(root, 'electron', 'remote-agent.cjs'), 'utf8')
  const stopFn = agent.split('function stopRemoteAgent')[1]?.split('\nfunction ')[0] || ''
  assert.ok(stopFn.includes('resetTokenRefreshLifecycle'), 'should reset token refresh lifecycle on stop')
})
