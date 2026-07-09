# idleai — browser extension (MV3)

The ad line rendered beside the thinking indicator on **claude.ai, chatgpt.com
(including the Codex task view), grok.com, gemini.google.com, chat.mistral.ai,
perplexity.ai, chat.deepseek.com and replit.com (Agent/Assistant chat)**. The pill exists only while the
assistant is actually working; a view pays after 5 continuous seconds on a visible
tab; clicking the pill opens the ad in a new tab and pays 50×.

## Supported browsers

One build covers both engine families:

- **Chromium** — Chrome, Brave, Arc, Dia, Edge, Opera, Vivaldi: identical
  behavior, same unpacked install or Chrome Web Store build. (Brave: works with
  Shields up — our pill is first-party DOM, not a tracked iframe.)
- **Firefox ≥140** — real MV3 support via the dual `background` key (Firefox
  runs `scripts` as an event page, Chromium runs the `service_worker`; each
  ignores the other). AMO id + data-collection declaration are in
  `browser_specific_settings`. Validated with `npx web-ext lint` (0 errors).

## Install (unpacked)

1. Chromium family: `chrome://extensions` (or `brave://extensions`,
   `arc://extensions`, `edge://extensions`) → **Developer mode** →
   **Load unpacked** → select `clients/browser/`.
   Firefox: `about:debugging` → This Firefox → **Load Temporary Add-on** →
   pick `manifest.json` (permanent installs need AMO signing — see
   `docs/PUBLISHING.md`).
2. Click the extension → **settings** → paste your device token + server URL
   (defaults to `http://localhost:3000`; self-hosted origins must also be added to
   `host_permissions` in `manifest.json`).
3. Open any supported assistant and send a prompt — the ✶ pill appears while it thinks.

## Architecture

- `sw.js` — the only network surface; holds the token, proxies
  `serve`/`event`/`stats`/`openAd` messages. Token never enters page contexts.
- `content.js` — per-site thinking probes (a `[data-is-streaming]` /
  stop-button heuristic per host + generic fallback; chatgpt.com additionally
  scans the Codex activity feed for a live status line like "Thinking" or
  "Running a command") polled at 700ms, a
  shadow-DOM pill (site CSS can't touch it), the 5s verified-view timer, and
  rotation to the next winner every 12s of continued thinking.
- Honest-view rules baked in: hidden tabs never serve or pay
  (`document.hidden`), a dismissed pill (×) stays gone for the tab, pausing from
  the popup stops all serving.

## Known maintenance

The per-site probes in `content.js` (`SITES`) track live DOM details of eight
frontends and **will** need updates as those sites ship redesigns. The generic
stop-button fallback usually survives — Replit's probe leans on it plus a
running-progressbar fallback, since its Agent composer shows a Stop control
while a run is live. `npm run test:e2e-browser -- idl_xxx`
exercises the pill lifecycle in real Chromium and every probe against
mimicked per-site DOM (`PROBE_CASES` in `scripts/e2e-browser.mjs`).
