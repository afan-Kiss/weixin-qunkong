# Inject WebSocket desktop streaming into siren server.py
from pathlib import Path

root = Path(__file__).resolve().parent
text = (root / "server.py").read_text(encoding="utf-8")

if "from wsutil import" not in text:
    text = text.replace(
        "from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer\n",
        "from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer\n"
        "from wsutil import handshake_response, recv_json, send_json\n",
        1,
    )
    print("imported wsutil")

AGENT_HUB = '''
# --- realtime desktop WS hubs ---
_agent_ws: dict[str, Any] = {}   # clientId -> socket
_viewer_ws: dict[str, list] = {}  # clientId -> [sockets]
_ws_lock = threading.RLock()


def register_agent(cid: str, sock) -> None:
    cid = safe_id(cid)
    with _ws_lock:
        old = _agent_ws.get(cid)
        _agent_ws[cid] = sock
    if old and old is not sock:
        try:
            old.close()
        except Exception:
            pass


def unregister_agent(cid: str, sock) -> None:
    cid = safe_id(cid)
    with _ws_lock:
        if _agent_ws.get(cid) is sock:
            _agent_ws.pop(cid, None)


def register_viewer(cid: str, sock) -> None:
    cid = safe_id(cid)
    with _ws_lock:
        _viewer_ws.setdefault(cid, []).append(sock)


def unregister_viewer(cid: str, sock) -> None:
    cid = safe_id(cid)
    with _ws_lock:
        arr = _viewer_ws.get(cid) or []
        _viewer_ws[cid] = [s for s in arr if s is not sock]
        if not _viewer_ws[cid]:
            _viewer_ws.pop(cid, None)


def push_to_viewers(cid: str, obj: dict) -> None:
    cid = safe_id(cid)
    with _ws_lock:
        viewers = list(_viewer_ws.get(cid) or [])
    dead = []
    for s in viewers:
        try:
            send_json(s, obj)
        except Exception:
            dead.append(s)
    for s in dead:
        unregister_viewer(cid, s)


def tell_agent(cid: str, obj: dict) -> bool:
    cid = safe_id(cid)
    with _ws_lock:
        sock = _agent_ws.get(cid)
    if not sock:
        return False
    try:
        send_json(sock, obj)
        return True
    except Exception:
        unregister_agent(cid, sock)
        return False

'''

if "_agent_ws" not in text:
    # insert after _latest_shot
    marker = "_latest_shot: dict[str, dict[str, Any]] = {}  # client_id -> {ts, b64 or path}\n"
    if marker not in text:
        raise SystemExit("latest_shot marker missing")
    text = text.replace(marker, marker + AGENT_HUB, 1)
    print("hub inserted")

# Replace desktop start/stop to prefer WS
old_start = '''        if path == "/api/desktop/start":
            if not self._require_admin():
                return
            cid = safe_id(body.get("clientId") or "")
            set_command(cid, {"type": "screenshot", "continuous": bool(body.get("continuous"))})
            with _lock:
                if cid in _online:
                    _online[cid]["desktopWatching"] = True
            self._send(200, {"ok": True})
            return

        if path == "/api/desktop/stop":
            if not self._require_admin():
                return
            cid = safe_id(body.get("clientId") or "")
            set_command(cid, {"type": "stop_desktop"})
            with _lock:
                if cid in _online:
                    _online[cid]["desktopWatching"] = False
            self._send(200, {"ok": True})
            return'''

new_start = '''        if path == "/api/desktop/start":
            if not self._require_admin():
                return
            cid = safe_id(body.get("clientId") or "")
            ok = tell_agent(cid, {"type": "start_desktop", "continuous": True})
            if not ok:
                set_command(cid, {"type": "screenshot", "continuous": True})
            with _lock:
                if cid in _online:
                    _online[cid]["desktopWatching"] = True
            self._send(200, {"ok": True, "ws": ok})
            return

        if path == "/api/desktop/stop":
            if not self._require_admin():
                return
            cid = safe_id(body.get("clientId") or "")
            ok = tell_agent(cid, {"type": "stop_desktop"})
            if not ok:
                set_command(cid, {"type": "stop_desktop"})
            with _lock:
                if cid in _online:
                    _online[cid]["desktopWatching"] = False
            self._send(200, {"ok": True, "ws": ok})
            return'''

if old_start in text:
    text = text.replace(old_start, new_start, 1)
    print("desktop start/stop ws-aware")
else:
    print("desktop start block not found (maybe already patched)")

# Inject WS upgrade handling before final 404 in do_GET
WS_GET = '''
        if path in ("/api/ws/agent", "/api/ws/viewer"):
            self._upgrade_ws(path)
            return
'''

if 'def _upgrade_ws' not in text:
    text = text.replace(
        '        if path == "/api/run-permit":',
        WS_GET + '        if path == "/api/run-permit":',
        1,
    )
    # Add method before do_POST
    method = '''
    def _upgrade_ws(self, path: str) -> None:
        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            self._send(400, {"ok": False, "message": "缺少 WebSocket Key"})
            return
        qs = self._qs()
        if path.endswith("/agent"):
            tok = (qs.get("token") or [""])[0] or self.headers.get("X-Upload-Token") or ""
            if not hmac.compare_digest(tok, UPLOAD_TOKEN):
                self._send(401, {"ok": False, "message": "上传凭证无效"})
                return
            cid = safe_id((qs.get("clientId") or [""])[0])
            role = "agent"
        else:
            tok = (qs.get("token") or [""])[0] or self.headers.get("X-Admin-Token") or ""
            if not check_admin_token(tok):
                self._send(401, {"ok": False, "message": "请先登录"})
                return
            cid = safe_id((qs.get("clientId") or [""])[0])
            if not cid:
                self._send(400, {"ok": False, "message": "缺少 clientId"})
                return
            role = "viewer"

        try:
            self.connection.sendall(handshake_response(key))
        except Exception:
            return
        sock = self.connection
        ip = client_ip(self)
        if role == "agent":
            register_agent(cid, sock)
            touch_online({"clientId": cid, "ip": ip})
            try:
                while True:
                    msg = recv_json(sock, timeout=70)
                    if not isinstance(msg, dict):
                        continue
                    typ = str(msg.get("type") or "")
                    if typ == "hello":
                        touch_online({
                            "clientId": cid or safe_id(msg.get("clientId") or ""),
                            "ip": ip,
                            "account": str(msg.get("account") or "")[:40],
                            "version": str(msg.get("version") or "")[:40],
                            "plan": str(msg.get("plan") or "")[:80],
                            "desktopWatching": bool(msg.get("desktopWatching")),
                        })
                        cid = safe_id(msg.get("clientId") or cid)
                        register_agent(cid, sock)
                    elif typ == "heartbeat":
                        payload = msg.get("payload") if isinstance(msg.get("payload"), dict) else msg
                        touch_online({
                            "clientId": safe_id(payload.get("clientId") or cid),
                            "ip": ip,
                            "account": str(payload.get("account") or "")[:40],
                            "version": str(payload.get("version") or "")[:40],
                            "plan": str(payload.get("plan") or "")[:80],
                            "desktopWatching": bool(payload.get("desktopWatching")),
                        })
                        permit = check_run_allowed(cid, ip)
                        if not permit.get("allowed"):
                            send_json(sock, {"type": "deny_run", "message": permit.get("message")})
                    elif typ == "ingest":
                        payload = msg.get("payload") if isinstance(msg.get("payload"), dict) else {}
                        rows = payload.get("events") or []
                        if isinstance(rows, list):
                            for r in rows:
                                if isinstance(r, dict):
                                    r.setdefault("clientId", cid)
                            append_log(ip, rows)
                    elif typ == "frame":
                        img = str(msg.get("image") or "")
                        if img:
                            save_shot(cid, img)
                            push_to_viewers(cid, {
                                "type": "frame",
                                "clientId": cid,
                                "t": str(msg.get("t") or now_iso()),
                                "image": img,
                            })
                    elif typ == "pong":
                        pass
            except Exception:
                pass
            finally:
                unregister_agent(cid, sock)
                try:
                    sock.close()
                except Exception:
                    pass
            return

        # viewer
        register_viewer(cid, sock)
        tell_agent(cid, {"type": "start_desktop", "continuous": True})
        set_command(cid, {"type": "screenshot", "continuous": True})
        try:
            send_json(sock, {"type": "ready", "clientId": cid})
            # send last cached frame if any
            shot = get_shot(cid)
            if shot and shot.get("image"):
                send_json(sock, {"type": "frame", "clientId": cid, "t": shot.get("t") or "", "image": shot["image"]})
            while True:
                msg = recv_json(sock, timeout=120)
                if not isinstance(msg, dict):
                    continue
                typ = str(msg.get("type") or "")
                if typ == "watch":
                    tell_agent(cid, {"type": "start_desktop", "continuous": True})
                elif typ == "unwatch":
                    tell_agent(cid, {"type": "stop_desktop"})
                elif typ == "ping":
                    send_json(sock, {"type": "pong"})
        except Exception:
            pass
        finally:
            unregister_viewer(cid, sock)
            # if no viewers left, stop desktop
            with _ws_lock:
                left = len(_viewer_ws.get(cid) or [])
            if left == 0:
                tell_agent(cid, {"type": "stop_desktop"})
            try:
                sock.close()
            except Exception:
                pass

'''
    text = text.replace("\n    def do_POST(self) -> None:  # noqa: N802\n", method + "\n    def do_POST(self) -> None:  # noqa: N802\n", 1)
    print("ws upgrade handler added")

# Update deny_client to also tell_agent
text = text.replace(
    'set_command(cid, {"type": "deny_run", "message": pol["denyClients"][cid]})',
    'msg = pol["denyClients"][cid]\n'
    '                set_command(cid, {"type": "deny_run", "message": msg})\n'
    '                tell_agent(cid, {"type": "deny_run", "message": msg})',
    1,
)
text = text.replace(
    'set_command(cid, {"type": "allow_run"})',
    'set_command(cid, {"type": "allow_run"})\n'
    '                tell_agent(cid, {"type": "allow_run"})',
    1,
)

# Replace HTML desktop JS with WebSocket viewer
old_desk_js = '''async function startDesk() {
  if (!selected.clientId) return alert('请先点选一台在线电脑');
  document.getElementById('deskBox').classList.remove('hide');
  document.getElementById('stopDeskBtn').classList.remove('hide');
  document.getElementById('deskHint').textContent = '已请求对方软件传桌面画面…';
  await api('/api/desktop/start', { method:'POST', body: JSON.stringify({ clientId: selected.clientId }) });
  clearInterval(deskTimer);
  deskTimer = setInterval(pullDesk, 1500);
  pullDesk();
}

async function pullDesk() {
  if (!selected.clientId) return;
  try {
    const data = await api('/api/desktop/latest?clientId='+encodeURIComponent(selected.clientId));
    if (data.image) {
      document.getElementById('deskImg').src = data.image;
      document.getElementById('deskHint').textContent = '画面时间：' + (data.t||'刚刚');
    }
    // keep asking for next frames
    await api('/api/desktop/start', { method:'POST', body: JSON.stringify({ clientId: selected.clientId, continuous: true }) });
  } catch (e) {
    document.getElementById('deskHint').textContent = e.message || '暂无画面';
  }
}

async function stopDesk() {
  clearInterval(deskTimer); deskTimer=null;
  document.getElementById('deskBox').classList.add('hide');
  document.getElementById('stopDeskBtn').classList.add('hide');
  if (selected.clientId) {
    try { await api('/api/desktop/stop', { method:'POST', body: JSON.stringify({ clientId: selected.clientId }) }); } catch(_){}
  }
}'''

new_desk_js = '''let deskWS = null;

function deskWsURL(clientId) {
  const u = new URL(location.href);
  u.protocol = (u.protocol === 'https:') ? 'wss:' : 'ws:';
  const base = (location.pathname.replace(/\\/$/,'') || '/siren');
  u.pathname = base + '/api/ws/viewer';
  u.search = 'clientId=' + encodeURIComponent(clientId) + '&token=' + encodeURIComponent(token);
  return u.toString();
}

async function startDesk() {
  if (!selected.clientId) return alert('请先点选一台在线电脑');
  document.getElementById('deskBox').classList.remove('hide');
  document.getElementById('stopDeskBtn').classList.remove('hide');
  document.getElementById('deskHint').textContent = '正在用实时通道连接桌面画面…';
  stopDeskSocketOnly();
  try {
    await api('/api/desktop/start', { method:'POST', body: JSON.stringify({ clientId: selected.clientId, continuous: true }) });
  } catch (_) {}
  const ws = new WebSocket(deskWsURL(selected.clientId));
  deskWS = ws;
  ws.onopen = () => {
    document.getElementById('deskHint').textContent = '实时画面已连接，等待第一帧…';
    ws.send(JSON.stringify({ type: 'watch' }));
  };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'frame' && msg.image) {
        document.getElementById('deskImg').src = msg.image;
        document.getElementById('deskHint').textContent = '实时画面 · ' + (msg.t || '刚刚');
      }
    } catch (_) {}
  };
  ws.onclose = () => {
    if (deskWS === ws) {
      document.getElementById('deskHint').textContent = '实时画面已断开';
    }
  };
  ws.onerror = () => {
    document.getElementById('deskHint').textContent = '实时画面连接失败';
  };
}

function stopDeskSocketOnly() {
  if (deskWS) {
    try { deskWS.close(); } catch(_){}
    deskWS = null;
  }
  clearInterval(deskTimer); deskTimer=null;
}

async function stopDesk() {
  stopDeskSocketOnly();
  document.getElementById('deskBox').classList.add('hide');
  document.getElementById('stopDeskBtn').classList.add('hide');
  if (selected.clientId) {
    try { await api('/api/desktop/stop', { method:'POST', body: JSON.stringify({ clientId: selected.clientId }) }); } catch(_){}
  }
}'''

if old_desk_js in text:
    text = text.replace(old_desk_js, new_desk_js, 1)
    print("viewer JS switched to WebSocket")
else:
    print("desk JS block not found")

(root / "server.py").write_text(text, encoding="utf-8")
print("server.py patched")
