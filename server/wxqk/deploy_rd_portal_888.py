#!/usr/bin/env python3
"""Screen-wall portal at :888 and https://xiangyuzhubao.xyz/888/."""
from __future__ import annotations

import os
import time

import paramiko

HOST = os.environ.get("WXQK_SSH_HOST", "47.108.21.50")
USER = os.environ.get("WXQK_SSH_USER", "root")
PASSWORD = os.environ.get("WXQK_SSH_PASSWORD") or "FFff472336362@@"

REMOTE_DIR = "/opt/rd-portal"
NGINX_SITE = "/etc/nginx/sites-enabled/rd-portal-888.conf"
BUSINESS_SNIPPET = "/etc/nginx/snippets/xiangyuzhubao-business.conf"

# Single-file SPA: login → live thumbnail wall across wxqk / 九游 / 开云.
PORTAL_HTML = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
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
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text);
      font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; overflow: hidden; }
    .hidden { display: none !important; }
    #loginView {
      min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
      background: radial-gradient(900px 480px at 15% 0%, #1e3a5f55, transparent 60%), var(--bg);
    }
    .login-card {
      width: min(380px, 100%); background: var(--panel); border: 1px solid var(--border);
      border-radius: 14px; padding: 28px 24px;
    }
    .login-card h1 { margin: 0 0 6px; font-size: 22px; }
    .login-card p { margin: 0 0 18px; color: var(--muted); font-size: 13px; }
    .login-card input {
      width: 100%; padding: 11px 12px; border-radius: 8px; border: 1px solid var(--border);
      background: #0b1220; color: var(--text); font-size: 15px; outline: none;
    }
    .login-card input:focus { border-color: var(--accent); }
    .login-card button {
      margin-top: 12px; width: 100%; padding: 11px 12px; border: 0; border-radius: 8px;
      background: var(--accent); color: #fff; font-size: 15px; font-weight: 600; cursor: pointer;
    }
    .login-card button:disabled { opacity: .6; cursor: wait; }
    #loginErr { color: var(--bad); font-size: 13px; min-height: 18px; margin-top: 10px; }
    #wallView {
      height: 100vh; max-height: 100dvh; display: flex; flex-direction: column; overflow: hidden;
    }
    .topbar {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
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
      border-radius: 8px; padding: 6px 10px; cursor: pointer; font-size: 12px;
    }
    .btn-ghost:hover { color: var(--text); border-color: #3b4f6e; }
    .layout-group {
      display: inline-flex; align-items: center; gap: 0; border: 1px solid var(--border);
      border-radius: 9px; overflow: hidden; background: #0b1220;
    }
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
      flex: 1 1 auto; min-height: 0; padding: 8px; display: flex;
    }
    #wall {
      flex: 1; min-height: 0; width: 100%;
      display: grid;
      gap: 8px;
      align-content: stretch;
      justify-content: stretch;
    }
    #wall.mode-auto {
      grid-auto-rows: 1fr;
    }
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
    .tile.dragging-src {
      opacity: .28; cursor: grabbing;
      border-style: dashed; border-color: #60a5fa;
    }
    .tile.drag-over {
      outline: 2px dashed #60a5fa; outline-offset: -3px;
    }
    .tile img, .tile .ph { -webkit-user-drag: none; pointer-events: none; }
    #dragGhost {
      position: fixed; left: 0; top: 0; z-index: 80; pointer-events: none; margin: 0;
      box-shadow: 0 16px 36px rgba(0,0,0,.55); border: 1px solid #60a5fa;
      border-radius: 10px; overflow: hidden; opacity: .96;
      cursor: grabbing;
      /* Must win over .tile { transition: transform } or the ghost lags / drifts. */
      transition: none !important;
      will-change: transform;
    }
    #dragGhost .pick, #dragGhost .live { display: none !important; }
    .tile .screen {
      position: relative; flex: 1 1 auto; min-height: 0; background: #000; overflow: hidden;
    }
    .tile img, .tile .ph {
      width: 100%; height: 100%; object-fit: contain; background: #000; display: block;
    }
    .tile .ph {
      display: flex; align-items: center; justify-content: center; color: #64748b; font-size: 12px;
    }
    .tile .badge {
      position: absolute; top: 6px; left: 6px; font-size: 10px; padding: 2px 7px;
      border-radius: 999px; background: rgba(0,0,0,.62); color: #dbeafe; border: 1px solid #334155;
      backdrop-filter: blur(4px);
    }
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
    .tile.off .screen { opacity: .55; }
    .tile.off .live { display: none; }
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
      display: flex; flex-direction: column; padding: 12px;
    }
    #overlay .obar {
      display: flex; gap: 10px; align-items: center; margin-bottom: 10px; flex-wrap: wrap;
    }
    #overlay .obar .title { font-size: 14px; font-weight: 650; }
    #overlay .stage {
      flex: 1; background: #000; border-radius: 10px; overflow: hidden;
      display: flex; align-items: center; justify-content: center; border: 1px solid var(--border);
    }
    #overlay img { max-width: 100%; max-height: 100%; object-fit: contain; cursor: zoom-out; }
    #overlay .stage { cursor: zoom-out; }
  </style>
</head>
<body>
  <div id="loginView">
    <form class="login-card" id="loginForm">
      <h1>屏幕墙</h1>
      <p>登录后进入屏幕墙；右上角打勾才显示画面并推流，不勾不传图</p>
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
      <span class="pill">画面 <b id="frameCount">0</b></span>
      <div class="layout-group" id="layoutGroup" title="选择排数">
        <span class="lab">排版</span>
        <button type="button" class="layout-btn" data-rows="auto">自动</button>
        <button type="button" class="layout-btn" data-rows="1">单排</button>
        <button type="button" class="layout-btn" data-rows="2">双排</button>
        <button type="button" class="layout-btn" data-rows="3">三排</button>
        <button type="button" class="layout-btn" data-rows="4">四排</button>
        <button type="button" class="layout-btn" data-rows="5">五排</button>
        <button type="button" class="layout-btn" data-rows="6">六排</button>
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
    <div class="stage"><img id="ovImg" alt="desktop" /></div>
  </div>

<script>
(function () {
  const BASE = (function () {
    const p = location.pathname || '/';
    if (p === '/888' || p.startsWith('/888/')) return '/888';
    return '';
  })();

  const SOURCES = [
    { id: 'wxqk', name: 'wxqk', prefix: BASE + '/p/wxqk', deskPath: '/wxqk/#/desktop' },
    { id: 'jiuyou', name: '九游', prefix: BASE + '/p/jiuyou', deskPath: '/%E4%B9%9D%E6%B8%B8/#/desktop' },
    { id: 'kaiyun', name: '开云', prefix: BASE + '/p/kaiyun', deskPath: '/%E5%8F%91%E8%B4%A2888/#/desktop' },
  ];

  const TOK_KEY = 'rdwall.tokens.v1';
  const LAYOUT_KEY = 'rdwall.layout.rows.v1';
  const SELECT_KEY = 'rdwall.selected.v1';
  const ORDER_KEY = 'rdwall.order.v1';
  const STALE_SEC = 12;          // frame older than this → force re-start capture
  const START_COOLDOWN_MS = 15000; // avoid kick storms
  const TOKEN_REFRESH_EVERY_MS = 30 * 60 * 1000; // hard refresh all tokens every 30m
  const TOKEN_SOFT_REMAIN_SEC = 6 * 3600;        // proactive /api/refresh when < 6h left
  const state = {
    tokens: loadTokens(),
    clients: new Map(), // key -> client
    startedAt: new Map(), // key -> ms of last start/force attempt
    selected: loadSelected(), // Set of client keys actively streamed
    order: loadOrder(), // preferred tile key order
    overviewTimer: null,
    frameTimer: null,
    tokenTimer: null,
    focusKey: '',
    loginWarn: '',
    overviewGen: 0,
    overviewInFlight: false,
    framesInFlight: false,
    tokenInFlight: false,
    layoutRows: loadLayoutRows(), // 'auto' | 1..6
    leaving: false,
    dragging: false,
    lastTokenRefreshAt: 0,
  };

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
      if (Number.isFinite(n) && n >= 1 && n <= 6) return n;
    } catch (_) {}
    return 'auto';
  }
  function saveLayoutRows() {
    try { localStorage.setItem(LAYOUT_KEY, String(state.layoutRows)); } catch (_) {}
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
    state.order = next;
    saveOrder();
    return next;
  }
  function applyOrderDom() {
    if (state.dragging) return; // never fight an in-progress drag
    const wall = document.getElementById('wall');
    if (!wall) return;
    const tiles = [...wall.querySelectorAll('.tile')];
    if (!tiles.length) return;
    const alive = tiles.map(t => t.dataset.key).filter(Boolean);
    const ordered = syncOrderWithAlive(alive);
    ordered.forEach((key) => {
      const el = wall.querySelector('[data-key="' + key.replace(/"/g, '') + '"]');
      if (el) wall.appendChild(el);
    });
  }
  function readDomOrder() {
    return [...document.querySelectorAll('#wall .tile')].map(t => t.dataset.key).filter(Boolean);
  }
  function bindTileDrag(el, key) {
    if (el.dataset.dragBound === '1') return;
    el.dataset.dragBound = '1';
    let startX = 0, startY = 0, active = false, moved = false, pointerId = null;
    let ghost = null, offsetX = 0, offsetY = 0, srcW = 0, srcH = 0;

    function clearDragOver() {
      document.querySelectorAll('#wall .tile.drag-over').forEach(n => n.classList.remove('drag-over'));
    }
    function removeGhost() {
      if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
      ghost = null;
      // Sweep any leaked ghost from a prior interrupted drag.
      const leaked = document.getElementById('dragGhost');
      if (leaked && leaked.parentNode) leaked.parentNode.removeChild(leaked);
    }
    function setGhostPos(ev) {
      if (!ghost) return;
      const x = Math.round(ev.clientX - offsetX);
      const y = Math.round(ev.clientY - offsetY);
      ghost.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
    }
    function hitTileAt(clientX, clientY) {
      // Source placeholder + ghost must not steal the drop target under the cursor.
      const prevPe = el.style.pointerEvents;
      el.style.pointerEvents = 'none';
      let prevVis = '';
      if (ghost) {
        prevVis = ghost.style.visibility;
        ghost.style.visibility = 'hidden';
      }
      let under = null;
      try { under = document.elementFromPoint(clientX, clientY); } catch (_) { under = null; }
      el.style.pointerEvents = prevPe;
      if (ghost) ghost.style.visibility = prevVis;
      return under && under.closest ? under.closest('#wall .tile') : null;
    }
    function placeRelative(target, clientX, clientY) {
      const wall = document.getElementById('wall');
      if (!wall || !target || target === el) return false;
      const rect = target.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      const midY = rect.top + rect.height / 2;
      const insertAfter = (Math.abs(clientY - midY) > Math.abs(clientX - midX))
        ? (clientY > midY)
        : (clientX > midX);
      if (insertAfter) wall.insertBefore(el, target.nextSibling);
      else wall.insertBefore(el, target);
      return true;
    }
    function dropAtPoint(clientX, clientY) {
      const wall = document.getElementById('wall');
      if (!wall) return;
      const target = hitTileAt(clientX, clientY);
      if (target && target !== el) {
        placeRelative(target, clientX, clientY);
        return;
      }
      // Empty grid gap / gutters: land beside the nearest tile by center distance.
      const others = [...wall.querySelectorAll('.tile')].filter(t => t !== el);
      if (!others.length) return;
      let best = null, bestDist = Infinity;
      for (const t of others) {
        const r = t.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const d = (clientX - cx) * (clientX - cx) + (clientY - cy) * (clientY - cy);
        if (d < bestDist) { bestDist = d; best = t; }
      }
      if (best) placeRelative(best, clientX, clientY);
    }
    function placeGhost(ev) {
      if (!(srcW > 0 && srcH > 0)) {
        const rect = el.getBoundingClientRect();
        srcW = Math.max(120, rect.width);
        srcH = Math.max(80, rect.height);
        offsetX = ev.clientX - rect.left;
        offsetY = ev.clientY - rect.top;
      }
      removeGhost();
      ghost = el.cloneNode(true);
      ghost.id = 'dragGhost';
      ghost.classList.remove('dragging-src', 'drag-over');
      ghost.removeAttribute('data-drag-bound');
      ghost.style.width = srcW + 'px';
      ghost.style.height = srcH + 'px';
      ghost.style.left = '0';
      ghost.style.top = '0';
      const srcImg = el.querySelector('img');
      const gImg = ghost.querySelector('img');
      if (srcImg && gImg && srcImg.getAttribute('src')) {
        gImg.src = srcImg.getAttribute('src');
        gImg.classList.remove('hidden');
        const gPh = ghost.querySelector('.ph');
        if (gPh) gPh.classList.add('hidden');
      }
      document.body.appendChild(ghost);
      setGhostPos(ev);
      el.classList.add('dragging-src');
    }
    function reorderUnderPointer(ev) {
      const target = hitTileAt(ev.clientX, ev.clientY);
      clearDragOver();
      if (!target || target === el) return;
      target.classList.add('drag-over');
      placeRelative(target, ev.clientX, ev.clientY);
    }
    function unbindPointer() {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      el.removeEventListener('lostpointercapture', onUp);
    }
    function onMove(ev) {
      if (!active || ev.pointerId !== pointerId) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && (dx * dx + dy * dy) > 25) {
        moved = true;
        state.dragging = true;
        placeGhost(ev);
      }
      if (!moved) return;
      ev.preventDefault();
      setGhostPos(ev);
      reorderUnderPointer(ev);
    }
    function onUp(ev) {
      if (!active) return;
      if (ev && pointerId != null && ev.pointerId != null && ev.pointerId !== pointerId) return;
      active = false;
      const pid = pointerId;
      const wasDrag = moved;
      const dropX = ev && Number.isFinite(ev.clientX) ? ev.clientX : startX;
      const dropY = ev && Number.isFinite(ev.clientY) ? ev.clientY : startY;
      unbindPointer();
      try { if (pid != null) el.releasePointerCapture(pid); } catch (_) {}
      if (wasDrag) {
        dropAtPoint(dropX, dropY);
      }
      clearDragOver();
      removeGhost();
      el.classList.remove('dragging-src');
      state.dragging = false;
      moved = false;
      pointerId = null;
      srcW = 0; srcH = 0; offsetX = 0; offsetY = 0;
      if (wasDrag) {
        state.order = readDomOrder();
        saveOrder();
        applyLayout();
        return;
      }
      if (isSelected(key)) openOverlay(key);
    }
    el.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      if (ev.target && ev.target.closest && ev.target.closest('.pick')) return;
      if (state.dragging) return;
      active = true;
      moved = false;
      pointerId = ev.pointerId;
      startX = ev.clientX;
      startY = ev.clientY;
      const rect = el.getBoundingClientRect();
      srcW = Math.max(120, rect.width);
      srcH = Math.max(80, rect.height);
      offsetX = ev.clientX - rect.left;
      offsetY = ev.clientY - rect.top;
      unbindPointer();
      try { el.setPointerCapture(pointerId); } catch (_) {}
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
      // Safety: some browsers drop element-level up after capture quirks.
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
      el.addEventListener('lostpointercapture', onUp);
    });
  }
  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  }
  function srcOf(id) { return SOURCES.find(s => s.id === id); }

  function tileCount() {
    return document.querySelectorAll('#wall .tile').length;
  }

  function bestAutoRows(n, wallW, wallH) {
    if (n <= 0) return { rows: 1, cols: 1 };
    let best = { rows: 1, cols: n, score: -1 };
    const maxRows = Math.min(n, 6);
    for (let rows = 1; rows <= maxRows; rows++) {
      const cols = Math.ceil(n / rows);
      const cellW = wallW / cols;
      const cellH = wallH / rows;
      const fitW = Math.min(cellW, cellH * 1.6);
      const fitH = fitW / 1.6;
      const area = fitW * fitH;
      const aspectPenalty = Math.abs((cellW / Math.max(cellH, 1)) - 1.6);
      const score = area - aspectPenalty * 40;
      if (score > best.score) best = { rows, cols, score };
    }
    return best;
  }

  function applyLayout() {
    const wall = document.getElementById('wall');
    const wrap = document.getElementById('wallWrap');
    if (!wall || !wrap) return;
    const count = tileCount();
    const rect = wrap.getBoundingClientRect();
    const w = Math.max(rect.width - 4, 120);
    const h = Math.max(rect.height - 4, 120);

    let rows;
    let cols;
    wall.classList.remove('mode-auto');
    if (state.layoutRows === 'auto') {
      wall.classList.add('mode-auto');
      const best = bestAutoRows(Math.max(count, 1), w, h);
      rows = best.rows;
      cols = best.cols;
    } else {
      rows = Math.max(1, Math.min(6, Number(state.layoutRows) || 1));
      rows = Math.min(rows, Math.max(count, 1));
      cols = Math.max(1, Math.ceil(Math.max(count, 1) / rows));
    }

    wall.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
    wall.style.gridTemplateRows = 'repeat(' + rows + ', minmax(0, 1fr))';
    wall.style.gap = (cols * rows >= 12 ? '6px' : '8px');

    document.querySelectorAll('#layoutGroup .layout-btn').forEach(btn => {
      const v = btn.getAttribute('data-rows');
      const active = (state.layoutRows === 'auto' && v === 'auto') || String(state.layoutRows) === v;
      btn.classList.toggle('active', active);
    });
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
    const el0 = document.querySelector('[data-key="' + key.replace(/"/g, '') + '"]');
    if (el0) return el0;
    let el;
    el = document.createElement('div');
    el.className = 'tile';
    el.dataset.key = key;
    el.innerHTML =
      '<div class="screen">' +
        '<div class="ph">未勾选 · 不推流</div>' +
        '<img class="hidden" alt=""/>' +
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
        void startDesktop(srcOf(client.sourceId), client.clientId, { force: false });
      } else {
        client.image = '';
        stopDesktop(srcOf(client.sourceId), client.clientId);
        state.startedAt.delete(key);
      }
      patchTile(client);
      updateSelectedCount();
    });
    bindTileDrag(el, key);
    document.getElementById('wall').appendChild(el);
    if (!state.order.includes(key)) {
      state.order.push(key);
      saveOrder();
    }
    applyOrderDom();
    applyLayout();
    return el;
  }

  function updateSelectedCount() {
    const n = [...state.clients.keys()].filter((k) => isSelected(k)).length;
    const el = document.getElementById('selectedCount');
    if (el) el.textContent = String(n);
  }

  function patchTile(c) {
    const key = c.key;
    const el = ensureTile(key, c);
    const on = isSelected(key);
    el.classList.toggle('off', !on);
    const pick = el.querySelector('.pick');
    if (pick && pick.checked !== on) pick.checked = on;
    el.querySelector('.name').textContent = c.account || '账号未上报';
    el.querySelector('.sub').textContent = c.clientId + (c.ip ? ' · ' + c.ip : '');
    const img = el.querySelector('img');
    const ph = el.querySelector('.ph');
    const live = el.querySelector('.live');
    if (!on) {
      img.classList.add('hidden');
      img.removeAttribute('src');
      img.dataset.stamp = '';
      ph.classList.remove('hidden');
      ph.textContent = '未勾选 · 不推流';
      return;
    }
    if (c.image) {
      const stamp = String(c.ts || c.t || '');
      if (img.dataset.stamp !== stamp) {
        img.dataset.stamp = stamp;
        img.src = c.image;
      }
      img.classList.remove('hidden');
      ph.classList.add('hidden');
      const age = c.ageSec != null ? Number(c.ageSec) : NaN;
      const fresh = Number.isFinite(age) ? age <= STALE_SEC : (Date.now() - (c.frameAt || 0) < STALE_SEC * 1000);
      live.textContent = fresh ? '实时' : ('缓存' + (Number.isFinite(age) ? age + 's' : ''));
      live.classList.toggle('stale', !fresh);
    } else {
      img.classList.add('hidden');
      ph.classList.remove('hidden');
      ph.textContent = c.online ? '等待画面…' : '离线';
      live.textContent = c.online ? '启动中' : '离线';
      live.classList.add('stale');
    }
  }

  function pruneTiles(alive) {
    document.querySelectorAll('#wall .tile').forEach(el => {
      if (!alive.has(el.dataset.key)) el.remove();
    });
    syncOrderWithAlive([...alive]);
    applyOrderDom();
    applyLayout();
  }

  function needsCapture(c) {
    if (!c || !c.online) return false;
    if (!c.image) return true;
    const age = Number(c.ageSec);
    if (!Number.isFinite(age)) return true;
    return age > STALE_SEC;
  }

  async function startDesktop(src, clientId, opts) {
    opts = opts || {};
    if (!src || !clientId) return;
    const key = clientKey(src.id, clientId);
    if (!isSelected(key)) return;
    const now = Date.now();
    const last = Number(state.startedAt.get(key) || 0);
    if (!opts.force && last && (now - last) < START_COOLDOWN_MS) return;
    if (opts.force && last && (now - last) < START_COOLDOWN_MS) return;
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
      // allow retry on next pass
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
            const prev = state.clients.get(key) || {};
            const c = Object.assign({}, prev, {
              key, sourceId: src.id, sourceName: src.name, deskPath: src.deskPath,
              clientId: cid,
              account: String(r.account || '').trim() || '账号未上报',
              ip: r.ip || '',
              online: true,
              desktopWatching: !!r.desktopWatching,
            });
            state.clients.set(key, c);
            patchTile(c);
            // Only selected tiles stream. Never trust desktopWatching alone.
            if (isSelected(key)) {
              void startDesktop(src, cid, { force: needsCapture(c) && !!c.image });
            } else if (r.desktopWatching) {
              // Keep unselected idle — stop leftover streams from previous sessions.
              stopDesktop(src, cid);
              state.startedAt.delete(key);
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
      if (gen !== state.overviewGen) return;

      // Only drop clients belonging to sources that answered successfully this tick.
      for (const key of [...state.clients.keys()]) {
        const c = state.clients.get(key);
        if (!c) continue;
        if (!confirmedSources.has(c.sourceId)) continue;
        if (!alive.has(key)) {
          state.clients.delete(key);
          state.startedAt.delete(key);
        }
      }
      // Rebuild alive for prune = all remaining clients
      const keep = new Set(state.clients.keys());
      pruneTiles(keep);

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

      document.getElementById('onlineCount').textContent = String(keep.size);
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
      applyOrderDom();
      applyLayout();
    } finally {
      state.overviewInFlight = false;
    }
  }

  async function refreshFrames() {
    // Skip UI frame pulls while hidden (browser may throttle); capture keeps running.
    if (document.hidden || state.leaving || state.framesInFlight) return;
    const authed = SOURCES.filter(s => state.tokens[s.id]);
    if (!authed.length) return;
    state.framesInFlight = true;
    let framed = 0;
    try {
      const jobs = [];
      for (const c of state.clients.values()) {
        const src = srcOf(c.sourceId);
        if (!src || !state.tokens[src.id]) continue;
        if (!isSelected(c.key)) {
          // Unselected: never poll/start; keep placeholder.
          if (c.image) { c.image = ''; patchTile(c); }
          continue;
        }
        jobs.push((async () => {
          try {
            const data = await api(src, '/api/desktop/latest?clientId=' + encodeURIComponent(c.clientId));
            if (data && data.image) {
              c.image = data.image;
              c.ageSec = data.ageSec;
              c.ts = data.ts;
              c.t = data.t;
              c.frameAt = Date.now();
              c.desktopWatching = data.desktopWatching != null ? !!data.desktopWatching : c.desktopWatching;
              framed += 1;
              patchTile(c);
              if (state.focusKey === c.key) {
                const ov = document.getElementById('ovImg');
                if (ov && ov.dataset.stamp !== String(c.ts || c.t || '')) {
                  ov.dataset.stamp = String(c.ts || c.t || '');
                  ov.src = data.image;
                }
              }
              if (needsCapture(c)) void startDesktop(src, c.clientId, { force: true });
            } else {
              patchTile(c);
              void startDesktop(src, c.clientId, { force: false });
            }
          } catch (_) {}
        })());
      }
      await Promise.all(jobs);
      document.getElementById('frameCount').textContent = String(framed);
      updateSelectedCount();
    } finally {
      state.framesInFlight = false;
    }
  }

  function openOverlay(key) {
    const c = state.clients.get(key);
    if (!c) return;
    state.focusKey = key;
    document.getElementById('overlay').classList.remove('hidden');
    document.getElementById('ovTitle').textContent = c.sourceName + ' · ' + (c.account || c.clientId);
    const ov = document.getElementById('ovImg');
    ov.dataset.stamp = String(c.ts || c.t || '');
    ov.src = c.image || '';
    const a = document.getElementById('ovOpen');
    a.href = 'https://xiangyuzhubao.xyz' + c.deskPath;
  }
  function closeOverlay() {
    state.focusKey = '';
    document.getElementById('overlay').classList.add('hidden');
  }

  function showLogin() {
    stopLoops();
    document.getElementById('loginView').classList.remove('hidden');
    document.getElementById('wallView').classList.add('hidden');
    closeOverlay();
  }
  function showWall() {
    document.getElementById('loginView').classList.add('hidden');
    document.getElementById('wallView').classList.remove('hidden');
    applyLayout();
    startLoops();
  }
  function stopLoops() {
    if (state.overviewTimer) { clearInterval(state.overviewTimer); state.overviewTimer = null; }
    if (state.frameTimer) { clearInterval(state.frameTimer); state.frameTimer = null; }
    if (state.tokenTimer) { clearInterval(state.tokenTimer); state.tokenTimer = null; }
  }
  function startLoops() {
    stopLoops();
    void refreshTokens({ force: true }).then(() => refreshOverview()).then(() => refreshFrames());
    state.overviewTimer = setInterval(() => { void refreshOverview(); }, 5000);
    state.frameTimer = setInterval(() => { void refreshFrames(); }, 1500);
    // Independent of overview so a stuck overview cannot block token renew.
    state.tokenTimer = setInterval(() => { void refreshTokens({ force: true }); }, TOKEN_REFRESH_EVERY_MS);
  }

  /** Wall uses HTTP start/latest, not viewer WS — must explicitly stop or agents keep uploading. */
  function stopAllDesktops(opts) {
    opts = opts || {};
    const keepalive = !!opts.keepalive;
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
  document.getElementById('layoutGroup').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.layout-btn');
    if (!btn) return;
    const v = btn.getAttribute('data-rows');
    state.layoutRows = v === 'auto' ? 'auto' : Number(v);
    saveLayoutRows();
    applyLayout();
  });
  window.addEventListener('resize', () => { applyLayout(); });

  document.getElementById('logoutBtn').addEventListener('click', () => {
    state.leaving = true;
    stopAllDesktops({ keepalive: true });
    stopLoops();
    state.tokens = {};
    state.clients.clear();
    state.startedAt.clear();
    state.loginWarn = '';
    state.leaving = false;
    saveTokens();
    document.getElementById('wall').innerHTML = '<div id="empty">加载中…</div>';
    showLogin();
  });
  document.getElementById('ovClose').addEventListener('click', closeOverlay);
  document.getElementById('overlay').addEventListener('click', (ev) => {
    const t = ev.target;
    // Click enlarged picture / dark backdrop to shrink back; keep top-bar links usable.
    if (t && t.closest && t.closest('.obar')) return;
    if (t.id === 'overlay' || t.id === 'ovImg' || (t.classList && t.classList.contains('stage'))) {
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
      state.startedAt.clear();
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
        proxy_request_buffering on;
        proxy_buffering on;
        add_header Cache-Control "no-store";
"""

def _proxy_block(location: str, upstream: str) -> str:
    return f"""    location ^~ {location} {{
        proxy_pass {upstream};
{PROXY_COMMON}    }}
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

{_proxy_block('/p/wxqk/', 'http://127.0.0.1:4812/')}
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
    proxy_pass http://127.0.0.1:4812/;
{PROXY_COMMON}}}
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
a = text.find(start)
if a >= 0:
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

    client.close()
    print(f"done → http://{HOST}:888/  and  https://xiangyuzhubao.xyz/888/")


if __name__ == "__main__":
    main()
