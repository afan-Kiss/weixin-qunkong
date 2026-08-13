/* WXQK_AUTOCONNECT_V1_BEGIN */
/* MeshCentral 1.2.4 only. Official viewmode opens the panel; it does NOT connect.
   Activate when:
     - #wxqkauto=desktop|files or ?wxqkauto=... is present, OR
     - page is framed (WXQK iframe) and server-baked viewmode is 11/13
   Normal top-level MeshCentral admin is not auto-connected.

   Also: WXQK parent postMessage {source:'wxqk', kind:'desktop-input', enabled:bool}
   drives MeshCentral DeskControl (official Input checkbox) for real view-only. */
(function () {
  try {
    if (window.__wxqkAutoConnectInstalled) return;
    window.__wxqkAutoConnectInstalled = true;

    function modeFromText(t) {
      t = String(t || '').toLowerCase();
      if (t === 'desktop' || t === 'files') return t;
      return '';
    }
    var mode = '';
    try {
      var qm = String(window.location.search || '').match(/[?&]wxqkauto=(desktop|files)\b/i);
      if (qm) mode = modeFromText(qm[1]);
    } catch (eQ) { /* ignore */ }
    try {
      var hm = String(window.location.hash || '').match(/[#&]?wxqkauto=(desktop|files)\b/i);
      if (!mode && hm) mode = modeFromText(hm[1]);
    } catch (eH) { /* ignore */ }

    // Handlebars substitutes {{viewmode}} at render time (survives login URL cleanup).
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
      } catch (eH2) { /* ignore */ }
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
    // WXQK product default: view-only until parent enables input
    var wantInput = false;

    function postState(kind, state, detail) {
      try {
        if (!window.parent || window.parent === window) return;
        var origin = '*';
        try {
          if (document.referrer) origin = new URL(document.referrer).origin;
        } catch (e1) { /* keep * */ }
        window.parent.postMessage(
          { source: 'wxqk', kind: kind, state: state, detail: detail || '' },
          origin
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
        '/* Hide MeshCentral desktop chrome; WXQK supplies product toolbar */',
        '#DeskControlSpan,#DeskControl,#deskkeys,#DeskTools,#DeskRefreshButton,',
        '#DeskRecordButton,#DeskRecordButtonImage,#DeskClipButton,#DeskSaveButton,',
        '#p11progress,#deskProgress{display:none!important}',
        '#deskarea3x{height:100vh!important;max-height:100vh!important}',
        'body.fullscreen #deskarea3x,html.fullscreen #deskarea3x{height:100vh!important}'
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
        // Official helper updates store + color from checkbox
        try {
          if (typeof toggleKvmControl === 'function') toggleKvmControl();
        } catch (eT) { /* ignore */ }
        // toggleKvmControl may re-read checkbox — ensure still desired
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

    // Parent → iframe input gate
    window.addEventListener('message', function (ev) {
      try {
        var d = ev && ev.data;
        if (!d || d.source !== 'wxqk') return;
        var k = String(d.kind || d.type || '');
        if (k !== 'desktop-input') return;
        if (mode !== 'desktop') return;
        var ok = setWxqkDeskInput(!!d.enabled);
        postState('desktop-input', d.enabled ? 'on' : 'off', ok ? 'ok' : 'pending');
      } catch (eM) { /* ignore */ }
    });

    injectWxqkChromeCss();
    // Prefer view-only before Mesh restores DeskControl=1 from local store
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
          // Keep enforcing briefly — updateDesktopButtons may reset from store
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
          // Ensure view-only before first connectDesktop so Input starts unchecked
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
