/* idleai host broker — injected into Codex extension.js after
 * `async initializeWebview(e,r,n,o){`. `e` is the vscode Webview; `Ee` is the
 * extension's vscode namespace alias. Marker: __IDLEAI_BROKER__
 *
 * DISPLAY-ONLY architecture: the webview pill never calls acquireVsCodeApi (it
 * is one-shot and Codex needs it to boot). So the broker owns EVERYTHING on the
 * host side — no CSP here, fetch is available — and pushes ad state INTO the
 * webview with webview.postMessage (host->webview needs no acquire). The pill
 * just renders it. This can never affect Codex's boot.
 *
 * Loop (every few seconds): if Codex is actively working (fresh
 * ~/.codex/sessions write) and a device token exists, serve an ad and push it
 * in; after it has been shown 5s, record ONE impression; rotate periodically.
 * Auth reuses ~/.idleai.json. Wrapped in try/catch so it can never take the
 * panel down. */
try {
  (function (webview) {
    if (!webview || webview.__idleaiBroker) return;
    webview.__idleaiBroker = true;
    var fs = require("node:fs"), os = require("node:os"), path = require("node:path");
    var cfgPath = path.join(os.homedir(), ".idleai.json");
    function cfg() { try { return JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch (e) { return null; } }
    function newestNumericDir(d) {
      try {
        var s = fs.readdirSync(d).filter(function (n) { return /^\d+$/.test(n); });
        if (!s.length) return null;
        s.sort(function (a, b) { return Number(a) - Number(b); });
        return path.join(d, s[s.length - 1]);
      } catch (e) { return null; }
    }
    function codexActive() {
      var d = path.join(os.homedir(), ".codex", "sessions");
      for (var i = 0; i < 3 && d; i++) d = newestNumericDir(d);
      if (!d) return false;
      var latest = 0;
      try {
        fs.readdirSync(d).forEach(function (n) {
          try { latest = Math.max(latest, fs.statSync(path.join(d, n)).mtimeMs); } catch (e) {}
        });
      } catch (e) {}
      return latest && Date.now() - latest < 90000; // active + linger tier
    }
    async function api(c, p, init) {
      var res = await fetch(c.baseUrl + p, Object.assign({}, init, {
        headers: { Authorization: "Bearer " + c.token, "Content-Type": "application/json" },
      }));
      return res.json().catch(function () { return {}; });
    }

    var ad = null, shownAt = 0, paid = false, todayMicros = null, lastServe = 0, busy = false;
    function push() {
      try { webview.postMessage({ __idleai: true, kind: "state", ad: ad, today_micros: todayMicros }); } catch (e) {}
    }

    async function tick() {
      if (busy) return;
      busy = true;
      try {
        var c = cfg();
        if (!c || !c.token || c.paused) { ad = null; push(); return; }
        if (todayMicros == null) {
          var s = await api(c, "/api/customer/stats").catch(function () { return null; });
          if (s && s.stats) todayMicros = s.stats.today_micros;
        }
        if (!codexActive()) { if (ad) { ad = null; push(); } return; }
        var now = Date.now();
        if (!ad && now - lastServe >= 5000) {
          lastServe = now;
          var r = await api(c, "/api/serve");
          if (r && r.ad) { ad = r.ad; shownAt = now; paid = false; push(); }
          return;
        }
        if (ad) {
          if (!paid && now - shownAt >= 5000) {
            paid = true;
            var ev = await api(c, "/api/events", {
              method: "POST",
              body: JSON.stringify({ campaignId: ad.campaignId, type: "impression" }),
            }).catch(function () { return null; });
            if (ev && ev.ok) { todayMicros = (todayMicros || 0) + (ev.customer_share_micros || 0); push(); }
          }
          if (paid && now - shownAt >= 12000) { ad = null; } // rotate to next winner
        }
      } catch (e) {} finally { busy = false; }
    }

    var timer = setInterval(function () { tick(); }, 2000);
    try { webview.onDidDispose && webview.onDidDispose(function () { clearInterval(timer); }); } catch (e) {}
    tick();
  })(e);
} catch (e) {}
