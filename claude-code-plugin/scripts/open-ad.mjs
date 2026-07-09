#!/usr/bin/env node
// Open the last ad the statusline served and record the click (pays 50× a view).
// Invoked by the /idleai:open slash command.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";

const STALE_MS = 15 * 60 * 1000; // don't pay a click on an ad nobody just saw

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const cfg = readJson(join(homedir(), ".idleai.json"));
if (!cfg?.token) {
  console.log("Not logged in — run: idleai login idl_xxx");
  process.exit(1);
}
const ad = readJson(join(homedir(), ".idleai", "last-ad.json"));
if (!ad?.url || Date.now() - (ad.servedAt ?? 0) > STALE_MS) {
  console.log("No current ad — the statusline serves one while Claude works.");
  process.exit(0);
}

const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
execFile(opener, [ad.url], () => {});

const res = await fetch(`${cfg.baseUrl}/api/events`, {
  method: "POST",
  headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ campaignId: ad.campaignId, type: "click" }),
}).catch(() => null);
const data = res ? await res.json().catch(() => ({})) : {};
if (data.ok) {
  console.log(`✶ opened ${ad.url} — click recorded (+$${(data.customer_share_micros / 1e6).toFixed(4)})`);
} else {
  console.log(`✶ opened ${ad.url} (click not recorded: ${data.reason ?? "offline"})`);
}
