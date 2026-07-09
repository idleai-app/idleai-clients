// __IDLEAI__ pill — injected into the Codex Desktop (Codex.app) chat renderer.
//
// DISPLAY-ONLY BY DESIGN. This runs in the Electron renderer, which is locked
// down by CSP (connect-src is chatgpt/openai only) and has no Node. It NEVER
// fetches, never posts OUT over the network, and never touches Codex's own IPC
// bridge (electronBridge / codexWindowType). It only listens for inbound window
// "message" events the MAIN-PROCESS broker pushes in via
// webContents.executeJavaScript(window.postMessage(...)), and renders one ✶ ad
// line pinned to the bottom of the window. It owns exactly one DOM node, so it
// can never affect Codex's boot.
//
// Two tiny renderer→broker signals, both read by the broker via
// executeJavaScript (NOT network, NOT IPC) each tick:
//   - window.__idleaiClick — on pill click we preventDefault() (so NO
//     window-open ever fires and Codex's own setWindowOpenHandler is left
//     entirely alone) and stash {url,ts}. The broker reads+clears it and opens
//     the url with shell.openExternal.
//   - the broker also reads document.hidden / document.hasFocus() / whether
//     this pill is actually displayed to gate the 5s honest-view impression.
//
// The main broker (full Node, no CSP — see main-broker.js) owns the timer, the
// ad-server calls, the 5s honest-view impression, and the thinking-signal gate
// (~/.codex/sessions mtime). It pushes { __idleai:true, kind:"state", ad,
// today_micros }. Codex's own preload re-dispatches host MessageEvents as
// window "message" events (preload.js: window.dispatchEvent(new MessageEvent(
// "message",{data:t}))), so an executeJavaScript-injected window.postMessage is
// delivered here natively — no acquire API needed.
(function () {
  if (window.__idleaiCodexDesktop) return; // idempotent across renderer reloads
  window.__idleaiCodexDesktop = true;

  // ---- pill DOM (pinned bottom-center, above Codex's composer) ----
  var host = document.createElement("div");
  host.id = "idleai-codex-pill";
  host.style.cssText =
    "position:fixed;left:0;right:0;bottom:96px;z-index:2147483647;display:none;" +
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
    '<span style="color:#00b894">↗</span>' +
    '<span id="idleai-earn" style="color:#8aa39b"></span></a>';

  function mount() {
    if (document.body) {
      if (!document.getElementById("idleai-codex-pill")) document.body.appendChild(host);
    } else {
      document.addEventListener("DOMContentLoaded", mount);
    }
  }
  mount();

  // Click capture WITHOUT a window-open handler: preventDefault() so the <a>
  // never triggers Electron's window-open path at all (leaving Codex's own
  // setWindowOpenHandler untouched), and stash the ad url for the broker to
  // read + open externally. Guard on href so a stale/empty pill never pings.
  host.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("#idleai-pill") : null;
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    var url = a.getAttribute("href");
    if (url && url !== "#") {
      window.__idleaiClick = { url: url, ts: Date.now() };
    }
  });

  // Shared usd() shape (money mono, cents; 4dp for sub-cent amounts).
  function usd(m) {
    return "$" + (m / 1e6).toFixed(m !== 0 && m < 10000 ? 4 : 2);
  }

  var pillEl, textEl, earnEl, starEl;
  function refs() {
    pillEl = document.getElementById("idleai-pill");
    textEl = document.getElementById("idleai-text");
    earnEl = document.getElementById("idleai-earn");
    starEl = document.getElementById("idleai-star");
  }

  function render(state) {
    refs();
    if (!textEl) return;
    if (state && state.ad) {
      var a = state.ad;
      // takeover gets the gold star; strip the creative's trailing ↗ (we draw our own).
      starEl.style.color = a.takeover ? "#fde047" : "#00b894";
      textEl.textContent = (a.text || "").replace(/\s*↗\s*$/, "");
      pillEl.href = a.url || "#";
      earnEl.textContent =
        typeof state.today_micros === "number" ? "· " + usd(state.today_micros) + " today" : "";
      host.style.display = "flex";
    } else {
      host.style.display = "none";
    }
  }

  // Main broker pushes { __idleai:true, kind:"state", ad, today_micros } on its
  // timer. Delivered here as a plain window "message" — no acquire API needed.
  window.addEventListener("message", function (e) {
    var m = e && e.data;
    if (!m || m.__idleai !== true) return; // ignore Codex's own IPC traffic
    if (m.kind === "state") render(m);
  });
})();
