# idleai clients

The install-anywhere clients for [idleai](https://idleai.app) — while your AI
assistant thinks, one tasteful ad line shows on your screen and the revenue is
split with you. Every client is a thin loop over two HTTPS endpoints with a
device token; none of them contain server code or secrets.

## Install

| Surface | How |
|---|---|
| Terminal / CLI | `npm i -g idleai` then `idleai login idl_xxx` and `idleai run` |
| Claude Code | `/plugin marketplace add idleai-app/idleai-clients` then `/plugin install idleai@idleai` |
| VS Code / Cursor / Windsurf | install the extension from `vscode/` |
| Browser | load `browser/` (claude.ai, chatgpt.com, grok, gemini, mistral, perplexity, deepseek) |
| macOS | build `companion-mac/` |
| Windows | run `companion-windows/idleai-companion.ps1` |
| Replit | `replit/` extension pane |
| MCP | `mcp/` stdio utility server |

See each client's own README for details.

## License

Apache-2.0 — see [LICENSE](LICENSE).
