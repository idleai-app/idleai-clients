# idleai companion — Windows tray

The Windows twin of `companion-mac`: serves **only while an assistant app owns
the foreground window** (Claude, ChatGPT, Codex, Grok, Gemini, Perplexity,
DeepSeek, Mistral/Le Chat, Windsurf — matched on window title or process name).
Windows trays are icon-only, so the ad line lives in the tray tooltip, with a
balloon notification when a new ad rotates in. No build step, no dependencies —
one PowerShell file using WinForms + user32.

## Run

```powershell
# auth once (shared with every idleai client)
npx idleai login idl_xxxxx --url https://your-idleai.app

powershell -ExecutionPolicy Bypass -File idleai-companion.ps1
```

Autostart: put a shortcut to that command in `shell:startup`.

## Behavior

- View pays after 5 continuous seconds with the assistant still foreground;
  rotation every 12s; tray menu **Open ad** pays 50×.
- Honors the machine-wide `idleai pause` flag (rechecked every 60s) plus its
  own Pause menu item.
- Quit from the tray menu.

## Status

⚠️ Written to the same contract as the verified macOS companion but **untested
on real Windows** — the P/Invoke surface (`GetForegroundWindow`,
`GetWindowText`, `GetWindowThreadProcessId`) and WinForms tray APIs are
stable/ancient, but give it one manual pass before distributing.
