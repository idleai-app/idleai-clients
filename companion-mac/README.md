# idleai companion — macOS menu bar

The desktop-app answer: native assistants (Claude Desktop, ChatGPT, Codex app,
Grok, Gemini) can't be injected, so the companion puts the ticker in the menu bar
and **only serves while one of those apps is frontmost** — that's when the user is
staring at a spinner anyway. No Accessibility permission, no app tampering:
frontmost-app detection is plain public API (`NSWorkspace`).

## Build & run

```bash
# auth once (shared with every idleai client)
npx idleai login idl_xxxxx --url https://your-idleai.app

cd clients/companion-mac
./build.sh            # swiftc → "Idleai Companion.app"
open "Idleai Companion.app"
```

## Behavior

- Menu bar shows `✶ <ad text> ↗ $0.42` while an assistant app is focused,
  a quiet `✶ $0.42` otherwise. `⭐` marks a takeover.
- A view pays after 5 continuous seconds with the assistant still frontmost;
  the winner rotates every 12s. Switching away hides and stops everything.
- Menu: **Open ad** (pays 50×), today's earnings, **Pause**, Quit.
- Detection is by app name/bundle id (`claude`, `chatgpt`, `codex`, `grok`,
  `gemini`) — extend `assistantNames` in `main.swift` for new assistants.
- Terminals (Terminal, iTerm2, Warp, Ghostty, kitty, Alacritty, WezTerm, …)
  also count, but only while an agent CLI is actually working there — fresh
  writes under `~/.codex/sessions`, `~/.gemini/tmp` or `~/.grok` within 15s.
  These TUIs have no hook for custom status-line text, so the menu bar is the
  honest slot beside them.

## Distribution note

Nothing here needs entitlements, so this can be sandboxed/notarized normally —
unlike an Accessibility-overlay approach, App Store distribution stays open.
