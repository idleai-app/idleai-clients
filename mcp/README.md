# idleai MCP server — the connector-catalog build

Connectors are **model-invoked tools**, so they can't host the idle-time ad slot
(nothing runs while the assistant thinks). This server is the honest complement:
a utility connector that gives idleai catalog presence in every MCP client while
the real rendering clients (statusline, extensions, companions) own the slot.

Tools (all read-only against the developer's own account, except pause):

- `check_earnings` — today, balance, streak, level, leaderboard position
- `current_ad` — what's winning the screen right now (informational; never pays)
- `set_paused` — machine-wide pause/resume via the shared `~/.idleai.json` flag

Zero dependencies, stdio transport. Auth: `idleai login idl_xxx` once.

## Hook it up

**Claude Code** (`.mcp.json` or `claude mcp add`):

```json
{ "mcpServers": { "idleai": { "command": "node", "args": ["/path/to/clients/mcp/idleai-mcp.mjs"] } } }
```

**Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.idleai]
command = "node"
args = ["/path/to/clients/mcp/idleai-mcp.mjs"]
```

**Gemini CLI**: this directory is already a Gemini extension
(`gemini-extension.json`) — `gemini extensions install ./clients/mcp`.

**Claude.ai / ChatGPT / Grok web connectors** need a remote (HTTP) deployment —
wrap this server with an MCP streamable-HTTP transport when publishing there.

## Test

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"check_earnings","arguments":{}}}' \
  | node idleai-mcp.mjs
```
