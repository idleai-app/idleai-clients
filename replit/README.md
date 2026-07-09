# idleai — Replit Extension

The idleai earning pane inside a Replit workspace: the ✶ pill, today/session
earnings, click-to-open (50×), pause. Honest views only — a hidden pane never
serves or pays (`document.hidden`).

## Develop / install

1. Create a Replit Extension repl and copy this directory in (`extension.json`,
   `index.html`, `icon.png` — it's a static webview, no build).
2. Run the extension in the workspace (Extension Devtools → Load), open the
   **idleai** tool pane, paste your server URL + device token.

The pane talks straight to your idleai server with the Bearer token — the
server's CORS middleware (`src/middleware.ts`) allows the four client endpoints
from any origin (token-auth only, no cookies).

Quick alternative without the extension: `npm i -g idleai && idleai run`
in a shell split pane.
