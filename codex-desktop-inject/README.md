# idleai — Codex Desktop injection (opt-in, reversible)

Codex Desktop (`Codex.app`, OpenAI's Electron chat app — **not** the VS Code
extension) has no hook of its own: no statusline, no spinner override. The only
way to draw the ✶ ad line *inside* the Codex window is to patch OpenAI's
installed `app.asar`. That is what `patch.mjs` does, and it is fully reversible.

```bash
node patch.mjs status          # is Codex patched? show integrity hashes + backups
node patch.mjs patch --dry-run # patch a COPY, verify every step, touch nothing live
node patch.mjs patch           # inject the ✶ line (needs App Management, see below)
node patch.mjs unpatch         # restore the original bytes (incl. signature)
```

Default app path is `/Applications/Codex.app`; override with `--app <path>`.

## The two halves (display-only pill + main-process broker)

Same split as the VS Code case, but cleaner: this is a normal Electron
main-process + renderer app (no `acquireVsCodeApi`, no nested webview).

- **`webview/index.html`** gets one `<script src="./assets/idleai-line.js">`.
  That copied-in script (`idleai-line.js`) is **display-only**: it runs in the
  CSP-locked renderer with no Node, never fetches, never posts out, never
  touches Codex's IPC bridge. It only listens for inbound `window` "message"
  events and renders a single ✶ pill pinned above the composer. It owns exactly
  one DOM node, so it can never affect Codex's boot.
- **`.vite/build/main-DVEWN1ng.js`** gets `main-broker.js` inserted inside the
  primary window's `did-finish-load` callback (anchor: `setZoomLevel(0)`). The
  broker's IIFE is invoked with the **minified identifier the anchor regex
  captured** for that `BrowserWindow` — the patcher rewrites the broker's
  `})(__IDLEAI_WIN__);` tail to the real var name, so a Codex rebuild that
  renames the window variable still binds correctly (it never assumes `A`). The
  broker runs in the Electron **main process** — full Node, no CSP, `fetch`
  available. It owns the timer (1s), reads `~/.idleai.json` for the device
  token, gates on the `~/.codex/sessions` thinking signal, calls `/api/serve`
  `/api/events` `/api/customer/stats` at `http://localhost:3000`, records the 5s
  impression itself, and pushes ad state into the renderer via
  `webContents.executeJavaScript(window.postMessage(...))`. Codex's own preload
  re-dispatches host messages as `window` "message" events, so the injected
  `postMessage` reaches the pill natively.

### Honest-view is gated on a fresh renderer heartbeat

Each 1s tick the broker runs a tiny probe **inside the renderer** via
`executeJavaScript` and reads back one boolean:
`document.visibilityState==='visible' && document.hidden===false &&
document.hasFocus()` **and** the pill is actually displayed. The 5s impression
timer accumulates only while that heartbeat is true and **resets to zero the
instant it lapses** — a hidden tab, an unfocused window, or an occluded/
background-composited window all forfeit the in-progress view. Main-process
`win.isVisible()/isFocused()` is used only as a cheap short-circuit; the
renderer's own `document` state is the source of truth. A view pays only after
5 continuous heartbeat-true seconds.

### Clicks — no `setWindowOpenHandler`

The broker does **not** call `webContents.setWindowOpenHandler`. Electron keeps
only one window-open handler and Codex installs its own (chat links, OAuth
popups), so replacing it would clobber Codex's links or, with a deny default,
break every non-ad link. Instead the pill `<a>` calls `preventDefault()` on
click — so no window-open ever fires — and stashes `{url, ts}` on a renderer
global. The broker reads and clears that global each tick and opens the
(already UTM-tagged) url with `shell.openExternal`, recording one `click`
event. **Codex's own handler is left entirely untouched.**

The creative's trailing `↗` is stripped and the pill draws its own accent arrow.

## The one operational gate: macOS App Management

`/Applications/Codex.app` is write-protected by macOS App Management
(`com.apple.provenance` + SIP). **Reads and copy-out work; writes/`mv` into the
bundle fail with `EPERM`** unless your terminal holds the permission. The
patcher preflights this and, if blocked, prints the fix and exits without
leaving a half-patched bundle:

> System Settings → Privacy & Security → **App Management** → enable your
> terminal (Terminal / iTerm / etc.). Then fully quit Codex and re-run.

`--dry-run` never needs this permission (it patches a staging copy).

## What the patch does, step by step

1. Preflight: read the shipped integrity hash from `Info.plist`, confirm the
   live asar hash matches (warns if already patched / Codex updated).
2. Extract `app.asar` to a staging tree.
3. Inject the three edits (marked `__IDLEAI__` / `__IDLEAI_BROKER__` for
   idempotency — re-runs skip already-patched files). The broker's window var is
   substituted from the captured anchor identifier.
4. Repack, preserving the native modules (`better-sqlite3`, `node-pty`,
   `objc-js`) as unpacked.
5. Recompute the asar integrity hash
   (`sha256(asar.getRawHeader(newAsar).headerString)` — proven to reproduce the
   shipped value exactly) into a **staged** copy of the plist and verify it took.
6. **Writability preflight of every dir a mutation touches**:
   `Contents/Resources`, `Contents`, `Contents/_CodeSignature`, and the parent
   dir of the sidecar backup. If any is blocked, exit BEFORE touching anything.
7. Back up the originals into a sidecar dir **next to** the `.app`
   (`<App>.app.idleai-backup/`), never inside the bundle (a `_CodeSignature`
   copy inside `Contents/` makes `codesign --deep` fail): `app.asar`,
   `Info.plist`, `app.asar.unpacked`, and the whole original `_CodeSignature`.
8. **Transactional swap**: after every mutation above has succeeded, swap in the
   patched `app.asar` + `app.asar.unpacked`, write the verified plist, then
   ad-hoc re-sign (`codesign --force --deep --sign -`) and `codesign --verify`.
   The entire live apply is wrapped in `try/catch`; **any failure rolls back to
   the pre-patch bytes** and removes the backups this run created — no
   half-patched, boot-bricked bundle.
9. Fully quit Codex (Cmd-Q) and relaunch.

`unpatch` restores `app.asar`, `Info.plist`, and `app.asar.unpacked`
byte-identically, then restores the original `_CodeSignature` and runs
`codesign --verify`. When the signature backup is present and re-validates, the
app carries **OpenAI's original Developer-ID signature** again and the on-disk
bundle matches the shipped one. If the restored signature does not re-validate
(some other byte differs), `unpatch` falls back to an ad-hoc re-sign and **says
so** — it never falsely claims the Developer-ID seal was restored.

## Known costs (by design, not bugs)

- **App Management permission** is required for the live swap (see above).
- **While patched, the bundle is ad-hoc signed**, not Developer-ID signed —
  our asar/plist edits break the sealed hardened-runtime signature, so we ad-hoc
  re-sign. Gatekeeper may prompt once on first relaunch. `unpatch` restores the
  original `_CodeSignature`, so after unpatch the Developer-ID signature is back
  (when it re-validates; otherwise unpatch tells you it stayed ad-hoc). The
  server-side notarization ticket is unaffected either way. Codex config
  (`~/.codex`) and userData (Application Support/Codex) are never touched.
- **Integrity fuse** (`EmbeddedAsarIntegrityValidation` on): a modified asar
  will not load unless the plist hash is updated — the patcher does this.
- **Codex auto-updates (Sparkle) overwrite the bundle** and wipe the patch —
  re-run `patch` after an update. Idempotency markers make re-runs safe.
- The main.js anchor is version-fragile; it is matched by a loose regex on
  `did-finish-load` + `setZoomLevel(0)`. The pill is `position:fixed` and
  anchor-free, so renderer/asset-hash changes don't break it.

Everything host-side is wrapped in `try/catch`: a broken broker can never take
Codex's window down, the live apply rolls back on any failure, and `unpatch`
restores the byte-identical originals including the original signature.

Editing a vendor's shipped app likely violates OpenAI's terms — this is a
power-user opt-in, not something to ship enabled.
