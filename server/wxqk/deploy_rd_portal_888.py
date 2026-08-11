#!/usr/bin/env python3
"""Screen-wall portal at :888 and https://xiangyuzhubao.xyz/888/."""
from __future__ import annotations

import os
import time

import paramiko

# 屏幕墙挂在旧域名机；独立环境变量，避免被 WXQK_SSH_HOST=新服 带偏
HOST = os.environ.get("RD_PORTAL_SSH_HOST") or "47.108.21.50"
USER = os.environ.get("RD_PORTAL_SSH_USER") or os.environ.get("WXQK_SSH_USER") or "root"
PASSWORD = (
    os.environ.get("RD_PORTAL_SSH_PASSWORD")
    or os.environ.get("WXQK_SSH_PASSWORD")
    or "FFff472336362@@"
)

REMOTE_DIR = "/opt/rd-portal"
NGINX_SITE = "/etc/nginx/sites-enabled/rd-portal-888.conf"
BUSINESS_SNIPPET = "/etc/nginx/snippets/xiangyuzhubao-business.conf"
# 微信群控已迁到新服：旧域名屏幕墙经此反向代理看新服画面（同页聚合，无需再开 8443）
NEW_WXQK_UPSTREAM = "https://120.27.219.138:8443/wxqk/"
NEW_WXQK_DESK = "https://120.27.219.138:8443/wxqk/#/desktop"

# Single-file SPA: login → live thumbnail wall across wxqk / 九游 / 开云.
PORTAL_HTML = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="mobile-web-app-capable" content="yes" />
  <title>屏幕墙</title>
  <style>
    :root {
      --bg: #0b1220;
      --panel: #121a2b;
      --text: #e8eef8;
      --muted: #8fa0b8;
      --accent: #3b82f6;
      --ok: #22c55e;
      --bad: #ef4444;
      --border: #243047;
      --safe-top: env(safe-area-inset-top, 0px);
      --safe-bottom: env(safe-area-inset-bottom, 0px);
      --safe-left: env(safe-area-inset-left, 0px);
      --safe-right: env(safe-area-inset-right, 0px);
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text);
      font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; overflow: hidden;
      -webkit-text-size-adjust: 100%; }
    .hidden { display: none !important; }
    #loginView {
      min-height: 100vh; min-height: 100dvh; display: flex; align-items: center; justify-content: center;
      padding: calc(24px + var(--safe-top)) calc(24px + var(--safe-right)) calc(24px + var(--safe-bottom)) calc(24px + var(--safe-left));
      background: radial-gradient(900px 480px at 15% 0%, #1e3a5f55, transparent 60%), var(--bg);
    }
    .login-card {
      width: min(380px, 100%); background: var(--panel); border: 1px solid var(--border);
      border-radius: 14px; padding: 28px 24px;
    }
    .login-card h1 { margin: 0 0 6px; font-size: 22px; }
    .login-card p { margin: 0 0 18px; color: var(--muted); font-size: 13px; line-height: 1.45; }
    .login-card input {
      width: 100%; padding: 12px 12px; border-radius: 8px; border: 1px solid var(--border);
      background: #0b1220; color: var(--text); font-size: 16px; outline: none;
    }
    .login-card input:focus { border-color: var(--accent); }
    .login-card button {
      margin-top: 12px; width: 100%; padding: 12px; border: 0; border-radius: 8px;
      background: var(--accent); color: #fff; font-size: 16px; font-weight: 600; cursor: pointer;
    }
    .login-card button:disabled { opacity: .6; cursor: wait; }
    #loginErr { color: var(--bad); font-size: 13px; min-height: 18px; margin-top: 10px; }
    #wallView {
      height: 100vh; max-height: 100dvh; display: flex; flex-direction: column; overflow: hidden;
      padding-top: var(--safe-top); padding-left: var(--safe-left); padding-right: var(--safe-right);
    }
    .topbar {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      padding: 10px 14px; border-bottom: 1px solid var(--border); background: #0d1524f2;
      z-index: 20; flex: 0 0 auto;
    }
    .topbar h1 { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: 0.02em; }
    .topbar .meta { color: var(--muted); font-size: 12px; max-width: 42vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .topbar .spacer { flex: 1; min-width: 8px; }
    .pill {
      display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px;
      border-radius: 999px; border: 1px solid var(--border); font-size: 12px; color: var(--muted);
      background: #0b1220aa;
    }
    .pill b { color: var(--text); font-weight: 650; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); }
    .dot.off { background: var(--bad); }
    .btn-ghost {
      background: transparent; border: 1px solid var(--border); color: var(--muted);
      border-radius: 8px; padding: 8px 12px; cursor: pointer; font-size: 12px;
      min-height: 36px;
    }
    .btn-ghost:hover { color: var(--text); border-color: #3b4f6e; }
    .layout-group {
      display: inline-flex; align-items: center; gap: 0; border: 1px solid var(--border);
      border-radius: 9px; overflow: hidden; background: #0b1220;
      max-width: 100%;
    }
    .layout-mob { display: none; }
    .layout-group .lab {
      padding: 0 8px; font-size: 11px; color: var(--muted); border-right: 1px solid var(--border);
      height: 30px; display: inline-flex; align-items: center; white-space: nowrap;
    }
    .layout-btn {
      appearance: none; border: 0; background: transparent; color: var(--muted);
      height: 30px; min-width: 36px; padding: 0 10px; font-size: 12px; cursor: pointer;
      border-right: 1px solid var(--border);
    }
    .layout-btn:last-child { border-right: 0; }
    .layout-btn:hover { color: var(--text); background: #1a2740; }
    .layout-btn.active { color: #fff; background: var(--accent); font-weight: 650; }
    #wallWrap {
      flex: 1 1 auto; min-height: 0; height: 0; padding: 8px; display: flex;
      padding-bottom: calc(8px + var(--safe-bottom));
      overflow: hidden;
      box-sizing: border-box;
    }
    /* 单/双/三排：视口固定格数，超出在 wrap 内纵向滚动 */
    #wallWrap.wall-scroll {
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    #wall {
      flex: 1; min-height: 0; height: 100%; width: 100%;
      display: grid;
      gap: 8px;
      align-content: stretch;
      justify-content: stretch;
      overflow: hidden;
      box-sizing: border-box;
    }
    #wall.muuri-scroll {
      height: auto;
      min-height: 100%;
      overflow: visible;
      flex: 0 0 auto;
    }
    /* Muuri 桌面布局：绝对定位网格（https://github.com/haltu/muuri） */
    #wall.muuri-active {
      display: block;
      position: relative;
    }
    #wall.muuri-active .tile {
      display: flex;
      flex-direction: column;
      position: absolute;
      margin: 0;
      z-index: 1;
    }
    #wall.muuri-active .tile.muuri-item-dragging { z-index: 4; }
    #wall.muuri-active .tile.muuri-item-releasing { z-index: 3; }
    #wall.muuri-active .tile.muuri-item-hidden { z-index: 0; }
    .tile {
      background: linear-gradient(180deg, #152036 0%, #101827 100%);
      border: 1px solid var(--border); border-radius: 10px;
      overflow: hidden; cursor: grab; display: flex; flex-direction: column;
      min-width: 0; min-height: 0; box-shadow: 0 4px 14px rgba(0,0,0,.22);
      transition: border-color .15s ease, box-shadow .15s ease, transform .12s ease;
      touch-action: none; user-select: none;
    }
    .tile:hover {
      border-color: #3b82f6aa;
      box-shadow: 0 6px 18px rgba(37, 99, 235, .18);
    }
    .tile img, .tile canvas, .tile .ph { -webkit-user-drag: none; pointer-events: none; }
    .tile.muuri-item-dragging {
      cursor: grabbing;
      box-shadow: 0 16px 36px rgba(0,0,0,.55);
      border-color: #60a5fa;
      opacity: .96;
    }
    .tile .screen {
      position: relative; flex: 1 1 auto; min-height: 0; background: #000; overflow: hidden;
    }
    .tile img, .tile canvas, .tile .ph {
      width: 100%; height: 100%; object-fit: contain; background: #000; display: block;
    }
    .tile canvas.hidden, .tile img.hidden { display: none; }
    .tile .ph {
      display: flex; align-items: center; justify-content: center; color: #64748b; font-size: 12px;
    }
    .tile .badge {
      position: absolute; top: 6px; left: 6px; font-size: 10px; padding: 2px 7px;
      border-radius: 999px; background: rgba(0,0,0,.62); color: #dbeafe; border: 1px solid #334155;
      backdrop-filter: blur(4px);
    }
    /* 链路状态只保留右下角 .live，去掉右上角 path-badge 避免重复 */
    .tile video {
      width: 100%; height: 100%; object-fit: contain; background: #000; display: none;
    }
    .tile video.on { display: block; }
    .tile .pick {
      position: absolute; top: 6px; right: 6px; z-index: 5;
      width: 22px; height: 22px; margin: 0; cursor: pointer;
      accent-color: var(--accent);
      background: rgba(0,0,0,.45); border-radius: 4px;
    }
    .tile .live {
      position: absolute; bottom: 6px; right: 6px; font-size: 10px; padding: 2px 6px;
      border-radius: 999px; background: rgba(34,197,94,.2); color: #86efac; border: 1px solid #166534;
      backdrop-filter: blur(4px);
    }
    .tile .live.stale { background: rgba(239,68,68,.18); color: #fca5a5; border-color: #7f1d1d; }
    .tile .stale-banner {
      display: none; position: absolute; top: 0; left: 0; right: 0; z-index: 4;
      padding: 6px 8px; font-size: 11px; font-weight: 650; line-height: 1.35; text-align: center;
      color: #fff; background: rgba(185,28,28,.88); pointer-events: none;
    }
    .tile.is-stale .stale-banner { display: block; }
    /* 断链/卡死：最后一帧半透+灰，避免「看起来还活着」 */
    .tile.is-stale .screen video.on,
    .tile.is-stale .screen canvas:not(.hidden) {
      opacity: 0.42;
      filter: grayscale(0.4);
    }
    .tile.off .screen { opacity: .55; }
    .tile.off .live { display: none; }
    .tile.off .stale-banner { display: none; }
    .tile.off.is-stale .stale-banner { display: block; }
    .tile.off.is-stale .screen { opacity: 0.42; filter: grayscale(0.4); }
    .tile .meta {
      flex: 0 0 auto; padding: 5px 8px 6px; font-size: 11px; display: flex; flex-direction: column; gap: 1px;
      border-top: 1px solid var(--border); background: rgba(8, 14, 26, .72);
    }
    .tile .meta .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tile .meta .sub { color: var(--muted); font-family: ui-monospace, Consolas, monospace; font-size: 10px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #empty {
      grid-column: 1 / -1; grid-row: 1 / -1; text-align: center; color: var(--muted);
      padding: 60px 20px; font-size: 14px; align-self: center; justify-self: center;
    }
    #overlay {
      position: fixed; inset: 0; background: rgba(2,6,14,.88); z-index: 50;
      display: flex; flex-direction: column;
      padding: calc(12px + var(--safe-top)) calc(12px + var(--safe-right)) calc(12px + var(--safe-bottom)) calc(12px + var(--safe-left));
    }
    #overlay .obar {
      display: flex; gap: 10px; align-items: center; margin-bottom: 10px; flex-wrap: wrap;
    }
    #overlay .obar .title { font-size: 14px; font-weight: 650; flex: 1; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #overlay .stage {
      flex: 1; background: #000; border-radius: 10px; overflow: hidden;
      display: flex; align-items: center; justify-content: center; border: 1px solid var(--border);
      min-height: 0;
    }
    #overlay img, #overlay canvas, #overlay video { max-width: 100%; max-height: 100%; object-fit: contain; cursor: zoom-out; }
    #overlay .stage, #overlay video.on, #overlay canvas:not(.hidden) { cursor: zoom-out; }
    #overlay canvas.hidden, #overlay video:not(.on) { display: none; }
    #overlay video.on { display: block; background: #000; }
    #overlay .stage { position: relative; cursor: zoom-out; }
    #ovStaleBanner {
      display: none; position: absolute; top: 0; left: 0; right: 0; z-index: 3;
      padding: 8px 12px; font-size: 13px; font-weight: 600; text-align: center;
      color: #fff; background: rgba(185,28,28,.88); pointer-events: none;
    }
    #overlay .stage.is-stale #ovStaleBanner { display: block; }
    #overlay .stage.is-stale video.on,
    #overlay .stage.is-stale canvas:not(.hidden) {
      opacity: 0.45;
      filter: grayscale(0.35);
    }

    /* —— 手机 / 窄屏 —— */
    @media (max-width: 768px) {
      html, body { overflow: auto; overflow-x: hidden; height: auto; min-height: 100%; }
      #wallView {
        height: auto; min-height: 100dvh; max-height: none; overflow: visible;
      }
      .topbar {
        gap: 6px; padding: 8px 10px;
        position: sticky; top: 0;
      }
      .topbar h1 { font-size: 14px; width: 100%; }
      .topbar .meta { max-width: 100%; width: 100%; white-space: normal; }
      .topbar .spacer { display: none; }
      .pill { padding: 3px 8px; font-size: 11px; }
      .pill-desk { display: none; }
      .layout-desk { display: none !important; }
      .layout-mob { display: inline-flex !important; width: 100%; }
      .layout-group {
        width: 100%;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
      }
      .layout-group::-webkit-scrollbar { display: none; }
      .layout-group .lab { flex: 0 0 auto; height: 34px; }
      .layout-btn {
        flex: 1 1 auto; height: 34px; min-width: 42px; padding: 0 12px; font-size: 13px;
      }
      .btn-ghost { min-height: 38px; padding: 8px 14px; font-size: 13px; }
      #logoutBtn { width: 100%; }
      #wallWrap {
        display: block; flex: none; min-height: auto; height: auto;
        padding: 8px 8px calc(16px + var(--safe-bottom));
        overflow: visible;
      }
      #wall {
        display: grid !important;
        grid-template-columns: 1fr !important;
        grid-auto-rows: minmax(200px, 42vw) !important;
        grid-template-rows: none !important;
        gap: 10px !important;
        height: auto !important;
        min-height: 0;
        align-content: start;
      }
      #wall.cols-2 {
        grid-template-columns: 1fr 1fr !important;
        grid-auto-rows: minmax(150px, 36vw) !important;
      }
      .tile {
        touch-action: manipulation;
        cursor: pointer;
        min-height: 180px;
      }
      .tile .pick {
        width: 28px; height: 28px; top: 8px; right: 8px;
      }
      .tile .badge { top: 8px; left: 8px; font-size: 11px; padding: 3px 8px; }
      .tile .live { bottom: 8px; right: 8px; font-size: 11px; padding: 3px 8px; }
      .tile .meta { padding: 7px 10px 8px; font-size: 12px; }
      .tile .meta .sub { font-size: 11px; }
      #overlay .obar .title { white-space: normal; }
      #ovOpen, #ovClose { flex: 1 1 auto; text-align: center; }
    }
    @media (max-width: 420px) {
      #wall { grid-auto-rows: minmax(190px, 55vw) !important; }
      #wall.cols-2 {
        grid-auto-rows: minmax(140px, 42vw) !important;
      }
    }
    @media (min-width: 769px) {
      .layout-mob { display: none !important; }
    }
    /* 触屏设备：允许页面滚动，拖拽改由桌面指针处理 */
    @media (pointer: coarse) and (max-width: 1024px) {
      .tile { touch-action: manipulation; cursor: pointer; }
    }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/livekit-client@2.15.4/dist/livekit-client.umd.js"></script>
  <!-- 成熟布局+拖拽：Muuri https://github.com/haltu/muuri -->
  <script src="https://cdn.jsdelivr.net/npm/web-animations-js@2.3.2/web-animations.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/muuri@0.9.5/dist/muuri.min.js"></script>
</head>
<body>
  <div id="loginView">
    <form class="login-card" id="loginForm">
      <h1>屏幕墙</h1>
      <p>登录后进入屏幕墙；右上角打勾才显示画面并推流；双击瓦片放大，再双击退出</p>
      <input id="password" type="password" placeholder="管理密码" autocomplete="current-password" autofocus />
      <button id="loginBtn" type="submit">进入</button>
      <div id="loginErr"></div>
    </form>
  </div>

  <div id="wallView" class="hidden">
    <div class="topbar">
      <h1>屏幕墙</h1>
      <span class="pill"><span class="dot" id="liveDot"></span>实时</span>
      <span class="pill">在线 <b id="onlineCount">0</b></span>
      <span class="pill">勾选 <b id="selectedCount">0</b></span>
      <span class="pill pill-desk">画面 <b id="frameCount">0</b></span>
      <div class="layout-group layout-desk" id="layoutGroup" title="单排=一屏1台可下滑；双排=一屏2×2可下滑；三排=一屏3×3可下滑">
        <span class="lab">排版</span>
        <button type="button" class="layout-btn" data-rows="auto" title="全部塞进一屏：3台左二右一，4台上二下二">自动</button>
        <button type="button" class="layout-btn" data-rows="1" title="一屏1台，下滑看其余">单排</button>
        <button type="button" class="layout-btn" data-rows="2" title="一屏2×2平分，下滑看其余">双排</button>
        <button type="button" class="layout-btn" data-rows="3" title="一屏3×3平分，下滑看其余">三排</button>
      </div>
      <div class="layout-group layout-mob" id="layoutGroupMobile" title="手机排版">
        <span class="lab">排版</span>
        <button type="button" class="layout-btn" data-mcols="1">单列</button>
        <button type="button" class="layout-btn" data-mcols="2">双列</button>
      </div>
      <span class="meta" id="statusText"></span>
      <span class="spacer"></span>
      <button class="btn-ghost" id="logoutBtn" type="button">退出</button>
    </div>
    <div id="wallWrap"><div id="wall"><div id="empty">加载中…</div></div></div>
  </div>

  <div id="overlay" class="hidden">
    <div class="obar">
      <span class="title" id="ovTitle"></span>
      <span class="spacer"></span>
      <a class="btn-ghost" id="ovOpen" href="#" target="_blank" rel="noopener">打开完整远程桌面</a>
      <button class="btn-ghost" id="ovClose" type="button">关闭</button>
    </div>
    <div class="stage">
      <div id="ovStaleBanner">画面已停住（缓存）</div>
      <video id="ovVideo" playsinline muted autoplay></video>
      <canvas id="ovCanvas"></canvas>
      <img id="ovImg" class="hidden" alt="desktop" />
    </div>
  </div>

<script>
(function () {
  const BASE = (function () {
    const p = location.pathname || '/';
    if (p === '/888' || p.startsWith('/888/')) return '/888';
    return '';
  })();

  const SOURCES = [
    // preferWs: 新服 wxqk 支持 /api/admin/ws-ticket；九游/开云旧后端无此接口，走 HTTP 轮询即可
    // preferWebRtc: 先端到端，失败走云中转(TURN)，再失败 JPG全图；瓦片三态标注
    { id: 'wxqk', name: '微信群控', prefix: BASE + '/p/wxqk', deskPath: 'https://120.27.219.138:8443/wxqk/#/desktop', preferWs: true, preferWebRtc: true },
    { id: 'jiuyou', name: '九游', prefix: BASE + '/p/jiuyou', deskPath: '/%E4%B9%9D%E6%B8%B8/#/desktop', preferWs: false, preferWebRtc: false },
    { id: 'kaiyun', name: '开云', prefix: BASE + '/p/kaiyun', deskPath: '/%E5%8F%91%E8%B4%A2888/#/desktop', preferWs: false, preferWebRtc: false },
  ];
  // TURN/对称 NAT 协商常需 >8s；过短会误杀后回落 JPG全图
  const WEBRTC_CONNECT_TIMEOUT_MS = 45000;

  const TOK_KEY = 'rdwall.tokens.v1';
  const LAYOUT_KEY = 'rdwall.layout.rows.v3';
  const MOBILE_COLS_KEY = 'rdwall.layout.mcols.v1';
  const SELECT_KEY = 'rdwall.selected.v1';
  const ORDER_KEY = 'rdwall.order.v1';
  const STALE_SEC = 12;          // frame older than this → force re-start capture
  const STALE_BANNER_LIVE_MS = 8000; // align admin_ui / 开云：画面卡死阈值
  const LIVE_POLL_GRACE_MS = 3000; // WS realtime healthy → skip HTTP pixel overwrite
  const FRAME_POLL_MS = 1500;    // historical wall pace (HTTP latest backup)
  const OFFLINE_KEEP_MS = 10 * 60 * 1000; // 掉线后仍保留瓦片，便于看掉线多久
  const START_COOLDOWN_MS = 45000; // 拉长冷却，避免 getDisplayMedia 超时后再硬拉风暴
  const TOKEN_REFRESH_EVERY_MS = 30 * 60 * 1000; // hard refresh all tokens every 30m
  const TOKEN_SOFT_REMAIN_SEC = 6 * 3600;        // proactive /api/refresh when < 6h left
  const state = {
    tokens: loadTokens(),
    clients: new Map(), // key -> client
    startedAt: new Map(), // key -> ms of last start/force attempt
    selected: loadSelected(), // Set of client keys actively streamed
    order: loadOrder(), // preferred tile key order
    wsDisabled: {}, // srcId -> true when /api/admin/ws-ticket missing (avoid 404 spam)
    overviewTimer: null,
    frameTimer: null,
    tokenTimer: null,
    staleTimer: null,
    focusKey: '',
    loginWarn: '',
    overviewGen: 0,
    overviewInFlight: false,
    framesInFlight: false,
    tokenInFlight: false,
    layoutRows: loadLayoutRows(), // 'auto' | 1..3
    mobileCols: loadMobileCols(), // 1 | 2
    leaving: false,
    dragging: false,
    suppressClickUntil: 0,
    layoutSig: '',
    lastTokenRefreshAt: 0,
  };

  function sourceAllowsWs(src) {
    if (!src) return false;
    if (src.preferWs === false) return false;
    if (state.wsDisabled[src.id]) return false;
    return true;
  }

  function markWsUnsupported(src, reason) {
    if (!src || state.wsDisabled[src.id]) return;
    state.wsDisabled[src.id] = true;
    try { console.info('[屏幕墙]', src.name, '不支持实时 WS，改用 HTTP 画面', reason || ''); } catch (_) {}
  }

  function isNarrow() {
    try { return window.matchMedia('(max-width: 768px)').matches; } catch (_) { return window.innerWidth <= 768; }
  }
  function dragDisabled() {
    // 手机/触屏窄屏：禁止拖拽，保证上下滑动浏览墙
    if (isNarrow()) return true;
    try {
      return window.matchMedia('(pointer: coarse)').matches && window.innerWidth <= 1024;
    } catch (_) { return false; }
  }

  function loadTokens() {
    try { return JSON.parse(sessionStorage.getItem(TOK_KEY) || '{}') || {}; }
    catch (_) { return {}; }
  }
  function saveTokens() {
    sessionStorage.setItem(TOK_KEY, JSON.stringify(state.tokens || {}));
  }
  function loadLayoutRows() {
    try {
      const v = localStorage.getItem(LAYOUT_KEY);
      if (v === 'auto' || v == null || v === '') return 'auto';
      const n = Number(v);
      if (Number.isFinite(n) && n >= 1 && n <= 3) return n;
    } catch (_) {}
    return 'auto';
  }
  function saveLayoutRows() {
    try { localStorage.setItem(LAYOUT_KEY, String(state.layoutRows)); } catch (_) {}
  }
  function loadMobileCols() {
    try {
      const n = Number(localStorage.getItem(MOBILE_COLS_KEY));
      if (n === 2) return 2;
    } catch (_) {}
    return 1;
  }
  function saveMobileCols() {
    try { localStorage.setItem(MOBILE_COLS_KEY, String(state.mobileCols)); } catch (_) {}
  }
  function loadSelected() {
    try {
      const arr = JSON.parse(localStorage.getItem(SELECT_KEY) || '[]');
      return new Set(Array.isArray(arr) ? arr.map(String) : []);
    } catch (_) { return new Set(); }
  }
  function saveSelected() {
    try { localStorage.setItem(SELECT_KEY, JSON.stringify([...state.selected])); } catch (_) {}
  }
  function isSelected(key) { return state.selected.has(key); }
  function setSelected(key, on) {
    if (on) state.selected.add(key);
    else state.selected.delete(key);
    saveSelected();
  }
  function loadOrder() {
    try {
      const arr = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]');
      return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
    } catch (_) { return []; }
  }
  function saveOrder() {
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(state.order || [])); } catch (_) {}
  }
  function syncOrderWithAlive(aliveKeys) {
    const alive = new Set(aliveKeys || []);
    const next = [];
    for (const k of state.order) {
      if (alive.has(k) && !next.includes(k)) next.push(k);
    }
    for (const k of aliveKeys || []) {
      if (!next.includes(k)) next.push(k);
    }
    const prev = state.order || [];
    let same = prev.length === next.length;
    if (same) {
      for (let i = 0; i < next.length; i += 1) {
        if (prev[i] !== next[i]) { same = false; break; }
      }
    }
    if (!same) {
      state.order = next;
      saveOrder();
    }
    return state.order;
  }
  function applyOrderDom() {
    if (state.dragging) return; // never fight an in-progress drag
    const wall = document.getElementById('wall');
    if (!wall) return;
    const tiles = [...wall.querySelectorAll('.tile')];
    if (!tiles.length) return;
    const alive = tiles.map(t => t.dataset.key).filter(Boolean);
    const ordered = syncOrderWithAlive(alive);
    if (wallMuuri) {
      const byKey = new Map();
      wallMuuri.getItems().forEach((it) => {
        const k = it.getElement() && it.getElement().dataset.key;
        if (k) byKey.set(k, it);
      });
      const sorted = ordered.map((k) => byKey.get(k)).filter(Boolean);
      const cur = wallMuuri.getItems();
      const orphans = cur.filter((it) => sorted.indexOf(it) < 0);
      if (orphans.length) {
        try { wallMuuri.remove(orphans, { removeElements: true }); } catch (_) {}
      }
      if (!sorted.length) return;
      const next = wallMuuri.getItems();
      let same = next.length === sorted.length;
      if (same) {
        for (let i = 0; i < sorted.length; i += 1) {
          if (next[i] !== sorted[i]) { same = false; break; }
        }
      }
      if (!same) wallMuuri.sort(sorted, { layout: 'instant' });
      return;
    }
    const current = tiles.map(t => t.dataset.key).filter(Boolean);
    if (current.length === ordered.length) {
      let same = true;
      for (let i = 0; i < ordered.length; i += 1) {
        if (current[i] !== ordered[i]) { same = false; break; }
      }
      if (same) return;
    }
    ordered.forEach((key) => {
      const el = wall.querySelector('[data-key="' + key.replace(/"/g, '') + '"]');
      if (el) wall.appendChild(el);
    });
  }
  function readDomOrder() {
    if (wallMuuri) {
      return wallMuuri.getItems().map((it) => it.getElement().dataset.key).filter(Boolean);
    }
    return [...document.querySelectorAll('#wall .tile')].map(t => t.dataset.key).filter(Boolean);
  }

  let wallMuuri = null;
  let wallMuuriWantDrag = null;
  function resetTileInlineLayout() {
    document.querySelectorAll('#wall .tile').forEach((t) => {
      t.style.width = '';
      t.style.height = '';
      t.style.minWidth = '';
      t.style.minHeight = '';
      t.style.marginRight = '';
      t.style.marginBottom = '';
      t.style.left = '';
      t.style.top = '';
      t.style.transform = '';
      t.style.position = '';
      t.style.display = '';
    });
  }
  function destroyWallMuuri() {
    state.dragging = false;
    wallMuuriWantDrag = null;
    state.layoutSig = '';
    if (!wallMuuri) return;
    const wall = document.getElementById('wall');
    try { wallMuuri.destroy(); } catch (_) {}
    wallMuuri = null;
    if (wall) wall.classList.remove('muuri-active');
    resetTileInlineLayout();
  }
  function removeTileEl(el) {
    if (!el) return;
    if (wallMuuri) {
      try {
        const items = wallMuuri.getItems(el);
        if (items && items.length) {
          wallMuuri.remove(items, { removeElements: true });
          return;
        }
      } catch (_) {}
    }
    try { el.remove(); } catch (_) {}
  }
  function ensureWallMuuri() {
    const wall = document.getElementById('wall');
    const Muuri = window.Muuri;
    if (!wall || !Muuri || isNarrow()) return null;
    const wantDrag = !dragDisabled();
    if (wallMuuri) {
      if (wallMuuriWantDrag !== wantDrag) {
        destroyWallMuuri();
      } else {
        return wallMuuri;
      }
    }
    wall.classList.add('muuri-active');
    wallMuuriWantDrag = wantDrag;
    state.layoutSig = '';
    wallMuuri = new Muuri(wall, {
      items: '.tile',
      showDuration: 0,
      hideDuration: 0,
      layoutDuration: 0,
      layoutEasing: 'ease',
      dragEnabled: wantDrag,
      dragContainer: document.body,
      dragSortHeuristics: {
        sortInterval: 40,
        minDragDistance: 12,
        minBounceBackAngle: 1,
      },
      // 延迟+距离：避免拖拽吞掉双击放大
      dragStartPredicate: function (item, event) {
        if (dragDisabled()) return false;
        const t = event.target;
        if (t && t.closest && t.closest('.pick, input, button, a')) return false;
        return Muuri.ItemDrag.defaultStartPredicate(item, event, {
          distance: 12,
          delay: 220,
        });
      },
      layoutOnResize: false,
      layoutOnInit: false,
    });
    wallMuuri.on('dragStart', function () {
      state.dragging = true;
    });
    wallMuuri.on('dragEnd', function () {
      state.dragging = false;
      state.suppressClickUntil = Date.now() + 350;
      state.order = readDomOrder();
      saveOrder();
      state.layoutSig = '';
      applyLayout();
    });
    return wallMuuri;
  }
  function bindTileClick(el, _key) {
    if (!el) return;
    el.title = '双击放大；拖拽可排序';
    // 实际双击在 #wall 委托处理：按点击坐标取最上层瓦片，避免 Muuri 叠层/闭包 key 错位
  }

  function tileKeyFromEvent(ev) {
    const wall = document.getElementById('wall');
    if (!wall || !ev) return '';
    if (ev.target && ev.target.closest && ev.target.closest('.pick')) return '';
    try {
      if (typeof document.elementsFromPoint === 'function' && ev.clientX != null) {
        const stack = document.elementsFromPoint(ev.clientX, ev.clientY) || [];
        for (let i = 0; i < stack.length; i += 1) {
          const node = stack[i];
          if (!node || !node.closest) continue;
          const tile = node.closest('#wall .tile');
          if (tile && wall.contains(tile) && tile.dataset.key) return String(tile.dataset.key);
        }
      }
    } catch (_) {}
    const t = ev.target && ev.target.closest && ev.target.closest('#wall .tile');
    return (t && t.dataset.key) ? String(t.dataset.key) : '';
  }

  function findTileEl(key) {
    const want = String(key || '');
    if (!want) return null;
    const wall = document.getElementById('wall');
    if (!wall) return null;
    const tiles = wall.querySelectorAll('.tile');
    for (let i = 0; i < tiles.length; i += 1) {
      if (String(tiles[i].dataset.key || '') === want) return tiles[i];
    }
    return null;
  }
  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  }
  function srcOf(id) { return SOURCES.find(s => s.id === id); }

  function tileCount() {
    return document.querySelectorAll('#wall .tile').length;
  }

  function bestAutoRows(n, wallW, wallH) {
    // 自动：全部塞进一屏。常见台数固定最优格，避免 3 台被排成 1×3 后 Muuri 换行裁切
    if (n <= 0) return { rows: 1, cols: 1 };
    if (n === 1) return { rows: 1, cols: 1 };
    if (n === 2) return { rows: 1, cols: 2 };       // 左右各一
    if (n === 3) return { rows: 2, cols: 2 };       // 左二右一（2×2 缺右下）
    if (n === 4) return { rows: 2, cols: 2 };       // 上二下二
    if (n === 5 || n === 6) return { rows: 2, cols: 3 };
    if (n === 7 || n === 8 || n === 9) return { rows: 3, cols: 3 };

    let best = null;
    const maxDim = Math.min(n, 6);
    const wallAr = wallW / Math.max(wallH, 1);
    for (let cols = 1; cols <= maxDim; cols++) {
      const rows = Math.ceil(n / cols);
      if (rows > maxDim) continue;
      const cellW = wallW / cols;
      const cellH = wallH / rows;
      if (cellW < 60 || cellH < 50) continue;
      const ar = cellW / Math.max(cellH, 1);
      const empty = rows * cols - n;
      // 接近 16:10，少留空，行列贴近墙面比例
      const score = -Math.abs(ar - 1.6) * 2 - empty * 0.35 - Math.abs((cols / rows) - wallAr) * 0.5;
      if (!best || score > best.score) best = { rows, cols, score };
    }
    if (!best) {
      const cols = Math.ceil(Math.sqrt(n));
      return { rows: Math.ceil(n / cols), cols };
    }
    return { rows: best.rows, cols: best.cols };
  }

  function syncLayoutButtons() {
    document.querySelectorAll('#layoutGroup .layout-btn').forEach((btn) => {
      const v = btn.getAttribute('data-rows');
      const active = (state.layoutRows === 'auto' && v === 'auto') || String(state.layoutRows) === v;
      btn.classList.toggle('active', active);
    });
  }

  function applyLayout() {
    if (state.dragging) return;
    const wall = document.getElementById('wall');
    const wrap = document.getElementById('wallWrap');
    if (!wall || !wrap) return;

    if (isNarrow()) {
      destroyWallMuuri();
      wrap.classList.remove('wall-scroll');
      wrap.style.overflow = '';
      wall.classList.remove('muuri-scroll');
      wall.style.gridTemplateColumns = '';
      wall.style.gridTemplateRows = '';
      wall.style.height = '';
      wall.style.minHeight = '';
      wall.style.width = '';
      wall.style.gap = '';
      wall.style.overflow = '';
      const cols = state.mobileCols === 2 ? 2 : 1;
      wall.classList.toggle('cols-2', cols === 2);
      document.querySelectorAll('#layoutGroupMobile .layout-btn').forEach((btn) => {
        const v = Number(btn.getAttribute('data-mcols'));
        btn.classList.toggle('active', v === cols);
      });
      return;
    }

    const scrollMode = state.layoutRows !== 'auto';
    wall.classList.remove('cols-2');
    wall.style.boxSizing = 'border-box';
    wall.style.width = '100%';
    wall.style.gap = '0';
    wall.style.gridTemplateColumns = '';
    wall.style.gridTemplateRows = '';
    wall.style.gridAutoRows = '';
    wall.style.gridAutoColumns = '';
    wall.style.display = '';

    if (scrollMode) {
      // 单/双/三排：格子按视口算，墙高度随台数变长，wrap 内下滑
      wrap.classList.add('wall-scroll');
      wall.classList.add('muuri-scroll');
      wall.style.height = 'auto';
      wall.style.minHeight = '100%';
      wall.style.overflow = 'visible';
    } else {
      wrap.classList.remove('wall-scroll');
      wall.classList.remove('muuri-scroll');
      wall.style.height = '100%';
      wall.style.minHeight = '';
      wall.style.overflow = 'hidden';
      try { wrap.scrollTop = 0; } catch (_) {}
    }

    const tiles = [...wall.querySelectorAll('.tile')];
    const count = tiles.length;
    syncLayoutButtons();
    ensureWallMuuri();

    // 视口尺寸以 wrap 为准（滚动时 wall 会变高，不能拿 wall 量）
    const viewW = Math.max(wrap.clientWidth, 120);
    const viewH = Math.max(wrap.clientHeight, 120);
    // 与 Muuri 容器同宽，避免差 1px 把最后一列挤换行 → 看起来「显示不全」
    wall.style.width = viewW + 'px';

    if (count <= 0) {
      if (wallMuuri) wallMuuri.refreshItems().layout('instant');
      return;
    }

    let pageRows; // 一屏可见行数
    let cols;
    let gap;
    let cellW;
    let cellH;

    if (scrollMode) {
      // 单排=1×1 / 双排=2×2 / 三排=3×3，一屏平分；多出来的往下排，下滑看
      pageRows = Math.max(1, Math.min(3, Number(state.layoutRows) || 1));
      cols = pageRows;
      gap = pageRows >= 3 ? 6 : 8;
    } else {
      const best = bestAutoRows(count, viewW, viewH);
      pageRows = best.rows;
      cols = best.cols;
      gap = (cols * pageRows >= 12) ? 6 : 8;
    }

    // Muuri：每格 width+marginRight；保证 cols*(cellW+gap) <= viewW，绝不不换行裁切
    cellW = Math.max(40, Math.floor((viewW - gap * cols) / cols));
    cellH = Math.max(40, Math.floor((viewH - gap * pageRows) / pageRows));
    while (cols > 0 && cols * (cellW + gap) > viewW && cellW > 40) cellW -= 1;
    if (!scrollMode) {
      // 自动必须整屏可见：总高度不得超过视口
      while (pageRows > 0 && pageRows * (cellH + gap) > viewH && cellH > 40) cellH -= 1;
    }

    const layoutSig = [scrollMode ? 1 : 0, count, pageRows, cols, cellW, cellH, viewW, viewH, String(state.layoutRows)].join('|');
    if (wallMuuri && state.layoutSig === layoutSig) {
      return; // 尺寸未变：跳过 Muuri relayout，避免定时刷新把画面黑闪一下
    }
    state.layoutSig = layoutSig;

    if (!wallMuuri) {
      wall.classList.remove('muuri-active');
      wall.style.display = 'grid';
      wall.style.gap = gap + 'px';
      wall.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
      if (scrollMode) {
        wall.style.gridAutoRows = cellH + 'px';
        wall.style.gridTemplateRows = '';
        wall.style.justifyContent = 'start';
        wall.style.alignContent = 'start';
      } else {
        wall.style.gridTemplateRows = 'repeat(' + pageRows + ', minmax(0, 1fr))';
        wall.style.height = '100%';
        wall.style.width = '100%';
      }
      tiles.forEach((t) => {
        t.style.width = '';
        t.style.height = '';
        t.style.marginRight = '';
        t.style.marginBottom = '';
      });
      return;
    }

    tiles.forEach((t) => {
      t.style.width = cellW + 'px';
      t.style.height = cellH + 'px';
      t.style.marginRight = gap + 'px';
      t.style.marginBottom = gap + 'px';
      t.style.minWidth = '0';
      t.style.minHeight = '0';
    });
    wallMuuri.refreshItems().layout('instant');
  }

  function formatAccountLabel(c) {
    const name = String((c && c.account) || '').trim() || '账号未上报';
    let ver = String((c && c.version) || '').trim();
    if (!ver) return name;
    if (!/^v/i.test(ver)) ver = 'v' + ver;
    return name + ' · ' + ver;
  }

  function tokenRemainSec(tok) {
    const exp = parseInt(String(tok || '').split('.')[0], 10);
    if (!Number.isFinite(exp) || exp <= 0) return 0;
    return exp - Math.floor(Date.now() / 1000);
  }

  function applyTokenRenew(srcId, res, data) {
    let next = '';
    try { next = (res && res.headers && res.headers.get('X-Admin-Token-Renew')) || ''; } catch (_) { next = ''; }
    if (!next && data && data.token) next = String(data.token || '');
    if (!next || !srcId) return;
    if (state.tokens[srcId] === next) return;
    state.tokens[srcId] = next;
    saveTokens();
  }

  async function api(src, path, opts) {
    opts = opts || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    const tok = state.tokens[src.id];
    if (tok) headers['X-Admin-Token'] = tok;
    const res = await fetch(src.prefix + path, Object.assign({}, opts, { headers }));
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    // Sliding renew (server mints when past half-life). Must apply or wall dies at 24h.
    if (res.ok) applyTokenRenew(src.id, res, data);
    if (res.status === 401) {
      delete state.tokens[src.id];
      saveTokens();
      throw new Error('auth');
    }
    if (!res.ok || (data && data.ok === false)) {
      throw new Error((data && data.message) || ('HTTP ' + res.status));
    }
    return data;
  }

  /** Keep admin sessions alive across multi-day wall hangs (backends default TTL=24h). */
  async function refreshTokens(opts) {
    opts = opts || {};
    if (state.leaving || state.tokenInFlight) return;
    const force = !!opts.force;
    const authed = SOURCES.filter(s => state.tokens[s.id]);
    if (!authed.length) return;
    const due = force || (Date.now() - (state.lastTokenRefreshAt || 0) >= TOKEN_REFRESH_EVERY_MS);
    const soft = authed.some(s => tokenRemainSec(state.tokens[s.id]) > 0
      && tokenRemainSec(state.tokens[s.id]) < TOKEN_SOFT_REMAIN_SEC);
    if (!due && !soft) return;
    state.tokenInFlight = true;
    try {
      await Promise.all(authed.map(async (src) => {
        const remain = tokenRemainSec(state.tokens[src.id]);
        if (!force && !due && remain >= TOKEN_SOFT_REMAIN_SEC) return;
        try {
          const data = await api(src, '/api/refresh', { method: 'POST', body: '{}' });
          if (data && data.token) {
            state.tokens[src.id] = data.token;
            saveTokens();
          }
        } catch (e) {
          // auth already cleared inside api(); other errors retry next tick
          if (String(e.message) !== 'auth') { /* keep old token */ }
        }
      }));
      state.lastTokenRefreshAt = Date.now();
    } finally {
      state.tokenInFlight = false;
    }
  }

  async function loginAll(password) {
    const results = await Promise.all(SOURCES.map(async (src) => {
      try {
        const data = await fetch(src.prefix + '/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        }).then(r => r.json());
        if (data && data.ok && data.token) return { id: src.id, token: data.token, ok: true };
        return { id: src.id, ok: false, message: (data && data.message) || '失败' };
      } catch (e) {
        return { id: src.id, ok: false, message: String(e.message || e) };
      }
    }));
    const ok = results.filter(r => r.ok);
    if (!ok.length) {
      const msg = results.map(r => (srcOf(r.id) || {}).name + ': ' + (r.message || '失败')).join('；');
      throw new Error(msg || '登录失败');
    }
    state.tokens = {};
    ok.forEach(r => { state.tokens[r.id] = r.token; });
    saveTokens();
    const bad = results.filter(r => !r.ok);
    state.loginWarn = bad.length
      ? ('部分登录失败：' + bad.map(r => (srcOf(r.id) || {}).name).join('、') + '（这些源的在线台不会显示）')
      : '';
    return results;
  }

  function clientKey(srcId, clientId) { return srcId + '::' + clientId; }

  function ensureTile(key, c) {
    const el0 = findTileEl(key);
    if (el0) return el0;
    let el;
    el = document.createElement('div');
    el.className = 'tile';
    el.dataset.key = key;
    el.innerHTML =
      '<div class="screen">' +
        '<div class="stale-banner"></div>' +
        '<div class="ph">未勾选 · 不推流</div>' +
        '<video playsinline muted autoplay></video>' +
        '<canvas class="hidden"></canvas>' +
        '<span class="badge">' + esc(c.sourceName) + '</span>' +
        '<input class="pick" type="checkbox" title="勾选后显示并推流"/>' +
        '<span class="live stale">等待</span>' +
      '</div>' +
      '<div class="meta">' +
        '<div class="name"></div>' +
        '<div class="sub"></div>' +
      '</div>';
    const pick = el.querySelector('.pick');
    pick.checked = isSelected(key);
    pick.addEventListener('click', (ev) => ev.stopPropagation());
    pick.addEventListener('change', () => {
      const on = !!pick.checked;
      setSelected(key, on);
      const client = state.clients.get(key);
      if (!client) { patchTile({ key, sourceName: c.sourceName, online: true }); return; }
      if (on) {
        ensureViewer(client);
      } else {
        disconnectViewer(client);
        client.image = '';
        client.hasCanvasFrame = false;
        state.startedAt.delete(key);
      }
      patchTile(client);
      updateSelectedCount();
    });
    bindTileClick(el, key);
    if (wallMuuri && !isNarrow()) {
      wallMuuri.add([el]);
    } else {
      document.getElementById('wall').appendChild(el);
    }
    if (!state.order.includes(key)) {
      state.order.push(key);
      saveOrder();
    }
    if (!state.dragging) {
      applyOrderDom();
      applyLayout();
    }
    return el;
  }

  function updateSelectedCount() {
    const n = [...state.clients.keys()].filter((k) => isSelected(k)).length;
    const el = document.getElementById('selectedCount');
    if (el) el.textContent = String(n);
  }

  function formatDurationSec(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    if (sec < 60) return sec + 's';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m < 60) return s ? (m + '分' + s + '秒') : (m + '分钟');
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm ? (h + '小时' + rm + '分') : (h + '小时');
  }

  function markLinkDown(c, reason) {
    if (!c) return;
    if (!c.linkDownAt) c.linkDownAt = Date.now();
    c.linkDownReason = String(reason || 'disconnected');
    try { patchTile(c); } catch (_) {}
    try { syncOverlayStale(c); } catch (_) {}
  }

  function clearLinkDown(c) {
    if (!c) return;
    c.linkDownAt = 0;
    c.linkDownReason = '';
  }

  function isLivekitVideoFresh(c) {
    if (!c) return false;
    if (c.online === false || c.linkDownAt) return false;
    const v = c.viewer;
    // 仅「首次建链且还没有任何画面」宽限；禁止用重连刷新 watchStartedAt 永久压红条
    if (v && v.webrtcTrying && !c.hasVideoFrame && !c.hasCanvasFrame && !c.image) {
      const started = Number(v.watchStartedAt || 0);
      if (started && (Date.now() - started) < 20000) return true;
    }
    // 只认解码时间戳：轨 readyState=live 在编码器停更后仍为 true，不能当心跳
    if (c.hasVideoFrame && c.frameAt) {
      return (Date.now() - c.frameAt) < STALE_BANNER_LIVE_MS;
    }
    return false;
  }

  function bumpLivekitHeartbeat(c) {
    // 仅用于压住红条；禁止用「轨还在」刷新 frameAt，否则真卡死永远不恢复
    return isLivekitVideoFresh(c);
  }

  /** Align with admin_ui / 开云远程桌面 deskStaleBanner 文案。 */
  function resolveStaleInfo(c) {
    const now = Date.now();
    const online = c && c.online !== false;
    // 离线优先：绝不能被 webrtcTrying / 建链宽限压掉
    if (!online) {
      const offlineTxt = c && c.offlineSince
        ? formatDurationSec(Math.max(1, Math.round((now - c.offlineSince) / 1000)))
        : '';
      const shotAgeSec = c && c.ageSec != null && Number.isFinite(Number(c.ageSec))
        ? Number(c.ageSec)
        : (c && c.frameAt ? Math.round((now - c.frameAt) / 1000) : NaN);
      const ageTxt = Number.isFinite(shotAgeSec) && shotAgeSec > 0
        ? ('，缓存约 ' + Math.round(shotAgeSec) + 's 前')
        : '';
      return {
        stale: true,
        offline: true,
        text: '客户端已离线' + ageTxt + ' — 请重启对方软件后重开查看',
        liveText: offlineTxt ? ('掉线 ' + offlineTxt) : '已掉线',
      };
    }
    // 推流断链（LiveKit/WS）：保留最后一帧，但必须红条提示
    if (c && c.linkDownAt) {
      const sec = Math.max(1, Math.round((now - c.linkDownAt) / 1000));
      const why = c.linkDownReason === 'agent_left' ? '对方已离开推流'
        : (c.linkDownReason === 'ws_closed' ? '控制通道已断开' : '推流已断线');
      return {
        stale: true,
        offline: false,
        text: why + '约 ' + sec + 's — 正在重连…',
        liveText: '断链 ' + sec + 's',
      };
    }
    // LiveKit 在播/首次建链时才压红条
    if (bumpLivekitHeartbeat(c)) {
      return { stale: false, offline: false, text: '', liveText: '' };
    }
    const hasFrame = !!(c && (c.hasCanvasFrame || c.image || c.hasVideoFrame));
    const liveAgeMs = c && c.frameAt ? (now - c.frameAt) : (hasFrame ? 999999 : 0);
    const shotAgeSec = c && c.ageSec != null && Number.isFinite(Number(c.ageSec))
      ? Number(c.ageSec)
      : (c && c.frameAt ? Math.round((now - c.frameAt) / 1000) : NaN);
    if (!hasFrame) {
      return { stale: false, offline: false, text: '', liveText: '' };
    }
    if (liveAgeMs > STALE_BANNER_LIVE_MS || (Number.isFinite(shotAgeSec) && shotAgeSec > STALE_SEC)) {
      const sec = Number.isFinite(shotAgeSec) && shotAgeSec > 0
        ? Math.round(shotAgeSec)
        : Math.max(1, Math.round(liveAgeMs / 1000));
      return {
        stale: true,
        offline: false,
        text: '画面卡死约 ' + sec + 's — 正在尝试重拉推流…',
        liveText: '卡死 ' + sec + 's',
      };
    }
    return { stale: false, offline: false, text: '', liveText: '' };
  }

  function syncOverlayStale(c) {
    const stage = document.querySelector('#overlay .stage');
    const banner = document.getElementById('ovStaleBanner');
    if (!stage || !banner) return;
    if (!c || state.focusKey !== c.key) {
      stage.classList.remove('is-stale');
      return;
    }
    const info = resolveStaleInfo(c);
    if (info.stale) {
      stage.classList.add('is-stale');
      banner.textContent = info.text;
    } else {
      stage.classList.remove('is-stale');
    }
  }

  function pathModeLabel(mode) {
    if (mode === 'direct') return '端到端';
    if (mode === 'turn' || mode === 'livekit') return '云中转';
    if (mode === 'jpeg' || mode === 'relay') return 'JPG全图';
    return '';
  }

  function pathModeClass(mode) {
    if (mode === 'direct') return 'direct';
    if (mode === 'turn' || mode === 'livekit') return 'turn';
    if (mode === 'jpeg' || mode === 'relay') return 'jpeg';
    return '';
  }

  function normalizePathMode(mode) {
    if (mode === 'direct' || mode === 'turn' || mode === 'jpeg' || mode === 'livekit') return mode;
    // 兼容旧值：relay = JPG全图（非 TURN）
    if (mode === 'relay') return 'jpeg';
    return '';
  }

  function setPathMode(c, mode) {
    if (!c) return;
    const next = normalizePathMode(mode);
    if (c.pathMode === next) {
      patchTilePathBadge(c);
      return;
    }
    c.pathMode = next;
    patchTile(c);
  }

  function patchTilePathBadge(_c) {
    // 右上角徽章已移除，链路只显示在右下角 .live
  }

  async function detectWebRtcPathMode(pc) {
    if (!pc) return '';
    try {
      const stats = await pc.getStats();
      let pair = null;
      const cand = new Map();
      stats.forEach((r) => {
        if (r.type === 'local-candidate' || r.type === 'remote-candidate') cand.set(r.id, r);
        if (r.type === 'candidate-pair' && (r.state === 'succeeded' || r.nominated) && r.selected) pair = r;
      });
      if (!pair) {
        stats.forEach((r) => {
          if (!pair && r.type === 'candidate-pair' && r.state === 'succeeded') pair = r;
        });
      }
      if (!pair) return '';
      const local = cand.get(pair.localCandidateId);
      const remote = cand.get(pair.remoteCandidateId);
      const types = [local && local.candidateType, remote && remote.candidateType].filter(Boolean);
      if (types.includes('relay')) return 'turn';
      if (types.length) return 'direct';
    } catch (_) {}
    return '';
  }

  function patchTile(c) {
    const key = c.key;
    const el = ensureTile(key, c);
    const on = isSelected(key);
    const offline = c && c.online === false;
    el.classList.toggle('off', !on && !offline);
    const pick = el.querySelector('.pick');
    if (pick && pick.checked !== on) pick.checked = on;
    const nameEl = el.querySelector('.name');
    if (nameEl) nameEl.textContent = formatAccountLabel(c);
    el.querySelector('.sub').textContent = c.clientId + (c.ip ? ' · ' + c.ip : '');
    const canvas = el.querySelector('canvas');
    const video = el.querySelector('video');
    const ph = el.querySelector('.ph');
    const live = el.querySelector('.live');
    const banner = el.querySelector('.stale-banner');
    const info = resolveStaleInfo(c);
    const src = srcOf(c.sourceId);
    // 旧源无 WebRTC：勾选后固定标「JPG全图」
    if (on && src && src.preferWebRtc === false && !c.pathMode) c.pathMode = 'jpeg';

    // 未勾选且仍在线：保持占位，不显示掉线红条
    if (!on && !offline) {
      el.classList.remove('is-stale');
      if (banner) banner.textContent = '';
      if (video) {
        video.classList.remove('on');
        try { video.srcObject = null; } catch (_) {}
      }
      if (canvas) {
        canvas.classList.add('hidden');
        try {
          const ctx = canvas.getContext('2d');
          if (ctx) ctx.clearRect(0, 0, canvas.width || 0, canvas.height || 0);
        } catch (_) {}
        canvas.width = 0;
        canvas.height = 0;
      }
      ph.classList.remove('hidden');
      ph.textContent = '未勾选 · 不推流';
      live.textContent = '等待';
      live.classList.add('stale');
      patchTilePathBadge(c);
      return;
    }

    if (info.stale) {
      el.classList.add('is-stale');
      if (banner) banner.textContent = info.text;
    } else {
      el.classList.remove('is-stale');
      if (banner) banner.textContent = '';
    }

    // LiveKit：有轨/srcObject 就保 video.on，勿因 hasVideoFrame 瞬时 false 摘掉（黑闪主因）
    let lkVideoReady = false;
    if (video && video.srcObject) {
      try {
        lkVideoReady = video.srcObject.getVideoTracks().some((tr) => tr.readyState === 'live');
      } catch (_) { lkVideoReady = !!video.srcObject; }
    }
    const keepLkVideo = !!(on && video && (c.hasVideoFrame || (c.viewer && c.viewer.lkTrack) || lkVideoReady) && (video.srcObject || lkVideoReady));
    const hasVideo = !!(keepLkVideo || (c.hasVideoFrame && video && video.srcObject));
    if (hasVideo) {
      video.classList.add('on');
      if (canvas) canvas.classList.add('hidden');
      ph.classList.add('hidden');
      if (info.stale) {
        live.textContent = info.liveText;
        live.classList.add('stale');
      } else {
        live.textContent = pathModeLabel(c.pathMode) || '实时';
        live.classList.remove('stale');
      }
    } else if (c.hasCanvasFrame || c.image) {
      if (video) video.classList.remove('on');
      if (canvas) canvas.classList.remove('hidden');
      ph.classList.add('hidden');
        if (info.stale) {
          live.textContent = info.liveText;
          live.classList.add('stale');
        } else {
          // WebRTC 协商中不要盖成 JPG；preferWebRtc 默认按云中转展示，避免 JPG 帧把标签钉死
          const trying = !!(c.viewer && c.viewer.webrtcTrying);
          const src = srcOf(c.sourceId);
          if (c.pathMode === 'direct' || c.pathMode === 'turn' || c.pathMode === 'livekit') {
            live.textContent = pathModeLabel(c.pathMode);
          } else if (trying || (src && src.preferWebRtc && c.pathMode !== 'jpeg')) {
            live.textContent = trying ? '建链中…' : '云中转';
            if (src && src.preferWebRtc && !c.pathMode) c.pathMode = 'livekit';
          } else {
            c.pathMode = 'jpeg';
            live.textContent = 'JPG全图';
          }
          live.classList.remove('stale');
        }
    } else {
      if (video) video.classList.remove('on');
      if (canvas) canvas.classList.add('hidden');
      ph.classList.remove('hidden');
      if (offline) {
        ph.textContent = '已掉线 · 无缓存画面';
        live.textContent = info.liveText || '已掉线';
      } else {
        ph.textContent = '等待画面…';
        live.textContent = '启动中';
      }
      live.classList.add('stale');
    }
    patchTilePathBadge(c);
    syncOverlayStale(c);
  }

  function pruneTiles(alive) {
    if (state.dragging) return;
    document.querySelectorAll('#wall .tile').forEach(el => {
      if (!alive.has(el.dataset.key)) removeTileEl(el);
    });
    syncOrderWithAlive([...alive]);
    applyOrderDom();
    applyLayout();
  }

  function needsCapture(c) {
    if (!c || !c.online) return false;
    if (!isSelected(c.key)) return false;
    if (!c.hasCanvasFrame) return true;
    const ageMs = Date.now() - (c.frameAt || 0);
    return ageMs > STALE_SEC * 1000;
  }

  function tileCanvas(c) {
    const el = findTileEl(c && c.key);
    return el ? el.querySelector('canvas') : null;
  }

  function normImageSrc(image) {
    let src = String(image || '').trim();
    if (!src) return '';
    if (!/^data:image\//i.test(src) && /^[A-Za-z0-9+/=]+$/.test(src.slice(0, 80))) {
      src = 'data:image/jpeg;base64,' + src;
    }
    if (!/^data:image\//i.test(src) && !/^https?:\/\//i.test(src)) return '';
    return src;
  }

  function tileVideoEl(c) {
    if (!c) return null;
    const el = findTileEl(c.key);
    return el ? el.querySelector('video') : null;
  }

  function videoHasTrack(video, track) {
    if (!video || !video.srcObject || !track) return false;
    try {
      const mst = track.mediaStreamTrack || track;
      return video.srcObject.getVideoTracks().some((tr) => tr === mst || tr.id === mst.id);
    } catch (_) {
      return false;
    }
  }

  function preferOverlayVideo(c) {
    if (!c) return false;
    if (c.pathMode === 'livekit' || c.pathMode === 'direct' || c.pathMode === 'turn') return true;
    const v = c.viewer;
    return !!(v && (v.lkTrack || v.lkRoom || v.webrtcTrying || v.desktopSessionId));
  }

  function syncOverlayFromClient(c) {
    if (!c || state.focusKey !== c.key) return;
    const ov = document.getElementById('ovCanvas');
    const ovVideo = document.getElementById('ovVideo');
    const ovImg = document.getElementById('ovImg');
    const tileVideo = tileVideoEl(c);
    const stream = tileVideo && tileVideo.srcObject;
    const lkTrack = c.viewer && c.viewer.lkTrack;
    const wantVideo = preferOverlayVideo(c) || !!(c.hasVideoFrame && (stream || lkTrack));
    const forKey = ovVideo ? String(ovVideo.dataset.forKey || '') : '';

    // 放大层若还挂着别的瓦片流，先丢掉（否则标题是 A、画面是 B）
    if (ovVideo && forKey && forKey !== String(c.key) && (ovVideo.srcObject || ovVideo.classList.contains('on'))) {
      try {
        if (lkTrack && forKey) {
          /* 旧轨可能已换；仅清 DOM */
        }
        ovVideo.srcObject = null;
      } catch (_) {}
      ovVideo.classList.remove('on');
      ovVideo.dataset.forKey = '';
      c._overlayLockedVideo = false;
    }

    // LiveKit：必须 track.attach 到放大层（只拷贝瓦片 srcObject 在部分浏览器会黑屏）
    if (ovVideo && wantVideo && lkTrack) {
      c._overlayLockedVideo = true;
      try {
        if (!videoHasTrack(ovVideo, lkTrack)) {
          lkTrack.attach(ovVideo);
        }
      } catch (_) {
        try {
          const mst = lkTrack.mediaStreamTrack || lkTrack;
          if (mst) ovVideo.srcObject = new MediaStream([mst]);
        } catch (_2) {
          if (stream && ovVideo.srcObject !== stream) ovVideo.srcObject = stream;
        }
      }
      ovVideo.dataset.forKey = String(c.key);
      ovVideo.classList.add('on');
      if (ov) ov.classList.add('hidden');
      if (ovImg) ovImg.classList.add('hidden');
      if (ovVideo.paused) ovVideo.play().catch(() => {});
      return;
    }

    // 非 LiveKit / 兜底：共享瓦片 MediaStream
    if (ovVideo && stream && wantVideo) {
      c._overlayLockedVideo = true;
      if (ovVideo.srcObject !== stream) ovVideo.srcObject = stream;
      ovVideo.dataset.forKey = String(c.key);
      ovVideo.classList.add('on');
      if (ov) ov.classList.add('hidden');
      if (ovImg) ovImg.classList.add('hidden');
      if (ovVideo.paused) ovVideo.play().catch(() => {});
      return;
    }
    if (ovVideo && c._overlayLockedVideo && ovVideo.srcObject && forKey === String(c.key)) {
      ovVideo.classList.add('on');
      if (ov) ov.classList.add('hidden');
      if (ovImg) ovImg.classList.add('hidden');
      if (ovVideo.paused) ovVideo.play().catch(() => {});
      return;
    }
    // 等轨期间：若有 JPG/画布像素先顶上，避免放大层纯黑
    if (wantVideo && !stream && !lkTrack && !c.hasCanvasFrame) {
      return;
    }
    if (ovVideo && ovVideo.srcObject && !stream && !lkTrack) {
      try { ovVideo.srcObject = null; } catch (_) {}
      ovVideo.classList.remove('on');
    }
    const srcCanvas = tileCanvas(c);
    if (!srcCanvas || !ov || !srcCanvas.width || !srcCanvas.height) return;
    if (ov.width !== srcCanvas.width || ov.height !== srcCanvas.height) {
      ov.width = srcCanvas.width;
      ov.height = srcCanvas.height;
    }
    try {
      ov.getContext('2d').drawImage(srcCanvas, 0, 0);
    } catch (_) {}
    ov.classList.remove('hidden');
    if (ovVideo) ovVideo.classList.remove('on');
  }

  function applyTileFrame(c, image, t, opts) {
    opts = opts || {};
    const canvas = tileCanvas(c);
    if (!canvas || !c) return false;
    const src = normImageSrc(image);
    if (!src) return false;
    const cached = !!opts.cached;
    const v = c.viewer || (c.viewer = makeViewerState());
    const gen = cached ? v.gen : (++v.gen);
    const img = new Image();
    img.onload = () => {
      if (!cached && (!c.viewer || c.viewer.gen !== gen)) return;
      try {
        canvas.width = img.width;
        canvas.height = img.height;
        canvas.getContext('2d').drawImage(img, 0, 0);
      } catch (_) { return; }
      c.hasCanvasFrame = true;
      c.image = src;
      c.t = String(t || '');
      c.ts = c.t;
      c.frameAt = Date.now();
      c.ageSec = 0;
      c.frameVia = cached ? 'cache' : 'ws';
      if (!cached) clearLinkDown(c);
      if (!cached && opts.seq != null) {
        const seq = Number(opts.seq) || 0;
        const keySeq = Number(opts.keySeq != null ? opts.keySeq : opts.seq) || seq;
        if (seq > 0) {
          v.lastSeq = seq;
          v.keySeq = keySeq || seq;
          v.w = img.width;
          v.h = img.height;
          v.needKeyframe = false;
          v.deltaInFlight = false;
        }
      } else if (cached) {
        v.needKeyframe = true;
        v.lastSeq = 0;
        v.keySeq = 0;
        v.deltaInFlight = false;
      } else {
        v.needKeyframe = false;
        v.deltaInFlight = false;
        v.w = img.width;
        v.h = img.height;
      }
      patchTile(c);
      // LiveKit 锁定全屏时，JPG/缓存帧不要刷放大层（否则闪缩略图）
      if (!(c._overlayLockedVideo || preferOverlayVideo(c))) {
        syncOverlayFromClient(c);
      }
    };
    img.onerror = () => {
      if (c.viewer) c.viewer.needKeyframe = true;
    };
    img.src = src;
    return true;
  }

  function applyTileDelta(c, msg) {
    const canvas = tileCanvas(c);
    const v = c && c.viewer;
    if (!canvas || !c || !v || !msg) return false;
    if (v.needKeyframe || !canvas.width || !canvas.height) {
      v.needKeyframe = true;
      return false;
    }
    if (v.deltaInFlight) {
      if (!v.deltaQueue) v.deltaQueue = [];
      v.deltaQueue.push(msg);
      if (v.deltaQueue.length > 48) {
        v.deltaQueue.length = 0;
        v.needKeyframe = true;
        v.gen += 1;
        return false;
      }
      return true;
    }
    const w = Number(msg.w) || 0;
    const h = Number(msg.h) || 0;
    const seq = Number(msg.seq) || 0;
    const keySeq = Number(msg.keySeq) || 0;
    const tiles = Array.isArray(msg.tiles) ? msg.tiles : [];
    if (w < 16 || h < 16 || seq < 1 || keySeq < 1 || !tiles.length) {
      v.needKeyframe = true;
      if (v.deltaQueue) v.deltaQueue.length = 0;
      return false;
    }
    if (v.w && v.h && (w !== v.w || h !== v.h)) {
      v.needKeyframe = true;
      if (v.deltaQueue) v.deltaQueue.length = 0;
      return false;
    }
    if (v.keySeq && keySeq !== v.keySeq) {
      v.needKeyframe = true;
      if (v.deltaQueue) v.deltaQueue.length = 0;
      return false;
    }
    if (v.lastSeq && seq !== v.lastSeq + 1) {
      v.needKeyframe = true;
      if (v.deltaQueue) v.deltaQueue.length = 0;
      return false;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      v.needKeyframe = true;
      if (v.deltaQueue) v.deltaQueue.length = 0;
      return false;
    }
    const gen = v.gen;
    v.deltaInFlight = true;
    v.lastSeq = seq;
    let pending = tiles.length;
    let failed = false;
    const finish = () => {
      if (!c.viewer || c.viewer.gen !== gen) return;
      v.deltaInFlight = false;
      if (failed) {
        v.needKeyframe = true;
        if (v.deltaQueue) v.deltaQueue.length = 0;
        return;
      }
      v.keySeq = keySeq;
      v.w = w;
      v.h = h;
      v.needKeyframe = false;
      c.hasCanvasFrame = true;
      c.frameAt = Date.now();
      c.ageSec = 0;
      c.t = String(msg.t || '');
      c.ts = c.t;
      c.frameVia = 'delta';
      clearLinkDown(c);
      patchTile(c);
      if (!(c._overlayLockedVideo || preferOverlayVideo(c))) {
        syncOverlayFromClient(c);
      }
      const next = v.deltaQueue && v.deltaQueue.shift();
      if (next && !v.needKeyframe) applyTileDelta(c, next);
    };
    tiles.forEach((tile) => {
      const x = Number(tile.x) || 0;
      const y = Number(tile.y) || 0;
      const tw = Number(tile.w) || 0;
      const th = Number(tile.h) || 0;
      const src = normImageSrc(tile.image);
      if (!src || tw < 1 || th < 1) {
        failed = true;
        pending -= 1;
        if (pending <= 0) finish();
        return;
      }
      const img = new Image();
      img.onload = () => {
        if (!c.viewer || c.viewer.gen !== gen) return;
        try { ctx.drawImage(img, x, y); } catch (_) { failed = true; }
        pending -= 1;
        if (pending <= 0) finish();
      };
      img.onerror = () => {
        if (!c.viewer || c.viewer.gen !== gen) return;
        failed = true;
        pending -= 1;
        if (pending <= 0) finish();
      };
      img.src = src;
    });
    return true;
  }

  function makeViewerState() {
    return {
      ws: null,
      needKeyframe: true,
      lastSeq: 0,
      keySeq: 0,
      w: 0,
      h: 0,
      deltaInFlight: false,
      deltaQueue: [],
      gen: 0,
      reconnectTimer: null,
      connecting: false,
      desktopSessionId: '',
      webrtcTimer: null,
      disconnectTimer: null,
      webrtcTrying: false,
      webrtcRetries: 0,
      lkRoom: null,
      lkAgentReady: false,
    };
  }

  function clearWebRtcViewer(c) {
    if (!c || !c.viewer) return;
    const v = c.viewer;
    if (v.webrtcTimer) {
      clearTimeout(v.webrtcTimer);
      v.webrtcTimer = null;
    }
    if (v.disconnectTimer) {
      clearTimeout(v.disconnectTimer);
      v.disconnectTimer = null;
    }
    v.webrtcTrying = false;
    v.webrtcRetries = 0;
    v.lkAgentReady = false;
    const sid = String(v.desktopSessionId || '');
    const lk = v.lkRoom;
    v.lkRoom = null;
    v.desktopSessionId = '';
    if (lk) {
      try { lk.disconnect(); } catch (_) {}
    }
    c.hasVideoFrame = false;
    if (v) v.lkTrack = null;
    const el = findTileEl(c.key);
    const video = el && el.querySelector('video');
    if (video) {
      // 只摘 srcObject，绝不 stop LiveKit 远端轨（stop 会让 SFU 侧停订/黑闪）
      try { video.srcObject = null; } catch (_) {}
      video.classList.remove('on');
    }
    // 释放服务器会话，避免 _sessions 只增不减
    if (sid) {
      const src = srcOf(c.sourceId);
      const tok = src && state.tokens[src.id];
      if (src && tok) {
        try {
          fetch(src.prefix + '/api/desktop/webrtc/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Admin-Token': tok },
            body: JSON.stringify({ desktopSessionId: sid, clientId: c.clientId }),
            keepalive: true,
          }).catch(function () {});
        } catch (_) {}
      }
    }
  }

  function handleViewerWebRtcSignal(c, msg) {
    // 自研 P2P 已移除；LiveKit 占位 offer 仅用于路径标签
    const v = c && c.viewer;
    if (!v || !msg) return;
    const typ = String(msg.type || '');
    if (typ === 'webrtc_offer' && (String(msg.sdp || '') === 'livekit' || msg.transport === 'livekit')) {
      setPathMode(c, 'livekit');
      v.lkAgentReady = true;
    }
  }

  function forceLivekitHighQuality(pubOrTrack) {
    try {
      const LK = window.LivekitClient || window.livekit || null;
      const HQ = LK && LK.VideoQuality && LK.VideoQuality.HIGH;
      if (!HQ) return;
      if (pubOrTrack && typeof pubOrTrack.setVideoQuality === 'function') {
        pubOrTrack.setVideoQuality(HQ);
      }
    } catch (_) {}
  }

  function attachLivekitTrack(c, track) {
    if (!c || !track || !isSelected(c.key)) return;
    const el = ensureTile(c.key, c);
    const video = el.querySelector('video');
    if (!video) return;
    if (c.viewer) c.viewer.lkTrack = track;
    forceLivekitHighQuality(track);
    const bumpDecode = () => {
      c.hasVideoFrame = true;
      c.frameAt = Date.now();
      c.ageSec = 0;
      clearLinkDown(c);
    };
    const markLive = (opts) => {
      bumpDecode();
      setPathMode(c, 'livekit');
      // 每帧 patchTile 会抢 DOM / 放大层，易黑闪；仅首次或显式要求时刷
      if (!opts || opts.patch !== false) {
        patchTile(c);
        syncOverlayFromClient(c);
      }
    };
    // 同一轨已在播：勿 stop/reattach（会导致挂一会黑闪一下）
    if (videoHasTrack(video, track)) {
      markLive();
      if (video.paused) video.play().catch(() => {});
      return;
    }
    // 直接 attach，禁止先 srcObject=null（中间态 display:none → 黑闪）
    try {
      track.attach(video);
    } catch (_) {
      try {
        video.srcObject = new MediaStream([track.mediaStreamTrack || track]);
      } catch (_2) {}
    }
    video.classList.add('on');
    video.onloadeddata = () => markLive();
    video.onresize = () => markLive({ patch: false });
    video.play().then(() => markLive()).catch(() => {});
    // 真实解码心跳：只刷新 frameAt，勿每帧 patchTile
    try {
      if (typeof video.requestVideoFrameCallback === 'function' && video._lkVfTrack !== track) {
        video._lkVfTrack = track;
        const onVf = () => {
          if (!c.viewer || c.viewer.lkTrack !== track) {
            video._lkVfTrack = null;
            return;
          }
          bumpDecode();
          try { video.requestVideoFrameCallback(onVf); } catch (_) { video._lkVfTrack = null; }
        };
        video.requestVideoFrameCallback(onVf);
      }
    } catch (_) {}
    markLive();
  }

  function isLkRoomConnected(c) {
    const v = c && c.viewer;
    const lk = v && v.lkRoom;
    if (!lk) return false;
    const LK = window.LivekitClient || window.livekit || null;
    return String(lk.state || '') === 'connected'
      || !!(LK && LK.ConnectionState && lk.state === LK.ConnectionState.Connected);
  }

  /** 房间还连着但解码停更：观众侧重进；代理 forceRestart 最多 90s 一次，避免拆房风暴。 */
  function recoverStalledLivekit(c) {
    if (!c || !isSelected(c.key) || state.leaving) return false;
    const src = srcOf(c.sourceId);
    if (!src || !src.preferWebRtc) return false;
    const ageMs = c.frameAt ? (Date.now() - c.frameAt) : 999999;
    if (ageMs < 25000) return false;
    const v = c.viewer || (c.viewer = makeViewerState());
    const last = Number(v.lastKickAt || 0);
    if (last && (Date.now() - last) < 60000) return false;
    v.lastKickAt = Date.now();
    v.webrtcTrying = false;
    // 仅当长时间无帧才硬拉代理；否则只重进观众房
    const lastForce = Number(v.lastForceKickAt || 0);
    const allowForce = !lastForce || (Date.now() - lastForce) > 90000;
    if (allowForce) {
      v.lkAgentReady = false;
      v.lastForceKickAt = Date.now();
      v.desktopSessionId = '';
    }
    const room = v.lkRoom;
    v.lkRoom = null;
    v.lkTrack = null;
    // 保留 video 最后一帧；只标未在出新帧，便于恢复路径进入；立刻红条
    c.hasVideoFrame = false;
    markLinkDown(c, 'disconnected');
    if (room) {
      try { room.disconnect(); } catch (_) {}
    }
    if (v.ws && v.ws.readyState === 1) void beginWebRtcForViewer(c, v.ws);
    else ensureViewer(c);
    return true;
  }

  async function beginWebRtcForViewer(c, ws) {
    const src = srcOf(c.sourceId);
    if (!src || !src.preferWebRtc || !c.viewer) return;
    const v = c.viewer;
    const LK = window.LivekitClient || window.livekit || null;
    // 只有「此刻仍连着且解码仍新鲜」才跳过；卡死最后一帧必须重进
    if (isLkRoomConnected(c) && isLivekitVideoFresh(c)) return;
    if (v.webrtcTrying) {
      const started = Number(v.watchStartedAt || 0);
      if (started && (Date.now() - started) < 45000) return;
      v.webrtcTrying = false;
    }
    // 旧房（含假 connected）：拆掉重建，video 元素保留最后一帧
    if (v.lkRoom) {
      const prev = v.lkRoom;
      v.lkRoom = null;
      v.lkTrack = null;
      try { await prev.disconnect(); } catch (_) {}
    }
    v.webrtcTrying = true;
    v.watchStartedAt = Date.now();
    try {
      let sess = null;
      try {
        sess = await api(src, '/api/desktop/webrtc/session', {
          method: 'POST',
          body: JSON.stringify({
            clientId: c.clientId,
            quality: 'smooth',
            controlMouse: false,
            controlKeyboard: false,
            deferStart: true,
          }),
        });
      } catch (e) {
        try { console.warn('[屏幕墙] webrtc session 失败', e); } catch (_) {}
        // 暂保持当前路径，稍后再试；勿永久钉死 JPG
        v.webrtcTrying = false;
        v.lastKickAt = Date.now();
        return;
      }
      if (!sess || sess.ok === false) {
        try { console.warn('[屏幕墙] webrtc session 拒绝', sess && sess.message); } catch (_) {}
        v.webrtcTrying = false;
        v.lastKickAt = Date.now();
        return;
      }
      v.desktopSessionId = String(sess.desktopSessionId || '');
      if (!isSelected(c.key) || state.leaving) return;

      const transport = String(sess.transport || '');
      const viewerToken = String(sess.viewerToken || '');
      const lkUrlRaw = (location.protocol === 'https:')
        ? (sess.livekitBrowserUrl || sess.livekitUrl || '')
        : (sess.livekitUrl || sess.livekitBrowserUrl || '');
      const lkUrl = String(lkUrlRaw || '');

      // LiveKit 主路径（LK 必须现取，勿用未定义变量，否则整墙会掉进 JPG）
      if (transport === 'livekit' && LK && LK.Room && viewerToken && lkUrl && v.desktopSessionId) {
        // 拆房后必须用「当前」连接态；勿用拆房前缓存的 lkConnected（会永远软 watch 不重进）
        if (isLkRoomConnected(c)) {
          if (ws && ws.readyState === 1) {
            try {
              ws.send(JSON.stringify({
                type: 'watch',
                quality: 'smooth',
                desktopSessionId: v.desktopSessionId,
              }));
            } catch (_) {}
          }
          v.webrtcTrying = false;
          return;
        }
        if (v.lkRoom) {
          try { await v.lkRoom.disconnect(); } catch (_) {}
          v.lkRoom = null;
        }
        // 屏幕墙持续出画；观众侧也关 dynacast，避免短暂退订停流
        const room = new LK.Room({ adaptiveStream: false, dynacast: false });
        v.lkRoom = room;
        const onTrack = (track, pub) => {
          if (!track || track.kind !== 'video') return;
          forceLivekitHighQuality(pub || track);
          attachLivekitTrack(c, track);
          v.webrtcTrying = false;
          v.lkAgentReady = true;
        };
        room.on(LK.RoomEvent.TrackSubscribed, (track, _pub, pub) => {
          // livekit-client: (track, publication, participant)
          onTrack(track, _pub || pub);
        });
        room.on(LK.RoomEvent.TrackUnsubscribed, (track) => {
          // 保留 video 最后一帧；勿清 srcObject / 勿 remove('on')；立刻红条
          if (track && c.viewer && c.viewer.lkTrack === track) {
            v.lkTrack = null;
            markLinkDown(c, 'disconnected');
          }
        });
        room.on(LK.RoomEvent.TrackPublished, (pub, participant) => {
          try {
            if (pub && pub.kind === 'video' && !pub.isSubscribed) pub.setSubscribed(true);
          } catch (_) {}
        });
        try {
          room.on(LK.RoomEvent.ParticipantDisconnected, (participant) => {
            try {
              if (!participant || participant.isLocal) return;
              // 推流端离开：画面冻结但必须提示
              markLinkDown(c, 'agent_left');
            } catch (_) {}
          });
        } catch (_) {}
        room.on(LK.RoomEvent.Reconnecting, () => {
          setPathMode(c, 'livekit');
          markLinkDown(c, 'disconnected');
        });
        room.on(LK.RoomEvent.Disconnected, () => {
          if (v.lkRoom !== room) return;
          v.lkRoom = null;
          v.lkTrack = null;
          markLinkDown(c, 'disconnected');
          // 保留最后一帧挡黑屏；超时后静默重进，不要先摘 video.on
          setTimeout(() => {
            if (v.lkRoom || !isSelected(c.key) || state.leaving) return;
            v.webrtcTrying = false;
            v.lkAgentReady = false;
            if (v.ws && v.ws.readyState === 1) void beginWebRtcForViewer(c, v.ws);
            else ensureViewer(c);
          }, 1200);
        });

        // 代理硬拉节流：lkAgentReady=false 且距上次 force≥90s 才 kick（旧客户端强制会拆采集）
        const lastForce = Number(v.lastForceKickAt || 0);
        const needKick = !v.lkAgentReady && (!lastForce || (Date.now() - lastForce) > 90000);
        if (ws && ws.readyState === 1) {
          try {
            ws.send(JSON.stringify({
              type: 'watch',
              quality: 'smooth',
              desktopSessionId: v.desktopSessionId,
              kick: needKick,
              forceRestart: needKick,
            }));
          } catch (_) {}
        }
        if (needKick) {
          v.lkAgentReady = true;
          v.lastForceKickAt = Date.now();
        } else if (!v.lkAgentReady) {
          // 冷却中 / 复用会话：标已请求，避免每个新 sid 都 force
          v.lkAgentReady = true;
        }
        await room.connect(lkUrl, viewerToken);
        room.remoteParticipants.forEach((p) => {
          p.trackPublications.forEach((pub) => {
            try {
              if (pub.kind === 'video') {
                forceLivekitHighQuality(pub);
                if (!pub.isSubscribed) pub.setSubscribed(true);
                if (pub.track) onTrack(pub.track, pub);
              }
            } catch (_) {}
          });
        });

        if (v.webrtcTimer) clearTimeout(v.webrtcTimer);
        v.webrtcTimer = setTimeout(() => {
          v.webrtcTimer = null;
          if (c.hasVideoFrame) {
            v.webrtcTrying = false;
            setPathMode(c, 'livekit');
            patchTile(c);
            syncOverlayFromClient(c);
            return;
          }
          const retries = Number(v.webrtcRetries || 0);
          try { room.disconnect(); } catch (_) {}
          if (v.lkRoom === room) v.lkRoom = null;
          v.desktopSessionId = '';
          v.webrtcTrying = false;
          if (retries < 4 && isSelected(c.key) && !state.leaving) {
            v.webrtcRetries = retries + 1;
            v.lkAgentReady = false;
            void beginWebRtcForViewer(c, ws);
            return;
          }
          // 超时仍可稍后重试 LiveKit；像素用 JPG，但路径标签保持抢回云中转
          if (src.preferWebRtc) setPathMode(c, 'livekit');
          else setPathMode(c, 'jpeg');
          patchTile(c);
          v.lastKickAt = Date.now();
        }, WEBRTC_CONNECT_TIMEOUT_MS);
        return;
      }

      // SDK/会话缺字段：像素顶住，定时器会再抢 LiveKit；勿钉死 JPG 标签
      try { console.warn('[屏幕墙] LiveKit 条件不足', { transport, hasLK: !!LK, hasToken: !!viewerToken, lkUrl: lkUrl.slice(0, 48) }); } catch (_) {}
      if (src.preferWebRtc) setPathMode(c, 'livekit');
      else setPathMode(c, 'jpeg');
      if (ws && ws.readyState === 1) {
        try {
          ws.send(JSON.stringify({ type: 'watch', quality: 'smooth', kick: true, forceRestart: true }));
        } catch (_) {}
      }
      v.lastKickAt = Date.now();
    } catch (e) {
      try { console.warn('[屏幕墙] beginWebRtc 异常', e); } catch (_) {}
      v.lastKickAt = Date.now();
    } finally {
      if (!c.viewer || !c.viewer.lkRoom) v.webrtcTrying = false;
    }
  }

  async function viewerWsUrl(src, clientId) {
    if (!sourceAllowsWs(src)) {
      const err = new Error('ws-disabled');
      err.code = 'WS_DISABLED';
      throw err;
    }
    const data = await api(src, '/api/admin/ws-ticket', {
      method: 'POST',
      body: JSON.stringify({ clientId }),
    });
    const pathBase = String(src.prefix || '').replace(/\/$/, '');
    const proto = (location.protocol === 'https:') ? 'wss:' : 'ws:';
    return proto + '//' + location.host + pathBase + '/api/ws/viewer'
      + '?clientId=' + encodeURIComponent(clientId)
      + '&ticket=' + encodeURIComponent((data && data.ticket) || '');
  }

  function clearViewerReconnect(c) {
    if (c && c.viewer && c.viewer.reconnectTimer) {
      clearTimeout(c.viewer.reconnectTimer);
      c.viewer.reconnectTimer = null;
    }
  }

  function scheduleViewerReconnect(c) {
    if (!c || !isSelected(c.key) || state.leaving) return;
    clearViewerReconnect(c);
    const v = c.viewer || (c.viewer = makeViewerState());
    v.reconnectTimer = setTimeout(() => {
      v.reconnectTimer = null;
      ensureViewer(c);
    }, 1500);
  }

  function disconnectViewer(c) {
    if (!c) return;
    clearViewerReconnect(c);
    const v = c.viewer;
    if (!v) return;
    v.gen += 1;
    const ws = v.ws;
    v.ws = null;
    v.connecting = false;
    if (v.pingTimer) {
      try { clearInterval(v.pingTimer); } catch (_) {}
      v.pingTimer = null;
    }
    v.needKeyframe = true;
    v.lastSeq = 0;
    v.keySeq = 0;
    v.deltaInFlight = false;
    if (v.deltaQueue) v.deltaQueue.length = 0;
    clearWebRtcViewer(c);
    c.pathMode = '';
    c._overlayLockedVideo = false;
    if (ws) {
      try {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'unwatch' }));
      } catch (_) {}
      try { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; } catch (_) {}
      try { ws.close(); } catch (_) {}
    }
  }

  function ensureViewer(c) {
    if (!c || c.online === false || !isSelected(c.key) || state.leaving) return;
    const src = srcOf(c.sourceId);
    if (!src || !state.tokens[src.id]) return;
    // 旧后端无 ws-ticket：不建 WS，靠 HTTP /api/desktop/latest + startDesktop
    if (!sourceAllowsWs(src)) return;
    const key = c.key;
    const v = c.viewer || (c.viewer = makeViewerState());
    if (v.ws && (v.ws.readyState === 0 || v.ws.readyState === 1)) return;
    if (v.connecting) return;
    v.connecting = true;
    clearViewerReconnect(c);
    void (async () => {
      let url = '';
      try {
        url = await viewerWsUrl(src, c.clientId);
      } catch (e) {
        const cur = state.clients.get(key);
        if (cur && cur.viewer) cur.viewer.connecting = false;
        const msg = String((e && e.message) || e || '');
        const missingTicket = (e && e.code === 'WS_DISABLED')
          || /not found|HTTP 404|ws-disabled/i.test(msg);
        if (missingTicket) {
          markWsUnsupported(src, msg);
          setPathMode(state.clients.get(key) || c, 'jpeg');
          if (needsCapture(cur || c)) void startDesktop(src, c.clientId, { force: true });
          return;
        }
        scheduleViewerReconnect(state.clients.get(key) || c);
        return;
      }
      if (!isSelected(key) || state.leaving) {
        const cur = state.clients.get(key);
        if (cur && cur.viewer) cur.viewer.connecting = false;
        return;
      }
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (_) {
        const cur = state.clients.get(key);
        if (cur && cur.viewer) cur.viewer.connecting = false;
        scheduleViewerReconnect(state.clients.get(key) || c);
        return;
      }
      const cur0 = state.clients.get(key) || c;
      const vv = cur0.viewer || (cur0.viewer = makeViewerState());
      vv.ws = ws;
      ws.onopen = () => {
        const cur = state.clients.get(key);
        if (!cur || !cur.viewer) return;
        cur.viewer.connecting = false;
        cur.viewer.needKeyframe = true;
        // 心跳：LiveKit 出画不走本 WS，避免服务端 ~120s 空闲掐连接 → 重连黑屏
        if (cur.viewer.pingTimer) {
          try { clearInterval(cur.viewer.pingTimer); } catch (_) {}
        }
        cur.viewer.pingTimer = setInterval(() => {
          try {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
          } catch (_) {}
        }, 25000);
        try {
          if (src.preferWebRtc) {
            // 禁止空 sid watch（服务端会 livekit=0 拆房）；有 sid 再 watch，否则只建 session
            if (cur.viewer.desktopSessionId) {
              ws.send(JSON.stringify({
                type: 'watch',
                quality: 'smooth',
                desktopSessionId: cur.viewer.desktopSessionId,
              }));
            }
          } else {
            ws.send(JSON.stringify({
              type: 'watch',
              quality: 'smooth',
              kick: true,
              forceRestart: true,
            }));
            cur.viewer.lastKickAt = Date.now();
          }
        } catch (_) {}
        state.startedAt.set(key, Date.now());
        void seedCachedFrame(cur);
        if (src.preferWebRtc) {
          const lkLive = !!(cur.viewer && cur.viewer.lkRoom);
          const lkConnected = !!(lkLive && (String(cur.viewer.lkRoom.state || '') === 'connected'
            || (window.LivekitClient && window.LivekitClient.ConnectionState
              && cur.viewer.lkRoom.state === window.LivekitClient.ConnectionState.Connected)));
          if (lkConnected && cur.hasVideoFrame) {
            setPathMode(cur, 'livekit');
          } else if (lkLive && cur.viewer.desktopSessionId) {
            /* already watching with sid above */
          } else {
            if (cur.viewer) cur.viewer.webrtcTrying = false;
            void beginWebRtcForViewer(cur, ws);
          }
        } else setPathMode(cur, 'jpeg');
      };
      ws.onmessage = (ev) => {
        const cur = state.clients.get(key);
        if (!cur || !isSelected(key)) return;
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (!msg) return;
        if (String(msg.type || '').startsWith('webrtc_')) {
          handleViewerWebRtcSignal(cur, msg);
          return;
        }
        if (msg.type === 'frame') {
          // 真正有 WebRTC 画面时才挡 JPEG；协商中仍吃关键帧，避免黑瓦片
          if (cur.hasVideoFrame && (cur.pathMode === 'direct' || cur.pathMode === 'turn' || cur.pathMode === 'livekit')) return;
          // preferWebRtc：JPEG 只作像素兜底，禁止把路径标签钉成 JPG全图
          if (!(cur.viewer && cur.viewer.webrtcTrying) && !(src && src.preferWebRtc)) setPathMode(cur, 'jpeg');
          applyTileFrame(cur, msg.image, msg.t, {
            cached: !!msg.cached,
            seq: msg.seq,
            keySeq: msg.keySeq,
          });
          return;
        }
        if (msg.type === 'frame_delta') {
          if (cur.hasVideoFrame && (cur.pathMode === 'direct' || cur.pathMode === 'turn' || cur.pathMode === 'livekit')) return;
          if (!(cur.viewer && cur.viewer.webrtcTrying) && !(src && src.preferWebRtc)) setPathMode(cur, 'jpeg');
          const viewer = cur.viewer;
          const ok = applyTileDelta(cur, msg);
          // Only kick when continuity is truly lost — not when deltas are merely queued.
          if (!ok && viewer && viewer.needKeyframe) {
            const now = Date.now();
            if (!viewer.lastKickAt || (now - viewer.lastKickAt) > 15000) {
              viewer.lastKickAt = now;
              try {
                ws.send(JSON.stringify({ type: 'watch', quality: 'smooth', kick: true, forceRestart: true }));
              } catch (_) {}
            }
          }
        }
      };
      ws.onclose = () => {
        const cur = state.clients.get(key);
        if (cur && cur.viewer && cur.viewer.ws === ws) cur.viewer.ws = null;
        if (cur && cur.viewer) cur.viewer.connecting = false;
        // 控制通道断了：若仍勾选中且有最后一帧，立刻提示「断链」而不是假装还在播
        if (cur && isSelected(key) && !state.leaving) {
          const stillShowing = !!(cur.hasVideoFrame || cur.hasCanvasFrame || cur.image
            || (cur.viewer && (cur.viewer.lkTrack || cur.viewer.lkRoom)));
          if (stillShowing || cur.pathMode === 'livekit' || cur.pathMode === 'direct' || cur.pathMode === 'turn') {
            markLinkDown(cur, 'ws_closed');
          }
        }
        if (isSelected(key) && !state.leaving) scheduleViewerReconnect(state.clients.get(key) || c);
      };
      ws.onerror = () => {
        try { ws.close(); } catch (_) {}
      };
    })();
  }

  async function seedCachedFrame(c) {
    if (!c || !isSelected(c.key)) return;
    await pollLatestFrame(c, { force: !c.hasCanvasFrame });
  }

  /** HTTP /api/desktop/latest backup — this is what made the old wall reliable. */
  function shouldApplyPollFrame(c) {
    // LiveKit/直连仅在「解码仍新鲜」时挡 JPEG；假死最后一帧必须允许 /latest 兜底
    if (c && c.hasVideoFrame && (c.pathMode === 'direct' || c.pathMode === 'turn' || c.pathMode === 'livekit')) {
      if (c.pathMode === 'livekit') {
        if (isLivekitVideoFresh(c)) return false;
      } else {
        const liveAge = c.frameAt ? (Date.now() - c.frameAt) : 999999;
        if (liveAge < STALE_BANNER_LIVE_MS) return false;
      }
    }
    const v = c && c.viewer;
    const wsOpen = !!(v && v.ws && v.ws.readyState === 1);
    const liveAge = c.frameAt ? (Date.now() - c.frameAt) : 999999;
    const hasRealtime = !!(v && !v.needKeyframe && v.keySeq > 0);
    if (wsOpen && hasRealtime && liveAge < LIVE_POLL_GRACE_MS) return false;
    return true;
  }

  async function pollLatestFrame(c, opts) {
    opts = opts || {};
    if (!c || !isSelected(c.key)) return null;
    const src = srcOf(c.sourceId);
    if (!src || !state.tokens[src.id]) return null;
    // LiveKit 出画正常时禁止拉全图 JPEG（每 1.5s × N 瓦片浪费极大）
    if (!opts.force && src.preferWebRtc && c.pathMode === 'livekit' && isLivekitVideoFresh(c) && c.hasVideoFrame) {
      return null;
    }
    if (!opts.force && !shouldApplyPollFrame(c) && src.preferWebRtc && (c.pathMode === 'livekit' || c.pathMode === 'direct' || c.pathMode === 'turn')) {
      return null;
    }
    try {
      const data = await api(src, '/api/desktop/latest?clientId=' + encodeURIComponent(c.clientId));
      if (!isSelected(c.key) || !data || !data.image) return data;
      if (data.ageSec != null) c.ageSec = data.ageSec;
      if (!opts.force && !shouldApplyPollFrame(c)) return data;
      const stamp = String(data.t || data.ts || '');
      // Same shot stamp must NOT redraw / bump frameAt — that masked freezes as "fresh".
      if (stamp && stamp === String(c.t || '') && c.hasCanvasFrame) return data;
      applyTileFrame(c, data.image, stamp, { cached: true });
      return data;
    } catch (_) {
      return null;
    }
  }

  async function startDesktop(src, clientId, opts) {
    // Kept as emergency kick; primary start is viewer WS register.
    opts = opts || {};
    if (!src || !clientId) return;
    const key = clientKey(src.id, clientId);
    if (!isSelected(key)) return;
    const now = Date.now();
    const last = Number(state.startedAt.get(key) || 0);
    if (!opts.force && last && (now - last) < START_COOLDOWN_MS) return;
    if (opts.force && last && (now - last) < 3000) return;
    state.startedAt.set(key, now);
    try {
      await api(src, '/api/desktop/start', {
        method: 'POST',
        body: JSON.stringify({
          clientId,
          continuous: true,
          quality: 'smooth',
          kick: !!opts.force,
          forceRestart: !!opts.force,
        }),
      });
    } catch (_) {
      state.startedAt.delete(key);
    }
  }

  function stopDesktop(src, clientId) {
    if (!src || !clientId) return;
    const tok = state.tokens[src.id];
    if (!tok) return;
    try {
      fetch(src.prefix + '/api/desktop/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Token': tok },
        body: JSON.stringify({ clientId }),
        keepalive: true,
      }).catch(function () {});
    } catch (_) {}
  }

  async function refreshOverview() {
    // Keep overview while hidden so online list / start recovery still run on long hangs.
    if (state.leaving || state.overviewInFlight) return;
    const authed = SOURCES.filter(s => state.tokens[s.id]);
    if (!authed.length) { showLogin(); return; }
    state.overviewInFlight = true;
    const gen = ++state.overviewGen;
    const alive = new Set();
    const confirmedSources = new Set(); // sources whose overview succeeded this tick
    const statusBits = [];
    try {
      void refreshTokens({ force: false });
      await Promise.all(authed.map(async (src) => {
        try {
          const data = await api(src, '/api/overview');
          if (gen !== state.overviewGen) return;
          const rows = (data && data.online) || [];
          statusBits.push(src.name + ' ' + rows.length);
          confirmedSources.add(src.id);
          const seen = new Set();
          for (const r of rows) {
            const cid = String(r.clientId || '');
            if (!cid || seen.has(cid)) continue;
            seen.add(cid);
            const key = clientKey(src.id, cid);
            alive.add(key);
            let c = state.clients.get(key);
            if (!c) {
              c = {
                key, sourceId: src.id, sourceName: src.name, deskPath: src.deskPath,
                clientId: cid,
                account: String(r.account || '').trim() || '账号未上报',
                version: String(r.version || '').trim(),
                ip: r.ip || '',
                online: true,
                desktopWatching: !!r.desktopWatching,
                missCount: 0,
              };
              state.clients.set(key, c);
            } else {
              // In-place update — never replace the object (viewer WS closes over it).
              c.sourceId = src.id;
              c.sourceName = src.name;
              c.deskPath = src.deskPath;
              c.clientId = cid;
              c.account = String(r.account || '').trim() || '账号未上报';
              c.version = String(r.version || '').trim();
              c.ip = r.ip || '';
              c.online = true;
              c.offlineSince = 0;
              c.desktopWatching = !!r.desktopWatching;
              c.missCount = 0;
            }
            patchTile(c);
            // Only selected tiles stream. wxqk 用 viewer WS；九游/开云无 ticket 则 HTTP。
            if (isSelected(key)) {
              if (sourceAllowsWs(src)) ensureViewer(c);
              const wsOpen = !!(c.viewer && c.viewer.ws && c.viewer.ws.readyState === 1);
              // wxqk WebRTC：禁止无 sid 的 HTTP force，否则会堵死 publisher
              if (!wsOpen && needsCapture(c) && !src.preferWebRtc) {
                void startDesktop(src, cid, { force: true });
              }
            } else {
              disconnectViewer(c);
              if (r.desktopWatching) {
                // Keep unselected idle — stop leftover streams from previous sessions.
                stopDesktop(src, cid);
                state.startedAt.delete(key);
              }
            }
          }
        } catch (e) {
          statusBits.push(src.name + '×');
          // Keep last-known clients for this source on transient errors (avoid count drop).
          for (const [key, c] of state.clients) {
            if (c.sourceId === src.id) alive.add(key);
          }
          if (String(e.message) === 'auth') {
            /* token dropped for this source */
          }
        }
      }));
      if (state.leaving || gen !== state.overviewGen) return;

      // Only drop clients belonging to sources that answered successfully this tick.
      // Require 2 consecutive misses → mark offline + keep tile (red banner) for OFFLINE_KEEP_MS.
      for (const key of [...state.clients.keys()]) {
        const c = state.clients.get(key);
        if (!c) continue;
        if (!confirmedSources.has(c.sourceId)) continue;
        if (alive.has(key)) {
          c.missCount = 0;
          c.online = true;
          c.offlineSince = 0;
          continue;
        }
        c.missCount = (Number(c.missCount) || 0) + 1;
        // First miss: keep showing as online (transient glitch).
        if (c.missCount < 2) continue;

        c.online = false;
        if (!c.offlineSince) c.offlineSince = Date.now();
        // 勾选中且正在 WebRTC 建链：概览抖动不要拆会话（否则 offer 永到不了）
        const keepRtc = isSelected(key) && c.viewer && (c.viewer.webrtcTrying || c.viewer.lkRoom);
        if (!keepRtc) {
          disconnectViewer(c);
          state.startedAt.delete(key);
        }

        const offlineFor = Date.now() - Number(c.offlineSince || Date.now());
        if (!state.dragging && offlineFor >= OFFLINE_KEEP_MS) {
          state.clients.delete(key);
          continue;
        }
        // Update ageSec so banner can show「缓存约 Xs 前」
        if (c.frameAt) c.ageSec = Math.round((Date.now() - c.frameAt) / 1000);
        patchTile(c);
      }
      // Rebuild keep set for prune = all remaining clients (incl. offline kept)
      const keep = new Set(state.clients.keys());
      if (!state.dragging) {
        pruneTiles(keep);
      }

      const empty = document.getElementById('empty');
      if (keep.size === 0) {
        if (!empty) {
          const d = document.createElement('div');
          d.id = 'empty';
          d.textContent = '暂无在线客户端';
          document.getElementById('wall').appendChild(d);
        } else {
          empty.textContent = '暂无在线客户端';
          empty.classList.remove('hidden');
        }
      } else if (empty) empty.remove();

      const onlineN = [...state.clients.values()].filter((c) => c.online !== false).length;
      document.getElementById('onlineCount').textContent = String(onlineN);
      updateSelectedCount();
      const warn = state.loginWarn ? (' · ' + state.loginWarn) : '';
      const tokBits = SOURCES.filter(s => state.tokens[s.id]).map(s => {
        const r = tokenRemainSec(state.tokens[s.id]);
        if (r <= 0) return s.name + '令牌?';
        if (r < 3600) return s.name + '令牌' + Math.max(1, Math.floor(r / 60)) + 'm';
        return '';
      }).filter(Boolean);
      const tokWarn = tokBits.length ? (' · ' + tokBits.join(' ')) : '';
      document.getElementById('statusText').textContent = statusBits.join(' · ') + warn + tokWarn;
      const missing = SOURCES.filter(s => !state.tokens[s.id]).map(s => s.name);
      if (missing.length) {
        document.getElementById('liveDot').classList.add('off');
      } else {
        document.getElementById('liveDot').classList.remove('off');
      }
      // Refresh offline/stale red banners (duration text).
      for (const c of state.clients.values()) {
        if (c.online === false || isSelected(c.key)) patchTile(c);
      }
      if (!state.dragging) {
        applyOrderDom();
        applyLayout();
      }
    } finally {
      state.overviewInFlight = false;
    }
  }

  async function refreshFrames() {
    // Hybrid: WS for smooth deltas; HTTP latest as the reliable pixel backup (pre-WS wall behavior).
    if (document.hidden || state.leaving || state.framesInFlight) return;
    const authed = SOURCES.filter(s => state.tokens[s.id]);
    if (!authed.length) return;
    state.framesInFlight = true;
    let live = 0;
    try {
      for (const c of state.clients.values()) {
        const src = srcOf(c.sourceId);
        if (!src || !state.tokens[src.id]) continue;
        if (!isSelected(c.key)) {
          if (c.viewer && c.viewer.ws) disconnectViewer(c);
          if (c.image || c.hasCanvasFrame) {
            c.image = '';
            c.hasCanvasFrame = false;
            patchTile(c);
          }
          continue;
        }
        ensureViewer(c);
        await pollLatestFrame(c);
        const wsOpen = !!(c.viewer && c.viewer.ws && c.viewer.ws.readyState === 1);
        const ageMs = Date.now() - (c.frameAt || 0);
        const fresh = ageMs < STALE_SEC * 1000;
        // LiveKit 假死 / 误掉进 JPG：定期抢回云中转
        if (src.preferWebRtc) {
          if (ageMs > 25000 && recoverStalledLivekit(c)) continue;
          const trying = !!(c.viewer && c.viewer.webrtcTrying);
          const lkUp = isLkRoomConnected(c);
          // 已在房/建链中：禁止再 begin（会拆观众房，永远看不成云中转）
          const needLk = !c.hasVideoFrame && !lkUp && !trying && (c.pathMode === 'jpeg' || !c.pathMode || c.pathMode === 'livekit');
          if (needLk) {
            const last = Number((c.viewer && c.viewer.lastKickAt) || 0);
            if (!last || (Date.now() - last) > 45000) {
              if (c.viewer) {
                c.viewer.webrtcRetries = 0;
                c.viewer.webrtcTrying = false;
                c.viewer.lastKickAt = Date.now();
              }
              if (c.viewer && c.viewer.ws && c.viewer.ws.readyState === 1) {
                void beginWebRtcForViewer(c, c.viewer.ws);
              } else {
                ensureViewer(c);
              }
            }
          }
        }
        if (wsOpen && fresh && c.viewer && !c.viewer.needKeyframe) {
          live += 1;
          continue;
        }
        if (needsCapture(c)) {
          const hardStall = !c.hasCanvasFrame || ageMs > STALE_SEC * 1000 || !!(c.viewer && c.viewer.needKeyframe && ageMs > 4000);
          const lastKick = Number((c.viewer && c.viewer.lastKickAt) || 0);
          // 仅「正在协商且未超时」算 busy；已连通但卡死走 recoverStalledLivekit
          const trying = !!(c.viewer && c.viewer.webrtcTrying);
          const tryingAge = trying ? (Date.now() - Number((c.viewer && c.viewer.watchStartedAt) || 0)) : 0;
          // 与 WEBRTC_CONNECT_TIMEOUT_MS 对齐，避免 25s 又踢、45s 建链还在跑
          const webrtcBusy = !!(src.preferWebRtc && trying && tryingAge < WEBRTC_CONNECT_TIMEOUT_MS);
          // LiveKit 路径拉长硬拉间隔，给客户端 JPEG 兜底与 getDisplayMedia 退避时间
          const kickGap = src.preferWebRtc ? 90000 : 12000;
          if (hardStall && !webrtcBusy && (!lastKick || (Date.now() - lastKick) > kickGap)) {
            if (c.viewer) c.viewer.lastKickAt = Date.now();
            if (src.preferWebRtc) {
              if (c.viewer) c.viewer.webrtcTrying = false;
              if (c.viewer && c.viewer.ws && c.viewer.ws.readyState === 1) {
                void beginWebRtcForViewer(c, c.viewer.ws);
              } else {
                ensureViewer(c);
              }
            } else if (c.viewer && c.viewer.ws && c.viewer.ws.readyState === 1) {
              try {
                c.viewer.ws.send(JSON.stringify({ type: 'watch', quality: 'smooth', kick: true, forceRestart: true }));
              } catch (_) {
                void startDesktop(src, c.clientId, { force: true });
              }
            } else {
              void startDesktop(src, c.clientId, { force: true });
            }
          } else if (!wsOpen) {
            ensureViewer(c);
          }
        }
        if (c.hasCanvasFrame && fresh) live += 1;
      }
      document.getElementById('frameCount').textContent = String(live);
      updateSelectedCount();
    } finally {
      state.framesInFlight = false;
    }
  }

  function openOverlay(key) {
    key = String(key || '');
    const c = state.clients.get(key);
    if (!c) return;
    const prevKey = state.focusKey;
    if (prevKey && prevKey !== key) {
      const prev = state.clients.get(prevKey);
      if (prev) {
        prev._overlayLockedVideo = false;
        // 从放大层卸下旧轨，勿动瓦片上的 attach
        try {
          const prevTrack = prev.viewer && prev.viewer.lkTrack;
          const ovVideo = document.getElementById('ovVideo');
          if (prevTrack && ovVideo && typeof prevTrack.detach === 'function') prevTrack.detach(ovVideo);
        } catch (_) {}
      }
    }
    state.focusKey = key;
    const overlay = document.getElementById('overlay');
    overlay.classList.remove('hidden');
    document.getElementById('ovTitle').textContent = c.sourceName + ' · ' + formatAccountLabel(c);
    const ovImg = document.getElementById('ovImg');
    if (ovImg) {
      ovImg.classList.add('hidden');
      ovImg.removeAttribute('src');
    }
    const ovVideo = document.getElementById('ovVideo');
    // 切换瓦片时先清空放大层，避免短暂显示上一台画面
    if (ovVideo && prevKey !== key) {
      try { ovVideo.srcObject = null; } catch (_) {}
      ovVideo.classList.remove('on');
      ovVideo.dataset.forKey = '';
    }
    const ovCanvas = document.getElementById('ovCanvas');
    if (ovCanvas && prevKey !== key) ovCanvas.classList.add('hidden');
    // 先立刻绑轨/画布，避免放大层黑一帧
    syncOverlayFromClient(c);
    // 下一帧再刷一次（attach 异步/play 竞态）
    requestAnimationFrame(() => {
      if (state.focusKey === key) syncOverlayFromClient(c);
    });
    if (!c.hasCanvasFrame && c.image) {
      applyTileFrame(c, c.image, c.t, { cached: true });
    }
    const a = document.getElementById('ovOpen');
    const desk = String(c.deskPath || '');
    a.href = /^https?:\/\//i.test(desk)
      ? desk
      : (location.origin.replace(/:888$/, '') || location.origin) + desk;
  }
  function closeOverlay() {
    const prevKey = state.focusKey;
    state.focusKey = '';
    if (prevKey) {
      const prev = state.clients.get(prevKey);
      if (prev) {
        prev._overlayLockedVideo = false;
        try {
          const prevTrack = prev.viewer && prev.viewer.lkTrack;
          const ovVideo = document.getElementById('ovVideo');
          if (prevTrack && ovVideo && typeof prevTrack.detach === 'function') prevTrack.detach(ovVideo);
        } catch (_) {}
      }
    }
    const overlay = document.getElementById('overlay');
    overlay.classList.add('hidden');
    const ovVideo = document.getElementById('ovVideo');
    if (ovVideo) {
      // 只断开放大层引用；瓦片 video 各自持有同一 MediaStream，勿 track.detach 瓦片
      try { ovVideo.srcObject = null; } catch (_) {}
      ovVideo.classList.remove('on');
      ovVideo.dataset.forKey = '';
    }
  }

  function showLogin() {
    stopAllViewers();
    stopLoops();
    document.getElementById('loginView').classList.remove('hidden');
    document.getElementById('wallView').classList.add('hidden');
    closeOverlay();
  }
  function showWall() {
    state.leaving = false;
    document.getElementById('loginView').classList.add('hidden');
    document.getElementById('wallView').classList.remove('hidden');
    applyLayout();
    startLoops();
  }
  function refreshStaleBanners() {
    if (state.leaving || state.dragging) return;
    const now = Date.now();
    let removed = false;
    for (const c of [...state.clients.values()]) {
      bumpLivekitHeartbeat(c);
      if (c.frameAt) c.ageSec = Math.round((now - c.frameAt) / 1000);
      // 卡死恢复只走 refreshFrames，避免与帧轮询叠加重连烧流量
      if (c.online === false || isSelected(c.key) || c.linkDownAt) patchTile(c);
      if (state.focusKey && c.key === state.focusKey) {
        try { syncOverlayStale(c); } catch (_) {}
      }
      // Expire offline-kept tiles
      if (c.online === false && c.offlineSince && (now - c.offlineSince) >= OFFLINE_KEEP_MS && !state.dragging) {
        disconnectViewer(c);
        state.clients.delete(c.key);
        state.startedAt.delete(c.key);
        const el = findTileEl(c.key);
        if (el) removeTileEl(el);
        removed = true;
      }
    }
    if (removed && !state.dragging) {
      syncOrderWithAlive([...state.clients.keys()]);
      applyOrderDom();
      applyLayout();
      const keep = state.clients.size;
      const empty = document.getElementById('empty');
      if (keep === 0) {
        if (!empty) {
          const d = document.createElement('div');
          d.id = 'empty';
          d.textContent = '暂无在线客户端';
          document.getElementById('wall').appendChild(d);
        } else {
          empty.textContent = '暂无在线客户端';
          empty.classList.remove('hidden');
        }
      } else if (empty) empty.remove();
    }
    const onlineN = [...state.clients.values()].filter((row) => row.online !== false).length;
    const el = document.getElementById('onlineCount');
    if (el) el.textContent = String(onlineN);
  }

  function stopLoops() {
    if (state.overviewTimer) { clearInterval(state.overviewTimer); state.overviewTimer = null; }
    if (state.frameTimer) { clearInterval(state.frameTimer); state.frameTimer = null; }
    if (state.tokenTimer) { clearInterval(state.tokenTimer); state.tokenTimer = null; }
    if (state.staleTimer) { clearInterval(state.staleTimer); state.staleTimer = null; }
  }
  function startLoops() {
    stopLoops();
    void refreshTokens({ force: true }).then(() => refreshOverview()).then(() => refreshFrames());
    state.overviewTimer = setInterval(() => { void refreshOverview(); }, 5000);
    // Rare health check — not the pixel path.
    state.frameTimer = setInterval(() => { void refreshFrames(); }, FRAME_POLL_MS);
    state.tokenTimer = setInterval(() => { void refreshTokens({ force: true }); }, TOKEN_REFRESH_EVERY_MS);
    // Tick red offline/stale banners like 开云 deskStaleBanner.
    state.staleTimer = setInterval(() => { refreshStaleBanners(); }, 2000);
  }

  function stopAllViewers() {
    for (const c of state.clients.values()) {
      disconnectViewer(c);
      c.hasCanvasFrame = false;
      c.image = '';
    }
  }

  /** Close viewer WS first so server can stop agents; HTTP stop is backup. */
  function stopAllDesktops(opts) {
    opts = opts || {};
    const keepalive = !!opts.keepalive;
    stopAllViewers();
    const snapshot = [...state.clients.values()].map(c => ({
      sourceId: c.sourceId,
      clientId: c.clientId,
      token: state.tokens[c.sourceId] || '',
    }));
    for (const row of snapshot) {
      const src = srcOf(row.sourceId);
      if (!src || !row.token || !row.clientId) continue;
      try {
        fetch(src.prefix + '/api/desktop/stop', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Admin-Token': row.token,
          },
          body: JSON.stringify({ clientId: row.clientId }),
          keepalive: keepalive,
        }).catch(function () {});
      } catch (_) {}
    }
    state.startedAt.clear();
  }

  document.getElementById('loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = document.getElementById('loginBtn');
    const err = document.getElementById('loginErr');
    const password = document.getElementById('password').value || '';
    err.textContent = '';
    btn.disabled = true;
    try {
      await loginAll(password);
      document.getElementById('password').value = '';
      showWall();
    } catch (e) {
      err.textContent = e.message || '登录失败';
    } finally {
      btn.disabled = false;
    }
  });
  document.getElementById('wall').addEventListener('dblclick', (ev) => {
    if (state.dragging) return;
    if (Date.now() < (state.suppressClickUntil || 0)) return;
    const key = tileKeyFromEvent(ev);
    if (!key) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (!isSelected(key)) return;
    openOverlay(key);
  });
  document.getElementById('layoutGroup').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.layout-btn');
    if (!btn) return;
    const v = btn.getAttribute('data-rows');
    state.layoutRows = v === 'auto' ? 'auto' : Math.max(1, Math.min(3, Number(v) || 1));
    saveLayoutRows();
    applyLayout();
    // 二次测量：顶栏换行后墙高会变，补一帧避免乱版
    requestAnimationFrame(() => applyLayout());
  });
  document.getElementById('layoutGroupMobile').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.layout-btn');
    if (!btn) return;
    const n = Number(btn.getAttribute('data-mcols'));
    state.mobileCols = n === 2 ? 2 : 1;
    saveMobileCols();
    applyLayout();
    requestAnimationFrame(() => applyLayout());
  });
  let layoutResizeTimer = 0;
  window.addEventListener('resize', () => {
    if (layoutResizeTimer) clearTimeout(layoutResizeTimer);
    layoutResizeTimer = setTimeout(() => {
      layoutResizeTimer = 0;
      applyLayout();
    }, 80);
  });
  try {
    window.matchMedia('(max-width: 768px)').addEventListener('change', () => {
      destroyWallMuuri();
      applyLayout();
    });
  } catch (_) {}

  document.getElementById('logoutBtn').addEventListener('click', () => {
    state.leaving = true;
    state.overviewGen += 1;
    stopAllDesktops({ keepalive: true });
    stopLoops();
    state.tokens = {};
    state.clients.clear();
    state.startedAt.clear();
    state.loginWarn = '';
    saveTokens();
    destroyWallMuuri();
    wallMuuriWantDrag = null;
    document.getElementById('wall').innerHTML = '<div id="empty">加载中…</div>';
    showLogin();
    // leaving 保持 true，直到下次 showWall，避免未完成的 overview/LiveKit 回写墙
  });
  document.getElementById('ovClose').addEventListener('click', closeOverlay);
  document.getElementById('overlay').addEventListener('dblclick', (ev) => {
    const t = ev.target;
    // 双击画面/黑底退出全屏；顶栏按钮仍可单击
    if (t && t.closest && t.closest('.obar')) return;
    if (t.id === 'overlay' || t.id === 'ovImg' || t.id === 'ovCanvas' || t.id === 'ovVideo' || (t.classList && t.classList.contains('stage'))) {
      ev.preventDefault();
      closeOverlay();
    }
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeOverlay();
  });

  // Long-hang wall: do NOT stop capture on tab hide (that caused freeze/recovery storms).
  // Only pause heavy frame polling while hidden; overview+token renew keep running.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (SOURCES.some(s => state.tokens[s.id])) {
      // 勿清空 startedAt：否则回前台会冲掉冷却、对勾选瓦片 forceRestart 风暴
      void refreshTokens({ force: false }).then(() => refreshOverview()).then(() => refreshFrames());
    }
  });
  window.addEventListener('pagehide', () => {
    state.leaving = true;
    stopAllDesktops({ keepalive: true });
  });
  window.addEventListener('beforeunload', () => {
    state.leaving = true;
    stopAllDesktops({ keepalive: true });
  });

  if (SOURCES.some(s => state.tokens[s.id])) showWall();
  else showLogin();
})();
</script>
</body>
</html>
"""

PROXY_COMMON = """\
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_connect_timeout 60s;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        client_body_timeout 600s;
        client_max_body_size 250m;
        proxy_request_buffering off;
        proxy_buffering off;
        add_header Cache-Control "no-store";
"""

# 反代到新服 HTTPS（自签证书）：关闭校验，Host 用上游 IP:8443，保留 WS Upgrade
PROXY_REMOTE_WXQK = """\
        proxy_http_version 1.1;
        proxy_ssl_server_name on;
        proxy_ssl_verify off;
        proxy_ssl_name 120.27.219.138;
        proxy_set_header Host 120.27.219.138:8443;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_connect_timeout 60s;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        client_body_timeout 600s;
        client_max_body_size 250m;
        proxy_request_buffering off;
        proxy_buffering off;
        add_header Cache-Control "no-store";
"""


def _proxy_block(location: str, upstream: str, *, remote_wxqk: bool = False) -> str:
    common = PROXY_REMOTE_WXQK if remote_wxqk else PROXY_COMMON
    return f"""    location ^~ {location} {{
        proxy_pass {upstream};
{common}    }}
"""


NGINX_PORT_CONF = f"""# Remote screen-wall on :888 (managed by deploy_rd_portal_888.py)
server {{
    listen 888;
    listen [::]:888;
    server_name _;
    client_max_body_size 250m;
    root {REMOTE_DIR};
    index index.html;

    location = / {{
        try_files /index.html =404;
        add_header Cache-Control "no-store";
    }}

{_proxy_block('/p/wxqk/', NEW_WXQK_UPSTREAM, remote_wxqk=True)}
{_proxy_block('/p/jiuyou/', 'http://127.0.0.1:4811/')}
{_proxy_block('/p/kaiyun/', 'http://127.0.0.1:4810/')}

    access_log /var/log/nginx/rd-portal-888.access.log;
    error_log /var/log/nginx/rd-portal-888.error.log;
}}
"""

# Inserted into xiangyuzhubao-business.conf for HTTPS/HTTP path /888/
NGINX_PATH_BLOCK = f"""# rd-portal /888 managed block
location = /888 {{
    return 301 /888/;
}}
location ^~ /888/p/wxqk/ {{
    proxy_pass {NEW_WXQK_UPSTREAM};
{PROXY_REMOTE_WXQK}}}
location ^~ /888/p/jiuyou/ {{
    proxy_pass http://127.0.0.1:4811/;
{PROXY_COMMON}}}
location ^~ /888/p/kaiyun/ {{
    proxy_pass http://127.0.0.1:4810/;
{PROXY_COMMON}}}
location ^~ /888/ {{
    alias {REMOTE_DIR}/;
    index index.html;
    add_header Cache-Control "no-store";
}}
# end rd-portal /888 managed block
"""


UPSERT_PATH_PY = f"""
from pathlib import Path
p = Path({BUSINESS_SNIPPET!r})
text = p.read_text(encoding='utf-8')
start = '# rd-portal /888 managed block'
end = '# end rd-portal /888 managed block'
# 清掉历史重复插入的整块
while True:
    a = text.find(start)
    if a < 0:
        break
    b = text.find(end, a)
    if b < 0:
        raise RuntimeError('incomplete /888 nginx block')
    text = text[:a] + text[b + len(end):].lstrip('\\r\\n')
block = {NGINX_PATH_BLOCK!r}
needle = 'client_max_body_size 200m;\\n'
if needle in text:
    text = text.replace(needle, needle + block, 1)
else:
    text = block + text
p.write_text(text, encoding='utf-8')
print('nginx /888 path block upserted')
"""


def main() -> None:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        HOST,
        username=USER,
        password=PASSWORD,
        timeout=20,
        allow_agent=False,
        look_for_keys=False,
    )

    def run(command: str) -> str:
        _, stdout, stderr = client.exec_command(command, timeout=90)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        print("$", command[:120])
        if out.strip():
            print(out[:2500])
        if err.strip():
            print("ERR", err[:1000])
        return out

    run(f"mkdir -p {REMOTE_DIR}")
    sftp = client.open_sftp()
    with sftp.file(f"{REMOTE_DIR}/index.html", "w") as f:
        f.write(PORTAL_HTML)
    with sftp.file(f"{REMOTE_DIR}/rd-portal-888.conf", "w") as f:
        f.write(NGINX_PORT_CONF)
    with sftp.file(f"{REMOTE_DIR}/_upsert_nginx_888_path.py", "w") as f:
        f.write(UPSERT_PATH_PY)
    sftp.close()

    run(f"cp {REMOTE_DIR}/rd-portal-888.conf {NGINX_SITE}")
    run(f"python3 {REMOTE_DIR}/_upsert_nginx_888_path.py")
    run("nginx -t && systemctl reload nginx")
    time.sleep(0.4)

    run("ss -lntp | grep ':888 ' || true")
    checks = [
        ("portal888", "http://127.0.0.1:888/"),
        ("path888", "http://127.0.0.1/888/", "xiangyuzhubao.xyz"),
        ("p_wxqk", "http://127.0.0.1:888/p/wxqk/"),
        ("p_jiuyou", "http://127.0.0.1:888/p/jiuyou/"),
        ("p_kaiyun", "http://127.0.0.1:888/p/kaiyun/"),
        ("path_p_wxqk", "http://127.0.0.1/888/p/wxqk/", "xiangyuzhubao.xyz"),
    ]
    for item in checks:
        name, url = item[0], item[1]
        host = item[2] if len(item) > 2 else None
        hdr = f"-H 'Host: {host}' " if host else ""
        run(f"curl -sS -o /dev/null -w '{name} %{{http_code}}\\n' {hdr}{url}")

    # 确认屏幕墙 /p/wxqk 已打到新服（登录应成功）
    run(
        "curl -sS -X POST 'http://127.0.0.1:888/p/wxqk/api/login' "
        "-H 'Content-Type: application/json' "
        "-d '{\"password\":\"ff472336362\"}' | head -c 180; echo"
    )
    run(
        "curl -sS -X POST 'http://127.0.0.1/888/p/wxqk/api/login' "
        "-H 'Host: xiangyuzhubao.xyz' -H 'Content-Type: application/json' "
        "-d '{\"password\":\"ff472336362\"}' | head -c 180; echo"
    )

    client.close()
    print(f"done → http://{HOST}:888/  and  https://xiangyuzhubao.xyz/888/")


if __name__ == "__main__":
    main()
