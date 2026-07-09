#!/usr/bin/env node
// idleai thinking-window tracker. Hooks call `state.mjs start|stop` with the
// Claude Code hook payload on stdin; the statusline reads the resulting file to
// decide whether the assistant is mid-turn (= the ad window is open).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const STATE_PATH = join(homedir(), ".idleai", "claude-state.json");
const DAY_MS = 24 * 60 * 60 * 1000;

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

const mode = process.argv[2];
if (!["start", "stop"].includes(mode)) process.exit(0);

const payload = readStdin();
const sessionId = payload.session_id ?? "default";

const state = loadState();
const now = Date.now();
// Prune dead sessions so the file never grows unbounded.
for (const [id, s] of Object.entries(state)) {
  if (now - (s.ts ?? 0) > DAY_MS) delete state[id];
}
state[sessionId] = { thinking: mode === "start", ts: now };

mkdirSync(dirname(STATE_PATH), { recursive: true });
writeFileSync(STATE_PATH, JSON.stringify(state));
