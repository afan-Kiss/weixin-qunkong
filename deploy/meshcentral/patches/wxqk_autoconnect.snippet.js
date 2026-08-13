/* WXQK_AUTOCONNECT_V1_BEGIN */
/* MeshCentral 1.2.4 only. Official viewmode opens the panel; it does NOT connect.
   Activate when:
     - #wxqkauto=desktop|files or ?wxqkauto=... is present, OR
     - page is framed (WXQK iframe) and server-baked viewmode is 11/13
   Normal top-level MeshCentral admin is not auto-connected. */
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
    // Note: MeshCentral login redirect strips #hash and unknown query args, so prefer baked viewmode.
    var bakedView = parseInt('{{viewmode}}', 10);
    var inFrame = false;
    try { inFrame = !!(window.parent && window.parent !== window); } catch (eF) { inFrame = true; }
    function hideMask() {
      try {
        if (typeof urlargs !== 'undefined' && urlargs && urlargs.hide != null) return parseInt(urlargs.hide, 10);
      } catch (eU) { /* ignore */ }
      try {
        var hm = String(window.location.search || '').match(/[?&]hide=(\d+)\b/);
        if (hm) return parseInt(hm[1], 10);
      } catch (eH2) { /* ignore */ }
      return NaN;
    }
    // Product embed uses hide=63. Framed WXQK iframe also qualifies.
    // Do NOT auto-connect plain top-level MeshCentral admin (no hide / hide!=63 / not framed).
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
      // MeshCentral en: Connected / zh-chs: 已连接 (exclude Disconnected / 已断开)
      if (/已断开|Disconnected/i.test(t)) return false;
      return /(^|\s)Connected/i.test(t) || /Connected,/i.test(t) || /已连接/.test(t);
    }

    function isConnecting() {
      var t = mode === 'desktop' ? statusText('deskstatus') : statusText('p13Status');
      return /Connecting|Setup/i.test(t) || /正在连接|正在设置|准备/.test(t);
    }

    postState(mode, 'page_loaded', 'baked=' + bakedView);

    var timer = setInterval(function () {
      if (finished) return;
      attempt += 1;
      try {
        if (isConnected()) {
          finished = true;
          clearInterval(timer);
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
          connectTries += 1;
          nextConnectAt = attempt + 10;
          postState(mode, 'connecting', 'connectDesktop');
          // Official Connect button uses contype 3 (session enum on Windows).
          // Fallback to contype 1 if still idle (matches MeshCentral autoConnectDesktop).
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
