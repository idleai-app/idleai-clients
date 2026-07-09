#!/usr/bin/env node
// Wire (or unwire, with --remove) the idleai statusline into ~/.claude/settings.json.
// Invoked by the /idleai:setup slash command; safe to run by hand.
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const settingsPath = join(homedir(), ".claude", "settings.json");
const statuslinePath = join(dirname(fileURLToPath(import.meta.url)), "statusline.mjs");
const remove = process.argv.includes("--remove");

let settings = {};
mkdirSync(dirname(settingsPath), { recursive: true });
if (existsSync(settingsPath)) {
  copyFileSync(settingsPath, `${settingsPath}.idleai-backup`);
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    console.error(`Could not parse ${settingsPath} — fix it first (backup saved).`);
    process.exit(1);
  }
}

if (remove) {
  delete settings.statusLine;
  delete settings.spinnerVerbs; // statusline.mjs mirrors the live ad into this key
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  // The IDE extensions read the spinner from the editor's own user settings
  // (claudeCode.spinnerVerbs, also written by statusline.mjs) — clean those too.
  const ideSettings =
    process.platform === "darwin"
      ? (app) => join(homedir(), "Library", "Application Support", app, "User", "settings.json")
      : process.platform === "win32"
        ? (app) => join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), app, "User", "settings.json")
        : (app) => join(homedir(), ".config", app, "User", "settings.json");
  for (const app of ["Code", "Code - Insiders", "Cursor", "Windsurf"]) {
    try {
      const path = ideSettings(app);
      const s = JSON.parse(readFileSync(path, "utf8"));
      if (!("claudeCode.spinnerVerbs" in s)) continue;
      delete s["claudeCode.spinnerVerbs"];
      writeFileSync(path, JSON.stringify(s, null, 2));
    } catch {}
  }
  console.log("✶ idleai statusline and spinner removed from Claude Code and editor settings.");
  process.exit(0);
}

if (!existsSync(join(homedir(), ".idleai.json"))) {
  console.error("Not logged in yet — get a device token from your idleai dashboard, then run:");
  console.error("  npx idleai login idl_xxxxx --url https://your-idleai.app");
  process.exit(1);
}

// process.execPath, not bare `node`: GUI-launched Claude Code (desktop app,
// IDE extensions) runs statusline commands without the shell PATH.
settings.statusLine = { type: "command", command: `"${process.execPath}" "${statuslinePath}"` };
writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
console.log("✶ idleai wired in — the ad takes over the thinking spinner (Claude Code 2.1+), with the full line + earnings in the statusline below.");
console.log(`  (backup at ${settingsPath}.idleai-backup — rerun with --remove to undo)`);
