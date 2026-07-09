# idleai — Claude Code plugin

The ad rides the thinking spinner: while Claude works, the creative shows where
"Percolating…" would (Claude Code 2.1+), with the full ad line + earnings in the
statusline underneath. Outside the thinking window both hand back to stock.

The spinner takeover works everywhere the spinner renders — terminal CLI, IDE
extension panels, desktop app. The statusline is CLI-only; on panel-only
surfaces the spinner is the ad slot and the idleai VS Code extension or macOS
companion carries the earnings line.

## Install

```bash
# 1. Auth (once per machine) — token from your idleai dashboard
npx idleai login idl_xxxxx --url https://your-idleai.app

# 2. Add the marketplace + plugin (inside Claude Code)
/plugin marketplace add idleai-app/idleai-clients
/plugin install idleai@idleai

# 3. Wire the statusline
/idleai:setup
```

## How it works

- `hooks/hooks.json` — `UserPromptSubmit` opens the ad window, `Stop`/`SessionEnd`
  close it (state in `~/.idleai/claude-state.json`, per session, self-pruning).
- `scripts/statusline.mjs` — Claude Code re-runs this as it works. While the window
  is open it fetches `GET /api/serve`, prints the line, and posts an impression;
  the server's 4s pacing guard meters refreshes into correctly-paid views. Outside
  the window it prints `✶ idleai · $x.xx today` and never serves.
- The spinner takeover is the same loop: each refresh mirrors the live ad text
  into Claude Code's supported spinner-verb override
  (`{"mode":"replace","verbs":[ad]}`) — as `spinnerVerbs` in
  `~/.claude/settings.json` for the CLI, and as `claudeCode.spinnerVerbs` in
  the editor's own user settings for the VS Code/Cursor/Windsurf extension
  (which hot-reloads it mid-session). Both keys are deleted when there is no
  ad, restoring the stock verbs. Display only; impressions are still metered
  by the statusline fetches above.
- `scripts/setup.mjs` — writes `statusLine` into `~/.claude/settings.json`
  (backs up first; `--remove` undoes both keys).

## Commands

- `/idleai:setup` — wire the statusline (backs up settings first)
- `/idleai:open` — open the current ad in your browser; a click pays 50× a view
  (statuslines aren't clickable, so this is the click surface)
- `/idleai:remove` — unwire the statusline

`idleai pause` / `idleai resume` (CLI) pause and resume every client on the
machine, this statusline included.

## Uninstall

`/idleai:remove`, then `/plugin uninstall idleai@idleai`.
