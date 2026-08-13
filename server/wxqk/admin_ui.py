"""微信群控 wxqk admin console SPA — light enterprise theme."""
HTML = r"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate"/>
<meta http-equiv="Pragma" content="no-cache"/>
<meta name="admin-ui-build" content="__ADMIN_UI_BUILD__"/>
<title>在线客户端</title>
<style>
:root{
  --page-bg:#f5f7fb;--panel-bg:#fff;--sidebar-bg:#fff;
  --primary:#2563eb;--primary-hover:#1d4ed8;--primary-soft:#eff6ff;
  --success:#16a34a;--success-soft:#ecfdf3;
  --danger:#dc2626;--danger-soft:#fef2f2;
  --warning:#d97706;--warning-soft:#fff7ed;
  --text-main:#172033;--text-secondary:#58657a;--text-muted:#8995a8;
  --border:#e5eaf1;--border-strong:#d6dde8;
  --sidebar-w:228px;--topbar-h:64px;--radius:12px;--shadow:0 2px 8px rgba(15,23,42,.04);
  --font:"Microsoft YaHei","PingFang SC","Segoe UI",sans-serif;
  --banker:#dc2626;--player:#2563eb;--tie:#16a34a;
  --control-h:36px;
}
*,*::before,*::after{box-sizing:border-box}
html,body{height:100%;margin:0;font-family:var(--font);background:var(--page-bg);color:var(--text-main);font-size:14px;line-height:1.5}
button,input,select,textarea{font:inherit}
a{color:var(--primary);text-decoration:none}
.hide{display:none!important}
.muted{color:var(--text-secondary);font-size:13px}
.card{background:var(--panel-bg);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:var(--control-h);padding:0 14px;border-radius:8px;border:1px solid transparent;cursor:pointer;font-weight:500;white-space:nowrap;transition:.15s}
.btn-primary{background:var(--primary);color:#fff}.btn-primary:hover{background:var(--primary-hover)}
.btn-secondary{background:#fff;color:var(--text-main);border-color:var(--border)}.btn-secondary:hover{background:#f8fafc}
.btn-danger{background:var(--danger);color:#fff}.btn-danger:hover{background:#b91c1c}
.btn-ghost{background:transparent;color:var(--text-secondary);border-color:transparent}.btn-ghost:hover{background:#f1f5f9;color:var(--text-main)}
.btn-sm{height:30px;padding:0 10px;font-size:13px;border-radius:6px}
.btn:disabled{opacity:.55;cursor:not-allowed}
.btn-success-soft{background:var(--success-soft);color:var(--success);border-color:#bbf7d0}
.btn-success-soft:hover{background:#dcfce7}
.btn-danger-soft{background:var(--danger-soft);color:var(--danger);border-color:#fecaca}
.btn-danger-soft:hover{background:#fee2e2}
.badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:500}
.badge-ok{background:var(--success-soft);color:var(--success)}
.badge-deny{background:var(--danger-soft);color:var(--danger)}
.badge-neutral{background:#f1f5f9;color:var(--text-secondary)}
.badge-blue{background:var(--primary-soft);color:var(--primary)}
.badge-warn{background:var(--warning-soft);color:var(--warning)}
.input{height:var(--control-h);padding:0 12px;border:1px solid var(--border);border-radius:8px;background:#fff;color:var(--text-main);width:100%}
.input:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px rgba(37,99,235,.12)}
textarea.input{height:auto;padding:10px 12px;resize:vertical;min-height:88px;line-height:1.45}
select.input{padding-right:28px}
.stat-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
.stat-card{padding:16px 18px}
.stat-card .label{font-size:13px;color:var(--text-secondary);margin-bottom:6px}
.stat-card .value{font-size:26px;font-weight:700;line-height:1.1;font-variant-numeric:tabular-nums}
.stat-card .sub{font-size:12px;color:var(--text-muted);margin-top:4px}
.stat-card.compact{padding:12px 14px}
.stat-card.compact .value{font-size:20px}
.stat-card.with-icon{display:flex;gap:12px;align-items:center}
.stat-icon{width:40px;height:40px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;background:var(--primary-soft)}
.stat-icon.ok{background:var(--success-soft)}
.stat-icon.danger{background:var(--danger-soft)}
.stat-icon.warn{background:var(--warning-soft)}
.toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:14px}
.toolbar .grow{flex:1;min-width:160px}
.data-table{width:100%;border-collapse:collapse;font-size:13px}
.data-table th,.data-table td{padding:10px 12px;border-bottom:1px solid var(--border);text-align:left;vertical-align:middle}
.data-table th{font-weight:600;color:var(--text-secondary);background:#fafbfd;font-size:12px;white-space:nowrap}
.data-table tr:hover td{background:#fafbfd}
.data-table tr.selected td{background:var(--primary-soft)}
.data-table td.num{text-align:right;font-variant-numeric:tabular-nums}
.data-table .mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}
.table-wrap{overflow:auto;border:1px solid var(--border);border-radius:10px}
.road-dots{display:inline-flex;gap:3px;flex-wrap:wrap;max-width:220px;align-items:center}
.road-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;background:transparent;border:1.5px solid var(--text-muted);box-sizing:border-box}
.road-dot.b{border-color:var(--banker);background:rgba(220,38,38,.08)}
.road-dot.p{border-color:var(--player);background:rgba(37,99,235,.08)}
.road-dot.t{border-color:var(--tie);background:rgba(22,163,74,.08)}
.rate-good{color:var(--success);font-weight:600}
.rate-bad{color:var(--danger);font-weight:600}
#loginScreen{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--page-bg)}
.login-card{width:100%;max-width:420px;padding:32px 28px}
.login-card h1{margin:0 0 8px;font-size:24px;font-weight:700}
.login-card p{margin:0 0 20px}
#appShell{display:flex;min-height:100vh}
#sidebar{width:var(--sidebar-w);background:var(--sidebar-bg);border-right:1px solid var(--border);display:flex;flex-direction:column;position:fixed;top:0;left:0;bottom:0;z-index:100;transition:transform .2s}
.sidebar-brand{padding:18px 16px;border-bottom:1px solid var(--border)}
.brand-row{display:flex;align-items:center;gap:12px}
.brand-icon{width:36px;height:36px;border-radius:50%;background:var(--primary);color:#fff;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 4px 10px rgba(37,99,235,.25)}
.brand-icon svg{width:18px;height:18px;fill:currentColor}
.sidebar-brand .title{font-size:15px;font-weight:700;color:var(--text-main);line-height:1.2}
.sidebar-brand .sub{font-size:12px;color:var(--text-secondary);margin-top:3px}
.sidebar-nav{flex:1;padding:12px 10px;overflow:auto}
.nav-item{display:flex;align-items:center;gap:10px;height:44px;padding:0 12px;border-radius:8px;color:var(--text-secondary);cursor:pointer;margin-bottom:2px;font-weight:500;transition:.12s;border:none;background:none;width:100%;text-align:left}
.nav-item .nav-ico{width:18px;text-align:center;opacity:.75;flex-shrink:0}
.nav-item:hover{background:#f1f5f9;color:var(--text-main)}
.nav-item.active{background:var(--primary-soft);color:var(--primary);box-shadow:inset 3px 0 0 var(--primary)}
.nav-item.active .nav-ico{opacity:1}
.sidebar-foot{padding:14px 16px;border-top:1px solid var(--border);font-size:12px;color:var(--text-secondary);line-height:1.7}
.sidebar-foot .foot-ok{color:var(--success)}
.sidebar-foot .foot-bad{color:var(--danger)}
#mainWrap{flex:1;margin-left:var(--sidebar-w);display:flex;flex-direction:column;min-width:0}
#topbar{height:var(--topbar-h);background:var(--panel-bg);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 24px;position:sticky;top:0;z-index:50}
.topbar-left{display:flex;align-items:center;gap:12px;min-width:0}
.topbar-title h2{margin:0;font-size:18px;font-weight:700;line-height:1.2}
.topbar-title p{margin:2px 0 0;font-size:12px;color:var(--text-secondary)}
.topbar-right{display:flex;align-items:center;gap:12px;flex-shrink:0}
.conn-badge{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;font-size:12px;background:#f1f5f9;color:var(--text-secondary)}
.conn-badge.ok{background:var(--success-soft);color:var(--success)}
.conn-dot{width:7px;height:7px;border-radius:50%;background:currentColor}
.clock{font-size:13px;color:var(--text-secondary);font-variant-numeric:tabular-nums}
#content{padding:20px 24px 28px;flex:1}
.page-grid{display:grid;gap:16px}
.dash-mid{display:grid;grid-template-columns:7fr 3fr;gap:16px;align-items:start}
.dash-bottom{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}
.clients-layout{display:grid;grid-template-columns:1fr 280px;gap:16px;align-items:start}
.batch-panel{padding:16px;position:sticky;top:calc(var(--topbar-h) + 16px)}
.batch-panel h3{margin:0 0 4px;font-size:14px;font-weight:600}
.batch-panel .sel-sub{margin:0 0 12px;font-size:13px;color:var(--text-secondary)}
.batch-panel .btn{width:100%;margin-bottom:8px}
.batch-hint{font-size:12px;color:var(--text-muted);margin:4px 0 10px;min-height:18px}
.batch-fail-list{margin-top:8px;font-size:12px;color:var(--danger);max-height:120px;overflow:auto}
.dropdown{position:relative;display:inline-block}
.dropdown-menu{display:none}
#floatMenuRoot .dropdown-menu.portal{display:none;position:fixed;background:var(--panel-bg);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(15,23,42,.12);min-width:160px;z-index:3000;padding:4px}
#floatMenuRoot .dropdown-menu.portal.open{display:block}
#floatMenuRoot .dropdown-menu.portal button{display:block;width:100%;text-align:left;padding:8px 12px;border:none;background:none;cursor:pointer;border-radius:6px;font-size:13px;color:var(--text-main)}
#floatMenuRoot .dropdown-menu.portal button:hover{background:#f1f5f9}
#floatMenuRoot .dropdown-menu.portal button.danger{color:var(--danger)}
.modal-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.35);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px}
.modal-box{background:var(--panel-bg);border-radius:var(--radius);box-shadow:0 16px 48px rgba(15,23,42,.15);width:100%;max-width:520px;padding:22px 24px}
.modal-box h3{margin:0 0 14px;font-size:17px}
.modal-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}
.progress-bar{height:6px;background:#e2e8f0;border-radius:999px;overflow:hidden;margin:8px 0}
.progress-bar i{display:block;height:100%;background:var(--primary);transition:width .2s}
.log-layout{display:grid;grid-template-columns:280px 1fr;gap:16px;min-height:480px}
.log-sidebar{padding:14px;display:flex;flex-direction:column;gap:10px;max-height:640px}
.log-list{flex:1;overflow:auto}
.log-item{padding:8px 10px;border-radius:8px;cursor:pointer;font-size:13px;border:1px solid transparent}
.log-item:hover{background:#f8fafc}
.log-item.active{background:var(--primary-soft);border-color:#bfdbfe;color:var(--primary)}
.log-table-wrap{max-height:640px;overflow:auto}
.log-row{padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;line-height:1.5}
.log-row .t{color:var(--text-secondary);font-size:12px;margin-right:8px;font-variant-numeric:tabular-nums;white-space:nowrap;min-width:11.5em;display:inline-block}
.desktop-layout{display:grid;grid-template-columns:240px minmax(0,1fr) 220px;gap:16px;min-height:560px;align-items:stretch}
.desktop-list{padding:12px;max-height:none;overflow:auto}
.desktop-client{padding:10px 12px;border-radius:8px;cursor:pointer;border:1px solid transparent;margin-bottom:4px}
.desktop-client:hover{background:#f8fafc}
.desktop-client.active{background:var(--primary-soft);border-color:#bfdbfe}
.desktop-main{padding:0;overflow:hidden;display:flex;flex-direction:column;min-height:560px;min-width:0}
.desktop-main-head{padding:10px 14px;border-bottom:1px solid var(--border);display:flex;gap:8px;align-items:baseline;flex-shrink:0}
.desktop-main-head strong{font-size:15px}
.desktop-stage{background:#0b1220;border-radius:0;min-height:0;flex:1;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}
.desktop-stage video,.desktop-stage canvas{width:100%;height:100%;object-fit:contain;background:#111;cursor:default;display:none}
.desktop-stage.has-video video{display:block}
.desktop-stage.has-canvas canvas{display:block}
.desktop-stage img{display:none !important}
.desktop-stage #deskHint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#94a3b8;pointer-events:none;padding:16px;text-align:center;z-index:1}
.desktop-stage iframe{width:100%;height:100%;min-height:0;border:0;display:none;background:#0b1220}
.desktop-stage.has-frame iframe{display:block}
.desktop-stage.has-frame{display:block;padding:0}
.desktop-stage.has-frame #deskHint{display:none}
.desktop-stage #deskInputShield{display:none;position:absolute;inset:0;z-index:5;background:transparent;cursor:default}
.desktop-stage.is-viewonly.has-frame #deskInputShield{display:block}
.desktop-stage #deskViewHint{display:none;position:absolute;left:50%;top:14px;transform:translateX(-50%);z-index:6;padding:6px 12px;border-radius:999px;font-size:12px;color:#e2e8f0;background:rgba(15,23,42,.72);pointer-events:none;white-space:nowrap}
.desktop-stage.is-viewonly.has-frame #deskViewHint{display:block}
.desktop-stage #deskRelayStatus{display:none;position:absolute;left:12px;right:12px;bottom:12px;z-index:4;padding:10px 12px;border-radius:8px;font-size:13px;font-weight:600;text-align:center;color:#fff;background:rgba(15,23,42,.82)}
.desktop-stage #deskRelayStatus.is-visible{display:block}
.desktop-stage #deskRelayStatus.is-ok{background:rgba(21,128,61,.88)}
.desktop-stage #deskRelayStatus.is-err{background:rgba(185,28,28,.88)}
.desktop-stage #deskStaleBanner{display:none;position:absolute;top:0;left:0;right:0;z-index:3;padding:8px 12px;font-size:13px;font-weight:600;text-align:center;color:#fff;background:rgba(185,28,28,.88);pointer-events:none}
.desktop-stage.is-stale #deskStaleBanner{display:block}
.desktop-stats{position:absolute;bottom:0;left:0;right:0;padding:4px 10px;font-size:11px;color:#cbd5e1;background:rgba(0,0,0,.55);font-variant-numeric:tabular-nums;z-index:2;display:none;gap:12px;flex-wrap:wrap}
.desktop-stage.is-live .desktop-stats{display:flex}
.desktop-stage.fs{position:fixed;inset:0;z-index:2000;border-radius:0;min-height:100vh}
.desktop-stage.fs video,.desktop-stage.fs canvas,.desktop-stage.fs iframe{max-width:100vw;max-height:100vh}
.desktop-fs-close{display:none;position:absolute;top:16px;right:16px;z-index:2001;width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,.15);color:#fff;border:1px solid rgba(255,255,255,.3);cursor:pointer;font-size:22px;line-height:38px;padding:0}
.desktop-stage.fs .desktop-fs-close{display:block}
.desktop-bottom-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;border-top:1px solid var(--border);background:#fff;flex-shrink:0;min-height:44px}
.desktop-bottom-bar .desk-check{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--text-main);cursor:pointer;user-select:none;padding:4px 2px}
.desktop-bottom-bar .desk-check input{width:16px;height:16px;accent-color:var(--primary);cursor:pointer}
.desktop-bottom-bar .desk-check.is-disabled{opacity:.45;cursor:not-allowed}
.desktop-bottom-bar #deskConnStatus{font-size:12px;color:var(--text-secondary);min-width:4.5em}
.desktop-bottom-bar #deskConnStatus.is-ok{color:var(--success);font-weight:600}
.desktop-bottom-bar #deskConnStatus.is-busy{color:var(--warning)}
.desktop-bottom-bar #deskConnStatus.is-err{color:var(--danger)}
.desktop-toast{position:fixed;left:50%;bottom:72px;transform:translateX(-50%);z-index:2100;padding:8px 14px;border-radius:8px;font-size:13px;color:#fff;background:rgba(15,23,42,.88);opacity:0;pointer-events:none;transition:opacity .2s}
.desktop-toast.is-show{opacity:1}
.desktop-info{padding:16px;font-size:13px;background:var(--panel-bg)}
.desktop-info .desk-side-actions{display:flex;flex-direction:column;gap:8px;margin-top:14px}
.desktop-info .desk-side-actions .btn{width:100%;justify-content:center}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);margin-bottom:10px}
.tab-btn{padding:8px 14px;border:none;background:none;cursor:pointer;color:var(--text-secondary);font-weight:500;border-bottom:2px solid transparent;margin-bottom:-1px}
.tab-btn.active{color:var(--primary);border-bottom-color:var(--primary)}
.quick-actions{display:flex;flex-wrap:wrap;gap:10px}
.announce-results{margin-top:0;padding:14px;max-height:320px;overflow:auto}
.announce-result{padding:8px 0;border-bottom:1px solid var(--border);font-size:13px}
.form-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:12px}
.form-row label.muted{min-width:auto}
.mode-row{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px}
.mode-row label{display:inline-flex;align-items:center;gap:6px;cursor:pointer;color:var(--text-secondary)}
.client-picker{max-height:280px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:8px}
.picker-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;font-size:13px}
.picker-row:hover{background:#f8fafc}
.char-counter{font-size:12px;color:var(--text-muted);margin-top:4px;text-align:right}
.target-summary{margin:10px 0;padding:10px 12px;background:#f8fafc;border-radius:8px;font-size:13px;color:var(--text-secondary)}
.sidebar-toggle{display:none;padding:8px;border:none;background:none;cursor:pointer;font-size:20px;color:var(--text-main)}
.cid-cell{display:flex;flex-direction:column;gap:4px}
.cid-cell .online-tag{align-self:flex-start}
@media(max-width:1100px){
  #sidebar{transform:translateX(-100%)}
  #sidebar.open{transform:translateX(0);box-shadow:4px 0 24px rgba(15,23,42,.12)}
  #mainWrap{margin-left:0}
  .sidebar-toggle{display:inline-flex}
  .two-col,.clients-layout,.dash-mid,.dash-bottom{grid-template-columns:1fr}
  .batch-panel{position:static;order:-1}
  .stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .desktop-layout{grid-template-columns:1fr}
}
@media(max-width:760px){
  .stat-grid{grid-template-columns:1fr}
  .log-layout{grid-template-columns:1fr}
  .log-sidebar{max-height:200px}
  #topbar{padding:0 14px}
  #content{padding:14px 16px 20px}
}
</style>
</head>
<body>
<div id="loginScreen">
  <div class="card login-card">
    <div class="brand-row" style="margin-bottom:16px">
      <div class="brand-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 2l8 3v6c0 5.25-3.4 9.74-8 11-4.6-1.26-8-5.75-8-11V5l8-3zm0 2.2L6 6.1v4.9c0 4.1 2.6 7.6 6 8.8 3.4-1.2 6-4.7 6-8.8V6.1l-6-1.9z"/></svg></div>
      <div><div class="title">微信群控管理平台</div><div class="sub">设备与会话管理中心</div></div>
    </div>
    <p class="muted">请输入管理密码登录</p>
    <input id="loginPwd" class="input" type="password" placeholder="管理密码" autocomplete="current-password"/>
    <div style="margin-top:16px;display:flex;align-items:center;gap:12px">
      <button id="loginBtn" class="btn btn-primary">进入控制台</button>
      <span class="muted" id="loginErr" style="color:var(--danger)"></span>
    </div>
  </div>
</div>
<div id="appShell" class="hide">
  <aside id="sidebar">
    <div class="sidebar-brand">
      <div class="brand-row">
        <div class="brand-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 2l8 3v6c0 5.25-3.4 9.74-8 11-4.6-1.26-8-5.75-8-11V5l8-3zm0 2.2L6 6.1v4.9c0 4.1 2.6 7.6 6 8.8 3.4-1.2 6-4.7 6-8.8V6.1l-6-1.9z"/></svg></div>
        <div>
          <div class="title">微信群控管理平台</div>
          <div class="sub">客户端控制中心</div>
        </div>
      </div>
    </div>
    <nav class="sidebar-nav" id="sidebarNav"></nav>
    <div class="sidebar-foot" id="sidebarFoot">
      <div>服务运行中</div>
      <div id="sidebarConnLine">管理通道异常</div>
      <div>wxqk</div>
      <div id="sidebarVersion" class="muted" style="font-size:11px;margin-top:4px;line-height:1.4">版本加载中…</div>
    </div>
  </aside>
  <div id="mainWrap">
    <header id="topbar">
      <div class="topbar-left">
        <button class="sidebar-toggle" id="sidebarToggle" title="菜单">☰</button>
        <div class="topbar-title">
          <h2 id="pageTitle">控制台概览</h2>
          <p id="pageDesc">查看客户端在线状态、运行权限和最近服务数据。</p>
        </div>
      </div>
      <div class="topbar-right">
        <span class="conn-badge" id="connBadge"><span class="conn-dot"></span><span id="connText">连接异常</span></span>
        <span class="clock"><span class="muted" style="margin-right:4px">北京时间</span><span id="beijingClock">—</span></span>
        <button class="btn btn-ghost btn-sm" id="logoutBtn">退出登录</button>
      </div>
    </header>
    <main id="content"></main>
  </div>
</div>
<div id="modalRoot"></div>
<div id="floatMenuRoot"></div>
<script>
/* ===== state ===== */
const ROUTES = [
  { id:'dashboard', label:'总览', title:'控制台总览', desc:'查看在线客户端与微信会话数据。' },
  { id:'software-accounts', label:'软件账号', title:'软件账号管理', desc:'管理桌面软件的登录账号、使用状态和密码。' },
  { id:'clients', label:'在线客户端', title:'在线客户端', desc:'本机 Electron / Agent 上线列表与批量管控。' },
  { id:'wx-instances', label:'微信实例', title:'微信实例', desc:'桌面端同步的微信进程与连接状态（与软件侧栏同名）。' },
  { id:'wx-groups', label:'群与成员', title:'群与成员', desc:'进群/群事件上报记录。' },
  { id:'wx-qr', label:'二维码任务', title:'二维码任务', desc:'扫码进群相关上报与说明。' },
  { id:'wx-broadcast', label:'消息群发', title:'消息群发', desc:'群发任务说明；执行在桌面端完成。' },
  { id:'wx-contacts', label:'通讯录', title:'通讯录', desc:'好友/群通讯录相关上报。' },
  { id:'wx-wxids', label:'微信 ID 查询', title:'微信 ID 查询', desc:'按会话与上报数据检索 wxid。' },
  { id:'wx-tasks', label:'任务中心', title:'任务中心', desc:'桌面任务说明与云端协同入口。' },
  { id:'wx-logs', label:'客户端日志', title:'客户端日志', desc:'查看桌面软件自动同步的运行与错误记录。' },
  { id:'wx-monitor', label:'会话监控', title:'会话监控', desc:'聊天消息上报列表与图片清理。' },
  { id:'desktop', label:'远程桌面', title:'远程桌面', desc:'通过 MeshCentral 查看画面、键鼠操作与文件管理（客户端静默 Agent）。' },
  { id:'control', label:'运行管控', title:'运行管控', desc:'全局策略、在线权限与 IP 限制管理。' },
  { id:'announcements', label:'公告下发', title:'公告下发', desc:'向在线客户端或指定 IP 发送弹窗公告。' },
  { id:'logs', label:'操作日志', title:'操作日志', desc:'按客户端或 IP 查看白话操作记录。' },
  { id:'releases', label:'版本发布', title:'版本发布', desc:'上传便携包并发布；客户端启动后自动检查更新。' }
];
const HIDDEN_ROUTES = [
  { id:'client-detail', label:'客户端详情', title:'客户端运行详情', desc:'客户端详情。' },
  { id:'roads', label:'路单归档', title:'路单归档', desc:'兼容旧模块。' },
  { id:'formula-stats', label:'公式统计', title:'公式统计', desc:'兼容旧模块。' },
  { id:'formula-replay', label:'公式推演', title:'公式推演', desc:'兼容旧模块。' }
];
const ALL_ROUTES = ROUTES.concat(HIDDEN_ROUTES);
const GLOBAL_DENY_CONFIRM = '该操作会禁止全部客户端继续运行软件，确定继续吗？';
(function bootstrapAdminTokenFromHash(){
  try {
    const raw = String(location.hash || '').replace(/^#/, '');
    let tok = '';
    if (raw.startsWith('token=')) tok = decodeURIComponent((raw.slice(6).split(/[&?]/)[0] || ''));
    else {
      const m = raw.match(/(?:^|[?&])adminToken=([^&]+)/);
      if (m) tok = decodeURIComponent(m[1]);
    }
    if (tok) {
      localStorage.setItem('facai888_admin_token', tok);
      try { localStorage.setItem('wxqk_admin_token', tok); } catch (_) {}
      history.replaceState(null, '', location.pathname + location.search + '#/dashboard');
    }
  } catch (_) {}
})();
const state = {
  token: localStorage.getItem('facai888_admin_token') || (function(){const o=localStorage.getItem('siren_admin_token')||'';if(o){localStorage.setItem('facai888_admin_token',o);localStorage.removeItem('siren_admin_token');}return o;})(), 
  overview: null,
  currentRoute: 'dashboard',
  selection: new Set(),
  clientsFilters: { search:'', status:'all', desktop:'all', version:'all' },
  logsTab: 'online',
  logsSearch: '',
  logsTarget: { type:'', clientId:'', ip:'' },
  desktopSelectedId: '',
  desktopClientId: '',
  desktopSession: 0,
  desktopSessionMode: '', // 'desktop' | 'files'
  desktopInputEnabled: false,
  desktopConnState: 'idle', // idle|connecting|connected|error
  _wxqkRelayMsgBound: false,
  announceMode: 'clients',
  announceSelected: new Set(),
  announceResults: [],
  roadData: null,
  roadFilter: '',
  roadDay: '',
  roadCat: 'all',
  formulaScope: 'all',
  formulaClientId: '',
  formulaIp: '',
  formulaRows: null,
  formulaSearch: '',
  formulaSort: 'placeTotal',
  formulaLoaded: false,
  clientDetailId: '',
  clientDetail: null,
  openDropdown: null,
  sidebarOpen: false,
  batchRunning: false,
  connOk: false
};
let overviewPoller = null;
let roadPoller = null;
let clientDetailPoller = null;
let clockTimer = null;
let modalBusy = false;
let overviewReqSeq = 0;
let roadReqSeq = 0;
let formulaReqSeq = 0;
let logReqSeq = 0;
let clientDetailReqSeq = 0;

/* ===== router ===== */
function parseRoute() {
  const h = (location.hash || '#/dashboard').replace(/^#\/?/, '');
  const id = h.split('?')[0] || 'dashboard';
  return ALL_ROUTES.some(r => r.id === id) ? id : 'dashboard';
}
let navigating = false;
let navigateQueued = null;
function navigate(routeId) {
  if (navigating) { navigateQueued = routeId; return; }
  navigating = true;
  try {
    cleanupCurrentPage();
    state.currentRoute = routeId;
    const want = '#/' + routeId;
    if (location.hash !== want) location.hash = want;
    updateShellMeta(routeId);
    renderPage(routeId);
    updateNavActive();
    startPollersForRoute(routeId);
    if (window.innerWidth < 1100) state.sidebarOpen = false;
    document.getElementById('sidebar').classList.toggle('open', state.sidebarOpen);
  } finally {
    navigating = false;
    if (navigateQueued) {
      const next = navigateQueued;
      navigateQueued = null;
      if (next !== state.currentRoute) navigate(next);
    }
  }
}
function onHashChange() {
  const id = parseRoute();
  if (id === state.currentRoute) return;
  navigate(id);
}
function updateShellMeta(routeId) {
  const r = ALL_ROUTES.find(x => x.id === routeId) || ROUTES[0];
  document.getElementById('pageTitle').textContent = r.title;
  document.getElementById('pageDesc').textContent = r.desc;
  document.title = r.title;
}
function updateNavActive() {
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.route === state.currentRoute);
  });
}
const NAV_ICONS = {
  dashboard:'◈', clients:'◎', control:'⚙', announcements:'✉', roads:'▤',
  'software-accounts':'♙', 'formula-stats':'Σ', 'formula-replay':'↻', logs:'☰', desktop:'▣', releases:'⬆'
};
function renderSidebarNav() {
  document.getElementById('sidebarNav').innerHTML = ROUTES.map(r =>
    '<button class="nav-item" data-route="' + escHtml(r.id) + '"><span class="nav-ico">' +
    (NAV_ICONS[r.id] || '•') + '</span><span>' + escHtml(r.label) + '</span></button>'
  ).join('');
  document.querySelectorAll('.nav-item').forEach(el => {
    el.onclick = () => navigate(el.dataset.route);
  });
}
function cleanupCurrentPage() {
  stopRoadPoller();
  stopClientDetailPoller();
  closeDropdown();
  if (state.currentRoute === 'desktop') stopDesktop();
}
function stopClientDetailPoller() {
  if (clientDetailPoller) {
    clearInterval(clientDetailPoller);
    clientDetailPoller = null;
  }
}
function startPollersForRoute(routeId) {
  stopOverviewPoller();
  stopRoadPoller();
  stopClientDetailPoller();
  if (routeId === 'dashboard' || routeId === 'clients') {
    fetchOverview(true).catch(handleAuthError);
    overviewPoller = setInterval(() => {
      if (state.currentRoute === 'dashboard' || state.currentRoute === 'clients') {
        fetchOverview(true).catch(handleAuthError);
      }
    }, 5000);
  }
  if (routeId === 'client-detail') {
    loadClientDetail().catch(handleAuthError);
    clientDetailPoller = setInterval(() => {
      if (state.currentRoute === 'client-detail') loadClientDetail().catch(handleAuthError);
    }, 8000);
  }
  if (routeId === 'roads') {
    loadRoadOverview().catch(handleAuthError);
    roadPoller = setInterval(() => {
      if (state.currentRoute === 'roads') loadRoadOverview().catch(handleAuthError);
    }, 10000);
  }
}
function stopOverviewPoller() {
  if (overviewPoller) { clearInterval(overviewPoller); overviewPoller = null; }
}
function stopRoadPoller() {
  if (roadPoller) { clearInterval(roadPoller); roadPoller = null; }
}
function stopAllPollers() {
  stopOverviewPoller();
  stopRoadPoller();
  stopClientDetailPoller();
}

/* ===== api ===== */
function publicApiRoot() {
  // Keep brand prefix; empty root would hit portal /api/login by mistake.
  const raw = String(location.pathname || '');
  let p = raw;
  try { p = decodeURIComponent(raw); } catch (_) {}
  if (p === '/wxqk' || p.startsWith('/wxqk/')) return '/wxqk';
  if (p === '/发财888' || p.startsWith('/发财888/')) return '/发财888';
  if (/%E5%8F%91%E8%B4%A2.?888/i.test(raw)) return '/发财888';
  return '';
}
function apiUrl(path) {
  return publicApiRoot() + path;
}
async function api(path, opts) {
  opts = opts || {};
  const headers = Object.assign({ 'Content-Type':'application/json' }, opts.headers || {});
  if (state.token) headers['X-Admin-Token'] = state.token;
  const res = await fetch(apiUrl(path), Object.assign({}, opts, { headers }));
  const renew = (res.headers.get('X-Admin-Token-Renew') || '').trim();
  if (renew) {
    state.token = renew;
    try { localStorage.setItem('facai888_admin_token', renew); } catch (_) {}
  }
  const data = await res.json().catch(() => ({}));
  if (data && data.token && path === '/api/refresh') {
    state.token = String(data.token);
    try { localStorage.setItem('facai888_admin_token', state.token); } catch (_) {}
  }
  if (res.status === 401) {
    const err = new Error('未登录或密码失效');
    err.code = 401;
    throw err;
  }
  if (!res.ok || data.ok === false) throw new Error(data.message || ('请求失败 ' + res.status));
  return data;
}
function handleAuthError(e) {
  if (e && (e.code === 401 || /未登录|密码失效|401/.test(String(e.message || '')))) logout();
}
function stopAdminTokenRefresh() {
  if (window.__facai888TokenRefreshTimer) {
    clearInterval(window.__facai888TokenRefreshTimer);
    window.__facai888TokenRefreshTimer = 0;
  }
}
function ensureAdminTokenRefresh() {
  stopAdminTokenRefresh();
  // Explicit renew every 6h while page open (server also slides on API use).
  window.__facai888TokenRefreshTimer = setInterval(() => {
    if (!state.token) return;
    api('/api/refresh', { method: 'POST', body: '{}' }).catch(handleAuthError);
  }, 6 * 3600 * 1000);
}
async function fetchOverview(silent) {
  const seq = ++overviewReqSeq;
  try {
    const data = await api('/api/overview');
    if (seq !== overviewReqSeq) return data;
    state.overview = data;
    updateConnBadge(true);
    updateSidebarFoot(true);
    patchLivePage(data);
    return data;
  } catch (e) {
    updateConnBadge(false);
    updateSidebarFoot(false);
    throw e;
  }
}
function patchLivePage(data) {
  if (state.currentRoute === 'dashboard') patchDashboard(data);
  if (state.currentRoute === 'clients') patchClientsPage(data);
  if (state.currentRoute === 'control') patchControlPage(data);
  if (state.currentRoute === 'announcements') patchAnnouncePage(data);
  if (state.currentRoute === 'logs') patchLogsPage(data);
  if (state.currentRoute === 'desktop') patchDesktopPage(data);
}
function updateConnBadge(ok) {
  state.connOk = !!ok;
  const el = document.getElementById('connBadge');
  const txt = document.getElementById('connText');
  el.classList.toggle('ok', !!ok);
  txt.textContent = ok ? '连接正常' : '连接异常';
}
function updateSidebarFoot(ok) {
  const line = document.getElementById('sidebarConnLine');
  if (!line) return;
  if (ok) {
    line.className = 'foot-ok';
    line.textContent = '管理通道正常';
  } else {
    line.className = 'foot-bad';
    line.textContent = '管理通道异常';
  }
}

/* ===== helpers ===== */
function esc(s) {
  return escHtml(s);
}
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function fmtTs(sec) {
  const n = Number(sec) || 0;
  if (!n) return '—';
  try {
    return new Date(n * 1000).toLocaleString('zh-CN', {
      timeZone:'Asia/Shanghai', hour12:false,
      year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit'
    });
  } catch (_) { return String(n); }
}
function fmtClock(d) {
  try {
    return d.toLocaleString('zh-CN', { timeZone:'Asia/Shanghai', hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
  } catch (_) { return '—'; }
}
function fmtDate(d) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(d);
    const get = t => (parts.find(p => p.type === t) || {}).value || '';
    return get('year') + '-' + get('month') + '-' + get('day');
  } catch (_) {
    try { return d.toISOString().slice(0, 10); } catch (__) { return ''; }
  }
}
function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  return (v / (1024 * 1024)).toFixed(1) + ' MB';
}
function parseShanghaiWallTime(text) {
  const m = String(text || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const h = Number(m[4]), mi = Number(m[5]), s = Number(m[6] || 0);
  // Interpret wall clock as Asia/Shanghai (UTC+8)
  return Date.UTC(y, mo - 1, d, h - 8, mi, s);
}
function relativeTime(text) {
  if (!text) return '';
  let ms = parseShanghaiWallTime(text);
  if (ms == null) {
    const d = new Date(String(text));
    if (isNaN(d.getTime())) return text;
    ms = d.getTime();
  }
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 0) return '刚刚';
  if (sec < 60) return sec + '秒前';
  if (sec < 3600) return Math.floor(sec / 60) + '分钟前';
  if (sec < 86400) return Math.floor(sec / 3600) + '小时前';
  return Math.floor(sec / 86400) + '天前';
}
function pad2(n) {
  return String(Number(n) || 0).padStart(2, '0');
}
function parseLogTimeParts(raw) {
  const s = String(raw || '').trim();
  let m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) return { date: m[1], time: m[2] + ':' + m[3] + ':' + m[4], full: true };
  m = s.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (m) return { date: '', time: pad2(m[1]) + ':' + m[2] + ':' + m[3], full: false };
  return { date: '', time: s, full: false };
}
function addDaysYmd(ymd, delta) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return ymd;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + Number(delta || 0)));
  return dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
}
/** Unify ops-log timestamps to YYYY-MM-DD HH:MM:SS (newest-first rows). */
function enrichLogDisplayTimes(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const chrono = list.map((r, i) => ({ r, i, p: parseLogTimeParts(r && r.t) })).reverse();
  let curDate = '';
  let prevTime = '';
  // Seed from first known full date (oldest → newest).
  for (const item of chrono) {
    if (item.p.full) { curDate = item.p.date; break; }
  }
  if (!curDate) {
    for (let i = chrono.length - 1; i >= 0; i--) {
      if (chrono[i].p.full) { curDate = chrono[i].p.date; break; }
    }
  }
  if (!curDate) curDate = fmtDate(new Date());
  for (const item of chrono) {
    const p = item.p;
    if (p.full) {
      curDate = p.date;
      prevTime = p.time;
      item.display = p.date + ' ' + p.time;
      continue;
    }
    if (/^\d{2}:\d{2}:\d{2}$/.test(p.time)) {
      if (prevTime && p.time < prevTime) curDate = addDaysYmd(curDate, 1);
      item.display = curDate + ' ' + p.time;
      prevTime = p.time;
      continue;
    }
    item.display = String((item.r && item.r.t) || '—');
  }
  const byIndex = new Array(list.length);
  chrono.forEach(item => { byIndex[item.i] = item.display; });
  return byIndex;
}
function cleanLogText(text) {
  return String(text || '')
    .replace(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\s+/, '')
    .replace(/^\d{1,2}:\d{2}:\d{2}\s+/, '');
}
function pct(v) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  return Number(v).toFixed(1) + '%';
}
function rateClass(v) {
  if (v == null || Number.isNaN(Number(v))) return '';
  return Number(v) >= 50 ? 'rate-good' : 'rate-bad';
}
function hallLabel(cat) {
  const c = String(cat || '').toLowerCase();
  if (c === 'c') return '经典';
  if (c === 'f') return '极速';
  return cat || '—';
}
function displayAccount(r) {
  const a = String((r && r.account) || '').trim();
  if (!a || a === '未登录') return '账号未上报';
  return a;
}
/** True for opaque machine ids (clientId / mesh node hashes) — never show in UI. */
function looksLikeInternalId(s) {
  const t = String(s || '').trim();
  return t.length >= 32 && /^[a-f0-9]+$/i.test(t);
}
/** Human-facing device label — never surface raw clientId in UI. */
function displayClientLabel(r) {
  const a = displayAccount(r);
  if (a && a !== '账号未上报' && !looksLikeInternalId(a)) return a;
  const host = String((r && (r.hostname || r.host)) || '').trim();
  if (host && !looksLikeInternalId(host)) return host;
  const ip = String((r && r.ip) || '').trim();
  if (ip) return '设备 · ' + ip;
  return '未命名设备';
}
function findOnlineByClientId(cid) {
  const id = String(cid || '').trim();
  if (!id) return null;
  const rows = (state.overview && state.overview.online) || [];
  return rows.find(x => String(x.clientId || '') === id) || null;
}
function labelForClientId(cid) {
  const r = findOnlineByClientId(cid);
  return r ? displayClientLabel(r) : '设备';
}
function showClientCredentials(clientId) {
  const rows = (state.overview && state.overview.online) || [];
  const r = rows.find(x => x.clientId === clientId);
  if (!r) return alert('客户端已离线或不存在');
  const acc = String(r.account || '').trim();
  const pwd = String(r.password || '').trim();
  const pwdNote = pwd
    ? '（历史残留；新客户端已停止上报平台密码）'
    : '新客户端不再上报平台密码；请在本地客户端查看。';
  showModal('查看账号',
    '<div class="form-row"><label>设备</label><div>' + escHtml(displayClientLabel(r)) + '</div></div>' +
    '<div class="form-row"><label>IP</label><div class="mono">' + escHtml(r.ip || '—') + '</div></div>' +
    '<div class="form-row"><label>账号</label><input class="input" id="credAccount" readonly value="' + escAttr(acc || '（未上报）') + '"/></div>' +
    '<div class="form-row"><label>密码</label><input class="input" id="credPassword" readonly value="' + escAttr(pwd || '（不可用）') + '"/></div>' +
    '<p class="muted" style="margin:8px 0 0">' + escHtml(pwdNote) + '</p>',
    [
      { label: '复制账号', close: false, onClick: () => { copyText(acc); } },
      { label: '关闭', cls: 'btn-primary' }
    ]
  );
}
function escAttr(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}
function copyText(text) {
  const t = String(text || '');
  if (!t) return alert('没有可复制的内容');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(() => alert('已复制')).catch(() => alert(t));
    return;
  }
  alert(t);
}
function displayPlan(r) {
  if (!r) return '—';
  const name = String(r.plan || '').trim();
  const sum = String(r.planSummary || '').trim();
  if (name && sum) return name + ' · ' + sum;
  return name || sum || '—';
}
function onlineStats(data) {
  const rows = (data && data.online) || [];
  return {
    total: rows.length,
    allowed: rows.filter(r => r.allowed !== false).length,
    denied: rows.filter(r => r.allowed === false).length,
    desktopWatching: rows.filter(r => r.desktopWatching).length
  };
}
function filterClients(rows) {
  const f = state.clientsFilters;
  let out = rows.slice();
  if (f.search) {
    const q = f.search.toLowerCase();
    out = out.filter(r =>
      (r.clientId || '').toLowerCase().includes(q) ||
      (r.account || '').toLowerCase().includes(q) ||
      (r.ip || '').toLowerCase().includes(q) ||
      (r.plan || '').toLowerCase().includes(q) ||
      (r.planSummary || '').toLowerCase().includes(q)
    );
  }
  if (f.status === 'allowed') out = out.filter(r => r.allowed !== false);
  if (f.status === 'denied') out = out.filter(r => r.allowed === false);
  if (f.desktop === 'watching') out = out.filter(r => r.desktopWatching);
  if (f.desktop === 'idle') out = out.filter(r => !r.desktopWatching);
  if (f.version !== 'all') out = out.filter(r => (r.version || '') === f.version);
  // Keep table order stable across heartbeats (server already sorts by firstSeen).
  out.sort((a, b) => {
    const fa = Number(a.firstSeen) || 0;
    const fb = Number(b.firstSeen) || 0;
    if (fa !== fb) return fa - fb;
    return String(a.clientId || '').localeCompare(String(b.clientId || ''));
  });
  return out;
}
function uniqueVersions(rows) {
  const s = new Set();
  rows.forEach(r => { if (r.version) s.add(r.version); });
  return Array.from(s).sort();
}
function renderRoadDots(preview) {
  const s = String(preview || '');
  if (!s) return '<span class="muted">—</span>';
  let html = '<span class="road-dots">';
  for (let i = 0; i < s.length; i++) {
    const c = s[i].toLowerCase();
    let cls = 't';
    if (c === 'b' || c === '\u5e84') cls = 'b';
    else if (c === 'p' || c === '\u95f2') cls = 'p';
    html += '<span class="road-dot ' + cls + '" title="' + escHtml(s[i]) + '"></span>';
  }
  return html + '</span>';
}
function showLogin(on) {
  document.getElementById('loginScreen').classList.toggle('hide', on);
  document.getElementById('appShell').classList.toggle('hide', !on);
}
async function doLogin() {
  const btn = document.getElementById('loginBtn');
  if (btn && btn.disabled) return;
  const pwd = document.getElementById('loginPwd').value;
  document.getElementById('loginErr').textContent = '';
  if (btn) btn.disabled = true;
  try {
    const data = await api('/api/login', { method:'POST', body: JSON.stringify({ password: pwd }) });
    state.token = data.token;
    localStorage.setItem('facai888_admin_token', state.token);
    ensureAdminTokenRefresh();
    showLogin(true);
    renderSidebarNav();
    startClock();
    navigate(parseRoute());
  } catch (e) {
    document.getElementById('loginErr').textContent = e.message || '登录失败';
  } finally {
    if (btn) btn.disabled = false;
  }
}
function logout() {
  stopDesktop();
  stopAllPollers();
  stopAdminTokenRefresh();
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  state.token = '';
  localStorage.removeItem('facai888_admin_token');
  state.overview = null;
  state.selection.clear();
  state.formulaLoaded = false;
  state.formulaRows = null;
  state.connOk = false;
  updateConnBadge(false);
  updateSidebarFoot(false);
  showLogin(false);
}
function startClock() {
  const tick = () => { document.getElementById('beijingClock').textContent = fmtClock(new Date()); };
  tick();
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = setInterval(tick, 1000);
}

/* ===== modal ===== */
function showModal(title, bodyHtml, actions) {
  modalBusy = false;
  const root = document.getElementById('modalRoot');
  root.innerHTML =
    '<div class="modal-backdrop" id="modalBackdrop">' +
    '<div class="modal-box"><h3>' + escHtml(title) + '</h3><div id="modalBody">' + bodyHtml + '</div>' +
    '<div class="modal-actions" id="modalActions"></div></div></div>';
  const actEl = document.getElementById('modalActions');
  (actions || []).forEach(a => {
    const btn = document.createElement('button');
    btn.className = 'btn ' + (a.cls || 'btn-secondary');
    btn.textContent = a.label;
    btn.dataset.role = a.role || '';
    btn.onclick = () => { if (a.onClick) a.onClick(); if (a.close !== false) closeModal(); };
    actEl.appendChild(btn);
  });
  document.getElementById('modalBackdrop').onclick = e => {
    if (e.target.id === 'modalBackdrop' && !modalBusy) closeModal();
  };
}
function closeModal() {
  if (modalBusy) return;
  document.getElementById('modalRoot').innerHTML = '';
}
function confirmDanger(msg, onOk) {
  showModal('确认操作', '<p class="muted">' + escHtml(msg) + '</p>', [
    { label:'取消', cls:'btn-secondary' },
    { label:'确认', cls:'btn-danger', close:false, onClick: () => {
      closeModal();
      Promise.resolve(onOk && onOk()).catch(e => alert((e && e.message) || e || '操作失败'));
    }}
  ]);
}

/* ===== selection ===== */
function toggleSelection(clientId, on) {
  if (on) state.selection.add(clientId); else state.selection.delete(clientId);
  updateSelectionUI();
}
function clearSelection() {
  state.selection.clear();
  updateSelectionUI();
}
function selectAllVisible(ids) {
  ids.forEach(id => state.selection.add(id));
  updateSelectionUI();
}
function updateSelectionUI() {
  const n = state.selection.size;
  const countEl = document.getElementById('selCount');
  if (countEl) countEl.textContent = String(n);
  const hint = document.getElementById('batchEmptyHint');
  if (hint) hint.textContent = n ? '' : '请先勾选客户端';
  document.querySelectorAll('.row-check').forEach(el => {
    el.checked = state.selection.has(el.dataset.cid);
    const tr = el.closest('tr');
    if (tr) tr.classList.toggle('selected', state.selection.has(el.dataset.cid));
  });
  const allCb = document.getElementById('selectAllCb');
  if (allCb) {
    const vis = Array.from(document.querySelectorAll('.row-check')).map(el => el.dataset.cid);
    allCb.checked = vis.length > 0 && vis.every(id => state.selection.has(id));
    allCb.indeterminate = vis.some(id => state.selection.has(id)) && !allCb.checked;
  }
  setBatchButtonsEnabled(n > 0 && !state.batchRunning);
}
function setBatchButtonsEnabled(on) {
  ['batchAllow','batchDeny','batchAnnounce'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !on;
  });
  const clearBtn = document.getElementById('selClear');
  if (clearBtn) clearBtn.disabled = state.selection.size === 0 || state.batchRunning;
}

/* ===== batchRunner ===== */
async function runBatchAction(items, worker, opts) {
  opts = opts || {};
  if (state.batchRunning) return { ok:0, fail:0, total:0, failures:[] };
  const ids = opts.progressIds || {
    wrap:'batchProgress', text:'batchProgressText', bar:'batchProgressBar', fail:'batchFailList'
  };
  const progEl = document.getElementById(ids.wrap);
  const progTxt = document.getElementById(ids.text);
  const progBar = document.getElementById(ids.bar);
  const failEl = document.getElementById(ids.fail);
  const total = (items || []).length;
  if (!total) {
    if (progEl) progEl.classList.remove('hide');
    if (progTxt) progTxt.textContent = '所选客户端已不在线，未执行任何操作';
    if (progBar) progBar.style.width = '0%';
    if (failEl) failEl.innerHTML = '';
    return { ok:0, fail:0, total:0, failures:[] };
  }
  state.batchRunning = true;
  setBatchButtonsEnabled(false);
  const max = opts.concurrency || 3;
  let done = 0, ok = 0, fail = 0;
  const failures = [];
  const setProg = () => {
    if (progTxt) progTxt.textContent = '正在处理 ' + done + ' / ' + total + '  成功 ' + ok + '  失败 ' + fail;
    if (progBar) progBar.style.width = Math.round(done / total * 100) + '%';
    if (progEl) progEl.classList.remove('hide');
    if (failEl) {
      failEl.innerHTML = failures.slice(-8).map(f =>
        '<div>' + escHtml(labelForClientId(f.clientId)) + '：' + escHtml(f.reason) + '</div>'
      ).join('');
    }
  };
  setProg();
  const queue = items.slice();
  const runners = [];
  async function runOne() {
    while (queue.length) {
      const item = queue.shift();
      try { await worker(item); ok++; }
      catch (e) {
        fail++;
        failures.push({ clientId: item.clientId || item.ip || '?', reason: (e && e.message) || '失败' });
      }
      done++;
      setProg();
    }
  }
  for (let i = 0; i < Math.min(max, total); i++) runners.push(runOne());
  await Promise.all(runners);
  if (progTxt) progTxt.textContent = '处理完成：成功 ' + ok + ' 台，失败 ' + fail + ' 台';
  state.batchRunning = false;
  updateSelectionUI();
  await fetchOverview(true).catch(() => {});
  return { ok, fail, total, failures };
}
async function batchAllow() {
  const ids = Array.from(state.selection);
  if (!ids.length || state.batchRunning) return;
  const rows = ((state.overview && state.overview.online) || []).filter(r => ids.includes(r.clientId));
  await runBatchAction(rows, r => api('/api/run-control', {
    method:'POST', body: JSON.stringify({ action:'allow_client', clientId:r.clientId, ip:r.ip })
  }), { concurrency:3 });
  clearSelection();
}
async function batchDeny() {
  const ids = Array.from(state.selection);
  if (!ids.length || state.batchRunning) return;
  confirmDanger('确定禁止选中的 ' + ids.length + ' 台客户端运行吗？', async () => {
    const rows = ((state.overview && state.overview.online) || []).filter(r => ids.includes(r.clientId));
    await runBatchAction(rows, r => api('/api/run-control', {
      method:'POST', body: JSON.stringify({ action:'deny_client', clientId:r.clientId, ip:r.ip, reason:'服务暂不可用' })
    }), { concurrency:3 });
    clearSelection();
  });
}
function openBatchAnnounceModal() {
  const ids = Array.from(state.selection);
  if (!ids.length || state.batchRunning) return;
  showModal('批量发送公告',
    '<label class="muted">标题（最多40字）</label><input id="baTitle" class="input" value="公告" maxlength="40" style="margin:6px 0 12px"/>' +
    '<div class="char-counter" id="baTitleCounter">0/40</div>' +
    '<label class="muted">内容（最多2000字）</label><textarea id="baText" class="input" maxlength="2000" placeholder="公告内容"></textarea>' +
    '<div class="char-counter" id="baCounter">0/2000</div>' +
    '<div id="modalBatchProgress" class="hide" style="margin-top:12px"><div class="progress-bar"><i id="modalBatchProgressBar" style="width:0"></i></div><div class="muted" id="modalBatchProgressText"></div><div id="modalBatchFailList" class="batch-fail-list"></div></div>',
    [{ label:'取消', cls:'btn-secondary', role:'cancel' }, { label:'发送', cls:'btn-primary', role:'send', close:false, onClick: sendBatchAnnounce }]
  );
  const title = document.getElementById('baTitle');
  const ta = document.getElementById('baText');
  const titleCtr = document.getElementById('baTitleCounter');
  const ctr = document.getElementById('baCounter');
  const sync = () => {
    titleCtr.textContent = title.value.length + '/40';
    ctr.textContent = ta.value.length + '/2000';
  };
  title.oninput = sync; ta.oninput = sync; sync();
}
async function sendBatchAnnounce() {
  if (modalBusy || state.batchRunning) return;
  const title = (document.getElementById('baTitle').value || '公告').trim().slice(0, 40);
  const text = (document.getElementById('baText').value || '').trim();
  if (!text) { alert('请填写公告内容'); return; }
  modalBusy = true;
  const actions = document.getElementById('modalActions');
  if (actions) Array.from(actions.querySelectorAll('button')).forEach(b => { b.disabled = true; });
  const ids = Array.from(state.selection);
  const rows = ((state.overview && state.overview.online) || []).filter(r => ids.includes(r.clientId));
  try {
    if (!rows.length) {
      const t = document.getElementById('modalBatchProgressText');
      const p = document.getElementById('modalBatchProgress');
      if (p) p.classList.remove('hide');
      if (t) t.textContent = '所选客户端已不在线，未发送';
      return;
    }
    await runBatchAction(rows, r => api('/api/announce', {
      method:'POST', body: JSON.stringify({ clientId:r.clientId, ip:r.ip, title, text })
    }), {
      concurrency:3,
      progressIds:{ wrap:'modalBatchProgress', text:'modalBatchProgressText', bar:'modalBatchProgressBar', fail:'modalBatchFailList' }
    });
  } finally {
    modalBusy = false;
  }
  closeModal();
  clearSelection();
}

/* ===== MeshCentral remote (admin console) ===== */
function showDeskToast(msg) {
  let el = document.getElementById('deskToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'deskToast';
    el.className = 'desktop-toast';
    document.body.appendChild(el);
  }
  el.textContent = String(msg || '');
  el.classList.add('is-show');
  clearTimeout(showDeskToast._t);
  showDeskToast._t = setTimeout(() => el.classList.remove('is-show'), 1800);
}
function setDeskConnStatus(text, kind) {
  const el = document.getElementById('deskConnStatus');
  if (!el) return;
  el.textContent = String(text || '未连接');
  el.classList.remove('is-ok', 'is-busy', 'is-err');
  if (kind === 'ok') el.classList.add('is-ok');
  else if (kind === 'busy') el.classList.add('is-busy');
  else if (kind === 'err') el.classList.add('is-err');
}
function postDeskInputToFrame(enabled) {
  const frame = document.getElementById('deskFrame');
  if (!frame || !frame.contentWindow) return;
  try {
    frame.contentWindow.postMessage(
      { source: 'wxqk', kind: 'desktop-input', type: 'desktop-input', enabled: !!enabled },
      '*'
    );
  } catch (_) { /* cross-origin until loaded */ }
}
function applyDesktopInputMode(enabled, { toast } = {}) {
  const allow = !!enabled;
  state.desktopInputEnabled = allow;
  const stage = document.getElementById('deskStage');
  const cb = document.getElementById('deskAllowInput');
  const hint = document.getElementById('deskViewHint');
  if (cb && cb.checked !== allow) cb.checked = allow;
  if (stage) {
    const isDesktop = state.desktopSessionMode === 'desktop' && !!state.desktopSession;
    stage.classList.toggle('is-viewonly', isDesktop && !allow);
  }
  if (hint) {
    hint.textContent = allow ? '' : '当前为仅观看模式 · 勾选下方后可操作鼠标键盘';
  }
  postDeskInputToFrame(allow);
  // Retry a few times — Mesh page may still be booting DeskControl
  if (state.desktopSessionMode === 'desktop' && state.desktopSession) {
    [400, 1200, 2500].forEach((ms) => setTimeout(() => postDeskInputToFrame(allow), ms));
  }
  if (toast) showDeskToast(allow ? '已开启远程控制' : '当前为仅观看模式');
}
function syncDesktopBottomBar() {
  const hasSel = !!state.desktopSelectedId;
  const hasSession = !!state.desktopSession;
  const isDesktop = state.desktopSessionMode === 'desktop';
  const map = {
    deskOpenDesktop: hasSel && !hasSession,
    deskOpenFiles: hasSel && !hasSession,
    deskReconnect: hasSession,
    deskRefreshFrame: hasSession,
    deskFullscreen: hasSession,
    deskClose: hasSession,
  };
  Object.keys(map).forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !map[id];
  });
  const wrap = document.getElementById('deskAllowInputWrap');
  const cb = document.getElementById('deskAllowInput');
  if (wrap) wrap.classList.toggle('is-disabled', !(hasSession && isDesktop));
  if (cb) {
    cb.disabled = !(hasSession && isDesktop);
    if (!(hasSession && isDesktop)) cb.checked = false;
  }
}
async function stopDesktop() {
  const frame = document.getElementById('deskFrame');
  const stage = document.getElementById('deskStage');
  if (frame) {
    try { frame.src = 'about:blank'; } catch (_) {}
  }
  if (stage) stage.classList.remove('has-frame', 'fs', 'is-viewonly');
  state.desktopSession = 0;
  state.desktopSessionMode = '';
  state.desktopInputEnabled = false;
  state.desktopConnState = 'idle';
  setDeskRelayStatus('');
  setDeskConnStatus('未连接');
  syncDesktopBottomBar();
  const title = document.getElementById('deskTitle');
  if (title) title.textContent = '远程桌面';
}
function setDeskRelayStatus(text, kind) {
  const el = document.getElementById('deskRelayStatus');
  if (!el) return;
  const msg = String(text || '').trim();
  if (!msg) {
    el.hidden = true;
    el.textContent = '';
    el.classList.remove('is-visible', 'is-ok', 'is-err');
    return;
  }
  el.hidden = false;
  el.textContent = msg;
  el.classList.add('is-visible');
  el.classList.toggle('is-ok', kind === 'ok');
  el.classList.toggle('is-err', kind === 'err');
}
function onWxqkMeshRelayMessage(ev) {
  try {
    const data = ev && ev.data;
    if (!data || data.source !== 'wxqk') return;
    if (!state.desktopSession) return;
    const kind = String(data.kind || data.type || '');
    const st = String(data.state || '');
    if (kind === 'desktop-input') {
      // Mesh acknowledged input mode — keep parent checkbox in sync if needed
      return;
    }
    if (kind !== 'desktop' && kind !== 'files') return;
    if (st === 'page_loaded' || st === 'connecting') {
      state.desktopConnState = 'connecting';
      setDeskConnStatus('连接中', 'busy');
      setDeskRelayStatus(kind === 'files' ? '正在连接文件…' : '正在连接桌面…');
    } else if (st === 'connected') {
      state.desktopConnState = 'connected';
      setDeskConnStatus('已连接', 'ok');
      setDeskRelayStatus(kind === 'files' ? '文件已连接' : '桌面已连接', 'ok');
      if (kind === 'desktop') {
        // Enforce default view-only (or current checkbox) via Mesh DeskControl
        applyDesktopInputMode(!!state.desktopInputEnabled, { toast: false });
      }
      setTimeout(() => {
        const el = document.getElementById('deskRelayStatus');
        if (el && /已连接/.test(el.textContent || '')) setDeskRelayStatus('');
      }, 2200);
    } else if (st === 'failed') {
      state.desktopConnState = 'error';
      setDeskConnStatus('连接失败', 'err');
      setDeskRelayStatus(kind === 'files' ? '文件连接失败，请重试' : '桌面连接失败，请重试', 'err');
    }
  } catch (_) { /* ignore */ }
}
function renderDesktopShell() {
  return '<div class="desktop-layout">'
    + '<div class="card desktop-list">'
    + '<div class="toolbar" style="margin-bottom:8px">'
    + '<input id="deskSearch" class="input grow" placeholder="搜索账号 / IP"/>'
    + '<button class="btn btn-secondary btn-sm" id="deskRefreshList">刷新</button></div>'
    + '<div id="deskClientList" class="muted">加载中…</div></div>'
    + '<div class="card desktop-main">'
    + '<div class="desktop-main-head">'
    + '<strong id="deskTitle">远程桌面</strong>'
    + '<span class="muted" id="deskSub">选择左侧客户端</span></div>'
    + '<div class="desktop-stage is-viewonly" id="deskStage">'
    + '<iframe id="deskFrame" title="mesh-desktop" allow="clipboard-read; clipboard-write; fullscreen" tabindex="-1"></iframe>'
    + '<div id="deskInputShield" title="仅观看模式"></div>'
    + '<div id="deskViewHint">当前为仅观看模式 · 勾选下方后可操作鼠标键盘</div>'
    + '<div id="deskHint">选择左侧在线客户端，在下方点击「打开桌面」查看画面。<br/>默认仅观看，勾选「允许操作鼠标键盘」后才能控制远端。</div>'
    + '<div id="deskRelayStatus" class="desk-relay-status" hidden></div>'
    + '<button type="button" class="desktop-fs-close" id="deskFsExit" title="退出全屏">×</button></div>'
    + '<div class="desktop-bottom-bar" id="deskBottomBar">'
    + '<label class="desk-check is-disabled" id="deskAllowInputWrap">'
    + '<input type="checkbox" id="deskAllowInput" disabled/>'
    + '<span>允许操作鼠标键盘</span></label>'
    + '<span id="deskConnStatus">未连接</span>'
    + '<span class="grow"></span>'
    + '<button class="btn btn-primary btn-sm" id="deskOpenDesktop" disabled>打开桌面</button>'
    + '<button class="btn btn-secondary btn-sm" id="deskOpenFiles" disabled>文件管理</button>'
    + '<button class="btn btn-secondary btn-sm" id="deskReconnect" disabled>重连</button>'
    + '<button class="btn btn-ghost btn-sm" id="deskRefreshFrame" disabled>刷新</button>'
    + '<button class="btn btn-ghost btn-sm" id="deskFullscreen" disabled>全屏</button>'
    + '<button class="btn btn-ghost btn-sm" id="deskClose" disabled>断开</button>'
    + '</div></div>'
    + '<div class="card desktop-info"><h3 style="margin:0 0 10px;font-size:14px">设备状态</h3>'
    + '<div id="deskInfo" class="muted">未选择</div>'
    + '<div class="desk-side-actions">'
    + '<button class="btn btn-secondary btn-sm" id="deskAutoBind" disabled>重新绑定</button>'
    + '<button class="btn btn-ghost btn-sm" id="deskOpenTab" disabled>浏览器新窗口</button></div>'
    + '<p class="muted" style="margin-top:16px;font-size:12px;line-height:1.6">默认仅观看远程画面；勾选下方「允许操作鼠标键盘」后才会向远端发送键鼠。</p></div></div>';
}
function deskFilteredClients(data) {
  const rows = (data && data.online) || [];
  const q = String((document.getElementById('deskSearch') || {}).value || '').trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(r => {
    const blob = [r.clientId, r.account, r.hostname, r.host, r.ip, r.version].map(x => String(x || '').toLowerCase()).join(' ');
    return blob.includes(q);
  });
}
function patchDesktopPage(data) {
  const host = document.getElementById('deskClientList');
  if (!host) return;
  const rows = deskFilteredClients(data || state.overview);
  if (!rows.length) {
    host.innerHTML = '<p class="muted">暂无在线客户端</p>';
    return;
  }
  host.innerHTML = rows.map(r => {
    const cid = String(r.clientId || '');
    const active = cid && cid === state.desktopSelectedId ? ' active' : '';
    const ip = String(r.ip || '').trim() || '—';
    return '<div class="desktop-client' + active + '" data-cid="' + escHtml(cid) + '">'
      + '<div style="font-weight:600">' + escHtml(displayClientLabel(r)) + '</div>'
      + '<div class="muted" style="margin-top:4px;font-size:12px">' + escHtml(ip) + '</div></div>';
  }).join('');
  host.querySelectorAll('.desktop-client').forEach(el => {
    el.onclick = () => selectDesktopClient(el.dataset.cid || '');
  });
  if (state.desktopSelectedId && !rows.some(r => String(r.clientId || '') === state.desktopSelectedId)) {
    /* keep selection for offline reopen attempt */
  }
}
async function selectDesktopClient(clientId) {
  const cid = String(clientId || '').trim();
  state.desktopSelectedId = cid;
  state.desktopClientId = cid;
  patchDesktopPage(state.overview);
  const enabled = !!cid;
  const side = ['deskAutoBind', 'deskOpenTab'];
  side.forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !enabled;
  });
  syncDesktopBottomBar();
  if (enabled && !state.desktopSession) {
    const od = document.getElementById('deskOpenDesktop');
    const of = document.getElementById('deskOpenFiles');
    if (od) od.disabled = false;
    if (of) of.disabled = false;
  }
  const online = findOnlineByClientId(cid) || {};
  const sub = document.getElementById('deskSub');
  if (sub) {
    if (!cid) sub.textContent = '选择左侧客户端';
    else {
      const ip = String(online.ip || '').trim();
      sub.textContent = displayClientLabel(online) + (ip ? (' · ' + ip) : '');
    }
  }
  const title = document.getElementById('deskTitle');
  if (title && !state.desktopSession) title.textContent = '远程桌面';
  await refreshDesktopMeshStatus();
}
async function refreshDesktopMeshStatus() {
  const info = document.getElementById('deskInfo');
  const cid = state.desktopSelectedId;
  if (!info) return;
  if (!cid) { info.innerHTML = '<span class="muted">未选择</span>'; return; }
  info.textContent = '查询中…';
  const online = findOnlineByClientId(cid) || {};
  const label = displayClientLabel(online);
  const ip = String(online.ip || '').trim() || '—';
  let serverBanner = '';
  try {
    const health = await api('/api/mesh/health');
    if (health && health.enabled === false) {
      serverBanner = '<div style="margin-bottom:10px"><span class="badge badge-deny">远程维护服务器未配置</span></div>';
    } else if (health && health.meshReachable === false) {
      serverBanner = '<div style="margin-bottom:10px"><span class="badge badge-deny">远程维护服务器不可达</span></div>';
    } else if (health && health.loginKeyConfigured === false) {
      serverBanner = '<div style="margin-bottom:10px"><span class="badge badge-deny">远程维护服务器未配置</span></div>';
    } else if (health && health.ok) {
      serverBanner = '<div style="margin-bottom:10px"><span class="badge badge-ok">远程维护服务正常</span></div>';
    }
  } catch (_) { /* device status still useful */ }
  try {
    const st = await api('/api/mesh/status?clientId=' + encodeURIComponent(cid));
    const ready = !!(st.ready || st.remoteState === 'ready');
    const remoteState = String(st.remoteState || '');
    const userMsg = st.userMessage || st.message || '';
    let statusLabel = '';
    if (serverBanner.indexOf('未配置') >= 0 || serverBanner.indexOf('不可达') >= 0) {
      // Server-level problem dominates device wording
      statusLabel = '<span class="badge badge-neutral">等待远程维护服务器就绪…</span>';
    } else if (ready) {
      statusLabel = '<span class="badge badge-ok">设备已就绪</span>';
    } else if (remoteState === 'bound_offline' || st.code === 'MESH_AGENT_OFFLINE') {
      statusLabel = '<span class="badge badge-neutral">设备 Agent 离线</span>';
    } else if (remoteState === 'unverified' || st.code === 'MESH_SYNC_FAILED' || st.code === 'MESH_WS_ERROR') {
      statusLabel = '<span class="badge badge-neutral">正在等待设备上线…</span>';
    } else if (remoteState === 'preparing' || st.code === 'MESH_PREPARING') {
      statusLabel = '<span class="badge badge-neutral">设备 Agent 正在启动…</span>';
    } else if (remoteState === 'unbound' || st.code === 'MESH_NO_MATCH' || st.code === 'MESH_NODE_MISSING') {
      statusLabel = '<span class="badge badge-neutral">设备尚未绑定</span>';
    } else if (st.ok === false && st.code === 'MESH_DISABLED') {
      statusLabel = '<span class="badge badge-deny">远程维护服务器未配置</span>';
    } else if (st.ok === false || remoteState === 'error') {
      statusLabel = '<span class="badge badge-deny">远程服务准备失败</span>';
    } else {
      statusLabel = '<span class="badge badge-neutral">' + escHtml(userMsg || '正在准备服务…') + '</span>';
    }
    info.innerHTML = serverBanner
      + '<div><b>设备</b><div>' + escHtml(label) + '</div>'
      + '<div class="muted" style="margin-top:4px;font-size:12px">IP ' + escHtml(ip) + '</div></div>'
      + '<div style="margin-top:10px"><b>状态</b><div>' + statusLabel + '</div></div>'
      + (userMsg && ready ? '<div style="margin-top:10px" class="muted">' + escHtml(userMsg) + '</div>' : '');
  } catch (e) {
    info.innerHTML = serverBanner
      + '<span class="badge badge-deny">远程服务准备失败</span><div class="muted" style="margin-top:8px">' + escHtml(e.message || e) + '</div>';
  }
}
function friendlyMeshError(data) {
  const code = String((data && data.code) || '');
  const remoteState = String((data && data.remoteState) || '');
  if (code === 'MESH_DISABLED' || code === 'MESH_WS_UNAVAILABLE' || code === 'MESH_SYNC_FAILED' || code === 'MESH_WS_ERROR') {
    return 'MeshCentral 不可用';
  }
  if (code === 'MESH_AMBIGUOUS' || code === 'MESH_HOSTNAME_AMBIGUOUS') return '发现重复设备';
  if (code === 'MESH_INSTALL_FAILED' || code === 'MESH_AGENT_FILES_MISSING') return 'MeshAgent 安装失败';
  if (code === 'MESH_AGENT_OFFLINE' || code === 'MESH_NODE_TIMEOUT' || remoteState === 'bound_offline') {
    return '正在等待客户端远程服务上线…';
  }
  if (code === 'MESH_NO_MATCH' || code === 'MESH_UNBOUND' || code === 'MESH_NODE_MISSING' || code === 'MESH_PREPARING' || code === 'MESH_PREPARE_FAILED') {
    return '正在绑定设备…';
  }
  const msg = String((data && (data.userMessage || data.message)) || '');
  if (/未绑定|MESH_|meshNode|auto-bind|Mesh node/i.test(msg)) return '远程服务准备失败';
  return msg || '远程服务准备失败';
}
async function openMeshSession(mode, { forceTab } = {}) {
  const cid = state.desktopSelectedId;
  if (!cid) { alert('请先选择客户端'); return; }
  const path = mode === 'files' ? '/api/mesh/session/files' : '/api/mesh/session/desktop';
  const label = mode === 'files' ? '文件管理' : '远程桌面';
  const online = ((state.overview && state.overview.online) || []).find(r => String(r.clientId || '') === cid) || {};
  const hostname = String(online.hostname || online.host || '').trim();
  const sessionBody = JSON.stringify({ clientId: cid, hostname: hostname || undefined });
  const bindBody = JSON.stringify({
    clientId: cid,
    allowHostnameFallback: true,
    hostname: hostname || undefined,
    agentName: cid ? ('WXQK-' + cid) : undefined,
  });
  try {
    let data = await api(path, { method: 'POST', body: sessionBody });
    // Self-heal once only when session failed without a usable live session
    if (!data || !data.ok || !data.embedUrl || data.ready === false) {
      const bind = await api('/api/mesh/auto-bind', {
        method: 'POST',
        body: bindBody,
      });
      if (bind && (bind.ready || (bind.ok && bind.online))) {
        await refreshDesktopMeshStatus();
        data = await api(path, { method: 'POST', body: sessionBody });
      } else if (!data || !data.ok) {
        alert(friendlyMeshError(bind || data));
        await refreshDesktopMeshStatus();
        return;
      }
    }
    if (!data || !data.ok || !data.embedUrl) {
      alert(friendlyMeshError(data) || ('无法打开' + label));
      await refreshDesktopMeshStatus();
      return;
    }
    state.desktopSession = Date.now();
    state.desktopSessionMode = mode === 'files' ? 'files' : 'desktop';
    state.desktopInputEnabled = false;
    state.desktopConnState = 'connecting';
    const url = String(data.embedUrl);
    if (forceTab) {
      window.open(url, '_blank', 'noopener');
      return;
    }
    const frame = document.getElementById('deskFrame');
    const stage = document.getElementById('deskStage');
    if (!frame || !stage) {
      window.open(url, '_blank', 'noopener');
      return;
    }
    setDeskConnStatus('连接中', 'busy');
    setDeskRelayStatus(mode === 'files' ? '正在连接文件…' : '正在连接桌面…');
    // Tear down previous relay before attaching a new clean session
    try { frame.src = 'about:blank'; } catch (_) {}
    frame.src = url;
    stage.classList.add('has-frame');
    // Default view-only for desktop; files has no KVM input gate
    if (mode === 'desktop') {
      stage.classList.add('is-viewonly');
      const cb = document.getElementById('deskAllowInput');
      if (cb) cb.checked = false;
      applyDesktopInputMode(false, { toast: false });
    } else {
      stage.classList.remove('is-viewonly');
    }
    syncDesktopBottomBar();
    const title = document.getElementById('deskTitle');
    if (title) title.textContent = label;
    await refreshDesktopMeshStatus();
  } catch (e) {
    handleAuthError(e);
    setDeskRelayStatus((mode === 'files' ? '文件' : '桌面') + '连接失败', 'err');
    alert(e.message || ('打开' + label + '失败'));
  }
}
async function autoBindDesktopClient() {
  const cid = state.desktopSelectedId;
  if (!cid) return;
  const online = ((state.overview && state.overview.online) || []).find(r => String(r.clientId || '') === cid) || {};
  const hostname = String(online.hostname || online.host || '').trim();
  try {
    const data = await api('/api/mesh/auto-bind', {
      method: 'POST',
      body: JSON.stringify({
        clientId: cid,
        allowHostnameFallback: true,
        hostname: hostname || undefined,
        agentName: 'WXQK-' + cid,
      }),
    });
    alert(data && (data.ready || (data.ok && data.online)) ? '服务已就绪' : friendlyMeshError(data));
    await refreshDesktopMeshStatus();
  } catch (e) {
    alert(e.message || '远程服务准备失败');
  }
}
function setDeskFullscreen(on) {
  const stage = document.getElementById('deskStage');
  if (!stage) return;
  stage.classList.toggle('fs', !!on);
}
function bindDesktopPageEvents() {
  const search = document.getElementById('deskSearch');
  if (search) search.oninput = () => patchDesktopPage(state.overview);
  const refresh = document.getElementById('deskRefreshList');
  if (refresh) refresh.onclick = () => fetchOverview(true).then(() => {
    patchDesktopPage(state.overview);
    return refreshDesktopMeshStatus();
  }).catch(alert);
  const openD = document.getElementById('deskOpenDesktop');
  if (openD) openD.onclick = () => openMeshSession('desktop');
  const openF = document.getElementById('deskOpenFiles');
  if (openF) openF.onclick = () => openMeshSession('files');
  const bind = document.getElementById('deskAutoBind');
  if (bind) bind.onclick = () => autoBindDesktopClient();
  const tab = document.getElementById('deskOpenTab');
  if (tab) tab.onclick = () => openMeshSession(state.desktopSessionMode === 'files' ? 'files' : 'desktop', { forceTab: true });
  const recon = document.getElementById('deskReconnect');
  if (recon) recon.onclick = () => {
    const mode = state.desktopSessionMode === 'files' ? 'files' : 'desktop';
    if (!state.desktopSelectedId) return;
    openMeshSession(mode);
  };
  const refreshFrame = document.getElementById('deskRefreshFrame');
  if (refreshFrame) refreshFrame.onclick = () => {
    const frame = document.getElementById('deskFrame');
    if (!frame || !state.desktopSession) return;
    try {
      const u = frame.src;
      frame.src = 'about:blank';
      setTimeout(() => { frame.src = u; applyDesktopInputMode(!!state.desktopInputEnabled, { toast: false }); }, 50);
      setDeskConnStatus('连接中', 'busy');
    } catch (e) { alert(e.message || '刷新失败'); }
  };
  const fs = document.getElementById('deskFullscreen');
  if (fs) fs.onclick = () => {
    const stage = document.getElementById('deskStage');
    setDeskFullscreen(!(stage && stage.classList.contains('fs')));
  };
  const fsExit = document.getElementById('deskFsExit');
  if (fsExit) fsExit.onclick = () => setDeskFullscreen(false);
  const close = document.getElementById('deskClose');
  if (close) close.onclick = () => stopDesktop();
  const allow = document.getElementById('deskAllowInput');
  if (allow) {
    allow.onchange = () => {
      if (allow.disabled) return;
      applyDesktopInputMode(!!allow.checked, { toast: true });
    };
  }
  // Block keyboard reaching iframe while view-only (Mesh DeskControl is primary gate)
  if (!state._deskViewKeyGuard) {
    document.addEventListener('keydown', (ev) => {
      if (!state.desktopSession || state.desktopSessionMode !== 'desktop') return;
      if (state.desktopInputEnabled) return;
      const frame = document.getElementById('deskFrame');
      if (!frame) return;
      if (document.activeElement === frame) {
        try { frame.blur(); } catch (_) {}
        ev.preventDefault();
      }
    }, true);
    state._deskViewKeyGuard = true;
  }
  if (!state._wxqkRelayMsgBound) {
    window.addEventListener('message', onWxqkMeshRelayMessage);
    state._wxqkRelayMsgBound = true;
  }
  syncDesktopBottomBar();
  if (state.desktopSelectedId) selectDesktopClient(state.desktopSelectedId);
}

/* ===== dropdown ===== */
function closeDropdown() {
  const root = document.getElementById('floatMenuRoot');
  if (root) root.innerHTML = '';
  state.openDropdown = null;
}
function bindMoreMenuActions(menu) {
  menu.querySelectorAll('button').forEach(el => {
    el.onclick = () => {
      const act = el.dataset.act, cid = el.dataset.cid, ip = el.dataset.ip;
      closeDropdown();
      if (act === 'creds') showClientCredentials(cid);
      else if (act === 'detail') { state.clientDetailId = cid; navigate('client-detail'); }
      else if (act === 'allow') runControl('allow_client', { clientId:cid, ip }).catch(alert);
      else if (act === 'deny') confirmDanger('确定禁止此客户端？', () => runControl('deny_client', { clientId:cid, ip, reason:'服务暂不可用' }).catch(alert));
      else if (act === 'logs') { state.logsTarget = { type:'client', clientId:cid, ip }; navigate('logs'); }
    };
  });
}
function toggleDropdown(cid, btn) {
  if (state.openDropdown === cid) { closeDropdown(); return; }
  closeDropdown();
  const src = document.getElementById('menu-' + cid);
  const root = document.getElementById('floatMenuRoot');
  if (!src || !root || !btn) return;
  const menu = src.cloneNode(true);
  menu.id = 'float-menu-' + cid;
  menu.classList.add('portal', 'open');
  root.appendChild(menu);
  const rect = btn.getBoundingClientRect();
  menu.style.top = Math.min(window.innerHeight - 8, rect.bottom + 4) + 'px';
  menu.style.right = Math.max(8, window.innerWidth - rect.right) + 'px';
  menu.style.left = 'auto';
  state.openDropdown = cid;
  bindMoreMenuActions(menu);
  const close = e => {
    if (!menu.contains(e.target) && e.target !== btn) {
      closeDropdown();
      document.removeEventListener('click', close);
    }
  };
  setTimeout(() => document.addEventListener('click', close), 0);
}

/* ===== page renderers ===== */
function renderPage(routeId) {
  const host = document.getElementById('content');
  if (routeId === 'dashboard') host.innerHTML = renderDashboardShell();
  else if (routeId === 'software-accounts') host.innerHTML = renderSoftwareAccountsShell();
  else if (routeId === 'clients') host.innerHTML = renderClientsShell();
  else if (routeId === 'control') host.innerHTML = renderControlShell();
  else if (routeId === 'announcements') host.innerHTML = renderAnnounceShell();
  else if (routeId === 'roads') host.innerHTML = renderRoadsShell();
  else if (routeId === 'formula-stats') host.innerHTML = renderFormulaStatsShell();
  else if (routeId === 'formula-replay') host.innerHTML = renderFormulaReplayShell();
  else if (routeId === 'logs') host.innerHTML = renderLogsShell();
  else if (routeId === 'desktop') host.innerHTML = renderDesktopShell();
  else if (routeId === 'releases') host.innerHTML = renderReleasesShell();
  else if (routeId === 'client-detail') host.innerHTML = renderClientDetailShell();
  else if (routeId.startsWith('wx-')) host.innerHTML = renderWxFeatureShell(routeId);
  bindPageEvents(routeId);
  if (routeId === 'dashboard') { loadWxDashboard().catch(() => {}); patchDashboard(state.overview); }
  if (routeId === 'software-accounts') loadSoftwareAccounts().catch(handleAuthError);
  if (routeId === 'clients') patchClientsPage(state.overview);
  if (routeId === 'control') patchControlPage(state.overview);
  if (routeId === 'announcements') patchAnnouncePage(state.overview);
  if (routeId === 'formula-stats') {
    if (!state.formulaLoaded) loadFormulaStats().catch(handleAuthError);
    else renderFormulaStatsView();
  }
  if (routeId === 'logs') patchLogsPage(state.overview);
  if (routeId === 'client-detail') patchClientDetailPage(state.clientDetail);
  if (routeId === 'desktop') patchDesktopPage(state.overview);
  if (routeId === 'releases') { /* loaded in bindPageEvents */ }
  if (routeId.startsWith('wx-')) loadWxFeaturePage(routeId).catch(handleAuthError);
  if (['control','announcements','logs','formula-stats','wx-monitor','wx-groups'].includes(routeId)) {
    fetchOverview(true).catch(handleAuthError);
  }
}

function renderSoftwareAccountsShell() {
  return '<div class="card" style="padding:18px"><div class="toolbar"><div><h3 style="margin:0 0 4px">软件账号</h3><div class="muted">密码经过加密保存，管理员可以重置，不能查看原密码。</div></div><span class="grow"></span><button class="btn btn-secondary btn-sm" id="accountRefresh">刷新列表</button></div>' +
    '<div class="table-wrap"><table class="data-table"><thead><tr><th>账号</th><th>状态</th><th>注册时间</th><th>最后登录</th><th>操作</th></tr></thead><tbody id="softwareAccountBody"><tr><td colspan="5" class="muted">正在加载…</td></tr></tbody></table></div></div>';
}

async function loadSoftwareAccounts() {
  const body = document.getElementById('softwareAccountBody');
  if (!body) return;
  const data = await api('/api/admin/software-accounts');
  const rows = Array.isArray(data.rows) ? data.rows : [];
  body.innerHTML = rows.map(r => '<tr><td>' + esc(r.username) + '</td><td>' + (r.status === 'ACTIVE' ? '<span class="tag tag-success">正常</span>' : '<span class="tag tag-danger">已禁用</span>') + '</td><td>' + esc(fmtTs(r.createdAt)) + '</td><td>' + esc(fmtTs(r.lastLoginAt)) + '</td><td><div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn btn-secondary btn-sm account-status" data-id="' + esc(r.id) + '" data-enable="' + (r.status === 'ACTIVE' ? '0' : '1') + '">' + (r.status === 'ACTIVE' ? '禁用' : '启用') + '</button><button class="btn btn-secondary btn-sm account-reset" data-id="' + esc(r.id) + '">重置密码</button><button class="btn btn-danger btn-sm account-delete" data-id="' + esc(r.id) + '">删除</button></div></td></tr>').join('') || '<tr><td colspan="5" class="muted">还没有注册账号</td></tr>';
  body.querySelectorAll('.account-status').forEach(btn => btn.onclick = async () => { if (!confirm(btn.dataset.enable === '1' ? '确定启用这个账号吗？' : '禁用后该账号会立即退出软件，确定继续吗？')) return; await api('/api/admin/software-accounts/status',{method:'POST',body:JSON.stringify({id:btn.dataset.id,enabled:btn.dataset.enable==='1'})}); await loadSoftwareAccounts(); });
  body.querySelectorAll('.account-reset').forEach(btn => btn.onclick = async () => { const password=prompt('请输入新密码（至少8位）'); if (password === null) return; if (password.length < 8) { alert('新密码至少需要8位'); return; } await api('/api/admin/software-accounts/reset-password',{method:'POST',body:JSON.stringify({id:btn.dataset.id,password})}); alert('密码已重置，该账号需要重新登录'); await loadSoftwareAccounts(); });
  body.querySelectorAll('.account-delete').forEach(btn => btn.onclick = async () => { if (!confirm('删除后无法恢复，该账号也会立即退出软件。确定删除吗？')) return; await api('/api/admin/software-accounts/delete',{method:'POST',body:JSON.stringify({id:btn.dataset.id})}); await loadSoftwareAccounts(); });
  const refresh = document.getElementById('accountRefresh'); if (refresh) refresh.onclick = () => loadSoftwareAccounts().catch(e => alert(e.message || '刷新失败'));
}

function renderWxFeatureShell(routeId) {
  const meta = {
    'wx-instances': { title: '微信实例', hint: '桌面端启动微信并注入后会上线到「在线客户端」。此处展示协同说明与最近会话上报。' },
    'wx-groups': { title: '群与成员', hint: '来自桌面端 /api/wx/groups 上报的进群与群事件。' },
    'wx-qr': { title: '二维码任务', hint: '扫码进群在桌面端执行（qrscan + get_a8key）；云端保留任务说明与会话监控入口。' },
    'wx-broadcast': { title: '消息群发', hint: '群发勾选与风控在桌面端执行；云端用于监控发出的会话消息。' },
    'wx-contacts': { title: '通讯录', hint: '通讯录保存到手机等操作在桌面端完成；云端展示相关群/好友上报。' },
    'wx-wxids': { title: '微信 ID 查询', hint: '在上报的消息与群事件中检索 wxid / 会话 ID。' },
    'wx-tasks': { title: '任务中心', hint: '任务队列在桌面端 SQLite；云端可查看同步任务，必要时用「远程桌面」协助。' },
    'wx-logs': { title: '客户端日志', hint: '桌面软件每分钟自动同步最近的运行与错误记录，不包含聊天正文和密码。' },
    'wx-monitor': { title: '会话监控', hint: '聊天消息与图片上报；可清理服务端图片。' }
  }[routeId] || { title: '微信功能', hint: '' };
  return '<div class="stack">' +
    '<div class="card" style="padding:18px">' +
    '<h3 style="margin:0 0 8px;font-size:16px">' + meta.title + '</h3>' +
    '<p class="muted" style="margin:0 0 14px">' + meta.hint + '</p>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">' +
    '<button class="btn btn-secondary btn-sm" id="wxRefresh">刷新数据</button>' +
    '<button class="btn btn-secondary btn-sm" id="wxGoDesktop">远程桌面</button>' +
    (routeId === 'wx-monitor' ? '<button class="btn btn-danger btn-sm" id="wxCleanupImages">清理7天前图片</button>' : '') +
    '<input id="wxSearch" class="input" placeholder="搜索 wxid / 内容…" style="max-width:260px"/>' +
    '</div>' +
    '<div class="muted" id="wxHint">加载中…</div>' +
    '<div class="table-wrap" style="margin-top:10px"><table class="data-table"><thead><tr id="wxHead"></tr></thead><tbody id="wxBody"></tbody></table></div>' +
    '</div></div>';
}

async function loadWxFeaturePage(routeId) {
  const hint = document.getElementById('wxHint');
  const head = document.getElementById('wxHead');
  const body = document.getElementById('wxBody');
  if (!hint || !head || !body) return;
  const q = (document.getElementById('wxSearch')?.value || '').trim().toLowerCase();
  if (['wx-instances','wx-groups','wx-contacts','wx-tasks','wx-logs','wx-monitor','wx-wxids'].includes(routeId)) {
    const sync = await api('/api/admin/wx-sync');
    const snapshots = Array.isArray(sync.rows) ? sync.rows : [];
    const key = routeId === 'wx-instances' ? 'instances'
      : routeId === 'wx-groups' ? 'groups'
      : (routeId === 'wx-contacts' || routeId === 'wx-wxids') ? 'contacts'
      : (routeId === 'wx-logs' || routeId === 'wx-monitor') ? 'logs'
      : 'tasks';
    let rows = snapshots.flatMap(s => (Array.isArray(s[key]) ? s[key].map(r => ({ clientId:s.clientId, capturedAt:s.capturedAt, ...r })) : []));
    if (q) rows = rows.filter(r => JSON.stringify(r).toLowerCase().includes(q));
    if (routeId === 'wx-instances') {
      head.innerHTML = '<th>所属电脑</th><th>微信昵称</th><th>微信号</th><th>状态</th><th>同步时间</th>';
      body.innerHTML = rows.map(r => '<tr><td>'+esc(labelForClientId(r.clientId))+'</td><td>'+esc(r.nickname||'昵称读取中')+'</td><td>'+esc(r.accountWxid||'—')+'</td><td>'+esc(r.status||'—')+'</td><td>'+esc(r.capturedAt||'—')+'</td></tr>').join('') || '<tr><td colspan="5" class="muted">暂无微信实例同步</td></tr>';
    } else if (routeId === 'wx-groups') {
      head.innerHTML = '<th>所属电脑</th><th>群聊</th><th>群ID</th><th>人数</th><th>是否已保存</th>';
      body.innerHTML = rows.map(r => '<tr><td>'+esc(labelForClientId(r.clientId))+'</td><td>'+esc(r.name||'群聊')+'</td><td>'+esc(r.roomId||'—')+'</td><td>'+esc(r.members == null ? '—' : r.members)+'</td><td>'+(r.saved?'已保存':'未保存')+'</td></tr>').join('') || '<tr><td colspan="5" class="muted">暂无群聊同步</td></tr>';
    } else if (routeId === 'wx-contacts' || routeId === 'wx-wxids') {
      head.innerHTML = '<th>所属电脑</th><th>昵称</th><th>微信号</th><th>备注</th><th>类型</th>';
      body.innerHTML = rows.map(r => '<tr><td>'+esc(labelForClientId(r.clientId))+'</td><td>'+esc(r.nickname||'—')+'</td><td>'+esc(r.wxid||'—')+'</td><td>'+esc(r.remark||'—')+'</td><td>'+(r.isGroup?'群聊':'好友')+'</td></tr>').join('') || '<tr><td colspan="5" class="muted">暂无通讯录同步</td></tr>';
    } else if (routeId === 'wx-logs' || routeId === 'wx-monitor') {
      head.innerHTML = '<th>所属电脑</th><th>时间</th><th>级别</th><th>微信实例</th><th>功能</th><th>内容</th><th>原因</th>';
      body.innerHTML = rows.map(r => '<tr><td>'+esc(labelForClientId(r.clientId))+'</td><td>'+esc(r.time||'—')+'</td><td>'+esc(r.level==='ERROR'?'错误':r.level==='WARNING'?'提醒':'普通')+'</td><td>'+esc(r.instanceId||'本机')+'</td><td>'+esc(r.operation||r.module||'软件运行')+'</td><td>'+esc(r.message||'—')+'</td><td>'+esc(r.reason||'—')+'</td></tr>').join('') || '<tr><td colspan="7" class="muted">暂无客户端同步数据</td></tr>';
    } else {
      head.innerHTML = '<th>所属电脑</th><th>任务</th><th>类型</th><th>状态</th><th>进度</th>';
      body.innerHTML = rows.map(r => '<tr><td>'+esc(labelForClientId(r.clientId))+'</td><td>'+esc(r.name||'—')+'</td><td>'+esc(r.type||'—')+'</td><td>'+esc(r.status||'—')+'</td><td>'+esc((Number(r.success||0)+Number(r.failed||0)+Number(r.skipped||0))+'/'+Number(r.total||0))+'</td></tr>').join('') || '<tr><td colspan="5" class="muted">暂无任务同步</td></tr>';
    }
    hint.textContent = '已加载 ' + rows.length + ' 条，数据由桌面软件自动同步。';
    return;
  }
  let path = '/api/wx/messages?limit=80';
  let cols = ['时间', '账号', '会话', '发送者', '内容'];
  if (routeId === 'wx-groups' || routeId === 'wx-contacts') {
    path = '/api/wx/groups?limit=80';
    cols = ['时间', '账号', '群ID', '事件', '详情'];
  } else if (routeId === 'wx-monitor') {
    path = '/api/wx/messages?limit=100';
  } else if (routeId === 'wx-wxids') {
    path = '/api/wx/messages?limit=120';
    cols = ['时间', '账号', '会话/wxid', '发送者', '摘要'];
  } else if (routeId === 'wx-instances' || routeId === 'wx-qr' || routeId === 'wx-broadcast' || routeId === 'wx-tasks') {
    const ov = state.overview || await api('/api/overview');
    const rows = (ov.online || ov.clients || []);
    head.innerHTML = '<th>账号</th><th>版本</th><th>状态</th><th>IP</th><th>桌面</th>';
    body.innerHTML = rows.slice(0, 50).map(r => {
      return '<tr><td>' + esc(displayClientLabel(r)) + '</td><td>' +
        esc(r.version || '') + '</td><td>' + (r.online === false ? '离线' : '在线') + '</td><td>' +
        esc(r.ip || '') + '</td><td>' + (r.desktopWatching ? '推流中' : '—') + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="muted">暂无在线客户端。请先启动桌面端 Electron（会自动注册 Agent）。</td></tr>';
    hint.textContent = '共 ' + rows.length + ' 条在线记录。执行微信操作请在桌面软件对应页面，或进入「远程桌面」协助。';
    return;
  }
  head.innerHTML = cols.map(c => '<th>' + c + '</th>').join('');
  const data = await api(path);
  let rows = Array.isArray(data.rows) ? data.rows : [];
  if (q) {
    rows = rows.filter(r => JSON.stringify(r).toLowerCase().includes(q));
  }
  if (path.includes('/groups')) {
    body.innerHTML = rows.map(r => '<tr><td>' + esc(r.t || r.createdAt || '') + '</td><td>' + esc(r.account_wxid || r.accountWxid || '') +
      '</td><td>' + esc(r.group_id || r.groupId || r.chatroom || '') + '</td><td>' + esc(r.event || r.kind || '') +
      '</td><td>' + esc(r.detail || r.text || JSON.stringify(r).slice(0, 120)) + '</td></tr>').join('') ||
      '<tr><td colspan="5" class="muted">暂无群事件上报</td></tr>';
  } else {
    body.innerHTML = rows.map(r => '<tr><td>' + esc(r.t || r.createdAt || '') + '</td><td>' + esc(r.account_wxid || r.accountWxid || '') +
      '</td><td>' + esc(r.talker || r.session || r.to || '') + '</td><td>' + esc(r.sender || r.from || '') +
      '</td><td>' + esc(r.content || r.text || '') + '</td></tr>').join('') ||
      '<tr><td colspan="5" class="muted">暂无消息上报。桌面端回调接入后会写入 /api/wx/messages。</td></tr>';
  }
  hint.textContent = '已加载 ' + rows.length + ' 条';
}

async function loadWxDashboard() {
  const hint = document.getElementById('dashRoadHint');
  const body = document.getElementById('dashRoadBody');
  if (!hint || !body) return;
  try {
    const data = await api('/api/wx/messages?limit=8');
    const rows = Array.isArray(data.rows) ? data.rows : [];
    hint.textContent = rows.length ? ('最近 ' + rows.length + ' 条会话') : '暂无会话上报';
    body.innerHTML = rows.map(r => '<tr><td>' + esc(r.account_wxid || '') + '</td><td>' + esc(r.talker || r.session || '') +
      '</td><td>' + esc((r.content || r.text || '').slice(0, 40)) + '</td><td>' + esc(r.sender || '') +
      '</td><td>' + esc(r.t || '') + '</td></tr>').join('') ||
      '<tr><td colspan="5" class="muted">等待桌面端上报</td></tr>';
  } catch (e) {
    hint.textContent = '会话数据暂不可用';
    body.innerHTML = '<tr><td colspan="5" class="muted">' + esc(e.message || e) + '</td></tr>';
  }
}

function renderDashboardShell() {
  return '<div class="page-grid">' +
    '<div class="stat-grid" id="dashStats"></div>' +
    '<div class="dash-mid">' +
    '<div class="card" style="padding:18px"><h3 style="margin:0 0 14px;font-size:15px">在线客户端摘要（前8台）</h3><div class="table-wrap"><table class="data-table"><thead><tr>' +
    '<th>账号</th><th>计划</th><th>版本</th><th>状态</th><th>IP</th><th>最后活跃</th></tr></thead><tbody id="dashClients"></tbody></table></div></div>' +
    '<div class="card" style="padding:18px"><h3 style="margin:0 0 12px;font-size:15px">快速入口</h3><div class="quick-actions" style="flex-direction:column;align-items:stretch">' +
    '<button class="btn btn-secondary" id="dashGoDesktop">远程桌面</button>' +
    '<button class="btn btn-secondary" id="dashGoMonitor">会话监控</button>' +
    '<button class="btn btn-secondary" id="dashAnnounce">发布公告</button>' +
    '<button class="btn btn-secondary" id="dashClientsBtn">查看全部客户端</button></div></div></div>' +
    '<div class="dash-bottom">' +
    '<div class="card" style="padding:18px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
    '<h3 style="margin:0;font-size:15px">会话监控（最近上报）</h3><button class="btn btn-secondary btn-sm" id="dashRoadRefresh">刷新</button></div>' +
    '<div class="muted" id="dashRoadHint">加载中…</div><div class="table-wrap" style="margin-top:10px"><table class="data-table"><thead><tr>' +
    '<th>账号</th><th>会话</th><th>内容</th><th>发送者</th><th>时间</th></tr></thead><tbody id="dashRoadBody"></tbody></table></div></div>' +
    '<div class="card" style="padding:18px"><h3 style="margin:0 0 12px;font-size:15px">最近操作</h3>' +
    '<p class="muted" id="dashOpsHint">进入「操作日志」页面选择客户端或 IP 后查看记录。</p></div></div></div>';
}

function renderClientsShell() {
  return '<div class="page-grid"><div class="stat-grid" id="clientStats"></div>' +
    '<div class="clients-layout"><div><div class="card" style="padding:16px">' +
    '<div class="toolbar"><input id="clientSearch" class="input grow" placeholder="搜索账号或 IP"/>' +
    '<select id="clientStatusFilter" class="input" style="width:auto">' +
    '<option value="all">全部状态</option><option value="allowed">允许运行</option><option value="denied">禁止运行</option></select>' +
    '<select id="clientDesktopFilter" class="input" style="width:auto">' +
    '<option value="all">全部桌面状态</option><option value="watching">正在监控</option><option value="idle">未监控</option></select>' +
    '<select id="clientVersionFilter" class="input" style="width:auto"><option value="all">全部版本</option></select>' +
    '<button class="btn btn-secondary btn-sm" id="clientRefresh">刷新</button></div>' +
    '<div class="table-wrap"><table class="data-table"><thead><tr>' +
    '<th><input type="checkbox" id="selectAllCb"/></th><th>设备</th><th>账号</th><th>计划</th><th>版本</th><th>运行状态</th><th>桌面</th><th>最后心跳</th><th>IP</th><th>操作</th>' +
    '</tr></thead><tbody id="clientsBody"></tbody></table></div>' +
    '</div></div><div class="batch-panel card" id="batchPanel">' +
    '<h3>批量操作</h3><p class="sel-sub">已选择 <b id="selCount">0</b> 个客户端</p>' +
    '<div class="batch-hint" id="batchEmptyHint">请先勾选客户端</div>' +
    '<button class="btn btn-success-soft" id="batchAllow" disabled>批量允许运行</button>' +
    '<button class="btn btn-danger-soft" id="batchDeny" disabled>批量禁止运行</button>' +
    '<button class="btn btn-secondary" id="batchAnnounce" disabled>批量发送公告</button>' +
    '<button class="btn btn-ghost" id="selClear" disabled>取消选择</button>' +
    '<div id="batchProgress" class="hide" style="margin-top:12px"><div class="progress-bar"><i id="batchProgressBar" style="width:0"></i></div><div class="muted" id="batchProgressText"></div><div id="batchFailList" class="batch-fail-list"></div></div>' +
    '<p class="muted" style="margin:12px 0 0">并发上限 3</p></div></div></div>';
}

function renderControlShell() {
  return '<div class="page-grid"><div class="card" style="padding:18px" id="globalPolicyCard">' +
    '<h3 style="margin:0 0 12px">全局策略</h3><div id="globalPolicyText" class="muted">加载中…</div>' +
    '<div class="quick-actions" style="margin-top:14px">' +
    '<button class="btn btn-primary" id="ctrlGlobalAllow">全部允许运行</button>' +
    '<button class="btn btn-danger" id="ctrlGlobalDeny">全部禁止运行</button></div></div>' +
    '<div class="card" style="padding:18px"><h3 style="margin:0 0 12px">在线客户端权限</h3>' +
    '<div class="table-wrap"><table class="data-table"><thead><tr>' +
    '<th>设备</th><th>账号</th><th>IP</th><th>当前状态</th><th>限制原因</th><th>操作</th></tr></thead><tbody id="ctrlOnlineBody"></tbody></table></div></div>' +
    '<div class="card" style="padding:18px"><h3 style="margin:0 0 12px">受限制的 IP</h3>' +
    '<div class="table-wrap"><table class="data-table"><thead><tr><th>IP</th><th>原因</th><th>操作</th></tr></thead><tbody id="denyIpsBody"></tbody></table></div></div></div>';
}

function renderAnnounceShell() {
  return '<div class="page-grid two-col">' +
    '<div class="card" style="padding:18px">' +
    '<h3 style="margin:0 0 14px">选择目标</h3>' +
    '<div class="mode-row">' +
    '<label><input type="radio" name="annMode" value="clients"/> 选择在线客户端</label>' +
    '<label><input type="radio" name="annMode" value="ip"/> 指定 IP</label></div>' +
    '<div id="annClientsBox"><div class="toolbar" style="margin-bottom:8px">' +
    '<input id="annClientSearch" class="input grow" placeholder="筛选客户端"/>' +
    '<button class="btn btn-secondary btn-sm" id="annSelectAll">全选筛选结果</button></div>' +
    '<div class="client-picker" id="annClientPicker"></div></div>' +
    '<div id="annIpBox" class="hide"><label class="muted">目标 IP</label><input id="annIp" class="input" placeholder="例如 1.2.3.4" style="margin-top:6px"/></div>' +
    '</div>' +
    '<div class="card" style="padding:18px">' +
    '<h3 style="margin:0 0 14px">编写公告</h3>' +
    '<label class="muted">标题</label><input id="annTitle" class="input" value="公告" maxlength="40" style="margin-top:6px"/>' +
    '<div class="char-counter" id="annTitleCounter">0/40</div>' +
    '<label class="muted" style="display:block;margin-top:10px">内容</label><textarea id="annText" class="input" maxlength="2000" placeholder="公告正文" style="margin-top:6px"></textarea>' +
    '<div class="char-counter" id="annCounter">0/2000</div>' +
    '<div class="target-summary" id="annTargetSummary">未选择目标</div>' +
    '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
    '<button class="btn btn-primary" id="annSend">发送公告</button>' +
    '<button class="btn btn-secondary" id="annClear">清空</button></div>' +
    '<div id="annBatchProgress" class="hide" style="margin-top:12px"><div class="progress-bar"><i id="annProgBar" style="width:0"></i></div><div class="muted" id="annProgText"></div></div>' +
    '<div class="announce-results" style="margin-top:16px;padding:0"><h3 style="margin:0 0 12px;font-size:14px">本次会话发送记录</h3><div id="annResults"><p class="muted">暂无</p></div></div>' +
    '</div></div>';
}

function renderRoadsShell() {
  return '<div class="page-grid"><div class="stat-grid" id="roadStats"></div>' +
    '<div class="card" style="padding:18px"><div class="toolbar">' +
    '<input id="roadFilter" class="input grow" placeholder="搜索桌台 / 标题 / 账号 / 客户端"/>' +
    '<input id="roadDay" type="date" class="input" style="width:auto"/>' +
    '<select id="roadCat" class="input" style="width:auto">' +
    '<option value="all">全部大厅</option><option value="c">经典</option><option value="f">极速</option></select>' +
    '<button class="btn btn-secondary btn-sm" id="roadRefresh">手动刷新</button></div>' +
    '<div class="muted" id="roadHint">加载中…</div>' +
    '<p class="muted" style="margin:8px 0 0">统计结果仅描述已记录的历史样本。即使结果达到统计显著，也不表示未来结果会保持一致。</p>' +
    '<div class="table-wrap" style="margin-top:10px"><table class="data-table"><thead><tr>' +
    '<th>桌台</th><th>标题</th><th>日期</th><th>大厅类型</th><th>靴号</th><th class="num">手数</th>' +
    '<th>质量</th><th>连续</th><th>几何</th><th class="num">来源</th><th>尾路</th><th>账号</th><th>客户端</th><th>更新时间</th></tr></thead><tbody id="roadBody"></tbody></table></div></div></div>';
}

function renderFormulaStatsShell() {
  return '<div class="page-grid"><div class="stat-grid" id="formulaSummary"></div>' +
    '<div class="card" style="padding:18px"><div class="toolbar">' +
    '<select id="formulaScope" class="input" style="width:auto"><option value="all">全部电脑</option><option value="client">指定客户端</option><option value="ip">指定 IP</option></select>' +
    '<select id="formulaClientSel" class="input hide" style="width:auto;min-width:180px"></select>' +
    '<input id="formulaIpInput" class="input hide" style="width:auto;min-width:160px" placeholder="IP 地址"/>' +
    '<input id="formulaSearch" class="input grow" placeholder="搜索公式"/>' +
    '<select id="formulaSort" class="input" style="width:auto">' +
    '<option value="placeTotal">按下注总数</option><option value="winRate">按综合胜率</option><option value="wilson">按 Wilson 下界</option></select>' +
    '<button class="btn btn-primary btn-sm" id="formulaLoad">重新加载</button></div>' +
    '<div class="muted" id="formulaHint">首次进入自动加载全部范围（不自动刷新）</div>' +
    '<p class="muted" style="margin:8px 0 0">实际统计：来自客户端上报的真实/模拟下注事件；胜率不含未结算。统计结果仅描述已记录的历史样本。即使结果达到统计显著，也不表示未来结果会保持一致。</p></div>' +
    '<div class="card" style="padding:18px"><div class="table-wrap"><table class="data-table"><thead><tr>' +
    '<th>公式</th><th>真实/模拟</th><th class="num">有效样本</th><th class="num">原始胜率</th>' +
    '<th class="num">Wilson区间</th><th class="num">ROI</th><th class="num">最大回撤</th>' +
    '<th>样本结论</th><th>备注</th><th>最近</th></tr></thead><tbody id="formulaBody"></tbody></table></div>' +
    '<details style="margin-top:12px"><summary class="muted">展开高级字段说明</summary>' +
    '<p class="muted">高级指标含：未结算、未知、跨靴数、贝叶斯平滑胜率、Walk-forward ROI、FDR q值、连亏等。默认表格只展示核心可信度字段。</p></details></div></div>';
}

function renderFormulaReplayShell() {
  const today = fmtDate(new Date());
  return '<div class="page-grid"><div class="card" style="padding:18px"><h3 style="margin:0 0 14px">路单公式推演</h3>' +
    '<p class="muted" style="margin:0 0 8px">匹配算法：严格物理大路 · 数据范围：默认 A/B 级</p>' +
    '<p class="muted" style="margin:0 0 14px">本结果为历史数据回放，不代表未来结果。胜率 = 赢 ÷（赢 + 输），和局不计入分母。</p>' +
    '<div class="form-row"><input id="replayPattern" class="input grow" placeholder="公式，如：庄庄闲闲"/></div>' +
    '<div class="form-row"><select id="replayMode" class="input" style="width:auto">' +
    '<option value="follow">追龙</option><option value="against">反向</option><option value="banker">固定庄</option><option value="player">固定闲</option></select>' +
    '<select id="replayQuality" class="input" style="width:auto"><option value="AB">质量 A/B</option><option value="ABC">质量 A/B/C</option></select>' +
    '<label class="muted"><input type="checkbox" id="replayHeavy"/> 含 Bootstrap/Walk-forward</label></div>' +
    '<div class="form-row"><label class="muted">从</label><input id="replayFrom" type="date" class="input" style="width:auto" value="' + today + '"/>' +
    '<label class="muted">到</label><input id="replayTo" type="date" class="input" style="width:auto" value="' + today + '"/></div>' +
    '<div class="form-row"><input id="replayTableId" class="input" style="width:140px" placeholder="桌台ID（可选）"/>' +
    '<select id="replayCat" class="input" style="width:auto">' +
    '<option value="">全部</option><option value="c">经典(c)</option><option value="f">极速(f)</option></select></div>' +
    '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
    '<button class="btn btn-primary" id="replayCalc">计算胜率</button>' +
    '<button class="btn btn-secondary" id="replayReset">重置</button></div>' +
    '<div class="muted" id="replayHint" style="margin-top:12px">尚未计算</div></div>' +
    '<div id="replayResults" class="stat-grid"></div>' +
    '<p class="muted" style="margin-top:12px">统计结果仅描述已记录的历史样本。即使结果达到统计显著，也不表示未来结果会保持一致。</p></div>';
}

function renderLogsShell() {
  return '<div class="log-layout"><div class="card log-sidebar">' +
    '<div class="tabs"><button class="tab-btn active" data-logtab="online">在线客户端</button><button class="tab-btn" data-logtab="ips">已知 IP</button></div>' +
    '<input id="logSearch" class="input" placeholder="搜索…"/>' +
    '<div class="log-list" id="logSideList"></div></div>' +
    '<div class="card" style="padding:16px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
    '<h3 style="margin:0;font-size:15px" id="logTitle">请选择左侧目标</h3>' +
    '<button class="btn btn-secondary btn-sm" id="logRefresh">刷新</button></div>' +
    '<div class="log-table-wrap" id="logBox"><p class="muted">进入「操作日志」页面选择客户端或 IP 后查看记录。</p></div></div></div>';
}

function renderReleasesShell() {
  return '<div class="stack">' +
    '<div class="card" style="padding:18px">' +
    '<h3 style="margin:0 0 8px;font-size:16px">上传并发布</h3>' +
    '<p class="muted" style="margin:0 0 14px">只需上传一个安装包（如 微信群控系统v1.1.exe），点「上传并发布」。客户端启动后会弹窗下载、自动替换并重启，无需其它文件。</p>' +
    '<div><label class="muted">安装包 .exe</label><input id="relFile" class="input" type="file" accept=".exe,application/octet-stream"/></div>' +
    '<label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13px;cursor:pointer">' +
    '<input type="checkbox" id="relMandatory" checked/> 强制更新（启动时必须更新）</label>' +
    '<div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap;align-items:center">' +
    '<button class="btn btn-primary" id="relPublishBtn">上传并发布</button>' +
    '<button class="btn btn-secondary" id="relRefreshBtn">刷新</button>' +
    '<span class="muted" id="relMsg"></span></div>' +
    '<div id="relUploadWrap" class="hide" style="margin-top:12px">' +
    '<div class="progress-bar" style="height:10px"><i id="relUploadBar" style="width:0%"></i></div>' +
    '<div class="muted" id="relProgress" style="margin-top:8px"></div></div></div>' +
    '<div class="card" style="padding:18px"><h3 style="margin:0 0 10px;font-size:15px">当前状态</h3>' +
    '<div id="relCurrent" class="muted">加载中…</div></div>' +
    '<div class="card" style="padding:18px"><h3 style="margin:0 0 10px;font-size:15px">已上传安装包</h3>' +
    '<div class="table-wrap"><table><thead><tr><th>文件</th><th>大小</th><th>时间</th></tr></thead>' +
    '<tbody id="relPkgBody"><tr><td colspan="3" class="muted">加载中…</td></tr></tbody></table></div></div></div>';
}

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}
function releaseDisplayName(m) {
  m = m || {};
  const fn = String(m.fileName || '').trim();
  if (fn && !/^\d{8}-\d{6}\.exe$/i.test(fn)) return fn;
  const ver = String(m.version || '').trim().replace(/^v/i, '');
  if (ver && !/^\d{8}-/.test(ver)) return '微信群控系统v' + ver + '.exe';
  return fn || '安装包';
}
function patchReleasesPage(data) {
  if (!data || !data.ok) return;
  const m = data.manifest || {};
  const cur = document.getElementById('relCurrent');
  if (cur) {
    if (!m.buildId && !m.fileName && !m.downloadURL) {
      cur.innerHTML = '<span class="muted">尚未发布任何版本</span>';
    } else {
      const shown = releaseDisplayName(m);
      const when = m.publishedAt ? new Date(m.publishedAt) : null;
      const whenText = when && !isNaN(when.getTime()) ? when.toLocaleString() : (m.publishedAt || '');
      cur.innerHTML =
        '<div>已发布 · <b>' + escHtml(shown) + '</b>' +
        ' · ' + fmtBytes(m.fileSize) +
        (whenText ? ' · ' + escHtml(whenText) : '') + '</div>' +
        '<div class="muted" style="margin-top:6px">客户端只需这一个 exe：启动检测 → 弹窗下载 → 自动替换 → 自动重启</div>';
    }
  }
  const pb = document.getElementById('relPkgBody');
  if (pb) {
    const rows = data.packages || [];
    pb.innerHTML = rows.length ? rows.map(p => {
      const shown = String(p.fileName || p.name || '').trim() || '安装包';
      return '<tr><td>' + escHtml(shown) +
        '</td><td>' + fmtBytes(p.fileSize) + '</td><td>' + escHtml(p.mtime ? new Date(p.mtime * 1000).toLocaleString() : '') +
        '</td></tr>';
    }).join('') : '<tr><td colspan="3" class="muted">暂无安装包</td></tr>';
  }
}
async function loadReleasesStatus() {
  const data = await api('/api/admin/release/status');
  patchReleasesPage(data);
  return data;
}
function setReleaseUploadProgress(pct, text, tone) {
  const wrap = document.getElementById('relUploadWrap');
  const bar = document.getElementById('relUploadBar');
  const prog = document.getElementById('relProgress');
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  if (wrap) wrap.classList.remove('hide');
  if (bar) {
    bar.style.width = p.toFixed(1) + '%';
    bar.style.background = tone === 'ok' ? 'var(--success)' : (tone === 'err' ? 'var(--danger)' : 'var(--primary)');
  }
  if (prog) {
    prog.textContent = text || '';
    prog.style.color = tone === 'ok' ? 'var(--success)' : (tone === 'err' ? 'var(--danger)' : '');
    prog.style.fontWeight = tone === 'ok' || tone === 'err' ? '600' : '';
  }
}
/** Upload via XHR so we can show real upload % (fetch has no upload progress). */
async function confirmUploadedPackage(buildId, file) {
  try {
    const st = await api('/api/admin/release/status');
    const rows = (st && st.packages) || [];
    // ONLY accept the exact buildId from this upload attempt.
    // Size fallback used to match an older same-size exe, then abort the real upload —
    // publish then failed with「请先上传对应 buildId 的安装包」.
    const hit = rows.find(p => String(p.buildId || '') === String(buildId));
    if (!hit) return null;
    const size = Number(hit.fileSize) || 0;
    if (file && file.size && size && Math.abs(size - file.size) > 64) return null;
    return {
      ok: true,
      buildId: String(buildId),
      fileName: hit.fileName || hit.name || (file && file.name) || '',
      fileSize: size || (file && file.size) || 0,
      recovered: true
    };
  } catch (_) {
    return null;
  }
}
const RELEASE_RESUME_STORAGE_KEY = 'facai888_release_upload_resume';
function releaseFileIdentity(file) {
  return {
    fileName: String((file && file.name) || ''),
    fileSize: Number((file && file.size) || 0),
    lastModified: Number((file && file.lastModified) || 0)
  };
}
function loadReleaseResumeBuildId(file) {
  try {
    const row = JSON.parse(sessionStorage.getItem(RELEASE_RESUME_STORAGE_KEY) || '{}');
    const identity = releaseFileIdentity(file);
    if (row && row.buildId && row.fileName === identity.fileName &&
        Number(row.fileSize) === identity.fileSize && Number(row.lastModified) === identity.lastModified) {
      return String(row.buildId);
    }
  } catch (_) {}
  return '';
}
function saveReleaseResumeBuildId(file, buildId) {
  try {
    sessionStorage.setItem(RELEASE_RESUME_STORAGE_KEY, JSON.stringify(Object.assign(
      { buildId: String(buildId || '') }, releaseFileIdentity(file)
    )));
  } catch (_) {}
}
function clearReleaseResumeBuildId(buildId) {
  try {
    const row = JSON.parse(sessionStorage.getItem(RELEASE_RESUME_STORAGE_KEY) || '{}');
    if (!buildId || String(row.buildId || '') === String(buildId)) {
      sessionStorage.removeItem(RELEASE_RESUME_STORAGE_KEY);
    }
  } catch (_) {}
}
async function initReleaseUpload(file, buildId) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await api('/api/admin/release/upload/init', {
        method: 'POST',
        body: JSON.stringify({ buildId: buildId, fileName: file.name, fileSize: file.size })
      });
    } catch (e) {
      lastErr = e;
      if (e && e.code === 401) throw e;
      await new Promise(r => setTimeout(r, Math.min(4000, 350 * (2 ** (attempt - 1)))));
    }
  }
  throw lastErr || new Error('初始化上传失败');
}
function uploadReleasePackage(file, buildId) {
  return new Promise(async (resolve, reject) => {
    // 8KB created thousands of HTTP requests for one installer. The server
    // validates and resumes unordered 1MB parts, which is fast without making
    // a flaky connection restart the whole upload.
    const DEFAULT_PART_CHUNK = 1024 * 1024;
    const LEGACY_CHUNK = 24 * 1024;
    const WORKERS = 4;
    const REQUEST_TIMEOUT_MS = 120000;
    const uiBuild = (document.querySelector('meta[name="admin-ui-build"]') || {}).content || '';
    try {
      const init = await initReleaseUpload(file, buildId);
      if (!init || init.ok === false) {
        throw new Error((init && init.message) || '初始化上传失败');
      }
      if (init.mode === 'complete') {
        setReleaseUploadProgress(100, '服务器已确认此前上传完成，正在继续发布…');
        resolve(Object.assign({}, init, { buildId: init.buildId || buildId }));
        return;
      }
      const useParts = init.mode === 'parts';
      const partHint = Number(init.chunkHint) || DEFAULT_PART_CHUNK;
      const CHUNK = useParts
        ? Math.max(64 * 1024, Math.min(4 * 1024 * 1024, partHint))
        : LEGACY_CHUNK;
      if (useParts) {
        const total = Math.ceil(file.size / CHUNK);
        const completed = new Set(
          ((init.uploadedParts instanceof Array ? init.uploadedParts : []) || [])
            .map(n => Number(n))
            .filter(n => Number.isInteger(n) && n >= 0 && n < total)
        );
        let done = completed.size;
        const putOne = async (index) => {
          const start = index * CHUNK;
          const end = Math.min(start + CHUNK, file.size);
          const buf = await file.slice(start, end).arrayBuffer();
          const q = new URLSearchParams({ buildId: buildId, index: String(index) });
          let lastErr = null;
          for (let attempt = 1; attempt <= 8; attempt++) {
            let timer = null;
            try {
              const controller = new AbortController();
              timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
              const resp = await fetch(apiUrl('/api/admin/release/upload/part?' + q.toString()), {
                method: 'POST',
                headers: Object.assign(
                  { 'Content-Type': 'application/octet-stream' },
                  state.token ? { 'X-Admin-Token': state.token } : {}
                ),
                body: buf,
                signal: controller.signal
              });
              const data = await resp.json().catch(() => ({}));
              if (!resp.ok || data.ok === false) {
                throw new Error(data.message || ('分块失败 ' + resp.status));
              }
              return;
            } catch (e) {
              lastErr = e;
              await new Promise(r => setTimeout(r, Math.min(5000, 350 * (2 ** (attempt - 1)))));
            } finally {
              if (timer) clearTimeout(timer);
            }
          }
          throw lastErr || new Error('分块上传失败');
        };
        let next = 0;
        const worker = async () => {
          while (true) {
            let i = next++;
            while (i < total && completed.has(i)) i = next++;
            if (i >= total) return;
            await putOne(i);
            done += 1;
            const pct = Math.min(99.5, (done / total) * 100);
            setReleaseUploadProgress(
              pct,
              '正在上传 ' + file.name + ' · ' + pct.toFixed(1) + '%（' +
                fmtBytes(Math.min(file.size, done * CHUNK)) + ' / ' + fmtBytes(file.size) + '）' + (uiBuild ? ' [ui ' + uiBuild + ']' : '')
            );
          }
        };
        const initialPct = Math.min(99.5, (done / total) * 100);
        setReleaseUploadProgress(
          initialPct,
          done ? '已恢复上传 ' + file.name + ' · ' + initialPct.toFixed(1) + '%' : '正在分块上传 ' + file.name + ' · 0%'
        );
        await Promise.all(Array.from({ length: Math.min(WORKERS, total) }, () => worker()));
      } else {
        let offset = 0;
        while (offset < file.size) {
          const end = Math.min(offset + CHUNK, file.size);
          const buf = await file.slice(offset, end).arrayBuffer();
          const q = new URLSearchParams({ buildId: buildId, offset: String(offset) });
          let lastErr = null;
          let okRow = null;
          for (let attempt = 1; attempt <= 6; attempt++) {
            try {
              const resp = await fetch(apiUrl('/api/admin/release/upload/chunk?' + q.toString()), {
                method: 'POST',
                headers: Object.assign(
                  { 'Content-Type': 'application/octet-stream' },
                  state.token ? { 'X-Admin-Token': state.token } : {}
                ),
                body: buf
              });
              const data = await resp.json().catch(() => ({}));
              if (!resp.ok || data.ok === false) {
                throw new Error(data.message || ('分块失败 ' + resp.status));
              }
              okRow = data;
              lastErr = null;
              break;
            } catch (e) {
              lastErr = e;
              await new Promise(r => setTimeout(r, Math.min(2500, 200 * attempt)));
            }
          }
          if (lastErr) throw lastErr;
          offset = end;
          const pct = Math.min(99.5, (offset / file.size) * 100);
          setReleaseUploadProgress(
            pct,
            '正在分块上传 ' + file.name + ' · ' + pct.toFixed(1) + '%（' +
              fmtBytes(offset) + ' / ' + fmtBytes(file.size) + '）' +
              (uiBuild ? ' [ui ' + uiBuild + ']' : '')
          );
          if (okRow && typeof okRow.received === 'number' && okRow.received !== offset) {
            offset = okRow.received;
          }
        }
      }
      setReleaseUploadProgress(99.8, '分块已传完，正在合并确认…');
      let finished = null;
      let finishError = null;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          finished = await api('/api/admin/release/upload/finish', {
            method: 'POST',
            body: JSON.stringify({ buildId: buildId })
          });
          if (finished && finished.ok !== false) break;
          finishError = new Error((finished && finished.message) || '合并安装包失败');
        } catch (e) {
          finishError = e;
        }
        const recovered = await confirmUploadedPackage(buildId, file);
        if (recovered) {
          finished = recovered;
          break;
        }
        await new Promise(r => setTimeout(r, Math.min(5000, 500 * (2 ** (attempt - 1)))));
      }
      if (!finished || finished.ok === false) throw finishError || new Error('合并安装包失败');
      setReleaseUploadProgress(100, '上传成功');
      resolve(Object.assign({}, finished, { buildId: finished.buildId || buildId }));
    } catch (e) {
      // Fall back to legacy single-stream upload if chunk API missing on old server.
      const msg = String((e && e.message) || e || '');
      if (/请求失败 404|Not Found/i.test(msg)) {
        try {
          resolve(await uploadReleasePackageLegacy(file, buildId));
        } catch (e2) {
          reject(e2 instanceof Error ? e2 : new Error(String(e2 || '上传失败')));
        }
        return;
      }
      reject(e instanceof Error ? e : new Error(msg || '上传失败'));
    }
  });
}
function uploadReleasePackageLegacy(file, buildId) {
  return new Promise((resolve, reject) => {
    // fileName stays in query — headers are ISO-8859-1 only (Chinese exe names break fetch/XHR headers).
    const q = new URLSearchParams({ buildId: buildId, fileName: file.name });
    const xhr = new XMLHttpRequest();
    let settled = false;
    let pollTimer = null;
    let confirmTimer = null;
    let uploadBytesDone = false;
    const uiBuild = (document.querySelector('meta[name="admin-ui-build"]') || {}).content || '';
    const cleanup = () => {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
    };
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    };
    xhr.open('POST', apiUrl('/api/admin/release/upload?' + q.toString()));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (state.token) xhr.setRequestHeader('X-Admin-Token', state.token);
    const failOrRecover = async (errMsg) => {
      if (settled) return;
      setReleaseUploadProgress(100, '未收到确认，正在核对服务器是否已收到文件…');
      const recovered = await confirmUploadedPackage(buildId, file);
      if (recovered) {
        finish(resolve, recovered);
        return;
      }
      finish(reject, new Error(errMsg));
    };
    const startConfirmPoll = () => {
      // Wait until all bytes left the browser — polling earlier + abort killed in-flight uploads.
      if (!uploadBytesDone || settled || pollTimer) return;
      setReleaseUploadProgress(100, '数据已发送，正在确认服务器已收到文件…' + (uiBuild ? ' [ui ' + uiBuild + ']' : ''));
      // Proxy may drop/delay the upload HTTP response after the file is already on disk.
      let tries = 0;
      const tick = async () => {
        if (settled) return;
        tries += 1;
        setReleaseUploadProgress(100, '正在确认服务器已收到文件…（第 ' + tries + ' 次）');
        const recovered = await confirmUploadedPackage(buildId, file);
        if (recovered) {
          // Do NOT xhr.abort() here — aborting a still-open request races with onload
          // and previously caused false failures / wrong package confirmation.
          finish(resolve, recovered);
        }
      };
      tick(); // first check immediately
      pollTimer = setInterval(tick, 1200);
      confirmTimer = setTimeout(() => {
        failOrRecover('等待服务器确认超时。请点「刷新」查看安装包列表后再试');
      }, 120 * 1000);
    };
    xhr.upload.onprogress = (ev) => {
      if (!ev.lengthComputable || !file.size) return;
      const pct = Math.min(99.5, (ev.loaded / ev.total) * 100);
      setReleaseUploadProgress(
        pct,
        '正在上传 ' + file.name + ' · ' + pct.toFixed(1) + '%（' +
          fmtBytes(ev.loaded) + ' / ' + fmtBytes(ev.total) + '）'
      );
    };
    xhr.timeout = 10 * 60 * 1000;
    xhr.upload.onload = () => {
      uploadBytesDone = true;
      startConfirmPoll();
    };
    xhr.upload.onloadend = () => {
      uploadBytesDone = true;
      startConfirmPoll();
    };
    xhr.onerror = () => { failOrRecover('网络错误，上传中断（未确认成功）'); };
    xhr.onabort = () => {
      if (!settled) finish(reject, new Error('上传已取消'));
    };
    xhr.ontimeout = () => { failOrRecover('等待服务器确认超时。请点「刷新」查看安装包列表'); };
    xhr.onload = () => {
      if (settled) return;
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch (_) { data = {}; }
      if (xhr.status < 200 || xhr.status >= 300 || data.ok === false) {
        failOrRecover(data.message || ('上传失败 ' + xhr.status));
        return;
      }
      finish(resolve, Object.assign({}, data, { buildId: data.buildId || buildId }));
    };
    setReleaseUploadProgress(0, '正在上传 ' + file.name + ' · 0%（0 B / ' + fmtBytes(file.size) + '）');
    xhr.send(file);
  });
}
function versionFromReleaseFileName(name) {
  const stem = String(name || '').replace(/\.exe$/i, '');
  const m = /v(\d+\.\d+)$/i.exec(stem);
  return m ? m[1] : '';
}
async function publishReleasePackage() {
  const btn = document.getElementById('relPublishBtn');
  const msg = document.getElementById('relMsg');
  const fileEl = document.getElementById('relFile');
  const file = fileEl && fileEl.files && fileEl.files[0];
  if (!file) { alert('请选择 .exe 安装包'); return; }
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  // Keep this id across a retry of the same selected file, so durable parts are reused.
  const buildId = loadReleaseResumeBuildId(file) ||
    ('' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '-' +
      Math.random().toString(16).slice(2, 8));
  saveReleaseResumeBuildId(file, buildId);
  const gitCommit = '';
  const mandatory = !!(document.getElementById('relMandatory') && document.getElementById('relMandatory').checked);
  const version = versionFromReleaseFileName(file.name) || '';
  if (btn) btn.disabled = true;
  if (msg) {
    msg.textContent = '';
    msg.style.color = '';
    msg.style.fontWeight = '';
  }
  try {
    const upData = await uploadReleasePackage(file, buildId);
    const publishedBuildId = String((upData && upData.buildId) || buildId);
    setReleaseUploadProgress(100, '上传成功 · 正在发布清单…');
    if (msg) {
      msg.textContent = '上传成功';
      msg.style.color = 'var(--success)';
      msg.style.fontWeight = '600';
    }
    const pub = await api('/api/admin/release/publish', {
      method: 'POST',
      body: JSON.stringify({
        version: version,
        buildId: publishedBuildId, gitCommit, mandatory,
        fileName: upData.fileName || file.name
      })
    });
    const man = (pub && pub.manifest) || {};
    const shown = releaseDisplayName(man) || file.name;
    const seq = man.releaseSequence || '';
    const okText = (pub && pub.unchanged ? '已是当前版本（未重复发布）' : '发布成功') +
      (seq ? '（序号 ' + seq + '）' : '') +
      ' · ' + shown + ' · ' + fmtBytes(man.fileSize || upData.fileSize || file.size) +
      '。客户端启动后会自动更新。';
    if (msg) {
      msg.textContent = pub && pub.unchanged ? '已是当前版本' : '发布成功';
      msg.style.color = 'var(--success)';
      msg.style.fontWeight = '600';
    }
    setReleaseUploadProgress(100, okText, 'ok');
    clearReleaseResumeBuildId(publishedBuildId);
    try { await loadReleasesStatus(); } catch (_) { /* status refresh must not hide success */ }
    alert(okText);
  } catch (e) {
    const errText = (e && e.message) || '发布失败';
    if (msg) {
      msg.textContent = errText;
      msg.style.color = 'var(--danger)';
      msg.style.fontWeight = '600';
    }
    setReleaseUploadProgress(100, errText, 'err');
    alert(errText);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderClientDetailShell() {
  return '<div class="stack" id="clientDetailRoot">' +
    '<div class="card" style="padding:14px 16px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between">' +
    '<div><div class="muted" id="cdMeta">加载中…</div></div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<button class="btn btn-secondary btn-sm" id="cdBack">返回在线客户端</button>' +
    '<button class="btn btn-secondary btn-sm" id="cdRefresh">刷新</button></div></div>' +
    '<div class="card" style="padding:16px"><h3 style="margin:0 0 10px;font-size:15px">下注计划</h3>' +
    '<div id="cdPlanBox" class="muted">—</div></div>' +
    '<div class="card" style="padding:16px"><h3 style="margin:0 0 10px;font-size:15px">监控公式</h3>' +
    '<div id="cdFormulaBox" class="muted">—</div></div>' +
    '<div class="card" style="padding:16px"><h3 style="margin:0 0 10px;font-size:15px">按桌输赢明细</h3>' +
    '<div class="muted" id="cdTableHint" style="margin-bottom:8px"></div>' +
    '<div class="table-wrap"><table><thead><tr><th>桌子</th><th>赢</th><th>输</th><th>和</th><th>胜率</th><th>真实/模拟</th><th>金额合计</th></tr></thead>' +
    '<tbody id="cdTableBody"><tr><td colspan="7" class="muted">加载中…</td></tr></tbody></table></div></div>' +
    '<div class="card" style="padding:16px"><h3 style="margin:0 0 10px;font-size:15px">公式统计（本客户端）</h3>' +
    '<div class="table-wrap"><table><thead><tr><th>公式</th><th>模式</th><th>已定</th><th>胜率</th><th>结论</th><th>最近</th></tr></thead>' +
    '<tbody id="cdStatsBody"><tr><td colspan="6" class="muted">加载中…</td></tr></tbody></table></div></div>' +
    '<div class="card" style="padding:16px"><h3 style="margin:0 0 10px;font-size:15px">模拟结算明细</h3>' +
    '<div class="muted" id="cdSimHint" style="margin-bottom:8px"></div>' +
    '<div class="table-wrap"><table><thead><tr><th>时间</th><th>桌子</th><th>结果</th><th>方向</th><th>金额</th></tr></thead>' +
    '<tbody id="cdSimBody"><tr><td colspan="5" class="muted">加载中…</td></tr></tbody></table></div></div>' +
    '<div class="card" style="padding:16px"><h3 style="margin:0 0 10px;font-size:15px">近期公式结算</h3>' +
    '<div class="table-wrap"><table><thead><tr><th>时间</th><th>桌子</th><th>公式</th><th>结果</th><th>模式</th><th>金额</th></tr></thead>' +
    '<tbody id="cdRecentBody"><tr><td colspan="6" class="muted">加载中…</td></tr></tbody></table></div></div></div>';
}

async function loadClientDetail() {
  const cid = String(state.clientDetailId || '').trim();
  if (!cid) {
    state.clientDetail = null;
    patchClientDetailPage(null);
    return;
  }
  const seq = ++clientDetailReqSeq;
  const data = await api('/api/client-detail?clientId=' + encodeURIComponent(cid));
  if (seq !== clientDetailReqSeq) return;
  state.clientDetail = data;
  patchClientDetailPage(data);
}

function formatStepLine(s) {
  const side = String(s.side || '');
  const amount = Number(s.amount) || 0;
  const name = String(s.name || s.id || '');
  return (name ? name + '：' : '') + side + amount + '（赢→' + (s.onWin || '—') + ' / 输→' + (s.onLose || '—') + '）';
}

function mergeTableRows(formulaRows, simRows) {
  const map = new Map();
  (formulaRows || []).forEach(r => {
    const tid = Number(r.tableId) || 0;
    map.set(String(tid), Object.assign({}, r));
  });
  (simRows || []).forEach(r => {
    const tid = Number(r.tableId) || 0;
    const key = String(tid);
    const cur = map.get(key);
    if (!cur) {
      map.set(key, Object.assign({
        winReal: 0, loseReal: 0, tieReal: 0,
        winSim: Number(r.win) || 0, loseSim: Number(r.lose) || 0, tieSim: Number(r.tie) || 0,
      }, r));
      return;
    }
    if (!cur.tableTitle && r.tableTitle) cur.tableTitle = r.tableTitle;
    // Prefer formula totals when present; still surface sim-only amounts if formula empty.
    if (!(cur.win || cur.lose || cur.tie)) {
      cur.win = Number(r.win) || 0;
      cur.lose = Number(r.lose) || 0;
      cur.tie = Number(r.tie) || 0;
      cur.winSim = Number(r.win) || 0;
      cur.loseSim = Number(r.lose) || 0;
      cur.tieSim = Number(r.tie) || 0;
      cur.decided = Number(r.decided) || ((Number(r.win) || 0) + (Number(r.lose) || 0));
      cur.winRatePct = r.winRatePct;
    }
    if (!(cur.betAmountSum > 0) && r.betAmountSum) cur.betAmountSum = r.betAmountSum;
  });
  return Array.from(map.values()).sort((a, b) => {
    const ta = (Number(a.win)||0)+(Number(a.lose)||0)+(Number(a.tie)||0);
    const tb = (Number(b.win)||0)+(Number(b.lose)||0)+(Number(b.tie)||0);
    return tb - ta || (Number(b.tableId)||0) - (Number(a.tableId)||0);
  });
}

function patchClientDetailPage(data) {
  const root = document.getElementById('clientDetailRoot');
  if (!root) return;
  if (!data || !data.ok) {
    const meta = document.getElementById('cdMeta');
    if (meta) meta.textContent = (data && data.message) || '未选择客户端或加载失败';
    return;
  }
  const c = data.client || {};
  const meta = document.getElementById('cdMeta');
  if (meta) {
    meta.innerHTML = escHtml(displayClientLabel(c)) + ' · ' +
      (c.online ? '<span class="badge badge-ok">在线</span>' : '<span class="badge badge-neutral">离线</span>') +
      ' · ' + (c.allowed !== false ? '<span class="badge badge-ok">允许运行</span>' : '<span class="badge badge-deny">禁止运行</span>') +
      ' · IP ' + escHtml(c.ip || '—') + ' · 版本 ' + escHtml(c.version || '—') +
      (c.lastSeenText ? ' · ' + escHtml(relativeTime(c.lastSeenText) || c.lastSeenText) : '');
  }

  const planBox = document.getElementById('cdPlanBox');
  if (planBox) {
    const steps = Array.isArray(c.planSteps) ? c.planSteps : [];
    let html = '<p><b>' + escHtml(c.plan || '（未上报计划名）') + '</b></p>';
    if (c.planSummary) html += '<p class="muted">' + escHtml(c.planSummary) + '</p>';
    if (steps.length) {
      html += '<ol style="margin:8px 0 0;padding-left:18px">' + steps.map(s =>
        '<li>' + escHtml(formatStepLine(s)) + '</li>'
      ).join('') + '</ol>';
    } else {
      html += '<p class="muted">暂无步骤明细（需新版客户端上报）</p>';
    }
    planBox.innerHTML = html;
  }

  const formulaBox = document.getElementById('cdFormulaBox');
  if (formulaBox) {
    const formulas = Array.isArray(c.monitorFormulas) ? c.monitorFormulas : [];
    if (!formulas.length) {
      formulaBox.innerHTML = '<p class="muted">暂无监控公式（需新版客户端上报）</p>';
    } else {
      formulaBox.innerHTML = '<ul style="margin:0;padding-left:18px">' + formulas.map(f =>
        '<li><span class="muted">#' + escHtml(f.slot || '—') + '</span> ' + escHtml(f.patternText || '') + '</li>'
      ).join('') + '</ul>';
    }
  }

  const tableRows = mergeTableRows(
    (data.formulaTables && data.formulaTables.rows) || [],
    (data.simTables && data.simTables.rows) || []
  );
  const tableHint = document.getElementById('cdTableHint');
  if (tableHint) {
    tableHint.textContent = tableRows.length
      ? ('共 ' + tableRows.length + ' 张桌子 · 公式事件与模拟结算合并')
      : '暂无按桌输赢数据';
  }
  const tableBody = document.getElementById('cdTableBody');
  if (tableBody) {
    tableBody.innerHTML = tableRows.length ? tableRows.map(r => {
      const title = r.tableTitle || ('桌 ' + (r.tableId || '—'));
      const decided = Number(r.decided) || ((Number(r.win)||0)+(Number(r.lose)||0));
      const mode = '真 ' + ((Number(r.winReal)||0)+(Number(r.loseReal)||0)+(Number(r.tieReal)||0)) +
        ' / 模 ' + ((Number(r.winSim)||0)+(Number(r.loseSim)||0)+(Number(r.tieSim)||0));
      return '<tr><td>' + escHtml(title) + '<div class="muted mono">' + escHtml(r.tableId || '') + '</div></td>' +
        '<td class="num">' + (Number(r.win)||0) + '</td>' +
        '<td class="num">' + (Number(r.lose)||0) + '</td>' +
        '<td class="num">' + (Number(r.tie)||0) + '</td>' +
        '<td class="num ' + rateClass(r.winRatePct) + '">' + (decided ? pct(r.winRatePct) : '—') + '</td>' +
        '<td class="muted">' + escHtml(mode) + '</td>' +
        '<td class="num">' + (r.betAmountSum != null ? escHtml(Math.round(Number(r.betAmountSum) || 0)) : '—') + '</td></tr>';
    }).join('') : '<tr><td colspan="7" class="muted">暂无数据</td></tr>';
  }

  const statsRows = (data.formulaStats && data.formulaStats.rows) || [];
  const statsBody = document.getElementById('cdStatsBody');
  if (statsBody) {
    statsBody.innerHTML = statsRows.length ? statsRows.slice(0, 40).map(r => {
      const decided = (Number(r.winReal)||0)+(Number(r.loseReal)||0)+(Number(r.winSim)||0)+(Number(r.loseSim)||0);
      const mode = ((Number(r.placeReal)||0)+(Number(r.winReal)||0)+(Number(r.loseReal)||0)) > 0 &&
        ((Number(r.placeSim)||0)+(Number(r.winSim)||0)+(Number(r.loseSim)||0)) > 0 ? '混合' :
        ((Number(r.placeSim)||0)+(Number(r.winSim)||0)+(Number(r.loseSim)||0)) > 0 ? '模拟' : '真实';
      return '<tr><td class="formula-name">' + escHtml(r.formula || '—') +
        (r.slot != null ? ' <span class="muted">#' + escHtml(r.slot) + '</span>' : '') + '</td>' +
        '<td>' + escHtml(mode) + '</td><td class="num">' + decided + '</td>' +
        '<td class="num ' + rateClass(r.winRatePct) + '">' + pct(r.winRatePct) + '</td>' +
        '<td>' + escHtml(r.conclusion || '样本不足') + '</td>' +
        '<td>' + escHtml(r.lastAt || '') + '</td></tr>';
    }).join('') : '<tr><td colspan="6" class="muted">暂无公式统计</td></tr>';
  }

  const sim = data.simSummary || {};
  const simHint = document.getElementById('cdSimHint');
  if (simHint) {
    if (sim.empty) simHint.textContent = '暂无模拟会话汇总';
    else simHint.textContent = '会话 ' + (sim.sessionId || '—') +
      ' · 赢 ' + (sim.win || 0) + ' / 输 ' + (sim.lose || 0) + ' / 和 ' + (sim.tie || 0) +
      ' · 当前连输 ' + (sim.currentLoseStreak || 0) + ' · 最长连输 ' + (sim.maxLoseStreak || 0);
  }
  const simRows = (data.simEvents && data.simEvents.rows) || [];
  const simBody = document.getElementById('cdSimBody');
  if (simBody) {
    simBody.innerHTML = simRows.length ? simRows.map(r =>
      '<tr><td>' + escHtml(r.settledAt || r.createdAt || '') + '</td>' +
      '<td>' + escHtml(r.tableTitle || r.tableId || '—') + '</td>' +
      '<td>' + escHtml(r.gameResult || '') + '</td>' +
      '<td>' + escHtml(r.betSide || '—') + '</td>' +
      '<td class="num">' + escHtml(r.betAmount != null ? r.betAmount : '—') + '</td></tr>'
    ).join('') : '<tr><td colspan="5" class="muted">暂无模拟明细</td></tr>';
  }

  const recent = (data.formulaTables && data.formulaTables.recent) || [];
  const recentBody = document.getElementById('cdRecentBody');
  if (recentBody) {
    recentBody.innerHTML = recent.length ? recent.slice(0, 80).map(r => {
      return '<tr><td>' + escHtml(fmtTs(r.occurredAt)) + '</td>' +
        '<td>' + escHtml(r.tableTitle || r.tableId || '—') + '</td>' +
        '<td>' + escHtml(r.patternText || '—') + (r.slot ? ' <span class="muted">#' + escHtml(r.slot) + '</span>' : '') + '</td>' +
        '<td>' + escHtml(r.gameResult || '') + '</td>' +
        '<td>' + (r.simulated ? '模拟' : '真实') + '</td>' +
        '<td class="num">' + escHtml(r.betAmount != null ? r.betAmount : '—') + '</td></tr>';
    }).join('') : '<tr><td colspan="6" class="muted">暂无近期结算</td></tr>';
  }
}

function patchDashboard(data) {
  if (!data) return;
  const verEl = document.getElementById('sidebarVersion');
  if (verEl && data.versions) {
    const v = data.versions;
    verEl.textContent = '服务 ' + (v.gitCommit || '—').slice(0, 8) +
      ' · 数据 v' + (v.dataSchemaVersion || '—') +
      ' · 算法 ' + (v.analyticsAlgorithmVersion || '—');
  }
  const st = onlineStats(data);
  const statsEl = document.getElementById('dashStats');
  if (statsEl) statsEl.innerHTML =
    statCardIcon('在线总数', st.total, '💻', '') +
    statCardIcon('允许运行', st.allowed, '✓', 'ok') +
    statCardIcon('禁止运行', st.denied, '✕', 'danger') +
    statCardIcon('正在监控', st.desktopWatching, '👁', 'warn');
  const tbody = document.getElementById('dashClients');
  if (tbody) {
    const rows = (data.online || []).slice(0, 8);
    tbody.innerHTML = rows.length ? rows.map(r => '<tr>' +
      '<td>' + escHtml(displayAccount(r)) + '</td><td>' + escHtml(displayPlan(r)) + '</td><td>' + escHtml(r.version || '—') + '</td>' +
      '<td>' + (r.allowed !== false ? '<span class="badge badge-ok">允许运行</span>' : '<span class="badge badge-deny">禁止运行</span>') + '</td>' +
      '<td class="mono">' + escHtml(r.ip || '—') + '</td><td title="' + escHtml(r.lastSeenText || '') + '">' + escHtml(relativeTime(r.lastSeenText) || r.lastSeenText || '—') + '</td></tr>').join('') :
      '<tr><td colspan="6" class="muted">当前没有在线客户端</td></tr>';
  }
}
function statCard(label, value, compact) {
  return '<div class="card stat-card' + (compact ? ' compact' : '') + '"><div class="label">' + escHtml(label) + '</div><div class="value">' + escHtml(String(value)) + '</div></div>';
}
function statCardIcon(label, value, icon, tone) {
  return '<div class="card stat-card with-icon"><div class="stat-icon ' + escHtml(tone || '') + '">' + icon + '</div><div><div class="label">' + escHtml(label) + '</div><div class="value">' + escHtml(String(value)) + '</div></div></div>';
}
async function loadDashboardRoads() {
  try {
    const data = await api('/api/road-overview');
    const hint = document.getElementById('dashRoadHint');
    const body = document.getElementById('dashRoadBody');
    if (!body) return;
    const rows = (data.recentTables || []).slice(0, 5);
    if (hint) hint.textContent = '近7日桌文件约 ' + (data.tableFileCountRecent || 0) + ' · 展示 ' + rows.length + ' 桌';
    body.innerHTML = rows.length ? rows.map(r => '<tr><td class="num">' + escHtml(r.tid || '') + '</td><td>' + escHtml(r.title || '—') + '</td>' +
      '<td class="num">' + escHtml(r.n || 0) + '</td><td>' + renderRoadDots(r.preview) + '</td><td>' + escHtml(fmtTs(r.u)) + '</td></tr>').join('') :
      '<tr><td colspan="5" class="muted">暂无路单归档</td></tr>';
  } catch (e) {
    const hint = document.getElementById('dashRoadHint');
    if (hint) hint.textContent = e.message || '加载失败';
  }
}
function patchClientsPage(data) {
  if (!data) return;
  patchClientsStats(data);
  if (state.openDropdown || state.batchRunning) {
    // Keep open menus / in-flight batch UI stable; stats still refresh.
    return;
  }
  patchClientsTable(data);
  patchVersionFilter(data);
}
function patchClientsStats(data) {
  const el = document.getElementById('clientStats');
  if (!el) return;
  const st = onlineStats(data);
  el.innerHTML = statCard('在线', st.total, true) + statCard('允许运行', st.allowed, true) +
    statCard('禁止运行', st.denied, true) + statCard('正在监控', st.desktopWatching, true);
}
function patchVersionFilter(data) {
  const sel = document.getElementById('clientVersionFilter');
  if (!sel) return;
  const cur = sel.value || 'all';
  const vers = uniqueVersions(data.online || []);
  sel.innerHTML = '<option value="all">全部版本</option>' + vers.map(v => '<option value="' + escHtml(v) + '">' + escHtml(v) + '</option>').join('');
  sel.value = vers.includes(cur) ? cur : 'all';
  state.clientsFilters.version = sel.value;
}
function patchClientsTable(data) {
  const tbody = document.getElementById('clientsBody');
  if (!tbody || !data) return;
  const rows = filterClients(data.online || []);
  const nextIds = rows.map(r => String(r.clientId || ''));
  const prevIds = Array.from(tbody.querySelectorAll('tr[data-cid]')).map(tr => tr.dataset.cid || '');
  const sameOrder = nextIds.length === prevIds.length && nextIds.every((id, i) => id === prevIds[i]);
  if (sameOrder && nextIds.length) {
    rows.forEach((r, i) => {
      const tr = tbody.children[i];
      if (!tr) return;
      patchClientRowCells(tr, r);
    });
    updateSelectionUI();
    return;
  }
  tbody.innerHTML = rows.length ? rows.map(r => renderClientRow(r)).join('') : '<tr><td colspan="10" class="muted">没有匹配的在线客户端</td></tr>';
  bindClientsTableEvents(tbody);
  updateSelectionUI();
}
function renderClientRow(r) {
  const cid = escHtml(r.clientId);
  const raw = r.lastSeenText || '';
  const rel = relativeTime(raw) || raw || '—';
  const selected = state.selection.has(r.clientId);
  return '<tr data-cid="' + cid + '" class="' + (selected ? 'selected' : '') + '"><td><input type="checkbox" class="row-check" data-cid="' + cid + '"' + (selected ? ' checked' : '') + '/></td>' +
    '<td data-col="device"><div class="cid-cell"><strong>' + escHtml(displayClientLabel(r)) + '</strong><span class="badge badge-ok online-tag">在线</span></div></td>' +
    '<td data-col="account">' + escHtml(displayAccount(r)) + '</td>' +
    '<td data-col="plan">' + escHtml(displayPlan(r)) + '</td>' +
    '<td data-col="version">' + escHtml(r.version || '—') + '</td>' +
    '<td data-col="allowed">' + (r.allowed !== false ? '<span class="badge badge-ok">允许运行</span>' : '<span class="badge badge-deny">禁止运行</span>') + '</td>' +
    '<td data-col="desktop">' + (r.desktopWatching ? '<span class="badge badge-blue">监控中</span>' : '<span class="badge badge-neutral">未监控</span>') + '</td>' +
    '<td data-col="seen" title="' + escHtml(raw) + '">' + escHtml(rel) + '</td>' +
    '<td data-col="ip" class="mono">' + escHtml(r.ip || '—') + '</td><td><div style="display:flex;gap:4px;flex-wrap:wrap">' +
    '<button class="btn btn-secondary btn-sm cred-btn" data-cid="' + cid + '">查看账号密码</button>' +
    '<button class="btn btn-secondary btn-sm desk-btn" data-cid="' + cid + '">查看桌面</button>' +
    '<button class="btn btn-secondary btn-sm ann-btn" data-cid="' + cid + '" data-ip="' + escHtml(r.ip || '') + '">发送公告</button>' +
    '<div class="dropdown"><button class="btn btn-ghost btn-sm more-btn" data-cid="' + cid + '">更多</button>' +
    '<div class="dropdown-menu" id="menu-' + cid + '">' +
    '<button data-act="creds" data-cid="' + cid + '">查看账号密码</button>' +
    '<button data-act="detail" data-cid="' + cid + '">运行详情</button>' +
    '<button data-act="allow" data-cid="' + cid + '" data-ip="' + escHtml(r.ip || '') + '">允许这台运行</button>' +
    '<button class="danger" data-act="deny" data-cid="' + cid + '" data-ip="' + escHtml(r.ip || '') + '">禁止这台运行</button>' +
    '<button data-act="logs" data-cid="' + cid + '" data-ip="' + escHtml(r.ip || '') + '">查看操作日志</button></div></div></div></td></tr>';
}
function patchClientRowCells(tr, r) {
  const raw = r.lastSeenText || '';
  const rel = relativeTime(raw) || raw || '—';
  const set = (col, html) => {
    const el = tr.querySelector('[data-col="' + col + '"]');
    if (el && el.innerHTML !== html) el.innerHTML = html;
  };
  set('device', '<div class="cid-cell"><strong>' + escHtml(displayClientLabel(r)) + '</strong><span class="badge badge-ok online-tag">在线</span></div>');
  set('account', escHtml(displayAccount(r)));
  set('plan', escHtml(displayPlan(r)));
  set('version', escHtml(r.version || '—'));
  set('allowed', r.allowed !== false ? '<span class="badge badge-ok">允许运行</span>' : '<span class="badge badge-deny">禁止运行</span>');
  set('desktop', r.desktopWatching ? '<span class="badge badge-blue">监控中</span>' : '<span class="badge badge-neutral">未监控</span>');
  const seen = tr.querySelector('[data-col="seen"]');
  if (seen) {
    const next = escHtml(rel);
    if (seen.innerHTML !== next) seen.innerHTML = next;
    seen.title = raw || '';
  }
  set('ip', escHtml(r.ip || '—'));
  const selected = state.selection.has(r.clientId);
  tr.classList.toggle('selected', selected);
  const cb = tr.querySelector('.row-check');
  if (cb) cb.checked = selected;
}
function bindClientsTableEvents(tbody) {
  tbody.querySelectorAll('.row-check').forEach(el => {
    el.onchange = () => toggleSelection(el.dataset.cid, el.checked);
  });
  tbody.querySelectorAll('.cred-btn').forEach(el => {
    el.onclick = () => showClientCredentials(el.dataset.cid);
  });
  tbody.querySelectorAll('.desk-btn').forEach(el => {
    el.onclick = () => {
      state.desktopSelectedId = el.dataset.cid || '';
      state.desktopClientId = state.desktopSelectedId;
      navigate('desktop');
    };
  });
  tbody.querySelectorAll('.ann-btn').forEach(el => {
    el.onclick = () => { state.announceSelected = new Set([el.dataset.cid]); state.announceMode = 'clients'; navigate('announcements'); };
  });
  tbody.querySelectorAll('.more-btn').forEach(el => {
    el.onclick = e => { e.stopPropagation(); toggleDropdown(el.dataset.cid, el); };
  });
}
function patchControlPage(data) {
  if (!data) return;
  const pol = data.policy || {};
  const txt = document.getElementById('globalPolicyText');
  if (txt) txt.textContent = pol.globalAllow === false ? '当前：全部客户端已被禁止运行' : '当前：默认允许运行（可单独禁止客户端或 IP）';
  const onlineBody = document.getElementById('ctrlOnlineBody');
  const diBody = document.getElementById('denyIpsBody');
  const di = pol.denyIps || {};
  if (onlineBody) {
    const rows = data.online || [];
    onlineBody.innerHTML = rows.length ? rows.map(r => {
      const cid = escHtml(r.clientId);
      const reason = r.allowed === false ? (r.allowMessage || '已限制') : '—';
      return '<tr><td>' + escHtml(displayClientLabel(r)) + '</td><td>' + escHtml(displayAccount(r)) + '</td><td class="mono">' + escHtml(r.ip || '—') + '</td>' +
        '<td>' + (r.allowed !== false ? '<span class="badge badge-ok">允许运行</span>' : '<span class="badge badge-deny">禁止运行</span>') + '</td>' +
        '<td>' + escHtml(reason) + '</td><td style="display:flex;gap:6px;flex-wrap:wrap">' +
        '<button class="btn btn-success-soft btn-sm" data-allow-cid="' + cid + '" data-ip="' + escHtml(r.ip || '') + '">允许运行</button>' +
        '<button class="btn btn-danger-soft btn-sm" data-deny-cid="' + cid + '" data-ip="' + escHtml(r.ip || '') + '">禁止运行</button></td></tr>';
    }).join('') : '<tr><td colspan="6" class="muted">当前没有在线客户端</td></tr>';
    onlineBody.querySelectorAll('[data-allow-cid]').forEach(el => {
      el.onclick = () => runControl('allow_client', { clientId: el.dataset.allowCid, ip: el.dataset.ip }).catch(alert);
    });
    onlineBody.querySelectorAll('[data-deny-cid]').forEach(el => {
      el.onclick = () => confirmDanger('确定禁止此客户端？', () =>
        runControl('deny_client', { clientId: el.dataset.denyCid, ip: el.dataset.ip, reason:'服务暂不可用' }).catch(alert));
    });
  }
  if (diBody) {
    const keys = Object.keys(di);
    diBody.innerHTML = keys.length ? keys.map(k => '<tr><td class="mono">' + escHtml(k) + '</td><td>' + escHtml(di[k]) + '</td>' +
      '<td><button class="btn btn-secondary btn-sm" data-allow-ip="' + escHtml(k) + '">解除限制</button></td></tr>').join('') :
      '<tr><td colspan="3" class="muted">当前没有受限制的 IP</td></tr>';
    diBody.querySelectorAll('[data-allow-ip]').forEach(el => {
      el.onclick = () => runControl('allow_ip', { ip: el.dataset.allowIp }).catch(alert);
    });
  }
}
function updateAnnounceTargetSummary() {
  const el = document.getElementById('annTargetSummary');
  if (!el) return;
  if (state.announceMode === 'ip') {
    const ip = (document.getElementById('annIp') && document.getElementById('annIp').value || '').trim();
    el.textContent = ip ? ('目标 IP：' + ip) : '请填写目标 IP';
  } else {
    const n = state.announceSelected.size;
    el.textContent = n ? ('已选择 ' + n + ' 个在线客户端') : '请选择至少一个在线客户端';
  }
}
function patchAnnouncePage(data) {
  const picker = document.getElementById('annClientPicker');
  if (!picker || !data) return;
  const q = (document.getElementById('annClientSearch') && document.getElementById('annClientSearch').value || '').toLowerCase();
  const rows = (data.online || []).filter(r => !q ||
    (r.account || '').toLowerCase().includes(q) ||
    (r.clientId || '').toLowerCase().includes(q) ||
    (r.ip || '').toLowerCase().includes(q));
  picker.innerHTML = rows.length ? rows.map(r => {
    const sel = state.announceSelected.has(r.clientId);
    return '<label class="picker-row"><input type="checkbox" class="ann-check" data-cid="' + escHtml(r.clientId) + '"' + (sel ? ' checked' : '') + '/>' +
      '<span>' + escHtml(displayClientLabel(r)) + ' · ' + escHtml(r.ip || '') + '</span></label>';
  }).join('') : '<p class="muted">无在线客户端</p>';
  picker.querySelectorAll('.ann-check').forEach(el => {
    el.onchange = () => {
      if (el.checked) state.announceSelected.add(el.dataset.cid); else state.announceSelected.delete(el.dataset.cid);
      updateAnnounceTargetSummary();
    };
  });
  updateAnnounceTargetSummary();
  renderAnnounceResults();
}
function renderAnnounceResults() {
  const el = document.getElementById('annResults');
  if (!el) return;
  if (!state.announceResults.length) { el.innerHTML = '<p class="muted">暂无</p>'; return; }
  el.innerHTML = state.announceResults.slice().reverse().map(r =>
    '<div class="announce-result"><span class="badge ' + (r.ok ? 'badge-ok' : 'badge-deny') + '">' + (r.ok ? '成功' : '失败') + '</span> ' +
    escHtml(r.target) + ' — ' + escHtml(r.message) + ' <span class="muted">' + escHtml(r.time) + '</span></div>'
  ).join('');
}
async function loadRoadOverview() {
  const seq = ++roadReqSeq;
  try {
    const data = await api('/api/road-overview');
    if (seq !== roadReqSeq) return;
    state.roadData = data;
    patchRoadsPage(data);
  } catch (e) {
    const hint = document.getElementById('roadHint');
    if (hint) hint.textContent = e.message || '加载失败';
    handleAuthError(e);
  }
}
function filterRoadRows(rows) {
  let out = rows.slice();
  const filt = (state.roadFilter || '').toLowerCase();
  const day = state.roadDay || '';
  const cat = state.roadCat || 'all';
  if (day) out = out.filter(r => String(r.day || '') === day);
  if (cat !== 'all') out = out.filter(r => String(r.cat || '').toLowerCase() === cat);
  if (filt) {
    out = out.filter(r =>
      String(r.tid || '').includes(filt) ||
      String(r.title || '').toLowerCase().includes(filt) ||
      String((r.accounts || []).join(',')).toLowerCase().includes(filt) ||
      String((r.clients || []).join(',')).toLowerCase().includes(filt)
    );
  }
  return out;
}
function patchRoadsPage(data) {
  if (!data) return;
  const statsEl = document.getElementById('roadStats');
  const rows = data.recentTables || [];
  const filtered = filterRoadRows(rows);
  const qs = data.qualitySummary || {};
  if (statsEl) statsEl.innerHTML =
    statCard('A级靴', qs.A || 0) +
    statCard('B级靴', qs.B || 0) +
    statCard('C级靴', qs.C || 0) +
    statCard('冲突靴', qs.conflict || qs.D || 0) +
    statCard('未知靴号', qs.unknownBoot || 0) +
    statCard('几何失败', qs.geometryFail || 0);
  const hint = document.getElementById('roadHint');
  if (hint) hint.textContent = '共 ' + rows.length + ' 桌 · 筛选后 ' + filtered.length + ' 桌 · 本页手动刷新（不自动重算）';
  const body = document.getElementById('roadBody');
  if (body) body.innerHTML = filtered.length ? filtered.map(r => {
    const acc = (r.accounts || []).slice(-1)[0] || '—';
    const cli = (r.clients || []).slice(-1)[0] || '—';
    const q = String(r.qualityLevel || 'C');
    const qTone = q === 'A' || q === 'B' ? 'badge-ok' : (q === 'D' ? 'badge-deny' : 'badge-blue');
    const bootLabel = (!r.boot || r.boot === '_') ? '靴号未确认' : escHtml(r.boot);
    return '<tr><td class="num">' + escHtml(r.tid || '') + '</td><td>' + escHtml(r.title || '—') + '</td>' +
      '<td>' + escHtml(r.day || '') + '</td><td>' + escHtml(hallLabel(r.cat)) + '</td><td>' + bootLabel + '</td>' +
      '<td class="num">' + escHtml(r.n || 0) + '</td>' +
      '<td><span class="badge ' + qTone + '">' + escHtml(q) + '</span></td>' +
      '<td>' + (r.continuityOk ? '✓' : '—') + '</td>' +
      '<td>' + (r.geometryVerified ? '✓' : '—') + '</td>' +
      '<td class="num">' + escHtml(r.sourceClientCount || 0) + '</td>' +
      '<td>' + renderRoadDots(r.preview) + '</td>' +
      '<td>' + escHtml(acc) + '</td><td class="mono">' + escHtml(cli) + '</td><td>' + escHtml(fmtTs(r.u)) + '</td></tr>';
  }).join('') : '<tr><td colspan="14" class="muted">暂无路单归档</td></tr>';
}
function formulaSummaryCards(rows) {
  const el = document.getElementById('formulaSummary');
  if (!el) return;
  const list = rows || [];
  let placeReal = 0, placeSim = 0, outcomes = 0, unresolved = 0;
  list.forEach(r => {
    placeReal += Number(r.placeReal) || 0;
    placeSim += Number(r.placeSim) || 0;
    outcomes += (Number(r.win) || 0) + (Number(r.lose) || 0) + (Number(r.tie) || 0);
    unresolved += Number(r.unresolved) || 0;
  });
  el.innerHTML =
    statCard('公式数量', list.length) +
    statCard('真实下注总数', placeReal) +
    statCard('模拟下注总数', placeSim) +
    statCard('未结算', unresolved) +
    statCard('已结算结果', outcomes);
}
function getFilteredFormulaRows() {
  let rows = (state.formulaRows || []).slice();
  const q = (state.formulaSearch || '').toLowerCase();
  if (q) rows = rows.filter(r => String(r.formula || '').toLowerCase().includes(q) || String(r.slot || '').toLowerCase().includes(q));
  if (state.formulaSort === 'winRate') {
    rows.sort((a, b) => (Number(b.winRatePct) || -1) - (Number(a.winRatePct) || -1));
  } else if (state.formulaSort === 'wilson') {
    rows.sort((a, b) => (Number(b.wilsonLower) || -1) - (Number(a.wilsonLower) || -1));
  } else {
    rows.sort((a, b) => (Number(b.placeTotal) || Number(b.decided) || 0) - (Number(a.placeTotal) || Number(a.decided) || 0));
  }
  return rows;
}
function renderFormulaStatsView() {
  const body = document.getElementById('formulaBody');
  if (!body) return;
  const rows = getFilteredFormulaRows();
  formulaSummaryCards(state.formulaRows || []);
  body.innerHTML = rows.length ? rows.map(r => {
    const mode = r.simulated ? '模拟' : '真实';
    const decided = Number(r.decided) || ((Number(r.win)||0)+(Number(r.lose)||0));
    const wilson = (r.wilsonLowerPct != null && r.wilsonUpperPct != null)
      ? (r.wilsonLowerPct + '% ~ ' + r.wilsonUpperPct + '%')
      : '—';
    const bayes = r.bayesMean == null ? '—' : ((Math.round(r.bayesMean * 1000) / 10) + '%（区间暂未计算）');
    const sig = r.significanceBasis === 'NET_PROFIT' ? '盈利能力检验'
      : (r.significanceBasis === 'WIN_RATE' ? '胜负比例检验' : '暂不可检验');
    const note = (r.containsLegacyImport ? '含旧版导入数据；' : '') +
      (r.unresolved ? ('未结算 ' + r.unresolved + '；') : '') +
      (r.unknown ? ('未知 ' + r.unknown + '；') : '') +
      (r.qValue != null ? ('FDR q=' + Number(r.qValue).toFixed(3) + '；') : '') +
      ('贝叶斯 ' + bayes + '；') +
      (sig + '；') +
      (r.significanceHint || '');
    return '<tr><td class="formula-name">' + escHtml(r.formula || '—') +
      (r.slot != null ? ' <span class="muted">#' + escHtml(r.slot) + '</span>' : '') + '</td>' +
      '<td>' + escHtml(mode) + '</td>' +
      '<td class="num">' + decided + '</td>' +
      '<td class="num ' + rateClass(r.winRatePct) + '">' + pct(r.winRatePct) + '</td>' +
      '<td class="num">' + escHtml(wilson) + '</td>' +
      '<td class="num">' + (r.roi == null ? (r.roiPartial ? '部分数据' : '—') : (Math.round(r.roi * 1000) / 10) + '%') + '</td>' +
      '<td class="num">' + (r.maxDrawdown == null ? '—' : escHtml(r.maxDrawdown)) + '</td>' +
      '<td>' + escHtml(r.conclusion || '样本不足') + '</td>' +
      '<td class="muted">' + escHtml(note || '—') + '</td>' +
      '<td>' + escHtml(r.lastAt || '') + '</td></tr>';
  }).join('') :
    '<tr><td colspan="10" class="muted">暂无公式统计</td></tr>';
}
async function loadFormulaStats() {
  const scopeEl = document.getElementById('formulaScope');
  const hint = document.getElementById('formulaHint');
  const body = document.getElementById('formulaBody');
  if (!hint || !body) return;
  const scope = scopeEl ? scopeEl.value : 'all';
  const seq = ++formulaReqSeq;
  let q = '';
  if (scope === 'client') {
    const cid = document.getElementById('formulaClientSel').value;
    if (!cid) { hint.textContent = '请选择客户端'; return; }
    q = '?clientId=' + encodeURIComponent(cid);
  } else if (scope === 'ip') {
    const ip = (document.getElementById('formulaIpInput').value || '').trim();
    if (!ip) { hint.textContent = '请填写 IP'; return; }
    q = '?ip=' + encodeURIComponent(ip);
  }
  hint.textContent = '加载中…';
  try {
    const data = await api('/api/formula-stats' + q);
    if (seq !== formulaReqSeq) return;
    state.formulaRows = data.rows || [];
    state.formulaLoaded = true;
    hint.textContent = '共 ' + state.formulaRows.length + ' 个公式 · 事件 ' + (data.uniqueEvents || 0) + '/' + (data.eventCount || 0) + '（手动刷新，无自动轮询）';
    renderFormulaStatsView();
  } catch (e) {
    hint.textContent = e.message || '加载失败';
    body.innerHTML = '<tr><td colspan="12" class="muted">' + escHtml(e.message || '加载失败') + '</td></tr>';
    handleAuthError(e);
  }
}
async function calcFormulaReplay() {
  const pattern = (document.getElementById('replayPattern').value || '').trim();
  const hint = document.getElementById('replayHint');
  const box = document.getElementById('replayResults');
  const btn = document.getElementById('replayCalc');
  if (!pattern) return alert('请填写公式');
  if (btn) btn.disabled = true;
  hint.textContent = '计算中…';
  box.innerHTML = '';
  try {
    const cat = document.getElementById('replayCat').value || '';
    const heavyEl = document.getElementById('replayHeavy');
    const data = await api('/api/road-formula-winrate', {
      method:'POST',
      body: JSON.stringify({
        pattern,
        algorithm: 'strict',
        betMode: document.getElementById('replayMode').value || 'follow',
        qualityFilter: (document.getElementById('replayQuality') || {}).value || 'AB',
        includeHeavy: !!(heavyEl && heavyEl.checked),
        dayFrom: document.getElementById('replayFrom').value || '',
        dayTo: document.getElementById('replayTo').value || '',
        tableId: (document.getElementById('replayTableId').value || '').trim() || undefined,
        cat: cat || undefined
      })
    });
    const wr = data.winRatePct == null ? '暂无' : (data.winRatePct + '%');
    const wilson = (data.wilsonLowerPct != null && data.wilsonUpperPct != null)
      ? (data.wilsonLowerPct + '% ~ ' + data.wilsonUpperPct + '%') : '—';
    hint.textContent = (data.replayModeLabel || '固定单位理论回放') +
      ' · 桌台数 ' + (data.tableCountScanned || data.tableCount || 0) +
      ' · 天数 ' + (data.dayCount || 0) +
      ' · A/B/C ' + (data.qualityACount||0) + '/' + (data.qualityBCount||0) + '/' + (data.qualityCCount||0) +
      ' · 排除D ' + (data.excludedDCount||0) +
      ' · 公式：' + (data.pattern || pattern) +
      (data.cacheHit ? ' · 缓存命中' : '');
    box.innerHTML =
      statCard('回放模式', data.replayModeLabel || '固定单位理论回放') +
      statCard('历史胜率', wr) +
      statCard('Wilson 95%', wilson) +
      statCard('匹配次数', data.geometricTriggerCount || data.matches || 0) +
      statCard('赢', data.win || 0) +
      statCard('输', data.lose || 0) +
      statCard('和', data.tie || 0) +
      statCard('未知', data.unknown || 0) +
      statCard(data.planProvided ? '计划理论ROI' : '单位理论ROI', data.roi == null ? '—' : ((Math.round(data.roi * 1000) / 10) + '%')) +
      statCard('理论最大回撤', data.maxDrawdown == null ? '—' : data.maxDrawdown) +
      statCard('连亏', data.maxConsecutiveLoss == null ? '—' : data.maxConsecutiveLoss) +
      statCard('Walk-forward ROI', data.walkForwardRoi == null ? '—' : data.walkForwardRoi) +
      statCard('扫描靴数', data.bootCountScanned || data.bootsScanned || 0);
  } catch (e) {
    hint.textContent = e.message || '失败';
    handleAuthError(e);
  } finally {
    if (btn) btn.disabled = false;
  }
}
function resetFormulaReplay() {
  const today = fmtDate(new Date());
  document.getElementById('replayPattern').value = '';
  document.getElementById('replayMode').value = 'follow';
  document.getElementById('replayFrom').value = today;
  document.getElementById('replayTo').value = today;
  document.getElementById('replayTableId').value = '';
  document.getElementById('replayCat').value = '';
  document.getElementById('replayHint').textContent = '尚未计算';
  document.getElementById('replayResults').innerHTML = '';
}
function patchLogsPage(data) {
  const list = document.getElementById('logSideList');
  if (!list || !data) return;
  const q = (state.logsSearch || '').toLowerCase();
  if (state.logsTab === 'online') {
    const rows = (data.online || []).filter(r => !q || (r.account || '').toLowerCase().includes(q) || (r.clientId || '').toLowerCase().includes(q) || (r.ip || '').toLowerCase().includes(q));
    list.innerHTML = rows.length ? rows.map(r => {
      const active = state.logsTarget.clientId === r.clientId;
      return '<div class="log-item' + (active ? ' active' : '') + '" data-type="client" data-cid="' + escHtml(r.clientId) + '" data-ip="' + escHtml(r.ip || '') + '">' +
        escHtml(displayClientLabel(r)) + '<div class="muted">' + escHtml(r.ip || '') + '</div></div>';
    }).join('') : '<p class="muted">无在线客户端</p>';
  } else {
    const rows = (data.ips || []).filter(r => !q || (r.ip || '').toLowerCase().includes(q));
    list.innerHTML = rows.length ? rows.map(r => {
      const active = state.logsTarget.ip === r.ip && !state.logsTarget.clientId;
      const sizeTxt = r.size != null ? fmtBytes(r.size) : '';
      return '<div class="log-item' + (active ? ' active' : '') + '" data-type="ip" data-ip="' + escHtml(r.ip) + '">' +
        escHtml(r.ip) +
        (sizeTxt ? '<div class="muted">大小 ' + escHtml(sizeTxt) + '</div>' : '') +
        '<div class="muted">' + escHtml(r.updatedAt || '') + '</div></div>';
    }).join('') : '<p class="muted">还没有上传过日志</p>';
  }
  list.querySelectorAll('.log-item').forEach(el => {
    el.onclick = () => {
      state.logsTarget = el.dataset.type === 'client'
        ? { type:'client', clientId: el.dataset.cid, ip: el.dataset.ip }
        : { type:'ip', clientId:'', ip: el.dataset.ip };
      patchLogsPage(data);
      loadLogs().catch(() => {});
    };
  });
}
async function loadLogs() {
  const t = state.logsTarget;
  if (!t.ip && !t.clientId) return;
  const title = document.getElementById('logTitle');
  if (title) {
    if (t.clientId) {
      const online = findOnlineByClientId(t.clientId) || { clientId: t.clientId, ip: t.ip };
      title.textContent = displayClientLabel(online) + (t.ip ? (' · ' + t.ip) : '');
    } else {
      title.textContent = 'IP ' + t.ip;
    }
  }
  const seq = ++logReqSeq;
  const q = t.ip && !t.clientId ? ('ip=' + encodeURIComponent(t.ip)) : ('clientId=' + encodeURIComponent(t.clientId));
  try {
    const data = await api('/api/logs?' + q + '&limit=300');
    if (seq !== logReqSeq) return;
    const box = document.getElementById('logBox');
    const rows = data.rows || [];
    const times = enrichLogDisplayTimes(rows);
    box.innerHTML = rows.length ? rows.map((r, i) => {
      const kind = r.kind ? '<span class="badge badge-blue" style="margin-right:8px">' + escHtml(r.kind) + '</span>' : '';
      return '<div class="log-row"><span class="t">' + escHtml(times[i] || r.t || '—') + '</span>' + kind + escHtml(cleanLogText(r.text || '')) + '</div>';
    }).join('') : '<p class="muted">暂无记录</p>';
  } catch (e) {
    handleAuthError(e);
  }
}
async function runControl(action, extra) {
  await api('/api/run-control', { method:'POST', body: JSON.stringify(Object.assign({ action }, extra || {})) });
  await fetchOverview(true);
  if (state.currentRoute === 'control') patchControlPage(state.overview);
  if (state.currentRoute === 'clients') patchClientsPage(state.overview);
  if (state.currentRoute === 'dashboard') patchDashboard(state.overview);
}

/* ===== bindings ===== */
function bindPageEvents(routeId) {
  if (routeId === 'dashboard') {
    const goDesk = document.getElementById('dashGoDesktop');
    const goMon = document.getElementById('dashGoMonitor');
    if (goDesk) goDesk.onclick = () => navigate('desktop');
    if (goMon) goMon.onclick = () => navigate('wx-monitor');
    const ann = document.getElementById('dashAnnounce');
    if (ann) ann.onclick = () => navigate('announcements');
    const clientsBtn = document.getElementById('dashClientsBtn');
    if (clientsBtn) clientsBtn.onclick = () => navigate('clients');
    const roadRefresh = document.getElementById('dashRoadRefresh');
    if (roadRefresh) roadRefresh.onclick = () => loadWxDashboard().catch(alert);
  }
  if (routeId && routeId.startsWith('wx-')) {
    const refresh = document.getElementById('wxRefresh');
    if (refresh) refresh.onclick = () => loadWxFeaturePage(routeId).catch(alert);
    const go = document.getElementById('wxGoDesktop');
    if (go) go.onclick = () => navigate('desktop');
    const search = document.getElementById('wxSearch');
    if (search) search.onkeydown = (e) => { if (e.key === 'Enter') loadWxFeaturePage(routeId).catch(alert); };
    const cleanup = document.getElementById('wxCleanupImages');
    if (cleanup) cleanup.onclick = () => {
      const before = Math.floor(Date.now() / 1000) - 7 * 86400;
      api('/api/wx/images/cleanup', { method: 'POST', body: JSON.stringify({ before_ts: before }) })
        .then(() => { alert('已提交清理'); return loadWxFeaturePage(routeId); })
        .catch(alert);
    };
  }
  if (routeId === 'desktop') {
    bindDesktopPageEvents();
  }
  if (routeId === 'clients') {
    document.getElementById('clientSearch').value = state.clientsFilters.search;
    document.getElementById('clientStatusFilter').value = state.clientsFilters.status;
    document.getElementById('clientDesktopFilter').value = state.clientsFilters.desktop;
    document.getElementById('clientSearch').oninput = e => { state.clientsFilters.search = e.target.value; patchClientsTable(state.overview); };
    document.getElementById('clientStatusFilter').onchange = e => { state.clientsFilters.status = e.target.value; patchClientsTable(state.overview); };
    document.getElementById('clientDesktopFilter').onchange = e => { state.clientsFilters.desktop = e.target.value; patchClientsTable(state.overview); };
    document.getElementById('clientVersionFilter').onchange = e => { state.clientsFilters.version = e.target.value; patchClientsTable(state.overview); };
    document.getElementById('clientRefresh').onclick = () => fetchOverview(true).catch(alert);
    document.getElementById('selectAllCb').onchange = e => {
      const rows = filterClients((state.overview && state.overview.online) || []);
      if (e.target.checked) selectAllVisible(rows.map(r => r.clientId)); else clearSelection();
    };
    document.getElementById('selClear').onclick = clearSelection;
    document.getElementById('batchAllow').onclick = () => batchAllow().catch(alert);
    document.getElementById('batchDeny').onclick = () => batchDeny();
    document.getElementById('batchAnnounce').onclick = openBatchAnnounceModal;
  }
  if (routeId === 'client-detail') {
    const back = document.getElementById('cdBack');
    const refresh = document.getElementById('cdRefresh');
    if (back) back.onclick = () => navigate('clients');
    if (refresh) refresh.onclick = () => loadClientDetail().catch(alert);
  }
  if (routeId === 'control') {
    document.getElementById('ctrlGlobalAllow').onclick = () => runControl('global_allow').catch(alert);
    document.getElementById('ctrlGlobalDeny').onclick = () => confirmDanger(GLOBAL_DENY_CONFIRM, () => runControl('global_deny').catch(alert));
  }
  if (routeId === 'announcements') {
    document.querySelectorAll('input[name="annMode"]').forEach(el => {
      el.checked = el.value === state.announceMode;
      el.onchange = () => {
        state.announceMode = el.value;
        document.getElementById('annClientsBox').classList.toggle('hide', state.announceMode !== 'clients');
        document.getElementById('annIpBox').classList.toggle('hide', state.announceMode !== 'ip');
        updateAnnounceTargetSummary();
      };
    });
    document.getElementById('annClientsBox').classList.toggle('hide', state.announceMode !== 'clients');
    document.getElementById('annIpBox').classList.toggle('hide', state.announceMode !== 'ip');
    document.getElementById('annClientSearch').oninput = () => patchAnnouncePage(state.overview);
    document.getElementById('annSelectAll').onclick = () => {
      const checks = document.querySelectorAll('.ann-check');
      checks.forEach(el => { state.announceSelected.add(el.dataset.cid); el.checked = true; });
      updateAnnounceTargetSummary();
    };
    const title = document.getElementById('annTitle');
    const ta = document.getElementById('annText');
    const titleCtr = document.getElementById('annTitleCounter');
    const ctr = document.getElementById('annCounter');
    const syncCounters = () => {
      titleCtr.textContent = title.value.length + '/40';
      ctr.textContent = ta.value.length + '/2000';
    };
    title.oninput = syncCounters;
    ta.oninput = syncCounters;
    syncCounters();
    document.getElementById('annIp').oninput = updateAnnounceTargetSummary;
    document.getElementById('annSend').onclick = () => sendAnnounce().catch(alert);
    document.getElementById('annClear').onclick = () => {
      title.value = '公告';
      ta.value = '';
      state.announceSelected.clear();
      document.getElementById('annIp').value = '';
      syncCounters();
      patchAnnouncePage(state.overview);
    };
  }
  if (routeId === 'roads') {
    document.getElementById('roadFilter').value = state.roadFilter;
    document.getElementById('roadDay').value = state.roadDay;
    document.getElementById('roadCat').value = state.roadCat;
    document.getElementById('roadFilter').oninput = e => { state.roadFilter = e.target.value; patchRoadsPage(state.roadData); };
    document.getElementById('roadDay').onchange = e => { state.roadDay = e.target.value; patchRoadsPage(state.roadData); };
    document.getElementById('roadCat').onchange = e => { state.roadCat = e.target.value; patchRoadsPage(state.roadData); };
    document.getElementById('roadRefresh').onclick = () => loadRoadOverview().catch(alert);
  }
  if (routeId === 'formula-stats') {
    const scopeSel = document.getElementById('formulaScope');
    scopeSel.value = state.formulaScope;
    const clientSel = document.getElementById('formulaClientSel');
    const ipInput = document.getElementById('formulaIpInput');
    const online = (state.overview && state.overview.online) || [];
    clientSel.innerHTML = online.map(r => '<option value="' + escHtml(r.clientId) + '">' + escHtml(displayClientLabel(r) + (r.ip ? (' · ' + r.ip) : '')) + '</option>').join('');
    if (state.formulaClientId) clientSel.value = state.formulaClientId;
    if (state.formulaIp) ipInput.value = state.formulaIp;
    document.getElementById('formulaSearch').value = state.formulaSearch;
    document.getElementById('formulaSort').value = state.formulaSort;
    scopeSel.onchange = () => {
      state.formulaScope = scopeSel.value;
      clientSel.classList.toggle('hide', state.formulaScope !== 'client');
      ipInput.classList.toggle('hide', state.formulaScope !== 'ip');
      state.formulaLoaded = false;
      state.formulaRows = null;
      const hint = document.getElementById('formulaHint');
      const body = document.getElementById('formulaBody');
      const summary = document.getElementById('formulaSummary');
      if (summary) summary.innerHTML = '';
      if (body) body.innerHTML = '<tr><td colspan="12" class="muted">范围已切换，请重新加载</td></tr>';
      if (hint) hint.textContent = '范围已切换，点击「加载统计」获取数据';
      if (state.formulaScope === 'all') loadFormulaStats().catch(handleAuthError);
    };
    clientSel.classList.toggle('hide', state.formulaScope !== 'client');
    ipInput.classList.toggle('hide', state.formulaScope !== 'ip');
    document.getElementById('formulaSearch').oninput = e => { state.formulaSearch = e.target.value; renderFormulaStatsView(); };
    document.getElementById('formulaSort').onchange = e => { state.formulaSort = e.target.value; renderFormulaStatsView(); };
    document.getElementById('formulaLoad').onclick = () => {
      state.formulaClientId = clientSel.value;
      state.formulaIp = ipInput.value;
      loadFormulaStats().catch(alert);
    };
  }
  if (routeId === 'formula-replay') {
    document.getElementById('replayCalc').onclick = () => calcFormulaReplay().catch(alert);
    document.getElementById('replayReset').onclick = resetFormulaReplay;
  }
  if (routeId === 'logs') {
    document.querySelectorAll('.tab-btn').forEach(el => {
      el.classList.toggle('active', el.dataset.logtab === state.logsTab);
      el.onclick = () => { state.logsTab = el.dataset.logtab; document.querySelectorAll('.tab-btn').forEach(t => t.classList.toggle('active', t.dataset.logtab === state.logsTab)); patchLogsPage(state.overview); };
    });
    document.getElementById('logSearch').value = state.logsSearch;
    document.getElementById('logSearch').oninput = e => { state.logsSearch = e.target.value; patchLogsPage(state.overview); };
    document.getElementById('logRefresh').onclick = () => loadLogs().catch(alert);
    if (state.logsTarget.clientId || state.logsTarget.ip) loadLogs().catch(() => {});
  }
  if (routeId === 'releases') {
    document.getElementById('relRefreshBtn').onclick = () => loadReleasesStatus().catch(alert);
    document.getElementById('relPublishBtn').onclick = () => publishReleasePackage().catch(alert);
    loadReleasesStatus().catch(e => {
      const cur = document.getElementById('relCurrent');
      if (cur) cur.textContent = e.message || '加载失败';
    });
  }
}
async function sendAnnounce() {
  const mode = state.announceMode;
  const title = (document.getElementById('annTitle').value || '公告').trim().slice(0, 40);
  const text = (document.getElementById('annText').value || '').trim();
  if (!text) return alert('请填写公告内容');
  const sendBtn = document.getElementById('annSend');
  if (sendBtn && sendBtn.disabled) return;
  if (sendBtn) sendBtn.disabled = true;
  const now = fmtClock(new Date());
  try {
    if (mode === 'ip') {
      const ip = (document.getElementById('annIp').value || '').trim();
      if (!ip) return alert('请填写目标 IP');
      try {
        const data = await api('/api/announce', { method:'POST', body: JSON.stringify({ ip, text, title }) });
        state.announceResults.push({ ok:true, target: ip, message: data.message || '已发送', time: now });
      } catch (e) {
        state.announceResults.push({ ok:false, target: ip, message: e.message || '失败', time: now });
      }
      renderAnnounceResults();
      return;
    }
    const ids = Array.from(state.announceSelected);
    if (!ids.length) return alert('请选择至少一个客户端');
    const rows = ((state.overview && state.overview.online) || []).filter(r => ids.includes(r.clientId));
    if (!rows.length) {
      alert('所选客户端已不在线');
      return;
    }
    let done = 0, ok = 0, fail = 0;
    const prog = document.getElementById('annBatchProgress');
    const progBar = document.getElementById('annProgBar');
    const progTxt = document.getElementById('annProgText');
    if (prog) prog.classList.remove('hide');
    const queue = rows.slice();
    async function worker() {
      while (queue.length) {
        const r = queue.shift();
        try {
          const data = await api('/api/announce', { method:'POST', body: JSON.stringify({ clientId:r.clientId, ip:r.ip, title, text }) });
          state.announceResults.push({ ok:true, target: displayClientLabel(r), message: data.message || '已发送', time: now });
          ok++;
        } catch (e) {
          state.announceResults.push({ ok:false, target: displayClientLabel(r), message: e.message || '失败', time: now });
          fail++;
        }
        done++;
        if (progTxt) progTxt.textContent = '正在处理 ' + done + ' / ' + rows.length + '  成功 ' + ok + '  失败 ' + fail;
        if (progBar) progBar.style.width = Math.round(done / rows.length * 100) + '%';
      }
    }
    const runners = [];
    for (let i = 0; i < Math.min(3, rows.length); i++) runners.push(worker());
    await Promise.all(runners);
    if (progTxt) progTxt.textContent = '处理完成：成功 ' + ok + ' 台，失败 ' + fail + ' 台';
    renderAnnounceResults();
  } finally {
    if (sendBtn) sendBtn.disabled = false;
  }
}

document.getElementById('loginBtn').onclick = doLogin;
document.getElementById('loginPwd').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('logoutBtn').onclick = logout;
document.getElementById('sidebarToggle').onclick = () => {
  state.sidebarOpen = !state.sidebarOpen;
  document.getElementById('sidebar').classList.toggle('open', state.sidebarOpen);
};
window.addEventListener('hashchange', onHashChange);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!modalBusy) closeModal();
    setDeskFullscreen(false);
    closeDropdown();
  }
});

if (state.token) {
  ensureAdminTokenRefresh();
  api('/api/overview').then(data => {
    state.overview = data;
    showLogin(true);
    renderSidebarNav();
    startClock();
    updateConnBadge(true);
    updateSidebarFoot(true);
    navigate(parseRoute());
  }).catch(() => logout());
} else {
  showLogin(false);
  if (!location.hash) location.hash = '#/dashboard';
}
</script>
</body>
</html>
"""
