# idleai — VS Code / Cursor extension

The idleai earning line in your status bar: the current winning ad + your earnings.
Views pay after 5 full seconds on a focused window; clicking the item opens the ad
and pays 50×. Works in VS Code, Cursor and Windsurf (both install VS Code
extensions / OpenVSX).

## Install

```bash
cd clients/vscode
npx @vscode/vsce package        # → idleai-0.1.0.vsix
code --install-extension idleai-0.1.0.vsix     # or: cursor --install-extension …
```

Then either:

- run **“Idleai: Sign in with device token”** from the command palette, or
- do nothing — if you already ran `idleai login` (the CLI), the extension reuses
  `~/.idleai.json` automatically.

## Behavior

- Status bar (right): `✶ <ad text> ↗ · $0.42 today` (⭐ marks a takeover).
- Timed to the thinking window, from two kinds of signals: Claude Code's hooks
  (`~/.idleai/claude-state.json`) and agent-CLI session writes — Codex (IDE
  extension and CLI, `~/.codex/sessions`), Gemini CLI (`~/.gemini/tmp`) and
  Grok CLI (`~/.grok`) all write session artifacts while a turn runs, so fresh
  mtimes there count as thinking. With any signal present, the ad shows only
  while an assistant works (plus the server's linger window). Without any
  signal, any focused moment stays eligible.
- An impression only posts after the ad sat 5s on a **focused** window —
  unfocused editors never earn (honest views only).
- `Idleai: Pause / resume` stops serving instantly; `idleai pause` (CLI) pauses
  every client on the machine at once. `Idleai: Sign out` clears the token.
- Token lives in VS Code's SecretStorage, never in settings.
