// idleai — injected into the Cursor (Anysphere fork of VS Code) workbench renderer.
//
// DISPLAY-ONLY BY DESIGN. Cursor's AI chat ("Composer"/agent) is native
// workbench SolidJS in the same document as the workbench — NOT an extension
// webview — so there is no acquireVsCodeApi / webview.postMessage channel. This
// script never touches any VS Code API and never mutates Composer's DOM; it owns
// only its own pinned pill node, so it can NEVER affect the workbench boot.
//
// The renderer is sandboxed (sandbox:1, contextIsolation:1, nodeIntegration:0)
// so this script has DOM + fetch but NO Node/fs — it holds no token, no timer
// logic, no gate. The HOST broker (injected into a builtin Cursor extension's
// activate, full Node) owns the device token, the thinking-signal gate, the
// ad-server calls and the 5s-view impression. The broker exposes current ad
// state on a loopback HTTP server (127.0.0.1); this pill polls GET /state,
// renders the ✶ line, and — crucially for honest-view — POSTs /seen ~1s ONLY
// while it is actually on screen (!document.hidden && document.hasFocus()). The
// broker will not pay an impression without a fresh /seen, so a hidden/blurred
// Cursor window earns nothing. workbench.html CSP `connect-src http:` permits
// these loopback fetches.
//
// TRUSTED-TYPES: the page enforces require-trusted-types-for 'script'. Every
// node is built with createElement/textContent/append — NEVER innerHTML — so we
// never hit a TT sink. A parse-time <script src> and this file loading as a
// module are not TT sinks, so they satisfy script-src 'self'.
(function () {
  if (window.__idleaiCursor) return; // idempotent across SolidJS re-renders / reloads
  window.__idleaiCursor = true;

  // Broker binds the first free port from this candidate list; the pill probes
  // the same list (the renderer is sandboxed and cannot read the handshake file
  // ~/.idleai-cursor.json, so the port set is a fixed shared contract).
  var PORTS = [8790, 8791, 8792];
  var base = null; // "http://127.0.0.1:<port>" once discovered

  var lib = globalThis.idleaiLib;
  var usd = lib.usd;
  var reasonLabel = lib.reasonLabel;

  function onScreen() {
    if (document.hidden) return false;
    if (typeof document.hasFocus === "function" && !document.hasFocus()) return false;
    return true;
  }

  // ---- thinking gate (pure DOM, reported to the broker) ----
  // Cursor persists chat to SQLite, not per-conversation rollout files, so the
  // Codex/Devin-style mtime gate does not apply — the only reliable signal is
  // the Composer DOM. The broker (which records the impression) still gates on
  // a FRESH heartbeat carrying this flag, so a stale/blurred renderer can't keep
  // "thinking" alive: the moment heartbeats stop the broker's clock resets.
  // While the agent generates, the send button renders the STOP state (a
  // .primitive-square stop icon) instead of the send arrow; shimmer/streaming
  // markers on active bubbles inside .aichat-container corroborate. Either = thinking.
  function thinking() {
    try {
      var btns = document.querySelectorAll(".ui-prompt-input-submit-button");
      for (var i = 0; i < btns.length; i++) {
        if (btns[i].querySelector(".primitive-square")) return true;
        var st = btns[i].getAttribute("data-state") || "";
        if (st === "stop") return true;
      }
      var container = document.querySelector(".aichat-container") || document.querySelector(".aichat-pane");
      if (container) {
        if (
          container.querySelector("[data-shimmer]") ||
          container.querySelector("[data-loading]") ||
          container.querySelector(".generating") ||
          container.querySelector(".streaming")
        ) {
          return true;
        }
      }
    } catch (e) {}
    return false;
  }

  // ---- pill DOM (pinned bottom-center, above the Composer input) ----
  // Built imperatively (no innerHTML) to satisfy trusted-types.
  var host = document.createElement("div");
  host.id = "idleai-cursor-pill";
  host.style.cssText =
    "position:fixed;left:0;right:0;bottom:96px;z-index:2147483000;display:none;" +
    "justify-content:center;pointer-events:none;padding:4px 10px;font-family:" +
    "ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px";

  var pill = document.createElement("a"); // <a target=_blank> → VS Code opens externally
  pill.id = "idleai-cursor-anchor";
  pill.target = "_blank";
  pill.rel = "noopener noreferrer";
  pill.style.cssText =
    "pointer-events:auto;text-decoration:none;display:flex;align-items:center;gap:8px;" +
    "max-width:80ch;background:#0b0f0e;color:#e8f0ed;border:1px solid #253430;" +
    "border-radius:999px;padding:6px 12px;cursor:pointer;box-shadow:0 4px 18px " +
    "rgba(0,0,0,.4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis";

  var starEl = document.createElement("span");
  starEl.textContent = "✶";
  starEl.style.color = "#00b894";

  var textEl = document.createElement("span");

  var arrowEl = document.createElement("span"); // our own accent arrow (we strip ad's ↗)
  arrowEl.textContent = "↗";
  arrowEl.style.color = "#00b894";

  var earnEl = document.createElement("span");
  earnEl.style.color = "#8aa39b";

  pill.append(starEl, textEl, arrowEl, earnEl);
  host.append(pill);

  function mount() {
    if (document.body) {
      if (!document.getElementById("idleai-cursor-pill")) document.body.appendChild(host);
    } else {
      document.addEventListener("DOMContentLoaded", mount, { once: true });
    }
  }
  mount();
  // SolidJS re-renders the workbench; keep the pill attached to <body>.
  try {
    var mo = new MutationObserver(function () {
      if (document.body && !document.getElementById("idleai-cursor-pill")) {
        document.body.appendChild(host);
      }
    });
    if (document.documentElement) mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

  var currentCampaign = null;

  function render(state) {
    // Honest-view: never render into a hidden/unfocused window. The broker also
    // gates payment on the /seen heartbeat, but the pill hides itself too.
    if (state && state.ad && onScreen()) {
      var a = state.ad;
      currentCampaign = a.campaignId;
      starEl.style.color = a.takeover ? "#fde047" : "#00b894";
      arrowEl.style.color = a.takeover ? "#fde047" : "#00b894";
      textEl.textContent = lib.adText(a.text);
      pill.href = a.url || "#";
      pill.style.cursor = "pointer";
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
      pill.removeAttribute("href");
      pill.style.cursor = "default";
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
  pill.addEventListener("click", function () {
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
  // "5 continuous seconds actually on screen" for this surface. The beat also
  // carries the DOM thinking flag; the broker will not serve or pay unless that
  // flag is true in a FRESH beat, so the renderer cannot keep a stale "thinking"
  // alive after it stops beating.
  function beat() {
    if (!base || !onScreen()) return; // no beat at all when not on screen
    try {
      fetch(base + "/seen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thinking: thinking() }),
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
