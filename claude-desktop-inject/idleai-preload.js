// idleai — appended to Claude Desktop's claude.ai content preload
// (app.asar :: .vite/build/mainView.js). Marker: __IDLEAI_PILL__
//
// DISPLAY-ONLY BY DESIGN. Claude Desktop's real chat UI is REMOTE claude.ai
// loaded into a main-process WebContentsView (contextIsolation + sandbox), and
// this file is that view's preload. It runs in claude.ai's isolated world with
// electron's ipcRenderer available, but NO Node fs/fetch and — under the page
// CSP — no way to reach the ad server or window.open an external URL directly.
//
// So this half does three things and nothing else:
//   (a) polls the claude.ai streaming probe (~1s) and reports the boolean to the
//       broker over ipcRenderer.send("idleai:thinking", bool),
//   (b) renders one ✶ ad line from state the broker pushes on
//       ipcRenderer.on("idleai:state", ...),
//   (c) forwards a click to the broker via ipcRenderer.send("idleai:open", url)
//       — the main process owns shell.openExternal and records the click.
//
// It NEVER touches claude.ai's own nonce-namespaced $eipc_message$ IPC and never
// posts on a boot-critical channel, so it cannot affect app boot. Guarded by an
// idempotency flag and a claude.ai hostname check so it never mounts in
// auth/verify popups that share this preload.
(function () {
  try {
    if (window.__idleaiClaude) return; // idempotent across reloads
    // Only the real claude.ai chat surface — never auth/verify/OAuth popups.
    var h = (location && location.hostname) || "";
    if (!/(^|\.)claude\.ai$/i.test(h)) return;
    window.__idleaiClaude = true;

    var electron = require("electron");
    var ipc = electron && electron.ipcRenderer;
    if (!ipc) return;

    // ---- pill DOM: closed shadow root on <html>, fixed bottom-center ----
    var host = document.createElement("div");
    host.id = "idleai-claude-pill";
    host.style.cssText =
      "position:fixed;left:0;right:0;bottom:18px;z-index:2147483647;display:none;" +
      "justify-content:center;pointer-events:none;font-family:" +
      "ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px";
    var root = host.attachShadow ? host.attachShadow({ mode: "closed" }) : host;
    root.innerHTML =
      '<style>a{pointer-events:auto;text-decoration:none;display:flex;' +
      "align-items:center;gap:8px;max-width:80ch;background:#0b0f0e;color:#e8f0ed;" +
      "border:1px solid #253430;border-radius:999px;padding:6px 12px;cursor:pointer;" +
      "box-shadow:0 4px 18px rgba(0,0,0,.4);white-space:nowrap;overflow:hidden;" +
      "text-overflow:ellipsis;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}" +
      ".s{color:#00b894}.e{color:#8aa39b}</style>" +
      '<a id="p" rel="noopener"><span class="s" id="star">✶</span>' +
      '<span id="text"></span><span class="s">↗</span>' +
      '<span class="e" id="earn"></span></a>';

    var pillEl = root.getElementById ? root.getElementById("p") : root.querySelector("#p");
    var textEl = root.getElementById ? root.getElementById("text") : root.querySelector("#text");
    var earnEl = root.getElementById ? root.getElementById("earn") : root.querySelector("#earn");
    var starEl = root.getElementById ? root.getElementById("star") : root.querySelector("#star");
    var curUrl = null;

    if (pillEl) {
      pillEl.addEventListener("click", function (ev) {
        ev.preventDefault();
        if (curUrl) {
          try { ipc.send("idleai:open", curUrl); } catch (e) {}
        }
      });
    }

    function mount() {
      var target = document.documentElement || document.body;
      if (target && !document.getElementById("idleai-claude-pill")) {
        target.appendChild(host);
      } else if (!target) {
        document.addEventListener("DOMContentLoaded", mount);
      }
    }
    mount();

    // usd() + adText() from the shared inject lib (globalThis.idleaiLib, inlined
    // ahead of this preload by patch.mjs editPreload).
    var lib = globalThis.idleaiLib;
    var usd = lib.usd;

    function render(state) {
      if (!textEl) return;
      if (state && state.ad) {
        var a = state.ad;
        if (starEl) starEl.style.color = a.takeover ? "#fde047" : "#00b894";
        textEl.textContent = lib.adText(a.text);
        curUrl = a.url || null;
        if (earnEl) {
          earnEl.textContent =
            typeof state.today_micros === "number" ? "· " + usd(state.today_micros) + " today" : "";
        }
        host.style.display = "flex";
      } else {
        host.style.display = "none";
      }
    }

    // Broker pushes ad state on its timer (host -> preload needs no privilege).
    ipc.on("idleai:state", function (_ev, state) {
      try { render(state); } catch (e) {}
    });

    // ---- thinking probe: same DOM signal the browser client uses for claude.ai
    var THINK_SEL =
      '[data-is-streaming="true"], button[aria-label*="stop" i], ' +
      'button[data-testid*="stop" i], button[title*="stop" i]';
    var lastThinking = null;
    // Honest-view gate (renderer half): NEVER report thinking while this view is
    // not actually on screen AND focused. Claude Desktop can be minimized,
    // occluded, sent to another Space, or its window unfocused mid-stream; the
    // page's own document.hidden/visibilityState + document.hasFocus() are the
    // authoritative "watched" signal here. The broker adds a main-process
    // isVisible()/isFocused() check on top AND requires a FRESH heartbeat, so a
    // dead/silent renderer can never keep paying inside the linger window.
    function onScreen() {
      try {
        var vis = typeof document.visibilityState === "string"
          ? document.visibilityState === "visible"
          : !document.hidden;
        var focused = typeof document.hasFocus === "function" ? document.hasFocus() : true;
        return vis && focused;
      } catch (e) { return false; }
    }
    function report(val) {
      var v = !!val && onScreen(); // hidden/unfocused ⇒ forfeit immediately
      if (v !== lastThinking) {
        lastThinking = v;
        try { ipc.send("idleai:thinking", v); } catch (e) {}
      }
    }
    function probe() {
      var thinking = false;
      try { thinking = !!document.querySelector(THINK_SEL); } catch (e) {}
      report(thinking);
    }
    // ---- visibility heartbeat: an independent, always-on pulse the broker uses
    // to gate the 5s impression. Every ~1s (and on every visibility/focus event)
    // we tell the broker whether the page is on screen AND focused right now. The
    // broker resets its 5s timer whenever a heartbeat says not-visible OR whenever
    // heartbeats stop arriving (staleness) — so a minimized/occluded/unfocused
    // window, or a crashed/frozen renderer, cannot bank a paid view.
    function beat() {
      try { ipc.send("idleai:visible", onScreen()); } catch (e) {}
    }
    setInterval(function () { probe(); beat(); }, 1000);
    // Backgrounding/foregrounding/blur must take effect instantly, not on the next
    // 1s tick: re-report on every visibility/focus change (not-on-screen forfeits,
    // on-screen re-probes). Heartbeat rides each event too.
    function onVis() {
      if (onScreen()) probe();
      else report(false);
      beat();
    }
    try { document.addEventListener("visibilitychange", onVis); } catch (e) {}
    try { window.addEventListener("focus", onVis); } catch (e) {}
    try { window.addEventListener("blur", onVis); } catch (e) {}
    try { window.addEventListener("pagehide", function () { report(false); beat(); }); } catch (e) {}
    probe();
    beat();
  } catch (e) {
    /* never let the pill break the preload / app boot */
  }
})();
