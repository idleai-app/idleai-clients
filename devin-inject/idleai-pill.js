// idleai — injected into the Devin (Windsurf/Codeium) workbench renderer.
//
// DISPLAY-ONLY BY DESIGN. Devin's Cascade chat is native React compiled into
// the workbench bundle, NOT an extension webview — so there is no
// acquireVsCodeApi / postMessage host channel to reach. This script never
// touches any VS Code API and never mutates Cascade's DOM; it owns only its own
// pinned pill node, so it can NEVER affect the workbench boot.
//
// The renderer is sandboxed (sandbox:1, contextIsolation:1, nodeIntegration:0)
// so this script has DOM + fetch but NO Node/fs — it holds no token, no timer
// logic, no gate. The HOST broker (injected into the windsurf extension host,
// full Node) owns the device token, the thinking-signal gate, the ad-server
// calls and the 5s-view impression. The broker exposes current ad state on a
// loopback HTTP server (127.0.0.1); this pill polls GET /state, renders the ✶
// line, and — crucially for honest-view — POSTs /seen ~1s ONLY while it is
// actually on screen (!document.hidden && document.hasFocus()). The broker will
// not pay an impression without a fresh /seen, so a hidden/blurred Devin window
// earns nothing. CSP `connect-src http://127.0.0.1:*` (workbench.html) permits
// these fetches.
(function () {
  if (window.__idleaiDevin) return; // idempotent across renderer reloads
  window.__idleaiDevin = true;

  // Broker binds the first free port from this candidate list; the pill probes
  // the same list (the renderer is sandboxed and cannot read the handshake file
  // ~/.idleai-devin.json, so the port set is a fixed shared contract).
  var PORTS = [8787, 8788, 8789];
  var base = null; // "http://127.0.0.1:<port>" once discovered

  // ---- pill DOM (pinned bottom-center, above the Cascade composer) ----
  var host = document.createElement("div");
  host.id = "idleai-devin-pill";
  host.style.cssText =
    "position:fixed;left:0;right:0;bottom:132px;z-index:2147483647;display:none;" +
    "justify-content:center;pointer-events:none;padding:6px 10px;font-family:" +
    "ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px";
  host.innerHTML =
    '<a id="idleai-pill" target="_blank" rel="noopener" style="pointer-events:auto;' +
    "text-decoration:none;display:flex;align-items:center;gap:8px;max-width:80ch;" +
    "background:#0b0f0e;color:#e8f0ed;border:1px solid #253430;border-radius:999px;" +
    "padding:6px 12px;cursor:pointer;box-shadow:0 4px 18px rgba(0,0,0,.4);" +
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' +
    '<span id="idleai-star" style="color:#00b894">✶</span>' +
    '<span id="idleai-text"></span>' +
    '<span id="idleai-arrow" style="color:#00b894">↗</span>' +
    '<span id="idleai-earn" style="color:#8aa39b"></span></a>';

  function mount() {
    if (document.body) {
      if (!document.getElementById("idleai-devin-pill")) document.body.appendChild(host);
    } else {
      document.addEventListener("DOMContentLoaded", mount);
    }
  }
  mount();

  // usd() + adText() + reasonLabel() from the shared inject lib
  // (globalThis.idleaiLib, inlined ahead of this pill by patch-devin). One
  // canonical refusal-reason map so wording can't drift per surface.
  var lib = globalThis.idleaiLib;
  var usd = lib.usd;
  var reasonLabel = lib.reasonLabel;

  function onScreen() { return !document.hidden && document.hasFocus(); }

  var pillEl, textEl, earnEl, starEl, arrowEl, currentCampaign = null;
  function refs() {
    pillEl = document.getElementById("idleai-pill");
    textEl = document.getElementById("idleai-text");
    earnEl = document.getElementById("idleai-earn");
    starEl = document.getElementById("idleai-star");
    arrowEl = document.getElementById("idleai-arrow");
  }

  function render(state) {
    refs();
    if (!textEl) return;
    // Honest-view: never render into a hidden/unfocused window. The broker also
    // gates payment on the /seen heartbeat, but the pill hides itself too.
    if (state && state.ad && onScreen()) {
      var a = state.ad;
      currentCampaign = a.campaignId;
      starEl.style.color = a.takeover ? "#fde047" : "#00b894";
      textEl.textContent = lib.adText(a.text);
      pillEl.href = a.url || "#";
      pillEl.style.cursor = "pointer";
      arrowEl.style.display = "";
      earnEl.textContent =
        typeof state.today_micros === "number" ? "· " + usd(state.today_micros) + " today" : "";
      host.style.display = "flex";
      return;
    }
    currentCampaign = null;
    // No ad — if the broker gave a stated reason, show it muted instead of
    // vanishing silently (contract: clients display the reason, never fail
    // silently). Only surface a reason while the window is actually on screen.
    var label = state && onScreen() ? reasonLabel(state.reason) : null;
    if (label) {
      starEl.style.color = "#8aa39b";
      textEl.textContent = label;
      pillEl.removeAttribute("href");
      pillEl.style.cursor = "default";
      arrowEl.style.display = "none";
      earnEl.textContent =
        typeof state.today_micros === "number" ? "· " + usd(state.today_micros) + " today" : "";
      host.style.display = "flex";
    } else {
      host.style.display = "none";
    }
  }

  // Belt-and-suspenders click record: the <a target="_blank"> opens the URL
  // (VS Code turns it into an external-open); we also tell the broker so it can
  // POST the click event with the device token it holds, carrying the exact
  // campaignId so rotation can't misattribute the click.
  host.addEventListener("click", function () {
    if (!base || !currentCampaign) return;
    try {
      fetch(base + "/click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId: currentCampaign }),
        keepalive: true,
      }).catch(function () {});
    } catch (e) {}
  });

  // Visibility heartbeat: POST /seen only while the pill is genuinely on screen.
  // The broker requires a heartbeat < 2s old before it pays an impression and
  // resets its 5s clock the moment the beats stop, so this is what enforces
  // "5 continuous seconds actually on screen" for this surface.
  function beat() {
    if (!base || !onScreen()) return;
    try {
      fetch(base + "/seen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }).catch(function () {});
    } catch (e) {}
  }

  // Poll the broker's loopback server. First success pins `base` to the port
  // that answered; a fetch failure just hides the pill (broker down / paused).
  async function poll() {
    var candidates = base ? [base] : PORTS.map(function (p) { return "http://127.0.0.1:" + p; });
    for (var i = 0; i < candidates.length; i++) {
      try {
        var res = await fetch(candidates[i] + "/state", { cache: "no-store" });
        if (!res.ok) continue;
        var state = await res.json();
        base = candidates[i];
        render(state);
        beat(); // fold a heartbeat into every successful poll
        return;
      } catch (e) {}
    }
    render(null); // no broker answered
  }

  setInterval(function () { poll(); }, 2000);
  // Faster heartbeat than the 2s poll so the broker's < 2s freshness check has
  // slack even if a poll is momentarily slow.
  setInterval(function () { beat(); }, 1000);
  poll();
})();
