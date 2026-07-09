# idleai — Devin (Windsurf) Cascade injection (opt-in, reversible)

Devin.app is a Windsurf/Codeium build (product `Devin`, `.devin` data folder,
`Exafunction.Windsurf`). Its AI chat, **Cascade**, is **not** an extension
webview like Codex — it is native React compiled directly into the workbench
bundle (`workbench.desktop.main.js`). There is no CSP-bound chat webview HTML to
inject into; the chat lives in the main renderer DOM. So the only way to draw
the ad *inside* the Cascade panel is to patch Devin's installed files.

```bash
idleai patch-devin      # inject the ✶ ad line into the Cascade panel
# → fully quit and reopen Devin
idleai unpatch-devin    # restore Devin's original files
```

## What it patches (both plain unpacked JS, no asar; each backed up to `<file>.idleai-backup`)

- **`out/vs/code/electron-browser/workbench/workbench.html`** — adds one
  `<script src="./idleai-pill.js" type="module">` right after the `workbench.js`
  tag. That copied-in script (`idleai-pill.js`) renders a single ✶ pill pinned
  bottom-center and owns only its own DOM node — it never touches a VS Code API
  or Cascade's DOM, so it can never break the workbench boot.
- **`extensions/windsurf/dist/extension.js`** — injects `host-broker.js` right
  after the exported `e.activate=async function(A){` seam (`A` = the extension
  context), wrapped in `try/catch`.

## Why two halves + a loopback bridge

The renderer is sandboxed (`sandbox:1`, `contextIsolation:1`,
`nodeIntegration:0`), so the pill has DOM + `fetch` but **no** Node/fs — it holds
no token and does no gating. And because Cascade is native React (not a webview),
there is **no** `webview.postMessage` channel to push ad state in.

So the broker (extension host = Node, no CSP, full network) owns everything:
the device token from `~/.idleai.json`, the thinking-signal gate, the
`serve`/`events`/`stats` calls, and the 5s-view impression. It exposes the
current ad state on a **127.0.0.1 loopback HTTP server** (`GET /state`,
`POST /click`, `POST /seen`); the pill polls it. workbench.html's CSP must allow
`connect-src http://127.0.0.1:*`, so the pill fetch is permitted — `patch-devin`
reads the installed workbench.html and **verifies** this (and that `script-src`
permits `'self'`) before writing, aborting with a clear message otherwise so the
injection never silently no-ops.

Port handshake: the broker binds the first free port from a fixed candidate list
(`8787, 8788, 8789`) — the renderer cannot read a handshake file, so the port set
is a shared constant probed by both halves. The broker also writes the chosen
port to `~/.idleai-devin.json` for debugging.

## Thinking signal

Newest `~/.codeium/windsurf/cascade/*.pb` mtime within 90s — Cascade rewrites a
per-conversation protobuf as it streams, the direct analog of Codex's
`~/.codex/sessions` mtime. Fully decoupled from React internals, so a Cascade
redesign never breaks the gate.

Honest-view rules hold, enforced on the side that records the impression: the
pill POSTs `/seen` ~1s **only** while it is actually on screen
(`!document.hidden && document.hasFocus()`), and the broker pays only when
Cascade is thinking **and** a `/seen` heartbeat is < 2s old — resetting its 5s
clock the moment the heartbeat lapses, so the 5 seconds are continuous *visible*
seconds and a backgrounded/blurred window earns nothing. Refusal reasons
(`no_inventory`, `vpn_detected`, `geo_mismatch`, `busy_elsewhere`, killswitch,
paused) are threaded through `/state` and shown as a muted line — the pill never
fails silently. `idleai pause` (`paused:true` in `~/.idleai.json`) stops serving.

## Known costs (by design, not bugs)

- **Devin updates overwrite the files** — re-run `idleai patch-devin` after an
  update. The patch is idempotent and skips already-injected files.
- **Writes need `sudo`** (`/Applications/Devin.app` is root-owned) — the patcher
  falls back to `sudo cp` automatically.
- **VS Code may warn** that it was modified (it checksums installs).
- Editing a vendor's shipped app likely **violates Windsurf's terms** — this is
  a power-user opt-in, not something to ship enabled.

Everything is wrapped in `try/catch`: a broken broker can never take Cascade
down, and `unpatch-devin` restores byte-identical originals.
