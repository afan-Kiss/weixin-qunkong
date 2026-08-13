/* WXQK_AUTOCONNECT_V1_BEGIN */
/* MeshCentral 1.2.4 only. Official viewmode opens the panel; it does NOT connect.
   Activate when:
     - #wxqkauto=desktop|files or ?wxqkauto=... is present, OR
     - page is framed (WXQK iframe) and server-baked viewmode is 11/13
   Normal top-level MeshCentral admin is not auto-connected.

   Security: parent postMessage {source:'wxqk', kind:'desktop-input', enabled:bool}
   is accepted ONLY when:
     - ev.source === window.parent
     - ev.origin exactly matches EXPECTED_WXQK_ORIGIN (from #wxqkpo=) OR
       is listed in WXQK_PARENT_ORIGINS (exact scheme+host+port)
   Never use '*' targetOrigin for inbound trust decisions. */
(function () {
  try {
    if (window.__wxqkAutoConnectInstalled) return;
    window.__wxqkAutoConnectInstalled = true;

    // Injected by wxqk_patch.py from domains."".allowedFramingOrigins (JSON array).
    var WXQK_PARENT_ORIGINS = __WXQK_PARENT_ORIGINS__;

    function modeFromText(t) {
      t = String(t || '').toLowerCase();
      if (t === 'desktop' || t === 'files') return t;
      return '';
    }
    function readHashParam(name) {
      try {
        var h = String(window.location.hash || '').replace(/^#/, '');
        var parts = h.split(/[&]/);
        for (var i = 0; i < parts.length; i++) {
          var kv = parts[i].split('=');
          if (decodeURIComponent(kv[0] || '') === name) {
            return decodeURIComponent((kv.slice(1).join('=')) || '');
          }
        }
      } catch (eH) { /* ignore */ }
      return '';
    }
    function originExactInAllowlist(origin) {
      var o = String(origin || '');
      if (!o) return false;
      if (!Array.isArray(WXQK_PARENT_ORIGINS)) return false;
      for (var i = 0; i < WXQK_PARENT_ORIGINS.length; i++) {
        if (String(WXQK_PARENT_ORIGINS[i]) === o) return true;
      }
      return false;
    }
    function resolveExpectedParentOrigin() {
      var fromHash = readHashParam('wxqkpo');
      if (fromHash) {
        try {
          var u = new URL(fromHash);
          // Only http(s) absolute origins — exact URL.origin
          if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
          return u.origin;
        } catch (e1) {
          return '';
        }
      }
      try {
        if (document.referrer) {
          var r = new URL(document.referrer).origin;
          if (originExactInAllowlist(r)) return r;
        }
      } catch (e2) { /* ignore */ }
      return '';
    }
    var EXPECTED_WXQK_ORIGIN = resolveExpectedParentOrigin();

    var mode = '';
    try {
      var qm = String(window.location.search || '').match(/[?&]wxqkauto=(desktop|files)\b/i);
      if (qm) mode = modeFromText(qm[1]);
    } catch (eQ) { /* ignore */ }
    try {
      var hm = String(window.location.hash || '').match(/(?:^|[?#&])wxqkauto=(desktop|files)\b/i);
      if (!mode && hm) mode = modeFromText(hm[1]);
    } catch (eH2) { /* ignore */ }

    var bakedView = parseInt('{{viewmode}}', 10);
    var inFrame = false;
    try { inFrame = !!(window.parent && window.parent !== window); } catch (eF) { inFrame = true; }
    function hideMask() {
      try {
        if (typeof urlargs !== 'undefined' && urlargs && urlargs.hide != null) return parseInt(urlargs.hide, 10);
      } catch (eU) { /* ignore */ }
      try {
        var hm2 = String(window.location.search || '').match(/[?&]hide=(\d+)\b/);
        if (hm2) return parseInt(hm2[1], 10);
      } catch (eH3) { /* ignore */ }
      return NaN;
    }
    if (!mode && (bakedView === 11 || bakedView === 13) && (inFrame || hideMask() === 63)) {
      mode = bakedView === 11 ? 'desktop' : 'files';
    }
    if (mode !== 'desktop' && mode !== 'files') return;

    var wantView = mode === 'desktop' ? 11 : 13;
    var maxAttempts = 90;
    var attempt = 0;
    var connectTries = 0;
    var maxConnectTries = 3;
    var nextConnectAt = 0;
    var finished = false;
    var wantInput = false;

    function isTrustedParentMessage(ev) {
      if (!ev) return false;
      try {
        if (ev.source !== window.parent) return false;
      } catch (eS) {
        return false;
      }
      var origin = String(ev.origin || '');
      if (!origin) return false;
      if (EXPECTED_WXQK_ORIGIN && origin === EXPECTED_WXQK_ORIGIN) return true;
      if (originExactInAllowlist(origin)) return true;
      return false;
    }

    function postState(kind, state, detail) {
      try {
        if (!window.parent || window.parent === window) return;
        var target = EXPECTED_WXQK_ORIGIN || '';
        if (!target) {
          try {
            if (document.referrer) {
              var r = new URL(document.referrer).origin;
              if (originExactInAllowlist(r)) target = r;
            }
          } catch (eR) { /* ignore */ }
        }
        // Fail closed: never postMessage to '*'
        if (!target) return;
        window.parent.postMessage(
          { source: 'wxqk', kind: kind, state: state, detail: detail || '' },
          target
        );
      } catch (e2) { /* ignore */ }
    }

    function statusText(id) {
      try {
        var el = document.getElementById(id);
        return el ? String(el.textContent || el.innerText || '') : '';
      } catch (e3) {
        return '';
      }
    }

    function isConnected() {
      var t = mode === 'desktop' ? statusText('deskstatus') : statusText('p13Status');
      if (/已断开|Disconnected/i.test(t)) return false;
      return /(^|\s)Connected/i.test(t) || /Connected,/i.test(t) || /已连接/.test(t);
    }

    function isConnecting() {
      var t = mode === 'desktop' ? statusText('deskstatus') : statusText('p13Status');
      return /Connecting|Setup/i.test(t) || /正在连接|正在设置|准备/.test(t);
    }

    function injectWxqkChromeCss() {
      if (document.getElementById('wxqk-embed-chrome')) return;
      var s = document.createElement('style');
      s.id = 'wxqk-embed-chrome';
      s.textContent = [
        '#DeskControlSpan,#DeskControl,#deskkeys,#DeskTools,#DeskRefreshButton,',
        '#DeskRecordButton,#DeskRecordButtonImage,#DeskClipButton,#DeskSaveButton,',
        '#p11progress,#deskProgress{display:none!important}',
        '#deskarea3x{height:100vh!important;max-height:100vh!important}'
      ].join('');
      (document.head || document.documentElement).appendChild(s);
    }

    function setWxqkDeskInput(enabled) {
      wantInput = !!enabled;
      try {
        if (typeof Q !== 'function') return false;
        var el = Q('DeskControl');
        if (!el) return false;
        el.checked = !!enabled;
        if (typeof putstore === 'function') putstore('DeskControl', enabled ? 1 : 0);
        try {
          if (typeof QS === 'function' && Q('DeskControlSpan')) {
            QS('DeskControlSpan').color = enabled ? null : 'red';
          }
        } catch (eC) { /* ignore */ }
        try {
          if (typeof toggleKvmControl === 'function') toggleKvmControl();
        } catch (eT) { /* ignore */ }
        el.checked = !!enabled;
        if (typeof putstore === 'function') putstore('DeskControl', enabled ? 1 : 0);
        return true;
      } catch (eS) {
        return false;
      }
    }

    function enforceDefaultViewOnly() {
      if (mode !== 'desktop') return;
      setWxqkDeskInput(wantInput);
    }

    window.addEventListener('message', function (ev) {
      try {
        var d = ev && ev.data;
        if (!d || d.source !== 'wxqk') return;
        var k = String(d.kind || d.type || '');
        if (k !== 'desktop-input') return;
        if (mode !== 'desktop') return;
        // Strict parent + origin gate (ignore evil origins even if source==='wxqk')
        if (!isTrustedParentMessage(ev)) return;
        var ok = setWxqkDeskInput(!!d.enabled);
        postState('desktop-input', d.enabled ? 'on' : 'off', ok ? 'ok' : 'pending');
      } catch (eM) { /* ignore */ }
    });

    injectWxqkChromeCss();
    try {
      if (mode === 'desktop' && typeof putstore === 'function') putstore('DeskControl', 0);
    } catch (eP) { /* ignore */ }

    postState(mode, 'page_loaded', 'baked=' + bakedView);

    var timer = setInterval(function () {
      if (finished) return;
      attempt += 1;
      try {
        injectWxqkChromeCss();
        if (mode === 'desktop') enforceDefaultViewOnly();
        if (isConnected()) {
          finished = true;
          clearInterval(timer);
          enforceDefaultViewOnly();
          var guard = 0;
          var guardTimer = setInterval(function () {
            guard += 1;
            enforceDefaultViewOnly();
            if (guard >= 20) clearInterval(guardTimer);
          }, 500);
          postState(mode, 'connected', '');
          return;
        }
        if (typeof currentNode === 'undefined' || currentNode == null) {
          if (attempt >= maxAttempts) {
            finished = true;
            clearInterval(timer);
            postState(mode, 'failed', 'node_not_ready');
          }
          return;
        }
        if (typeof xxcurrentView === 'undefined' || Number(xxcurrentView) !== wantView) {
          if (attempt >= maxAttempts) {
            finished = true;
            clearInterval(timer);
            postState(mode, 'failed', 'panel_not_ready');
          }
          return;
        }
        if (isConnecting()) {
          postState(mode, 'connecting', '');
          return;
        }
        if (attempt < nextConnectAt) return;
        if (connectTries >= maxConnectTries) {
          finished = true;
          clearInterval(timer);
          postState(mode, 'failed', 'connect_timeout');
          return;
        }
        if (mode === 'desktop') {
          if (typeof connectDesktop !== 'function') return;
          enforceDefaultViewOnly();
          connectTries += 1;
          nextConnectAt = attempt + 10;
          postState(mode, 'connecting', 'connectDesktop');
          if (connectTries <= 2) connectDesktop(null, 3);
          else connectDesktop(null, 1);
        } else {
          if (typeof connectFiles !== 'function') return;
          connectTries += 1;
          nextConnectAt = attempt + 10;
          postState(mode, 'connecting', 'connectFiles');
          connectFiles(null, 1);
        }
      } catch (ex) {
        if (attempt >= maxAttempts) {
          finished = true;
          clearInterval(timer);
          postState(mode, 'failed', 'exception');
        }
      }
      if (!finished && attempt >= maxAttempts) {
        finished = true;
        clearInterval(timer);
        if (!isConnected()) postState(mode, 'failed', 'timeout');
      }
    }, 500);
  } catch (e0) { /* never break MeshCentral UI */ }
})();
/* WXQK_AUTOCONNECT_V1_END */
