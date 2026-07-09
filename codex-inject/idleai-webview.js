// idleai — injected into the Codex (openai.chatgpt) VS Code webview panel.
//
// DISPLAY-ONLY BY DESIGN. The webview content frame is nested + cross-origin,
// and its only outbound host channel (acquireVsCodeApi) is one-shot — Codex
// needs it to boot, and every attempt to share it broke Codex. So this script
// NEVER calls acquireVsCodeApi and never posts out. It cannot affect Codex's
// boot at all.
//
// Instead: the HOST broker (injected in extension.js) owns the timer, the ad
// server calls, and the thinking-signal gate. It PUSHES the current ad state
// into this webview with webview.postMessage — which arrives here as a plain
// window "message" event, needing no API. This script only renders that state
// as the ✶ line above the chat box. Clicks open via an <a target="_blank">,
// which VS Code turns into an external-open (and the host records the click on
// its next serve, seeing the click flag it set — see broker).
(function () {
  if (window.__idleaiCodex) return; // idempotent across webview reloads
  window.__idleaiCodex = true;

  // ---- pill DOM (sits just above the bottom chat composer) ----
  var host = document.createElement("div");
  host.id = "idleai-codex-pill";
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

  // Host pushes { __idleai:true, kind:"state", ad, today_micros } on its timer.
  // Receiving needs no acquireVsCodeApi — VS Code delivers it as a window event.
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (!m || m.__idleai !== true) return; // ignore Codex's own traffic
    if (m.kind === "state") render(m);
  });
})();
