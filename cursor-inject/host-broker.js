/* idleai host broker — injected into a builtin Cursor extension's activate
 * (Marker: __IDLEAI_BROKER__). Cursor's Composer chat is native workbench
 * SolidJS, NOT an extension webview, so — exactly like Devin/Windsurf — there is
 * no webview.postMessage channel to push ad state into the renderer. The broker
 * runs in the extension host (Node, no CSP, full fetch/http) and owns
 * EVERYTHING: the device token, the honest-view gate, the ad-server calls and
 * the 5s-view impression. It exposes current ad state on a 127.0.0.1 loopback
 * HTTP server; the display-only pill in the renderer polls GET /state
 * (workbench.html CSP `connect-src http:` permits it), POSTs /click, and POSTs
 * /seen ~1s while it is actually visible + focused.
 *
 * HONEST-VIEW (the side that records the impression gates it): a paid impression
 * requires (1) a fresh visibility heartbeat from the pill (< 2s old) AND (2) that
 * same fresh heartbeat reporting the Composer is thinking. The pill only POSTs
 * /seen while !document.hidden && document.hasFocus(), so a backgrounded/blurred
 * Cursor window stops beating and nothing pays. The 5s clock counts continuous
 * *visible* seconds: the instant the heartbeat lapses (or stops reporting
 * thinking) shownAt resets, so the developer must watch the ad for 5 unbroken
 * on-screen seconds before it pays.
 *
 * Why the thinking signal lives in the renderer here (unlike Devin's .pb mtime):
 * Cursor persists Composer to SQLite, not per-conversation files, so there is no
 * filesystem mtime analog. The DOM is the only reliable signal — but the broker
 * still refuses to pay on anything but a FRESH beat carrying thinking:true, so a
 * stale renderer can never keep a view alive.
 *
 * Auth reuses ~/.idleai.json. Wrapped in try/catch so it can never take the
 * extension host — and therefore Composer — down. */
globalThis.__idleaiCursorBrokerInit = function (context) {
  try {
    if (globalThis.__idleaiCursorBroker) return; // idempotent per host
    globalThis.__idleaiCursorBroker = true;
    var fs = require("node:fs"),
      os = require("node:os"),
      path = require("node:path"),
      http = require("node:http");
    var PORTS = [8790, 8791, 8792]; // shared contract with the renderer pill
    var SEEN_TTL = 2000; // a heartbeat older than this means the pill isn't on screen
    var cfgPath = path.join(os.homedir(), ".idleai.json");
    var handshakePath = path.join(os.homedir(), ".idleai-cursor.json");
    function cfg() {
      try { return JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch (e) { return null; }
    }
    // Pill is on screen only if it posted a /seen heartbeat within SEEN_TTL, and
    // "thinking" only if that fresh beat reported the Composer generating.
    function pillVisible() { return Date.now() - lastSeen < SEEN_TTL; }
    function composerActive() { return pillVisible() && lastThinking; }
    // Bearer fetch from the shared inject lib (globalThis.idleaiLib, inlined
    // ahead of this broker by patch-cursor).
    var lib = globalThis.idleaiLib;
    function api(c, p, init) { return lib.makeApi(c)(p, init); }

    var ad = null, shownAt = 0, paid = false, todayMicros = null, lastServe = 0, busy = false;
    var reason = null, lingerSeconds = null; // last refusal reason, surfaced to the pill
    var lastSeen = 0; // wall-clock of the pill's most recent /seen heartbeat
    var lastThinking = false; // thinking flag carried by that most recent beat
    var pendingClick = null; // { campaignId } POSTed by the renderer → record on next tick

    async function tick() {
      if (busy) return;
      busy = true;
      try {
        var c = cfg();
        if (!c || !c.token || c.paused) { ad = null; reason = c && c.paused ? "paused" : null; return; }
        if (todayMicros == null) {
          var s = await api(c, "/api/customer/stats").catch(function () { return null; });
          if (s && s.stats) todayMicros = s.stats.today_micros;
        }
        // A pending click always pays, recorded against the exact campaign the
        // renderer clicked (carried through the POST body), even if the pill has
        // since rotated away from it.
        if (pendingClick && pendingClick.campaignId) {
          var clickCampaign = pendingClick.campaignId;
          pendingClick = null;
          var cev = await api(c, "/api/events", {
            method: "POST",
            body: JSON.stringify({ campaignId: clickCampaign, type: "click" }),
          }).catch(function () { return null; });
          if (cev && cev.ok) todayMicros = (todayMicros || 0) + (cev.customer_share_micros || 0);
        }
        var now = Date.now();
        // HONEST-VIEW GATE: never hold or serve an ad unless the pill is genuinely
        // on screen (fresh heartbeat) AND that beat reports Composer thinking. A
        // hidden/blurred window stops posting /seen, so pillVisible() goes false
        // and nothing pays.
        if (!composerActive()) {
          // Drop the ad and reset the 5s clock — visibility must be continuous.
          ad = null; shownAt = 0; paid = false;
          return;
        }
        if (!ad && now - lastServe >= 5000) {
          lastServe = now;
          var r = await api(c, "/api/serve");
          reason = (r && r.reason) || null;
          lingerSeconds = (r && typeof r.lingerSeconds === "number") ? r.lingerSeconds : null;
          if (r && r.ad) { ad = r.ad; shownAt = now; paid = false; }
          return;
        }
        if (ad) {
          // 5 CONTINUOUS VISIBLE SECONDS: shownAt is set only while the pill is
          // visible (this gate) and is reset the instant visibility lapses, so
          // this measures real on-screen time, never wall-clock.
          if (!paid && now - shownAt >= 5000) {
            paid = true;
            var ev = await api(c, "/api/events", {
              method: "POST",
              body: JSON.stringify({ campaignId: ad.campaignId, type: "impression" }),
            }).catch(function () { return null; });
            if (ev && ev.ok) todayMicros = (todayMicros || 0) + (ev.customer_share_micros || 0);
          }
          if (paid && now - shownAt >= 12000) { ad = null; reason = null; } // rotate to next winner
        }
      } catch (e) {} finally { busy = false; }
    }

    // ---- loopback server the renderer pill polls (same machine, no CSP) ----
    var server = null;
    function handler(req, res) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      if (req.method === "GET" && req.url === "/state") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ad: ad, today_micros: todayMicros, reason: reason, lingerSeconds: lingerSeconds }));
        return;
      }
      if (req.method === "POST" && req.url === "/seen") {
        // The pill only posts this while !document.hidden && document.hasFocus().
        // The body carries {thinking:bool} from the Composer DOM; we require a
        // fresh beat AND thinking:true before paying, so a stale renderer can't
        // hold a view open.
        var sbody = "";
        req.on("data", function (ch) { sbody += ch; if (sbody.length > 4096) req.destroy(); });
        req.on("end", function () {
          lastSeen = Date.now();
          try { lastThinking = !!JSON.parse(sbody || "{}").thinking; } catch (e) { lastThinking = false; }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      if (req.method === "POST" && req.url === "/click") {
        var body = "";
        req.on("data", function (ch) { body += ch; if (body.length > 4096) req.destroy(); });
        req.on("end", function () {
          try {
            var parsed = JSON.parse(body || "{}");
            // Record the click against the exact campaign the renderer clicked,
            // not whatever ad the broker happens to hold on the next tick.
            if (parsed && parsed.campaignId) pendingClick = { campaignId: parsed.campaignId };
          } catch (e) {}
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      res.writeHead(404); res.end();
    }
    // Fresh server per bind attempt: reusing one http.Server across listen()
    // retries double-fires the listening callback and can write a stale port to
    // the handshake file. Each attempt gets its own socket; the port is written
    // exactly once, from the 'listening' event of the socket that actually bound.
    function listenOn(i) {
      if (i >= PORTS.length) return; // all taken — pill just won't find us
      var s = http.createServer(handler);
      s.once("error", function () { try { s.close(); } catch (e) {} listenOn(i + 1); });
      s.once("listening", function () {
        server = s;
        try { fs.writeFileSync(handshakePath, JSON.stringify({ port: PORTS[i] })); } catch (e) {}
      });
      s.listen(PORTS[i], "127.0.0.1");
    }
    listenOn(0);

    var timer = setInterval(function () { tick(); }, 2000);
    try {
      context && context.subscriptions && context.subscriptions.push({
        dispose: function () {
          clearInterval(timer);
          try { if (server) server.close(); } catch (e) {}
        },
      });
    } catch (e) {}
    tick();
  } catch (e) {}
};
