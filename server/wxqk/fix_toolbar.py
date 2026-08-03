from pathlib import Path
p = Path(__file__).with_name("server.py")
text = p.read_text(encoding="utf-8")

old = """  <div class=\"card row\" style=\"justify-content:space-between\">
    <div>
      <h1 style=\"margin:0\">软件运行看板</h1>
      <div class=\"muted\">每几秒自动刷新在线状态；日志按电脑公网 IP 分开保存。</div>
    </div>
    <button class=\"secondary\" id=\"logoutBtn\">退出登录</button>
  </div>"""
new = """  <div class=\"card row\" style=\"justify-content:space-between\">
    <div>
      <h1 style=\"margin:0\">软件运行看板</h1>
      <div class=\"muted\">每几秒自动刷新在线状态；日志按电脑公网 IP 分开保存。</div>
      <div class=\"muted\" id=\"policyHint\" style=\"margin-top:6px\"></div>
    </div>
    <div class=\"row\">
      <button id=\"globalAllowBtn\">全部允许运行</button>
      <button class=\"danger\" id=\"globalDenyBtn\">全部禁止运行</button>
      <button class=\"secondary\" id=\"logoutBtn\">退出登录</button>
    </div>
  </div>"""
if old in text:
    text = text.replace(old, new, 1)
    print("toolbar html fixed")
elif 'id="globalAllowBtn"' in text:
    print("toolbar already ok")
else:
    print("toolbar pattern not found")

old_hb = """            permit = check_run_allowed(cid, ip)
            if not permit.get(\"allowed\"):
                set_command(cid, {\"type\": \"deny_run\", \"message\": permit.get(\"message\") or \"禁止运行\"})
                cmd = pop_command(cid) or cmd
            self._send(200, {"""
new_hb = """            permit = check_run_allowed(cid, ip)
            self._send(200, {"""
if old_hb in text:
    text = text.replace(old_hb, new_hb, 1)
    print("heartbeat spam fixed")
else:
    print("heartbeat already ok or missing")

p.write_text(text, encoding="utf-8")
