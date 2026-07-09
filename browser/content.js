// idleai content script — detects the assistant's thinking state and renders
// the ad line beside it. The pill only exists while the assistant works; a view
// pays after 5 continuous visible seconds; clicking the pill opens the ad (50×).
(() => {
  const VIEW_MS = 5000;
  const POLL_MS = 700;
  const ROTATE_MS = 12000; // after a paid view, ask for the next winner
  const DEBOUNCE_MS = 800; // so a flickering indicator doesn't strobe the pill
  const RESERVE_MS = 5000; // min gap between serve attempts when nothing shows

  const REASONS = {
    vpn_detected: "VPN detected — disconnect to earn",
    geo_mismatch: "country mismatch — fix your location in the dashboard",
    busy_elsewhere: "another device is earning — this one stands by",
  };

  // Per-site "is it thinking?" probes, newest-known selectors first, with a
  // generic stop-button fallback — these WILL need maintenance as sites ship.
  const stopButton =
    'button[aria-label*="stop" i], button[data-testid*="stop" i], button[title*="stop" i]';
  // Codex task view (chatgpt.com/codex) has no .result-streaming and no stop
  // button — while a run is live the activity feed ends in an ephemeral status
  // line ("Thinking", "Searching files", "Running a command…"). Past-tense
  // summaries ("Read 5 files") persist after the run finishes, so matching
  // them would pin the pill on completed tasks forever; the linger window is
  // what carries the pill across the gaps between live statuses instead.
  const CODEX_LIVE =
    /^(thinking|working|planning|reading|searching|listing|browsing|running|editing|writing|testing|installing|building)\b[^!?]{0,60}$/i;
  const codexWorking = () => {
    if (!location.pathname.startsWith("/codex")) return false;
    const els = (document.querySelector("main") || document.body).querySelectorAll("span, div, p");
    // Live status renders at the tail of the feed — walk backwards over the
    // most recent leaf elements only, so the poll stays cheap on long tasks.
    for (let i = els.length - 1, seen = 0; i >= 0 && seen < 300; i--, seen++) {
      const el = els[i];
      if (el.childElementCount !== 0) continue;
      const t = (el.textContent || "")
        .trim()
        .replace(/(…|\.{3})$/, "");
      // A sentence-final period means prose narration, not a status line.
      if (t && t.length <= 72 && !t.endsWith(".") && CODEX_LIVE.test(t)) return true;
    }
    return false;
  };
  const SITES = {
    "claude.ai": () => !!document.querySelector(`[data-is-streaming="true"], ${stopButton}`),
    "chatgpt.com": () =>
      !!document.querySelector(`.result-streaming, ${stopButton}`) || codexWorking(),
    "chat.openai.com": () =>
      !!document.querySelector(`.result-streaming, ${stopButton}`) || codexWorking(),
    "grok.com": () => !!document.querySelector(stopButton),
    "gemini.google.com": () =>
      !!document.querySelector(`.streaming, [data-test-id*="stop" i], ${stopButton}`),
    "chat.mistral.ai": () => !!document.querySelector(stopButton),
    "www.perplexity.ai": () => !!document.querySelector(stopButton),
    "perplexity.ai": () => !!document.querySelector(stopButton),
    "chat.deepseek.com": () => !!document.querySelector(stopButton),
    // Replit Agent/Assistant chat: while a run is live the composer swaps its
    // send control for a Stop button (aria/title/testid "stop"); the generic
    // stopButton selector catches it, with Replit's own data-cy stop hook as a
    // fallback. NOT [role="progressbar"] — Replit shows progress bars for idle
    // deploys, package installs and workspace boot, which would pay for views
    // when the agent isn't thinking (dishonest). Stop-control only.
    "replit.com": () =>
      !!document.querySelector(`${stopButton}, [data-cy*="stop" i]`),
  };
  const isThinking = SITES[location.hostname] ?? (() => !!document.querySelector(stopButton));

  const send = (type, body) =>
    new Promise((resolve) => chrome.runtime.sendMessage({ type, body }, resolve));

  const usd = (m) => `$${(m / 1e6).toFixed(m !== 0 && m < 10000 ? 4 : 2)}`;
  // Creatives may end with the brand ↗ — the pill renders its own arrow.
  const adText = (t) => t.replace(/\s*↗\s*$/u, "");

  // ---- pill UI (shadow DOM so site CSS can't touch it) ----
  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483647;display:none;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      .pill{display:flex;align-items:center;gap:8px;font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;
        background:#0b0f0e;color:#e8f0ed;border:1px solid #253430;border-radius:999px;
        padding:8px 14px;cursor:pointer;max-width:72ch;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
        box-shadow:0 4px 24px rgba(0,0,0,.45)}
      .star{color:#00b894;animation:pulse 1.2s ease-in-out infinite}
      .star.takeover{color:#fde047}
      .arrow{color:#00b894}
      .earn{color:#8aa39b}
      .x{color:#8aa39b;margin-left:2px;padding:0 2px;cursor:pointer}
      .x:hover{color:#e8f0ed}
      @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
    </style>
    <div class="pill" part="pill">
      <span class="star">✶</span><span class="text"></span><span class="arrow">↗</span>
      <span class="earn"></span><span class="x" title="hide for this tab">×</span>
    </div>`;
  const pill = root.querySelector(".pill");
  const elStar = root.querySelector(".star");
  const elText = root.querySelector(".text");
  const elEarn = root.querySelector(".earn");
  document.documentElement.appendChild(host);

  let ad = null;
  let todayMicros = null;
  let dismissed = false;
  let thinkingSince = 0;
  let shownAt = 0;
  let paidThisAd = false;
  // Linger tier: the ad may stay for the server-set window after the response
  // ends — until the developer starts typing the next prompt.
  let lingerSeconds = 30;
  let wasThinking = false;
  let lastThinkEnd = 0;
  let typedAt = 0;
  let lastServeAt = 0;
  document.addEventListener("keydown", () => (typedAt = Date.now()), true);

  root.querySelector(".x").addEventListener("click", (e) => {
    e.stopPropagation();
    dismissed = true;
    hide();
  });
  pill.addEventListener("click", async () => {
    if (!ad) return;
    const ev = await send("openAd", { url: ad.url, campaignId: ad.campaignId });
    if (ev?.ok) {
      todayMicros = (todayMicros ?? 0) + ev.customer_share_micros;
      renderEarn();
    }
  });

  function renderEarn() {
    elEarn.textContent = todayMicros == null ? "" : `· ${usd(todayMicros)} today`;
  }

  function show(served) {
    ad = served;
    paidThisAd = false;
    shownAt = Date.now();
    elStar.classList.toggle("takeover", !!served.takeover);
    elText.textContent = adText(served.text);
    renderEarn();
    host.style.display = "block";
  }

  function hide() {
    host.style.display = "none";
    ad = null;
    shownAt = 0;
  }

  function showWarning(text) {
    ad = null;
    elStar.classList.add("takeover");
    elText.textContent = text;
    elEarn.textContent = "";
    host.style.display = "block";
  }

  async function serve() {
    lastServeAt = Date.now();
    const res = await send("serve");
    if (typeof res?.lingerSeconds === "number") lingerSeconds = res.lingerSeconds;
    if (res?.ad) show(res.ad);
    else if (REASONS[res?.reason]) showWarning(REASONS[res.reason]);
    else {
      // No pill and no user-facing reason (no_inventory, killswitch, paused,
      // no_token) — silent by design for real developers, but logged so the
      // console answers "why is nothing showing?" when debugging a setup.
      if (res?.reason || res?.error) console.debug("[idleai] no ad:", res.reason ?? res.error);
      hide();
    }
  }

  async function tick() {
    if (dismissed) return;
    if (document.hidden) {
      // The 5s view must be CONTINUOUS and visible — tabbing away mid-view
      // forfeits it entirely (a fresh serve starts on return).
      thinkingSince = 0;
      if (ad) hide();
      return;
    }
    const thinking = isThinking();
    const now = Date.now();

    if (thinking) {
      wasThinking = true;
      if (!thinkingSince) thinkingSince = now;
      if (now - thinkingSince < DEBOUNCE_MS) return;
    } else {
      if (wasThinking) {
        wasThinking = false;
        lastThinkEnd = now;
      }
      thinkingSince = 0;
      // Linger: an already-shown ad stays through the read-the-response phase
      // until the window closes or the developer starts typing again.
      const inLinger =
        ad && lingerSeconds > 0 && now - lastThinkEnd < lingerSeconds * 1000 && typedAt <= lastThinkEnd;
      if (!inLinger) {
        if (ad || host.style.display === "block") hide();
        return;
      }
    }

    if (!ad) {
      if (!thinking || now - lastServeAt < RESERVE_MS) return;
      if (todayMicros == null) {
        const s = await send("stats");
        if (s?.stats) todayMicros = s.stats.today_micros;
      }
      await serve();
      return;
    }
    // The 5-second verified view: pill continuously visible on a visible tab.
    if (!paidThisAd && now - shownAt >= VIEW_MS) {
      paidThisAd = true;
      const ev = await send("event", { campaignId: ad.campaignId, type: "impression" });
      if (ev?.ok) {
        todayMicros = (todayMicros ?? 0) + ev.customer_share_micros;
        renderEarn();
      }
    }
    if (paidThisAd && now - shownAt >= ROTATE_MS) await serve();
  }

  // Always run: the service worker gates paused/no-token per request, so pausing
  // from the popup (or pasting a token) takes effect without a page reload.
  setInterval(() => tick().catch(() => {}), POLL_MS);
})();
