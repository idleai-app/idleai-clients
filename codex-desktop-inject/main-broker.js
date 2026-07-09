/* __IDLEAI_BROKER__ idleai main-process broker — inserted into Codex Desktop's
 * main-DVEWN1ng.js, immediately inside the primary window's did-finish-load
 * callback. The IIFE below is invoked as `})(__IDLEAI_WIN__);` — patch.mjs
 * rewrites that `__IDLEAI_WIN__` token to whatever minified identifier the
 * anchor captured for the primary BrowserWindow (NEVER assumes `A`).
 * `win.webContents` is the chat renderer's webContents.
 *
 * DISPLAY-ONLY architecture: the in-renderer pill (idleai-line.js) is under CSP
 * with no Node and never posts out over the network. So the broker owns
 * EVERYTHING on the host side — it runs in Electron's MAIN process (full Node,
 * no CSP, fetch available) and PUSHES ad state into the renderer with
 * webContents.executeJavaScript(window.postMessage(...)). Codex's own preload
 * re-dispatches host MessageEvents as window "message" events, so the injected
 * postMessage is delivered to the pill natively. This can never affect Codex's
 * boot: it is wrapped in try/catch and only appends one DOM node in the
 * renderer.
 *
 * Loop (every 1s): if Codex is actively working (fresh ~/.codex/sessions write)
 * and a device token exists in ~/.idleai.json, serve an ad and push it in.
 *
 * HONEST-VIEW (non-negotiable): the impression is recorded ONLY after the pill
 * has been continuously VISIBLE and the window FOCUSED for 5 seconds, judged by
 * a FRESH RENDERER HEARTBEAT — every tick we read, from inside the renderer,
 * `document.hidden===false && document.hasFocus() && pill actually displayed`.
 * The 5s watched timer RESETS to zero whenever that heartbeat is false or stale.
 * Main-process win.isVisible()/isFocused() alone is not trusted: an occluded or
 * background-composited window can still report visible, so the renderer's own
 * document state is the source of truth.
 *
 * Clicks: we DO NOT call webContents.setWindowOpenHandler — Codex owns that
 * handler and Electron keeps only one, so replacing it would clobber Codex's
 * chat links and OAuth popups. Instead the pill <a> calls preventDefault() on
 * click (so no window-open fires at all) and stashes {url,ts} on a renderer
 * global; the broker reads it each tick and opens the url with
 * shell.openExternal, recording ONE click. Codex's own handler is untouched. */
try {
  (function (win) {
    if (!win || !win.webContents || win.webContents.__idleaiBroker) return;
    var wc = win.webContents;
    wc.__idleaiBroker = true;

    var fs = require("node:fs"),
      os = require("node:os"),
      path = require("node:path"),
      electron = require("electron");

    var cfgPath = path.join(os.homedir(), ".idleai.json");
    function cfg() {
      try {
        return JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      } catch (e) {
        return null;
      }
    }
    function baseUrl(c) {
      return (c && c.baseUrl) || "http://localhost:3000";
    }

    // ---- thinking signal: newest ~/.codex/sessions/<y>/<m>/<d>/ rollout mtime
    // within 90s. Copied verbatim from clients/codex-inject/host-broker.js. ----
    function newestNumericDir(d) {
      try {
        var s = fs.readdirSync(d).filter(function (n) {
          return /^\d+$/.test(n);
        });
        if (!s.length) return null;
        s.sort(function (a, b) {
          return Number(a) - Number(b);
        });
        return path.join(d, s[s.length - 1]);
      } catch (e) {
        return null;
      }
    }
    function codexActive() {
      var d = path.join(os.homedir(), ".codex", "sessions");
      for (var i = 0; i < 3 && d; i++) d = newestNumericDir(d);
      if (!d) return false;
      var latest = 0;
      try {
        fs.readdirSync(d).forEach(function (n) {
          try {
            latest = Math.max(latest, fs.statSync(path.join(d, n)).mtimeMs);
          } catch (e) {}
        });
      } catch (e) {}
      return latest && Date.now() - latest < 90000; // active + linger tier
    }

    // Coarse main-process gate (cheap short-circuit). The AUTHORITATIVE
    // honest-view decision is the renderer heartbeat below, not this.
    function windowMaybeWatched() {
      try {
        return win.isVisible() && !win.isMinimized() && win.isFocused();
      } catch (e) {
        return false;
      }
    }

    async function api(c, p, init) {
      var res = await fetch(baseUrl(c) + p, Object.assign({}, init, {
        headers: {
          Authorization: "Bearer " + c.token,
          "Content-Type": "application/json",
        },
      }));
      return res.json().catch(function () {
        return {};
      });
    }

    var ad = null,
      shownAt = 0,
      watchedMs = 0,
      lastVisibleTick = 0,
      paid = false,
      todayMicros = null,
      lastServe = 0,
      busy = false;

    function push() {
      try {
        var payload = JSON.stringify({
          __idleai: true,
          kind: "state",
          ad: ad,
          today_micros: todayMicros,
        });
        wc.executeJavaScript(
          "window.postMessage(" + payload + ", '*')",
          true
        ).catch(function () {});
      } catch (e) {}
    }

    // ---- renderer probe: run inside the chat renderer and return, in one round
    // trip, (a) the honest-view heartbeat — document.hidden===false &&
    // document.hasFocus() && the pill is actually displayed — and (b) any
    // pending click the pill captured (preventDefault'd, so no window-open
    // fired). The pill clears its own click stash after we read it. This is the
    // ONLY channel from renderer → broker; there is no IPC or fetch in the pill.
    function probeRenderer() {
      var js =
        "(function(){try{" +
        "var el=document.getElementById('idleai-codex-pill');" +
        "var shown=!!(el&&el.style.display!=='none'&&el.offsetParent!==null);" +
        "var visible=(document.visibilityState==='visible')&&(document.hidden===false)&&document.hasFocus();" +
        "var c=window.__idleaiClick||null;window.__idleaiClick=null;" +
        "return JSON.stringify({hb:!!(shown&&visible),click:c});" +
        "}catch(e){return JSON.stringify({hb:false,click:null});}})()";
      return wc.executeJavaScript(js, true).then(
        function (s) {
          try {
            return JSON.parse(s) || { hb: false, click: null };
          } catch (e) {
            return { hb: false, click: null };
          }
        },
        function () {
          return { hb: false, click: null };
        }
      );
    }

    async function recordClick(u) {
      try {
        if (!u || !ad || !ad.url || u !== ad.url) return;
        electron.shell.openExternal(u);
        var c = cfg();
        if (c && c.token) {
          var ev = await api(c, "/api/events", {
            method: "POST",
            body: JSON.stringify({ campaignId: ad.campaignId, type: "click" }),
          });
          if (ev && ev.ok) {
            todayMicros = (todayMicros || 0) + (ev.customer_share_micros || 0);
            push();
          }
        }
      } catch (e) {}
    }

    async function tick() {
      if (busy) return;
      busy = true;
      try {
        var c = cfg();
        if (!c || !c.token || c.paused) {
          if (ad) {
            ad = null;
            watchedMs = 0;
            push();
          }
          return;
        }
        if (todayMicros == null) {
          var s = await api(c, "/api/customer/stats").catch(function () {
            return null;
          });
          if (s && s.stats) todayMicros = s.stats.today_micros;
        }

        // Renderer heartbeat + pending click, in one round trip. The heartbeat
        // is the authoritative honest-view signal.
        var probe = await probeRenderer();
        if (probe && probe.click && probe.click.url) {
          await recordClick(probe.click.url);
        }
        var visibleNow = windowMaybeWatched() && probe && probe.hb === true;

        if (!codexActive() || !visibleNow) {
          // Not watched (or not thinking): forfeit the current view entirely.
          // Resetting watchedMs here means a lapse in visibility can never be
          // stitched together with a later window to reach 5s.
          if (ad) {
            ad = null;
            watchedMs = 0;
            push();
          }
          return;
        }

        var now = Date.now();
        if (!ad && now - lastServe >= 5000) {
          lastServe = now;
          var r = await api(c, "/api/serve");
          if (r && r.ad) {
            ad = r.ad;
            shownAt = now;
            watchedMs = 0;
            lastVisibleTick = now;
            paid = false;
            push();
          }
          return;
        }
        if (ad) {
          // Reaching here means the renderer heartbeat is TRUE right now, so the
          // pill is visible and the window focused. Accumulate only CONTINUOUS
          // watched time; any hidden/unfocused/stale tick took the early return
          // above and cleared `ad`, resetting the timer.
          watchedMs += now - lastVisibleTick;
          lastVisibleTick = now;
          if (!paid && watchedMs >= 5000) {
            paid = true;
            var ev = await api(c, "/api/events", {
              method: "POST",
              body: JSON.stringify({
                campaignId: ad.campaignId,
                type: "impression",
              }),
            }).catch(function () {
              return null;
            });
            if (ev && ev.ok) {
              todayMicros = (todayMicros || 0) + (ev.customer_share_micros || 0);
              push();
            }
          }
          if (paid && now - shownAt >= 12000) {
            ad = null; // rotate to next winner
            watchedMs = 0;
          }
        }
      } catch (e) {
      } finally {
        busy = false;
      }
    }

    var timer = setInterval(function () {
      tick();
    }, 1000);
    wc.on("destroyed", function () {
      clearInterval(timer);
    });
    tick();
  })(__IDLEAI_WIN__);
} catch (e) {}
