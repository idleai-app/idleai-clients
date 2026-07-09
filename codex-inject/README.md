# idleai — Codex panel injection (opt-in, reversible)

The Codex VS Code extension (`openai.chatgpt`) renders its chat in a webview
with **no hook of its own** — no statusline, no spinner override, and one
extension can't reach into another's webview through any supported API. The
only way to draw the ad *inside* the Codex panel is to patch OpenAI's installed
files. That's what `idleai patch-codex` does.

```bash
idleai patch-codex      # inject the ✶ ad line into the Codex panel
# → reload the VS Code window
idleai unpatch-codex    # restore OpenAI's original files
```

## What it patches (both backed up to `<file>.idleai-backup`)

- **`webview/index.html`** — adds one `<script src="./assets/idleai-line.js">`.
  That copied-in script (`idleai-webview.js`) renders a single ✶ pill pinned to
  the bottom of the panel and owns only its own DOM node.
- **`out/extension.js`** — injects `host-broker.js` right after the extension's
  `initializeWebview(` seam (a stable VS Code API chokepoint both the sidebar
  and panel webviews pass through).

## Why two halves

The webview CSP is `default-src 'none'` with `connect-src` locked to
chatgpt/mapbox/sentry — the in-panel script **cannot** reach the ad server.
So it speaks only over the standard `postMessage` bridge; the host broker
(extension host = Node, no CSP) does the actual `serve`/`events`/`stats` calls,
reusing the CLI's `~/.idleai.json` for auth and gating on the same
`~/.codex/sessions` thinking signal as every other idleai client. Honest-view
rules hold: hidden panel forfeits the view, a view pays after 5 continuous
seconds, clicks pay 50×.

## Known costs (by design, not bugs)

- **Codex updates overwrite the files** — re-run `idleai patch-codex` after an
  update. The patch is idempotent and skips already-injected files.
- **VS Code may warn** that an extension was modified (it checksums installs).
- Editing a vendor's shipped extension likely **violates OpenAI's extension
  terms** — this is a power-user opt-in, not something to ship enabled.

Everything is wrapped in `try/catch`: a broken broker can never take Codex's
own panel down, and `unpatch-codex` restores byte-identical originals.
