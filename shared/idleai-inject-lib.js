/* idleai shared inject library — ONE canonical copy of usd()/adText()/
 * reasonLabel()/the Codex thinking-signal/the Bearer fetch, inlined ahead of
 * each injected broker+pill (by clients/cli/idleai.mjs withLib() and by each
 * *-inject patcher) so those halves call idleaiLib.* instead of carrying their
 * own byte-identical copies. The injected surfaces run in foreign runtimes with
 * no filesystem module of their own, so this text is prepended as a string.
 * Idempotent via the __IDLEAI_LIB__ marker below — the patchers key off it.
 *
 * Defines globalThis.idleaiLib = { usd, adText, reasonLabel, makeApi,
 * codexSessionsMtime }. Pure, no imports, safe in both a browser-ish preload
 * world (fetch/global fetch) and a Node main-process world (global fetch on
 * modern Node / Electron). Marker: __IDLEAI_LIB__ */
(function () {
  if (typeof globalThis !== "undefined" && globalThis.idleaiLib) return; // idempotent

  // $1.2345 under a cent-ish threshold, $1.23 otherwise (matches usd() across clients).
  function usd(micros) {
    var m = Number(micros) || 0;
    return "$" + (m / 1e6).toFixed(m !== 0 && m < 10000 ? 4 : 2);
  }

  // Creatives may end with the brand ↗ — clients strip it and render their own arrow.
  function adText(t) {
    return String(t == null ? "" : t).replace(/\s*↗\s*$/u, "");
  }

  // Server-refusal reasons worth surfacing to the developer (never fail silently).
  var REASONS = {
    vpn_detected: "VPN detected — disconnect to earn",
    geo_mismatch: "country mismatch — fix your location in the dashboard",
    killswitch: "paused by server",
    no_inventory: "no ad right now",
    busy_elsewhere: "another device is earning — this one stands by",
    paused: "paused",
  };
  function reasonLabel(reason) {
    if (!reason) return null;
    return REASONS[reason] || null;
  }

  // Bearer-fetch factory. makeApi(cfg) → async (path, init) that hits
  // cfg.baseUrl + path with the idl_ device token, JSON in/out. Throws on !ok
  // with the server's error string (callers .catch()). Uses global fetch.
  function makeApi(cfg) {
    var base = (cfg && cfg.baseUrl) || "http://localhost:3000";
    var token = cfg && cfg.token;
    return async function api(path, init) {
      init = init || {};
      var headers = {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      };
      if (init.headers) {
        for (var k in init.headers) headers[k] = init.headers[k];
      }
      var opts = {};
      for (var o in init) opts[o] = init[o];
      opts.headers = headers;
      var res = await fetch(base + path, opts);
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || String(res.status));
      return data;
    };
  }

  // Codex thinking signal: newest rollout mtime under ~/.codex/sessions. Only
  // meaningful in a Node main-process world (needs fs/os/path); returns 0 when
  // unavailable. Kept here so every host-broker shares one definition.
  function codexSessionsMtime() {
    try {
      var fs = require("node:fs"), os = require("node:os"), path = require("node:path");
      var dir = path.join(os.homedir(), ".codex", "sessions");
      var newest = 0;
      (function walk(d) {
        var ents;
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (var i = 0; i < ents.length; i++) {
          var e = ents[i], p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else {
            try { var m = fs.statSync(p).mtimeMs; if (m > newest) newest = m; } catch (e2) {}
          }
        }
      })(dir);
      return newest;
    } catch (e) { return 0; }
  }

  var lib = {
    usd: usd,
    adText: adText,
    reasonLabel: reasonLabel,
    REASONS: REASONS,
    makeApi: makeApi,
    codexSessionsMtime: codexSessionsMtime,
  };
  if (typeof globalThis !== "undefined") globalThis.idleaiLib = lib;
})();
/* __IDLEAI_LIB__ */
