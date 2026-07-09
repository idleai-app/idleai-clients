/* idleai host broker — injected into Claude Desktop's main process
 * (app.asar :: .vite/build/index.js) INSIDE the claude.ai content-view factory
 * (currently `function JSt(A){return ue=new oA.WebContentsView(A),aT(
 * ue.webContents,kp.CLAUDE_AI_WEB),…,ue}`). The patcher splices
 * `,__idleaiInitBroker(<var>)` into that factory's return, passing the captured
 * (per-version) minified view var, so the broker never hardcodes it. `require(
 * "electron")` here is the main process, so ipcMain / shell are available.
 * Marker: __IDLEAI_BROKER__
 *
 * Shape: a named function `__idleaiInitBroker(view)` defined once before the
 * factory; the patcher splices `,__idleaiInitBroker(<var>)` into the factory's
 * return comma-expression so it fires each time the claude.ai view is created,
 * idempotent via `wc.__idleaiBroker`.
 *
 * DISPLAY-ONLY architecture: the preload pill never reaches the ad server (page
 * CSP blocks fetch to localhost and blocks external window.open on claude.ai).
 * So the broker — unsandboxed main process, full Node + fetch, no CSP — owns
 * EVERYTHING host-side: the token, the timer, the serve/events/stats calls, the
 * 5s impression, and pushes ad state INTO the view with webContents.send. It
 * gates serving on the streaming boolean the preload reports over IPC plus a
 * short linger, and opens clicked ads with shell.openExternal (recording the
 * click). Wrapped in try/catch so it can never take the window down. */
function __idleaiInitBroker(view) {
 try {
  (function (wc) {
    if (!wc || wc.__idleaiBroker) return;
    wc.__idleaiBroker = true;
    var electron = require("electron");
    var ipcMain = electron.ipcMain, shell = electron.shell;
    var BrowserWindow = electron.BrowserWindow;
    var fs = require("node:fs"), os = require("node:os"), path = require("node:path");
    var cfgPath = path.join(os.homedir(), ".idleai.json");
    function cfg() { try { return JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch (e) { return null; } }

    // Honest-view visibility gate (main-process half). This is the OS-truth check
    // that backs up the renderer heartbeat: if Claude.app's window is minimized,
    // hidden, or not the focused window, we never serve or pay — even against a
    // stale latched thinking=true or a lying renderer. Focus IS gated here (and
    // in the renderer via hasFocus()): a background window is not an honest view.
    function windowVisible() {
      try {
        if (wc.isDestroyed && wc.isDestroyed()) return false;
        var win = BrowserWindow && BrowserWindow.fromWebContents
          ? BrowserWindow.fromWebContents(wc)
          : null;
        if (win) {
          if (win.isMinimized && win.isMinimized()) return false;
          if (win.isVisible && !win.isVisible()) return false;
          if (win.isFocused && !win.isFocused()) return false;
        }
        // If no owning BrowserWindow resolves (WebContentsView on a BaseWindow),
        // the renderer heartbeat (idleai:visible, gated on hidden===false &&
        // hasFocus()) is the sole authority — and watched() already requires a
        // FRESH visible heartbeat, so an unwatched surface still cannot pay.
        return true;
      } catch (e) { return true; }
    }

    // Honest-view heartbeat (renderer half). The preload sends idleai:visible
    // ~every second AND on every visibility/focus event, carrying whether the
    // page is on screen AND focused (document.hidden===false && hasFocus()). The
    // broker records the last report + its timestamp. A view is "watched" only
    // when the last heartbeat said visible AND it is FRESH — if heartbeats stop
    // (crashed/frozen/torn-down renderer) we treat the page as not-watched rather
    // than trusting a stale latched value. This is what makes the 5s impression
    // honest: no dead renderer can bank a paid view inside the linger window.
    var HEARTBEAT_STALE_MS = 3000; // ~1s cadence → tolerate 2 missed beats
    var pageVisible = false, lastVisibleAt = 0;
    function onVisible(ev, val) {
      try { if (ev && ev.sender && ev.sender !== wc) return; } catch (e) {}
      var wasWatched = rendererWatched();
      pageVisible = !!val;
      lastVisibleAt = Date.now();
      // Losing visibility mid-window forfeits the in-flight impression at once.
      if (wasWatched && !rendererWatched()) forfeitView();
    }
    // Fresh + visible. A missing/old heartbeat is NOT watched (fail closed).
    function rendererWatched() {
      if (!pageVisible) return false;
      return lastVisibleAt !== 0 && (Date.now() - lastVisibleAt) < HEARTBEAT_STALE_MS;
    }

    // Thinking gate: the preload reports the claude.ai streaming boolean here,
    // pre-gated on page visibility+focus (not-on-screen ⇒ false). We keep a
    // linger window so the pill persists briefly across streaming gaps (mirrors
    // the codex broker's 90s active+linger tier, scaled for a live DOM signal).
    // Only trust reports from OUR view's WebContents.
    var lastThinkingAt = 0, thinking = false;
    function onThinking(ev, val) {
      try { if (ev && ev.sender && ev.sender !== wc) return; } catch (e) {}
      var was = thinking;
      thinking = !!val;
      if (thinking) { lastThinkingAt = Date.now(); }
      else {
        // A drop to false is either the stream ending or the page going hidden.
        // Kill the linger and reset any partial view so a half-counted 5s window
        // that spanned a backgrounding can never pay.
        lastThinkingAt = 0;
        if (was) forfeitView();
      }
    }
    // Reset the in-flight impression window when the surface stops being watched,
    // so a partial <5s view never pays after visibility is regained: clearing
    // shownAt makes tick() restart the 5s clock the next time it is watched.
    function forfeitView() {
      if (!paid) { shownAt = 0; }
    }
    // Fully watched = the OS window is on screen (main-process truth) AND the
    // renderer heartbeat is fresh+visible+focused. Both must hold to serve or pay.
    function watched() {
      return windowVisible() && rendererWatched();
    }
    function active() {
      if (!watched()) return false; // never serve when the surface isn't watched
      if (thinking) return true;
      return lastThinkingAt && Date.now() - lastThinkingAt < 90000; // linger tier
    }

    // Bearer fetch from the shared inject lib (globalThis.idleaiLib, inlined
    // ahead of the broker fn by patch.mjs editMain).
    var lib = globalThis.idleaiLib;
    function api(c, p, init) { return lib.makeApi(c)(p, init); }

    var ad = null, shownAt = 0, paid = false, todayMicros = null, lastServe = 0, busy = false;
    function push() {
      try {
        if (wc.isDestroyed && wc.isDestroyed()) return;
        wc.send("idleai:state", { ad: ad, today_micros: todayMicros });
      } catch (e) {}
    }

    // Click: preload forwards the UTM url; open it externally + record the click.
    function onOpen(ev, url) {
      try { if (ev && ev.sender && ev.sender !== wc) return; } catch (e) {}
      if (!url || typeof url !== "string") return;
      try { shell.openExternal(url); } catch (e) {}
      (async function () {
        try {
          var c = cfg();
          if (!c || !c.token || !ad || !ad.campaignId) return;
          var evr = await api(c, "/api/events", {
            method: "POST",
            body: JSON.stringify({ campaignId: ad.campaignId, type: "click" }),
          }).catch(function () { return null; });
          if (evr && evr.ok) { todayMicros = (todayMicros || 0) + (evr.customer_share_micros || 0); push(); }
        } catch (e) {}
      })();
    }

    try { ipcMain.on("idleai:thinking", onThinking); } catch (e) {}
    try { ipcMain.on("idleai:visible", onVisible); } catch (e) {}
    try { ipcMain.on("idleai:open", onOpen); } catch (e) {}
    // Both handlers ignore events whose sender isn't THIS view, so they're inert
    // for other views — but they must still be removed or they leak on the
    // singleton ipcMain across view churn (Electron MaxListeners warnings over a
    // long session). stop() below removes them and is wired to several teardown
    // signals so a missed 'destroyed' can't strand them.

    async function tick() {
      if (busy) return;
      busy = true;
      try {
        if (wc.isDestroyed && wc.isDestroyed()) return;
        var c = cfg();
        if (!c || !c.token || c.paused) { ad = null; push(); return; }
        if (todayMicros == null) {
          var s = await api(c, "/api/customer/stats").catch(function () { return null; });
          if (s && s.stats) todayMicros = s.stats.today_micros;
        }
        if (!active()) { if (ad) { ad = null; push(); } return; }
        var now = Date.now();
        if (!ad && now - lastServe >= 5000) {
          lastServe = now;
          var r = await api(c, "/api/serve");
          // Start the 5s clock only if still watched right now; else 0 = "not yet".
          if (r && r.ad) { ad = r.ad; shownAt = watched() ? now : 0; paid = false; push(); }
          return;
        }
        if (ad) {
          // The 5s must be CONTINUOUSLY watched. active() already required
          // watched() above, but re-assert here and (re)start the clock: if the
          // window was forfeited (shownAt cleared to 0) the clock restarts now.
          if (!paid) {
            if (!watched()) {
              shownAt = 0; // not watched → keep resetting the clock, never pay
            } else {
              if (!shownAt) shownAt = now; // (re)start the continuous-view clock
              if (now - shownAt >= 5000) {
                paid = true;
                var ev = await api(c, "/api/events", {
                  method: "POST",
                  body: JSON.stringify({ campaignId: ad.campaignId, type: "impression" }),
                }).catch(function () { return null; });
                if (ev && ev.ok) { todayMicros = (todayMicros || 0) + (ev.customer_share_micros || 0); push(); }
              }
            }
          }
          if (paid && shownAt && now - shownAt >= 12000) { ad = null; } // rotate to next winner
        }
      } catch (e) {} finally { busy = false; }
    }

    var timer = setInterval(function () { tick(); }, 2000);
    var stopped = false;
    function stop() {
      if (stopped) return; // idempotent: several teardown signals may all fire
      stopped = true;
      try { clearInterval(timer); } catch (e) {}
      try { ipcMain.removeListener("idleai:thinking", onThinking); } catch (e) {}
      try { ipcMain.removeListener("idleai:visible", onVisible); } catch (e) {}
      try { ipcMain.removeListener("idleai:open", onOpen); } catch (e) {}
    }
    // Tear down (and unhook the global ipcMain listeners) on every signal that a
    // view is gone, not just 'destroyed' — that event can be missed if a new
    // claude.ai view is created before this one finishes tearing down. Any of
    // these firing removes the listeners exactly once (stop() is idempotent).
    try {
      if (wc.once) {
        wc.once("destroyed", stop);
        wc.once("render-process-gone", stop);
      }
    } catch (e) {}
    tick();
  })(view && view.webContents);
 } catch (e) {}
}
