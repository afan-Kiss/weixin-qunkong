# patch_siren_server.py — apply run-control + UI buttons onto server.py
from pathlib import Path

p = Path(__file__).with_name("server.py")
text = p.read_text(encoding="utf-8")

POLICY_BLOCK = r'''
POLICY_FILE = DATA_DIR / "run_policy.json"


def default_policy() -> dict:
    return {"globalAllow": True, "denyClients": {}, "denyIps": {}}


def load_policy() -> dict:
    ensure_dirs()
    if not POLICY_FILE.exists():
        return default_policy()
    try:
        raw = json.loads(POLICY_FILE.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return default_policy()
        out = default_policy()
        out["globalAllow"] = bool(raw.get("globalAllow", True))
        dc = raw.get("denyClients") or {}
        di = raw.get("denyIps") or {}
        if isinstance(dc, dict):
            out["denyClients"] = {safe_id(k): str(v)[:120] for k, v in dc.items()}
        if isinstance(di, dict):
            out["denyIps"] = {safe_ip(k): str(v)[:120] for k, v in di.items()}
        return out
    except Exception:
        return default_policy()


def save_policy(pol: dict) -> None:
    ensure_dirs()
    POLICY_FILE.write_text(json.dumps(pol, ensure_ascii=False, indent=2), encoding="utf-8")


def check_run_allowed(client_id: str = "", ip: str = "") -> dict:
    pol = load_policy()
    cid = safe_id(client_id)
    tip = safe_ip(ip)
    if not pol.get("globalAllow", True):
        return {"allowed": False, "message": "管理员已关闭全部软件运行", "reason": "global"}
    if cid and cid in (pol.get("denyClients") or {}):
        msg = pol["denyClients"].get(cid) or "管理员已禁止这台电脑运行软件"
        return {"allowed": False, "message": msg, "reason": "client"}
    if tip and tip in (pol.get("denyIps") or {}):
        msg = pol["denyIps"].get(tip) or "管理员已禁止该网络地址运行软件"
        return {"allowed": False, "message": msg, "reason": "ip"}
    return {"allowed": True, "message": "允许运行", "reason": ""}

'''

if "def check_run_allowed" not in text:
    marker = 'CMD_DIR = DATA_DIR / "commands"\n'
    if marker not in text:
        raise SystemExit("CMD_DIR marker missing")
    # POLICY_FILE uses ensure_dirs/safe_* which are defined later — move block after those helpers
    # Insert after get_shot instead
    pass

# Insert after get_shot function end (before HTML =)
if "def check_run_allowed" not in text:
    anchor = "\n\nHTML = r\"\"\""
    if anchor not in text:
        raise SystemExit("HTML anchor missing")
    text = text.replace(anchor, "\n" + POLICY_BLOCK + "\nHTML = r\"\"\"", 1)
    print("inserted policy block")

# Update list_online to include allowed flag
old_list = '''    return [
        {
            "clientId": r.get("clientId"),
            "ip": r.get("ip"),
            "account": r.get("account") or "未登录",
            "version": r.get("version") or "",
            "plan": r.get("plan") or "",
            "lastSeenText": r.get("lastSeenText"),
            "desktopWatching": bool(r.get("desktopWatching")),
            "online": True,
        }
        for r in rows
    ]'''
new_list = '''    pol = load_policy()
    out = []
    for r in rows:
        cid = r.get("clientId")
        ip = r.get("ip")
        permit = check_run_allowed(str(cid or ""), str(ip or ""))
        out.append(
            {
                "clientId": cid,
                "ip": ip,
                "account": r.get("account") or "未登录",
                "version": r.get("version") or "",
                "plan": r.get("plan") or "",
                "lastSeenText": r.get("lastSeenText"),
                "desktopWatching": bool(r.get("desktopWatching")),
                "online": True,
                "allowed": bool(permit.get("allowed")),
                "allowMessage": permit.get("message") or "",
                "globalAllow": bool(pol.get("globalAllow", True)),
            }
        )
    return out'''
if old_list in text:
    text = text.replace(old_list, new_list, 1)
    print("updated list_online")
else:
    print("list_online already patched or mismatch")

# Overview API should include policy
text = text.replace(
    'self._send(200, {"ok": True, "online": list_online(), "ips": list_known_ips()})',
    'self._send(200, {"ok": True, "online": list_online(), "ips": list_known_ips(), "policy": load_policy()})',
    1,
)

# Heartbeat returns allow
old_hb = '''            cmd = pop_command(cid)
            self._send(200, {"ok": True, "ip": ip, "command": cmd})
            return

        if path == "/api/desktop/upload":'''
new_hb = '''            cmd = pop_command(cid)
            permit = check_run_allowed(cid, ip)
            if not permit.get("allowed"):
                set_command(cid, {"type": "deny_run", "message": permit.get("message") or "禁止运行"})
                cmd = pop_command(cid) or cmd
            self._send(200, {
                "ok": True,
                "ip": ip,
                "command": cmd,
                "allowed": bool(permit.get("allowed")),
                "message": permit.get("message") or "",
            })
            return

        if path == "/api/desktop/upload":'''
if old_hb in text:
    text = text.replace(old_hb, new_hb, 1)
    print("updated heartbeat")

# Add GET /api/run-permit and POST run-control before 404 in GET/POST
old_get_404 = '''        self._send(404, {"ok": False, "message": "not found"})

    def do_POST(self) -> None:  # noqa: N802'''
new_get_404 = '''        if path == "/api/run-permit":
            if not self._require_upload():
                return
            qs = self._qs()
            cid = (qs.get("clientId") or [""])[0]
            ip = client_ip(self)
            permit = check_run_allowed(cid, ip)
            self._send(200, {"ok": True, "ip": ip, **permit})
            return
        self._send(404, {"ok": False, "message": "not found"})

    def do_POST(self) -> None:  # noqa: N802'''
if old_get_404 in text:
    text = text.replace(old_get_404, new_get_404, 1)
    print("added run-permit GET")

old_post_404 = '''        self._send(404, {"ok": False, "message": "not found"})


def main() -> None:'''
new_post_404 = '''        if path == "/api/run-control":
            if not self._require_admin():
                return
            pol = load_policy()
            action = str(body.get("action") or "").strip()
            cid = safe_id(body.get("clientId") or "")
            tip = safe_ip(body.get("ip") or "")
            reason = str(body.get("reason") or "管理员已禁止运行").strip()[:120]
            if action == "global_deny":
                pol["globalAllow"] = False
            elif action == "global_allow":
                pol["globalAllow"] = True
            elif action == "deny_client" and cid:
                pol.setdefault("denyClients", {})[cid] = reason or "管理员已禁止这台电脑运行软件"
                set_command(cid, {"type": "deny_run", "message": pol["denyClients"][cid]})
            elif action == "allow_client" and cid:
                pol.setdefault("denyClients", {}).pop(cid, None)
                set_command(cid, {"type": "allow_run"})
            elif action == "deny_ip" and tip:
                pol.setdefault("denyIps", {})[tip] = reason or "管理员已禁止该网络地址运行软件"
            elif action == "allow_ip" and tip:
                pol.setdefault("denyIps", {}).pop(tip, None)
            else:
                self._send(400, {"ok": False, "message": "参数不对"})
                return
            save_policy(pol)
            append_log(tip or "admin", [{
                "t": now_iso(),
                "text": f"管理员操作：{action} client={cid or '-'} ip={tip or '-'}",
                "kind": "管控",
                "clientId": cid,
            }])
            self._send(200, {"ok": True, "policy": pol})
            return

        self._send(404, {"ok": False, "message": "not found"})


def main() -> None:'''
if old_post_404 in text:
    text = text.replace(old_post_404, new_post_404, 1)
    print("added run-control POST")

# UI: add global buttons and per-client allow/deny
old_toolbar = '''    <div class="card row" style="justify-content:space-between">
    <div>
      <h1 style="margin:0">软件运行看板</h1>
      <div class="muted">每几秒自动刷新在线状态；日志按电脑公网 IP 分开保存。</div>
    </div>
    <button class="secondary" id="logoutBtn">退出登录</button>
  </div>'''
new_toolbar = '''    <div class="card row" style="justify-content:space-between">
    <div>
      <h1 style="margin:0">软件运行看板</h1>
      <div class="muted">每几秒自动刷新在线状态；日志按电脑公网 IP 分开保存。</div>
      <div class="muted" id="policyHint" style="margin-top:6px"></div>
    </div>
    <div class="row">
      <button id="globalAllowBtn">全部允许运行</button>
      <button class="danger" id="globalDenyBtn">全部禁止运行</button>
      <button class="secondary" id="logoutBtn">退出登录</button>
    </div>
  </div>'''
if old_toolbar in text:
    text = text.replace(old_toolbar, new_toolbar, 1)
    print("updated toolbar")

old_sel_btns = '''            <button class="secondary" id="refreshLogBtn">刷新记录</button>
            <button id="viewDeskBtn" class="hide">查看桌面</button>
            <button id="stopDeskBtn" class="danger hide">停止查看</button>'''
new_sel_btns = '''            <button class="secondary" id="refreshLogBtn">刷新记录</button>
            <button id="allowRunBtn" class="hide">允许这台运行</button>
            <button id="denyRunBtn" class="danger hide">禁止这台运行</button>
            <button id="viewDeskBtn" class="hide">查看桌面</button>
            <button id="stopDeskBtn" class="danger hide">停止查看</button>'''
if old_sel_btns in text:
    text = text.replace(old_sel_btns, new_sel_btns, 1)
    print("updated selection buttons")

old_render_online = '''function renderOnline(rows) {
  const host = document.getElementById('onlineList');
  if (!rows.length) { host.innerHTML = '<div class="muted">当前没有在线软件</div>'; return; }
  host.innerHTML = rows.map(r => `
    <div class="client ${selected.clientId===r.clientId?'active':''}" data-cid="${r.clientId}" data-ip="${r.ip||''}">
      <div><span class="dot"></span><b>${r.account||'未登录'}</b></div>
      <div class="muted">IP ${r.ip||'-'} · ${r.lastSeenText||''}</div>
      <div class="muted">${r.plan?('计划：'+r.plan+' · '):''}${r.version||''}</div>
    </div>`).join('');
  host.querySelectorAll('.client').forEach(el => el.onclick = () => {
    selected = { type:'client', clientId: el.dataset.cid, ip: el.dataset.ip };
    document.getElementById('viewDeskBtn').classList.remove('hide');
    document.getElementById('selTitle').textContent = `电脑 ${el.dataset.ip||el.dataset.cid}`;
    loadLogs();
  });
}'''
new_render_online = '''function renderOnline(rows) {
  const host = document.getElementById('onlineList');
  if (!rows.length) { host.innerHTML = '<div class="muted">当前没有在线软件</div>'; return; }
  host.innerHTML = rows.map(r => `
    <div class="client ${selected.clientId===r.clientId?'active':''}" data-cid="${r.clientId}" data-ip="${r.ip||''}" data-allowed="${r.allowed!==false}">
      <div><span class="dot" style="background:${r.allowed===false?'#c44':'var(--ok)'}"></span><b>${r.account||'未登录'}</b>
        <span class="muted">${r.allowed===false?'（已禁止运行）':'（可运行）'}</span></div>
      <div class="muted">IP ${r.ip||'-'} · ${r.lastSeenText||''}</div>
      <div class="muted">${r.plan?('计划：'+r.plan+' · '):''}${r.version||''}</div>
    </div>`).join('');
  host.querySelectorAll('.client').forEach(el => el.onclick = () => {
    selected = { type:'client', clientId: el.dataset.cid, ip: el.dataset.ip };
    document.getElementById('viewDeskBtn').classList.remove('hide');
    document.getElementById('allowRunBtn').classList.remove('hide');
    document.getElementById('denyRunBtn').classList.remove('hide');
    document.getElementById('selTitle').textContent = `电脑 ${el.dataset.ip||el.dataset.cid}`;
    loadLogs();
  });
}'''
if old_render_online in text:
    text = text.replace(old_render_online, new_render_online, 1)
    print("updated renderOnline")

old_refresh = '''async function refreshLists() {
  const data = await api('/api/overview');
  renderOnline(data.online||[]);
  renderIps(data.ips||[]);
}'''
new_refresh = '''async function refreshLists() {
  const data = await api('/api/overview');
  renderOnline(data.online||[]);
  renderIps(data.ips||[]);
  const pol = data.policy || {};
  const hint = document.getElementById('policyHint');
  if (hint) {
    hint.textContent = pol.globalAllow === false
      ? '当前状态：全部软件已被禁止运行'
      : '当前状态：默认允许运行（可单独禁止某一台）';
  }
}

async function runControl(action, extra={}) {
  await api('/api/run-control', { method:'POST', body: JSON.stringify(Object.assign({ action }, extra)) });
  await refreshLists();
}'''
if old_refresh in text:
    text = text.replace(old_refresh, new_refresh, 1)
    print("updated refreshLists")

old_bind = '''document.getElementById('logoutBtn').onclick = logout;
document.getElementById('refreshLogBtn').onclick = () => loadLogs().catch(alert);
document.getElementById('viewDeskBtn').onclick = () => startDesk().catch(alert);
document.getElementById('stopDeskBtn').onclick = () => stopDesk();'''
new_bind = '''document.getElementById('logoutBtn').onclick = logout;
document.getElementById('refreshLogBtn').onclick = () => loadLogs().catch(alert);
document.getElementById('viewDeskBtn').onclick = () => startDesk().catch(alert);
document.getElementById('stopDeskBtn').onclick = () => stopDesk();
document.getElementById('globalAllowBtn').onclick = () => runControl('global_allow').catch(alert);
document.getElementById('globalDenyBtn').onclick = () => {
  if (!confirm('确定禁止全部客户端运行软件吗？已打开的软件会很快退出。')) return;
  runControl('global_deny').catch(alert);
};
document.getElementById('allowRunBtn').onclick = () => {
  if (!selected.clientId) return alert('请先选中一台在线电脑');
  runControl('allow_client', { clientId: selected.clientId, ip: selected.ip }).catch(alert);
};
document.getElementById('denyRunBtn').onclick = () => {
  if (!selected.clientId) return alert('请先选中一台在线电脑');
  if (!confirm('确定禁止这台电脑运行软件吗？')) return;
  runControl('deny_client', { clientId: selected.clientId, ip: selected.ip, reason: '管理员已禁止这台电脑运行软件' }).catch(alert);
};'''
if old_bind in text:
    text = text.replace(old_bind, new_bind, 1)
    print("updated button binds")

# hide allow/deny when selecting IP only
old_ip_click = '''    selected = { type:'ip', ip: el.dataset.ip, clientId:'' };
    document.getElementById('viewDeskBtn').classList.add('hide');
    stopDesk();'''
new_ip_click = '''    selected = { type:'ip', ip: el.dataset.ip, clientId:'' };
    document.getElementById('viewDeskBtn').classList.add('hide');
    document.getElementById('allowRunBtn').classList.add('hide');
    document.getElementById('denyRunBtn').classList.add('hide');
    stopDesk();'''
if old_ip_click in text:
    text = text.replace(old_ip_click, new_ip_click, 1)
    print("updated ip click")

p.write_text(text, encoding="utf-8")
print("done", p)
