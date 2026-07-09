# idleai — Cursor Composer injection (opt-in, reversible, re-signs Cursor.app)

Cursor is an Anysphere fork of VS Code. Its AI chat ("Composer"/agent) is
rendered as **native workbench SolidJS** in the main renderer DOM — not a webview
iframe like Codex. So, exactly like the Devin/Windsurf patch, the only way to
draw the ✶ ad line *inside* the Composer panel is to patch Cursor's installed
files, and the design is the same two-half **display-only pill + host broker**
with a 127.0.0.1 loopback bridge.

```bash
idleai patch-cursor      # inject the ✶ ad line into the Composer panel
# → fully quit and reopen Cursor
idleai unpatch-cursor    # restore Cursor's original files (see signature note below)
```

## The signature problem (read this first)

`Cursor.app` is **Developer-ID signed, notarized, hardened-runtime**. The files
this patch edits — `workbench.html` and `product.json` — are sealed in
`Contents/_CodeSignature/CodeResources`. Editing them invalidates the seal, so
`codesign --verify` and `spctl` fail and macOS can throw "Cursor is damaged and
can't be opened" (Gatekeeper) on relaunch.

`patch-cursor` handles this: after editing, it **ad-hoc re-signs the whole bundle**
(`codesign --force --deep --sign - Cursor.app`) and strips quarantine
(`xattr -dr com.apple.quarantine Cursor.app`). Verified against a copy of a real
notarized Cursor.app, this replaces the Developer-ID signature with a valid
**ad-hoc** signature (`codesign --verify --deep` passes) and the app launches.

**This is a real, honestly-stated cost, not a byte-perfect round trip:**

- `patch-cursor` **replaces Cursor's Developer-ID signature with an ad-hoc one.**
  It prints this loudly and gives the recovery command.
- `unpatch-cursor` restores `workbench.html`, `product.json` and the patched
  extension file **byte-for-byte** (verified: sha256 identical to pre-patch) and
  ad-hoc re-signs again so the restored bundle still launches. It **cannot**
  restore the original Developer-ID signature — the original `_CodeSignature`
  bundle is not preserved.
- **Recovery to a genuine, notarized Cursor is always: reinstall from cursor.com.**
- If `codesign` is missing, `patch-cursor` refuses to edit (an edited-but-unsigned
  bundle would be unlaunchable), and if the re-sign fails after editing it rolls
  every edit back so the app is never left broken.

Shippable-with-caveat: on a real notarized Cursor.app the ad-hoc re-sign reliably
lets it launch, but you are trading Cursor's genuine signature for an ad-hoc one
until you reinstall.

## What it patches (each backed up to `<file>.idleai-backup`)

- **`out/vs/code/electron-sandbox/workbench/workbench.html`** — one
  `<script src="./idleai-pill.js" type="module">` after the `workbench.js` tag.
  That copied-in **display-only** pill polls the broker's 127.0.0.1 loopback and
  renders the ✶ line. It never touches a VS Code API or Composer's DOM, so it can
  never break the workbench boot.
- **`extensions/cursor-agent-exec/dist/main.js`** — a builtin extension that
  activates on startup (`activationEvents: ["*"]`). The patch prepends the shared
  lib + the host broker (defining `globalThis.__idleaiCursorBrokerInit`), then
  wraps the webpack `activate` getter so `ext.activate(context)` fires the broker
  with the real `ExtensionContext` before delegating to the original activate. The
  activate function's minified name varies per build, so the patch captures it by
  regex rather than a fixed literal.
- **`product.json`** — Cursor keeps a `checksums` map that includes
  `workbench.html`. Editing the HTML would otherwise trip a *dismissible*
  "installation appears corrupt" toast; `patch-cursor` recomputes the entry as
  `base64(sha256(bytes))` (padding stripped, VS Code's convention) so even the
  toast stays quiet. `product.json` is not in its own checksum list, so editing it
  is free.

New file copied next to `workbench.js` (deleted on unpatch): `idleai-pill.js`.

## Why two halves + a loopback bridge

The renderer is sandboxed (`sandbox:1`, `contextIsolation:1`,
`nodeIntegration:0`), so the pill has DOM + `fetch` but **no** Node/fs — it holds
no token and does no gating. And because Composer is native SolidJS (not a
webview), there is **no** `webview.postMessage` channel to push ad state in.

So the broker (extension host = Node, no CSP, full network) owns everything: the
device token from `~/.idleai.json`, the thinking gate, the `serve`/`events`/
`stats` calls, and the 5s-view impression. It exposes the current ad state on a
**127.0.0.1 loopback HTTP server** (`GET /state`, `POST /click`, `POST /seen`);
the pill polls it. Cursor's `workbench.html` CSP ships
`connect-src 'self' http: https: …`, so the pill's loopback fetch is permitted —
`patch-cursor` reads the installed workbench.html and **verifies** this (and that
`script-src` permits `'self'`) before writing, aborting with a clear message
otherwise so the injection never silently no-ops.

Port handshake: the broker binds the first free port from a fixed candidate list
(`8790, 8791, 8792`) — the renderer cannot read a handshake file, so the port set
is a shared constant probed by both halves. The broker also writes the chosen
port to `~/.idleai-cursor.json` for debugging.

## Thinking gate + honest-view

Cursor persists Composer to SQLite, not per-conversation rollout files, so there
is no Codex/Devin-style filesystem mtime signal. The **only** reliable thinking
signal is the Composer DOM: while the agent generates, the send button
`.ui-prompt-input-submit-button` renders the STOP state (a `.primitive-square`
stop icon) instead of the send arrow, and shimmer/streaming markers appear inside
`.aichat-container`. The pill reads this and reports a `thinking` flag with every
heartbeat.

Honest-view is enforced **on the side that records the impression** (the broker):

- The pill POSTs `/seen` ~1s **only** while it is actually on screen
  (`!document.hidden && document.hasFocus()`), carrying the DOM `thinking` flag.
- The broker pays an impression only when a `/seen` heartbeat is **< 2s old** AND
  that fresh beat reported `thinking: true`. It **resets its 5s clock the moment
  the heartbeat lapses**, so the 5 seconds are continuous *visible* seconds and a
  backgrounded/blurred/hidden Cursor window earns nothing.
- A view pays after 5 continuous on-screen seconds; a click pays 50×, routed to
  the exact campaign the renderer clicked.

Verified end-to-end against the broker loopback: a hidden window (no heartbeat)
and a visible-but-not-thinking window both pay **0**; only a visible + thinking
window pays; a broken 3s+3s visibility gap resets the clock and pays 0.

Refusal reasons (`no_inventory`, `vpn_detected`, `geo_mismatch`, `busy_elsewhere`,
killswitch, paused) are threaded through `/state` and shown as a muted line — the
pill never fails silently. `idleai pause` (`paused:true` in `~/.idleai.json`)
stops serving on the next broker tick, no re-patch needed.

## Trusted-types safety

The page enforces `require-trusted-types-for 'script'`. The pill is built with
`createElement`/`textContent`/`append` only — never `innerHTML` — so it never
hits a TT sink. A parse-time `<script src>` and a module load are not TT sinks and
resolve as `'self'`, satisfying `script-src 'self'`.

## Known costs (by design, not bugs)

- **Cursor's Developer-ID signature is replaced with ad-hoc** — see the signature
  section. Reinstall from cursor.com to restore genuine notarization.
- **Cursor updates overwrite the files and restore the real signature** — re-run
  `idleai patch-cursor` after an update. The patch is idempotent.
- **Writes may need `sudo`** if `/Applications/Cursor.app` is root-owned — the
  patcher falls back to `sudo cp`/`sudo codesign` automatically.
- Editing Cursor's shipped files and re-signing the bundle **violates Cursor's
  terms** — this is a power-user opt-in, not something to ship enabled.

Everything is wrapped so a broken broker or pill can never take Composer down,
and `unpatch-cursor` restores byte-identical file originals (signature caveat
above).
