---
description: Wire the idleai earning statusline into Claude Code (ad line while Claude thinks, earnings otherwise)
allowed-tools: Bash(node:*)
---

Run this exact command and show the user its output:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs"
```

If it reports "Not logged in", tell the user to grab a device token from their
idleai dashboard (Developer dashboard → Connect your tools) and run
`npx idleai login idl_xxxxx --url <their idleai URL>`, then run `/idleai:setup` again.

After a successful run, tell the user the statusline appears on their next
Claude Code turn, and that `/idleai:remove` (or rerunning the script with
`--remove`) undoes everything.
