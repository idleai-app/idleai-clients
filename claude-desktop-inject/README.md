# idleai — Claude Desktop injection (opt-in, reversible)

Claude Desktop (`Claude.app`, Electron `@ant/desktop`) does **not** render its
chat from a local bundle. The main window HTML (`.vite/renderer/main_window/
index.html`) is only title-bar + error chrome — its own comment says
"everything else gets loaded from claude.ai". The real chat/thinking UI is
**remote claude.ai** loaded over HTTPS into a main-process `WebContentsView`
(`contextIsolation: true, sandbox: true`, preload `.vite/build/mainView.js`).

So there is no local page to drop a pill into. The ad has to ride the two build
files Electron already loads. `idleai patch-claude` edits both, inside `app.asar`:

```bash
idleai patch-claude      # inject the ✶ ad line into the Claude Desktop chat
# → fully quit and reopen Claude.app
idleai unpatch-claude    # restore the byte-identical original app.asar
```

## What it patches (all inside `app.asar`, backed up first)

- **`.vite/build/mainView.js`** — the claude.ai content preload. We append a
  self-contained display-only pill IIFE (`idleai-preload.js`) at EOF, before the
  trailing `//# sourceMappingURL` line. It renders one ✶ pill (closed shadow DOM,
  fixed bottom-center), reports the claude.ai streaming signal to the broker, and
  forwards clicks. The preload does zero DOM injection today, so appending is clean.
- **`.vite/build/index.js`** — the main process. We inject the broker
  (`host-broker.js`) right after the content-view factory
  `…new …WebContentsView(e), …(le.webContents, …CLAUDE_AI_WEB)…`, capturing that
  view's `webContents`.

`app.asar` is copied byte-identical to **`app.asar.idleai-backup`** (+ a
`.sha256` record) before anything is written. `unpatch-claude` restores that
copy exactly and deletes it.

### asar integrity fuse (the part that would otherwise brick boot)

The shipping `Claude.app` has the Electron fuse
`EnableEmbeddedAsarIntegrityValidation` **on**, and `Contents/Info.plist` pins
`ElectronAsarIntegrity → Resources/app.asar → hash` to the sha256 of the asar's
**header block**. At boot Electron recomputes that header hash and **aborts if it
differs** — completely independently of the code signature. Patching `app.asar`
changes `index.js`'s size/offset/integrity in the header JSON, so the header hash
changes and, with a stale plist, the app refuses to launch.

So `patch-claude`, after rewriting `app.asar`, **recomputes the new header hash
and writes it back into `Info.plist`** (via `PlistBuddy`), backing the plist up
byte-identical to `Info.plist.idleai-backup` first. `unpatch-claude` restores the
original plist (original pin) **byte-identical** alongside the original asar. Re-
signing does **not** help here (integrity is read from the plist, not the
signature), so no re-signing is done or advised and the original code signature
is never touched.

The whole patch is **gated behind fuse/plist detection and fails loudly** rather
than risk bricking boot:

- **fuse on** (`ElectronAsarIntegrity` present, hash readable) → rewrite the pin
  after patching (the normal path).
- **fuse off** (key genuinely absent) → the plist step is a no-op; asar is patched
  and the plist is left untouched.
- **undeterminable** (PlistBuddy missing, or the plist is unreadable/corrupt) →
  **refuse to patch before touching `app.asar`**, with instructions. It never
  guesses "off" and never ships a patched asar against a stale pin.

If patching fails partway (a seam moved, a write errors), it **rolls back both
`app.asar` and `Info.plist` to their byte-identical backups** so neither a half-
written archive nor a mismatched pin is ever left behind. `idleai patch-claude
status` reports whether the pin matches the current header — i.e. whether the app
would boot.

### Why not `@electron/asar extract`+`pack`

Claude.app ships a ~48MB `app.asar.unpacked` sibling of native binaries
(`.node`/`.dylib`) that live **outside** the archive. A naive `extract` fails
without that sibling present, and a `pack` must reproduce the exact set of
unpacked files or it silently pulls the natives back into the archive and
corrupts the app. So `patch.mjs` uses a small dependency-free asar reader/writer
(`asar.mjs`) that edits only the two packed JS files in place — recomputing their
size/offset/integrity and shifting subsequent offsets — and never touches
`app.asar.unpacked`. A no-op rewrite reproduces the original archive byte-for-byte
(verified). The broker seam is matched **structurally** (a regex over the
`WebContentsView` / `CLAUDE_AI_WEB` factory that captures the per-version minified
var and tolerates extra statements like `setMaxListeners`), not by literal
identifier, and the injected `__idleaiInitBroker(<var>)` call is spliced into the
factory's return so it fires on every claude.ai view creation.

## Why two halves (same reason as codex-inject)

The claude.ai page context runs under a strict CSP: it **cannot** `fetch` the ad
server on `localhost:3000`, and it **cannot** `window.open` an external URL. The
sandboxed preload has `ipcRenderer` but no Node `fs`/`fetch`. So the pill is
display-only and speaks only over IPC; the **host broker** (main process = full
Node + `fetch`, no CSP) does the real `serve`/`events`/`stats` calls, reuses the
CLI's `~/.idleai.json` for auth, records the 5s impression, opens clicked ads via
`shell.openExternal`, and pushes ad state into the view with `webContents.send`.

### Thinking gate

The gate is the claude.ai DOM streaming state, read inside the preload — the same
probe the browser client uses for claude.ai:
`[data-is-streaming="true"], button[aria-label*="stop" i], …`. The preload polls
it (~1s) and reports a boolean to the broker over `idleai:thinking`; the broker
serves only while thinking, plus a 90s linger so the pill persists across
streaming gaps. Honest-view rules hold: a view pays only after 5 *continuously
watched* seconds (see the visibility gate below), clicks pay 50×.

**Honest-view visibility gate.** Two independent, fail-closed signals both have
to say "watched" before a view can pay:

1. **Renderer heartbeat (`idleai:visible`).** The preload sends a heartbeat
   ~every second — and on every `visibilitychange`/`focus`/`blur`/`pagehide` —
   carrying whether the page is on screen **and** focused right now
   (`document.hidden === false && document.hasFocus()`). It also pre-gates the
   `thinking` boolean on that same check, so a hidden/unfocused page never even
   claims to be thinking. The broker treats the surface as watched **only** when
   the last heartbeat said visible **and it is fresh** (< 3 s old): if heartbeats
   stop — a minimized, occluded, crashed, or frozen renderer — the broker fails
   closed and pays nothing, rather than trusting a stale latched value.
2. **Main-process window truth.** On top of the heartbeat the broker checks the
   owning window (`BrowserWindow.fromWebContents(...)`): if it is minimized,
   hidden, or **not focused** (`isMinimized() || !isVisible() || !isFocused()`),
   `active()` is false and nothing serves or pays.

Any lapse mid-window forfeits the in-flight impression and **restarts the 5 s
clock** — the 5 s must be *continuously* watched, so a view that was hidden,
unfocused, backgrounded, or went silent partway through can never bank a payment.
A visible **and focused** foreground window is the only state that earns.

## Known costs (by design, not bugs)

- **Code signature** — `Claude.app` is signed; editing `app.asar` invalidates the
  signature's seal over `Resources/`. The patcher does **not** re-sign (that would
  strip notarization and does nothing for the asar-integrity fuse anyway); it
  instead keeps the app bootable by fixing the `Info.plist` integrity pin (see
  above). The original signature is left untouched, and `unpatch-claude` restores
  the original asar **and** plist. On a machine where Gatekeeper hard-blocks a
  signature-invalidated bundle, this patch is simply not usable — that is a hard
  stop, not something to paper over with an ad-hoc re-sign.
- **Claude Desktop updates overwrite `app.asar`** (and `Info.plist`) — the patch
  and backups are gone after an update; re-run `idleai patch-claude`. Minified
  identifiers change every version, so the broker seam is matched **structurally**
  (by a regex over the WebContentsView/`CLAUDE_AI_WEB` factory), not by literal
  identifier.
- Editing a vendor's shipped app likely **violates Anthropic's terms** — a
  power-user opt-in, not something to ship enabled.

Everything is wrapped in `try/catch`: a broken broker or pill can never take the
Claude Desktop window down, and `unpatch-claude` restores a byte-identical asar
and the original `Info.plist`.

## Files

- `idleai-preload.js` — the display-only pill (appended to `mainView.js`).
- `host-broker.js` — the ad-server broker (injected into `index.js`).
- `asar.mjs` — dependency-free asar reader/writer for in-place file edits.
- `patch.mjs` — in-place asar patcher (`patch` / `unpatch` / `status` /
  `verify <asar|dir>`); driven by `idleai patch-claude` / `unpatch-claude`.
