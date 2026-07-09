#!/usr/bin/env node
// idleai statusline for Claude Code — the ad line shows while Claude thinks,
// a quiet earnings line otherwise. Wired via `/idleai:setup` (or manually:
// settings.json → "statusLine": {"type":"command","command":"node <this file>"}).
//
// Auth: ~/.idleai.json written by `idleai login idl_xxx` (clients/cli).
// The thinking window comes from ~/.idleai/claude-state.json (hooks/state.mjs).
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const GREEN = "\x1b[38;2;0;184;148m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
// A statusline must answer fast; a slow network beats showing nothing late.
const TIMEOUT_MS = 1500;
// A crashed turn must not pin the ad window open forever.
const THINKING_STALE_MS = 10 * 60 * 1000;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// Claude Code ≥ 2.1 lets its thinking verbs ("Percolating…") be replaced with
// a spinnerVerbs config. The CLI reads it from ~/.claude/settings.json; the
// VS Code/Cursor/Windsurf extension reads claudeCode.spinnerVerbs from the
// editor's own user settings and hot-reloads it. Keeping both equal to the
// live ad puts the creative inside the spinner for the exact thinking window;
// removing the keys hands the stock verbs back. Runs on every statusline
// refresh, so it writes only when the text actually changes.
function spinnerSettingsTargets() {
  const ide =
    process.platform === "darwin"
      ? (app) => join(homedir(), "Library", "Application Support", app, "User", "settings.json")
      : process.platform === "win32"
        ? (app) => join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), app, "User", "settings.json")
        : (app) => join(homedir(), ".config", app, "User", "settings.json");
  return [
    [join(homedir(), ".claude", "settings.json"), "spinnerVerbs"],
    ...["Code", "Code - Insiders", "Cursor", "Windsurf"].map((app) => [ide(app), "claudeCode.spinnerVerbs"]),
  ];
}

function syncSpinnerVerbs(text) {
  for (const [settingsPath, key] of spinnerSettingsTargets()) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const current = settings[key]?.verbs?.[0] ?? null;
      if (current === text) continue;
      if (text) settings[key] = { mode: "replace", verbs: [text] };
      else delete settings[key];
      // Atomic replace: the editor and Claude Code also write these files —
      // a plain truncating write could be read half-finished or corrupt them.
      const tmp = `${settingsPath}.idleai-${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(settings, null, 2));
      renameSync(tmp, settingsPath);
    } catch {} // absent or unparseable (e.g. JSONC comments) — leave that surface alone
  }
}

const cfg = readJson(join(homedir(), ".idleai.json"));
if (!cfg?.token) {
  console.log(`${DIM}✶ idleai — run: idleai login idl_xxx${RESET}`);
  process.exit(0);
}
if (cfg.paused) {
  syncSpinnerVerbs(null);
  console.log(`${DIM}✶ idleai paused${RESET}`);
  process.exit(0);
}

// Claude Code pipes session context on stdin; session_id keys the ad window.
let session = {};
try {
  session = JSON.parse(readFileSync(0, "utf8"));
} catch {}
const state = readJson(join(homedir(), ".idleai", "claude-state.json")) ?? {};
const s = state[session.session_id ?? "default"] ?? state.default;
const thinking = !!s?.thinking && Date.now() - (s.ts ?? 0) < THINKING_STALE_MS;
// Linger tier: after the response ends the ad may stay for the server-set
// window (next prompt reopens the thinking window via the hook anyway).
const sinceStop = s && !s.thinking ? Date.now() - (s.ts ?? 0) : Infinity;
const maybeInWindow = thinking || sinceStop < 10 * 60 * 1000; // optimistic cap; server window decides below

async function api(path, init = {}) {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data;
}

const usd = (micros) => `$${(micros / 1e6).toFixed(micros !== 0 && micros < 10000 ? 4 : 2)}`;
// Creatives may end with the brand ↗ — the client renders its own accent arrow.
const adText = (t) => t.replace(/\s*↗\s*$/u, "");

const REASONS = {
  vpn_detected: "VPN detected — disconnect to earn",
  geo_mismatch: "country mismatch — fix your location in the dashboard",
  busy_elsewhere: "another device is earning — this one stands by",
};

try {
  const [res, stats] = await Promise.all([
    maybeInWindow ? api("/api/serve") : Promise.resolve({ ad: null }),
    api("/api/customer/stats").catch(() => null),
  ]);
  const inWindow = thinking || sinceStop <= (res.lingerSeconds ?? 30) * 1000;
  const ad = inWindow ? res.ad : null;
  syncSpinnerVerbs(ad ? adText(ad.text) : null);
  const today = stats ? usd(stats.stats.today_micros) : "";
  if (!ad && REASONS[res.reason]) {
    console.log(`${YELLOW}✶${RESET} ${DIM}idleai — ${REASONS[res.reason]}${RESET}`);
    process.exit(0);
  }
  if (ad) {
    // Statuslines aren't clickable — /idleai:open reads this to open the ad.
    const lastAdPath = join(homedir(), ".idleai", "last-ad.json");
    try {
      mkdirSync(dirname(lastAdPath), { recursive: true });
      writeFileSync(lastAdPath, JSON.stringify({ ...ad, servedAt: Date.now() }));
    } catch {}
    // Claude Code refreshes the statusline as it works; the server's 4s pacing
    // guard turns those refreshes into correctly-metered paid views.
    api("/api/events", {
      method: "POST",
      body: JSON.stringify({ campaignId: ad.campaignId, type: "impression" }),
    }).catch(() => {});
    const star = ad.takeover ? `${YELLOW}✶${RESET}` : `${GREEN}✶${RESET}`;
    console.log(`${star} ${adText(ad.text)} ${GREEN}↗${RESET} ${DIM}· idleai ${today} today${RESET}`);
  } else {
    console.log(`${DIM}✶ idleai · ${today || "$0.00"} today${RESET}`);
  }
} catch {
  syncSpinnerVerbs(null);
  console.log(`${DIM}✶ idleai offline${RESET}`);
}
