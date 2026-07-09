#!/usr/bin/env node
/**
 * idleai CLI — your terminal earns while your AI thinks.
 *
 *   idleai login <device-token> [--url http://localhost:3000]
 *   idleai run              live ad line in this terminal (o = open/click, q = quit)
 *   idleai codex [args…]    run the Codex CLI with the ad line under it (tmux)
 *   idleai gemini|grok      same wrapper for the Gemini and Grok CLIs
 *   idleai statusline       one-shot line for Claude Code's statusLine integration
 *   idleai setup-claude     wire `idleai statusline` into ~/.claude/settings.json
 *   idleai patch-codex      inject the ad line INSIDE the Codex VS Code panel
 *   idleai unpatch-codex    restore Codex's original files
 *   idleai patch-devin      inject the ad line INSIDE the Devin (Windsurf) Cascade panel
 *   idleai unpatch-devin    restore Devin's original files
 *   idleai patch-cursor     inject the ad line INSIDE the Cursor Composer panel (ad-hoc re-signs Cursor.app)
 *   idleai unpatch-cursor   restore Cursor's original files
 *
 * Zero dependencies. Auth = device token from your idleai dashboard
 * (Developer dashboard → Connect your tools).
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, renameSync, readdirSync, statSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import readline from "node:readline";

const CONFIG_PATH = join(homedir(), ".idleai.json");
const GREEN = "\x1b[38;2;0;184;148m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
}

function requireConfig() {
  const cfg = loadConfig();
  if (!cfg?.token) {
    console.error(`Not logged in. Get a device token from your dashboard, then:\n  idleai login idl_xxxxx`);
    process.exit(1);
  }
  return cfg;
}

async function api(cfg, path, init = {}) {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data;
}

const usd = (micros) => `$${(micros / 1e6).toFixed(micros !== 0 && micros < 10000 ? 4 : 2)}`;

// Creatives may end with the brand ↗ — the client renders its own accent arrow.
const adText = (t) => t.replace(/\s*↗\s*$/u, "");

// Server-refusal reasons worth surfacing to the developer.
const REASONS = {
  vpn_detected: "VPN detected — disconnect to earn",
  geo_mismatch: "country mismatch — fix your location in the dashboard",
  killswitch: "paused by server",
  busy_elsewhere: "another device is earning — this one stands by",
};

function openUrl(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(cmd, [url], () => {});
}

async function cmdLogin(args) {
  const token = args.find((a) => a.startsWith("idl_"));
  if (!token) {
    console.error("usage: idleai login idl_xxxxx [--url http://localhost:3000]");
    process.exit(1);
  }
  const urlIdx = args.indexOf("--url");
  const baseUrl = urlIdx >= 0 ? args[urlIdx + 1] : loadConfig()?.baseUrl ?? "http://localhost:3000";
  const cfg = { token, baseUrl };
  const me = await api(cfg, "/api/me").catch((e) => {
    console.error(`Token rejected by ${baseUrl}: ${e.message}`);
    process.exit(1);
  });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  console.log(`${GREEN}✶${RESET} Signed in as ${me.user.email} — config saved to ~/.idleai.json`);
}

function cmdPause(on) {
  const cfg = requireConfig();
  cfg.paused = on;
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  console.log(
    on
      ? `${DIM}✶ idleai paused everywhere on this machine (statusline, companion, run) — \`idleai resume\` to earn again${RESET}`
      : `${GREEN}✶${RESET} idleai resumed — earning again`
  );
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

// Codex/Gemini/Grok CLIs have no statusLine/spinnerVerbs equivalent, but each
// writes session artifacts under its home dir on every turn event — the age
// of the newest write is the thinking signal, same as the VS Code extension
// and the macOS companion use.
function codexActivityAge() {
  try {
    let dir = join(homedir(), ".codex", "sessions");
    for (let depth = 0; depth < 3; depth++) {
      const subs = readdirSync(dir).filter((n) => /^\d+$/.test(n));
      if (!subs.length) return Infinity;
      dir = join(dir, subs.sort((a, b) => Number(a) - Number(b)).pop());
    }
    let latest = 0;
    for (const f of readdirSync(dir)) {
      const m = statSync(join(dir, f)).mtimeMs;
      if (m > latest) latest = m;
    }
    return latest ? Date.now() - latest : Infinity;
  } catch {
    return Infinity;
  }
}

// Newest-write age under a directory tree, bounded (depth + stat budget) so a
// 5s statusline refresh never turns into a filesystem crawl. Subdirectories
// are visited newest-mtime-first so the active session's branch is reached
// before months of stale ones exhaust the budget.
function newestWriteAge(dir, depth, budget) {
  let latest = 0;
  const walk = (d, left) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs = [];
    for (const e of entries) {
      if (budget.files <= 0) return;
      const p = join(d, e.name);
      try {
        const m = statSync(p).mtimeMs;
        if (e.isDirectory()) {
          dirs.push([p, m]);
          continue;
        }
        budget.files--;
        if (m > latest) latest = m;
      } catch {}
    }
    if (left <= 0) return;
    dirs.sort((a, b) => b[1] - a[1]);
    for (const [p] of dirs) {
      if (budget.files <= 0) return;
      walk(p, left - 1);
    }
  };
  walk(dir, depth);
  return latest ? Date.now() - latest : Infinity;
}

const AGENT_AGES = {
  codex: codexActivityAge,
  gemini: () => newestWriteAge(join(homedir(), ".gemini", "tmp"), 5, { files: 600 }),
  grok: () => newestWriteAge(join(homedir(), ".grok"), 4, { files: 400 }),
};
const agentAge = (name) =>
  name === "any" ? Math.min(...Object.values(AGENT_AGES).map((fn) => fn())) : AGENT_AGES[name]();
// ~15s active-write slack + the server's linger tier (cached from the last
// serve; 30s until a first serve has told us otherwise).
function agentWindowMs() {
  let linger = 30;
  try {
    const last = JSON.parse(readFileSync(join(homedir(), ".idleai", "last-ad.json"), "utf8"));
    if (typeof last.lingerSeconds === "number") linger = last.lingerSeconds;
  } catch {}
  return 15_000 + linger * 1000;
}

async function cmdStatusline(args = []) {
  const cfg = requireConfig();
  // --tmux: tmux status-right mode — #[…] styles instead of ANSI, and never
  // touch Claude's spinnerVerbs (that surface belongs to Claude refreshes).
  // --gate <codex|gemini|grok|any>: only serve while that agent CLI is inside
  // its thinking/linger window (--codex-gate is the legacy spelling).
  const tmuxMode = args.includes("--tmux");
  const gateIdx = args.indexOf("--gate");
  const gate = args.includes("--codex-gate")
    ? "codex"
    : gateIdx >= 0 && AGENT_AGES[args[gateIdx + 1]]
      ? args[gateIdx + 1]
      : gateIdx >= 0
        ? "any"
        : null;
  const paint = tmuxMode
    ? { star: "#[fg=#00b894]✶#[default]", takeover: "#[fg=#fde047]✶#[default]", arrow: "#[fg=#00b894]↗#[default]", dim: (s) => `#[dim]${s}#[default]`, warn: "#[fg=yellow]✶#[default]" }
    : { star: `${GREEN}✶${RESET}`, takeover: `${YELLOW}✶${RESET}`, arrow: `${GREEN}↗${RESET}`, dim: (s) => `${DIM}${s}${RESET}`, warn: `${YELLOW}✶${RESET}` };
  const sync = tmuxMode ? () => {} : syncSpinnerVerbs;
  if (cfg.paused) {
    sync(null);
    console.log(paint.dim("✶ idleai paused"));
    return;
  }
  if (gate && agentAge(gate) > agentWindowMs()) {
    // Agent idle: show quiet earnings, don't serve, don't pay.
    const stats = await api(cfg, "/api/customer/stats").catch(() => null);
    console.log(paint.dim(`✶ idleai${stats ? ` · ${usd(stats.stats.today_micros)} today` : ""}`));
    return;
  }
  try {
    const [{ ad, reason, lingerSeconds }, stats] = await Promise.all([
      api(cfg, "/api/serve"),
      api(cfg, "/api/customer/stats").catch(() => null),
    ]);
    sync(ad ? adText(ad.text) : null);
    const today = stats ? usd(stats.stats.today_micros) : "";
    if (!ad && REASONS[reason]) {
      console.log(`${paint.warn} ${paint.dim(`idleai — ${REASONS[reason]}`)}`);
      return;
    }
    if (ad) {
      // Statuslines and spinners aren't clickable — `idleai open` (and the
      // plugin's /idleai:open) read this to open the ad and record the click.
      try {
        mkdirSync(join(homedir(), ".idleai"), { recursive: true });
        writeFileSync(
          join(homedir(), ".idleai", "last-ad.json"),
          JSON.stringify({ ...ad, servedAt: Date.now(), lingerSeconds })
        );
      } catch {}
      // Server-side pacing guards make repeated statusline refreshes safe.
      api(cfg, "/api/events", {
        method: "POST",
        body: JSON.stringify({ campaignId: ad.campaignId, type: "impression" }),
      }).catch(() => {});
      const star = ad.takeover ? paint.takeover : paint.star;
      console.log(`${star} ${adText(ad.text)} ${paint.arrow} ${paint.dim(`· idleai ${today} today`)}`);
    } else {
      console.log(paint.dim(`✶ idleai — no live campaigns · ${today} today`));
    }
  } catch {
    sync(null);
    console.log(paint.dim("✶ idleai offline"));
  }
}

// `idleai codex|gemini|grok [args…]` — these agent CLIs have no statusline
// hook of their own, so run them inside tmux and put the ad in the tmux status
// bar: same terminal, one row down, timed to the thinking window via each
// agent's session-write signal. Clicks go through `idleai open` (a status bar
// isn't clickable).
async function cmdWrap(tool, args) {
  requireConfig();
  if (spawnSync("tmux", ["-V"], { stdio: "ignore" }).error) {
    console.error(`✶ \`idleai ${tool}\` draws its line in a tmux status bar — install tmux first (brew install tmux)`);
    process.exit(1);
  }
  const self = fileURLToPath(import.meta.url);
  const statusCmd = `"${process.execPath}" "${self}" statusline --tmux --gate ${tool}`;
  const OPTIONS = [
    ["status-interval", "5"], // server pacing refuses impressions under 4s apart
    ["status-left", ""],
    ["status-right-length", "200"],
    ["status-right", `#(${statusCmd})`],
    ["status-style", "bg=default"],
  ];
  if (process.env.TMUX) {
    // Already inside tmux: borrow this session's status bar for the run, then
    // hand every option back exactly as it was.
    const prev = OPTIONS.map(([key]) => {
      const out = spawnSync("tmux", ["show-options", "-qv", key], { encoding: "utf8" });
      return [key, out.stdout?.replace(/\n$/, "") ?? ""];
    });
    for (const [key, value] of OPTIONS) spawnSync("tmux", ["set-option", key, value]);
    const restore = () => {
      for (const [key, value] of prev) {
        spawnSync("tmux", value === "" ? ["set-option", "-u", key] : ["set-option", key, value]);
      }
    };
    const child = spawn(tool, args, { stdio: "inherit" });
    child.on("error", (e) => {
      // Missing binary must still hand the borrowed status bar back.
      restore();
      console.error(`✶ could not start \`${tool}\`: ${e.message}`);
      process.exit(1);
    });
    child.on("exit", (code) => {
      restore();
      process.exit(code ?? 0);
    });
    return;
  }
  const inner = [tool, ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
  const tmuxArgs = ["new-session", "-n", tool, inner];
  for (const [key, value] of OPTIONS) tmuxArgs.push(";", "set-option", key, value);
  const child = spawn("tmux", tmuxArgs, { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}

async function cmdRun() {
  const cfg = requireConfig();
  if (cfg.paused) {
    console.log(`${DIM}✶ idleai is paused — run \`idleai resume\` first${RESET}`);
    process.exit(0);
  }
  let ad = null;
  let today = 0;
  let session = 0;
  let lastReason = null;

  const render = () => {
    process.stdout.write("\r\x1b[2K");
    if (!ad && REASONS[lastReason]) {
      process.stdout.write(`${YELLOW}✶${RESET} ${DIM}${REASONS[lastReason]} · [q]uit${RESET}`);
      return;
    }
    if (ad) {
      const star = ad.takeover ? `${YELLOW}✶${RESET}` : `${GREEN}✶${RESET}`;
      process.stdout.write(
        `${star} ${adText(ad.text)} ${GREEN}↗${RESET}  ${DIM}today ${usd(today)} · session +${usd(session)} · [o]pen [q]uit${RESET}`
      );
    } else {
      process.stdout.write(`${DIM}✶ waiting for inventory…${RESET}`);
    }
  };

  const refreshStats = async () => {
    const s = await api(cfg, "/api/customer/stats").catch(() => null);
    if (s) today = s.stats.today_micros;
  };

  const cycle = async () => {
    const res = await api(cfg, "/api/serve").catch(() => ({ ad: null }));
    ad = res.ad;
    lastReason = res.reason ?? null;
    render();
    if (!ad) {
      // No inventory / refused: breathe instead of hammering the rate limit.
      await new Promise((r) => setTimeout(r, 3000));
      return;
    }
    // View threshold: the line must actually sit here for 5 seconds.
    await new Promise((r) => setTimeout(r, 5000));
    const ev = await api(cfg, "/api/events", {
      method: "POST",
      body: JSON.stringify({ campaignId: ad.campaignId, type: "impression" }),
    }).catch(() => null);
    if (ev?.ok) {
      session += ev.customer_share_micros;
      today += ev.customer_share_micros;
    }
    render();
  };

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on("keypress", async (_str, key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      process.stdout.write(`\n${GREEN}✶${RESET} session earned ${usd(session)} — bye\n`);
      process.exit(0);
    }
    if (key.name === "o" && ad) {
      openUrl(ad.url);
      const ev = await api(cfg, "/api/events", {
        method: "POST",
        body: JSON.stringify({ campaignId: ad.campaignId, type: "click" }),
      }).catch(() => null);
      if (ev?.ok) {
        session += ev.customer_share_micros;
        today += ev.customer_share_micros;
        render();
      }
    }
  });

  console.log(`${GREEN}✶ idleai${RESET} — earning while you wait. ${DIM}[o] opens the ad (pays 50×), [q] quits${RESET}\n`);
  await refreshStats();
  setInterval(refreshStats, 30000);
  // Serve → view 5s → record → next, forever.
  for (;;) await cycle();
}

// The spinner and statusline aren't clickable, so this is the click surface:
// open the last ad the statusline served and record the click (pays 50× a view).
async function cmdOpen() {
  const cfg = requireConfig();
  const STALE_MS = 15 * 60 * 1000; // don't pay a click on an ad nobody just saw
  let ad = null;
  try {
    ad = JSON.parse(readFileSync(join(homedir(), ".idleai", "last-ad.json"), "utf8"));
  } catch {}
  if (!ad?.url || Date.now() - (ad.servedAt ?? 0) > STALE_MS) {
    console.log(`${DIM}✶ no current ad — the statusline serves one while Claude works${RESET}`);
    return;
  }
  openUrl(ad.url);
  const ev = await api(cfg, "/api/events", {
    method: "POST",
    body: JSON.stringify({ campaignId: ad.campaignId, type: "click" }),
  }).catch(() => null);
  if (ev?.ok) {
    console.log(`${GREEN}✶${RESET} opened ${ad.url} — click recorded (+${usd(ev.customer_share_micros)})`);
  } else {
    console.log(`${DIM}✶ opened ${ad.url} (click not recorded)${RESET}`);
  }
}

// ---- Codex webview injection (opt-in, reversible) ----
// The Codex (openai.chatgpt) panel is a VS Code webview with no hook of its
// own; the only way to render inside it is to patch OpenAI's installed files.
// `patch-codex` edits two files, each backed up to <file>.idleai-backup:
//   • webview/index.html — adds a nonce'd <script> that loads our webview line
//   • out/extension.js   — injects the host broker after initializeWebview(
// `unpatch-codex` restores the backups. Both are idempotent. This is brittle
// by nature: every Codex update overwrites the files (re-run patch-codex) and
// VS Code may warn that an extension was modified.
const CODEX_PUBLISHER = "openai.chatgpt";
const INJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "codex-inject");
const BROKER_MARKER = "__IDLEAI_BROKER__";

// Shared inject library — ONE canonical copy of usd()/adText()/REASONS/the
// Codex thinking-signal/the Bearer fetch, inlined ahead of each injected
// broker+pill so they call idleaiLib.* instead of carrying their own copies.
// The injected surfaces run in foreign runtimes with no filesystem module of
// their own, so the lib text is prepended as a string (idempotent via its
// __IDLEAI_LIB__ marker).
const SHARED_LIB = join(dirname(fileURLToPath(import.meta.url)), "..", "shared", "idleai-inject-lib.js");
const LIB_MARKER = "__IDLEAI_LIB__";
function libSrc() {
  return readFileSync(SHARED_LIB, "utf8");
}
// Prepend the shared lib to a surface script (once) so idleaiLib is defined in
// the same scope before the surface code that calls it.
function withLib(surfaceSrc) {
  return surfaceSrc.includes(LIB_MARKER) ? surfaceSrc : libSrc() + "\n" + surfaceSrc;
}

function codexExtDir() {
  // Newest openai.chatgpt-* under ~/.vscode/extensions (and Cursor/Windsurf).
  const roots = [
    join(homedir(), ".vscode", "extensions"),
    join(homedir(), ".vscode-insiders", "extensions"),
    join(homedir(), ".cursor", "extensions"),
    join(homedir(), ".windsurf", "extensions"),
  ];
  const hits = [];
  for (const root of roots) {
    let names = [];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const n of names) {
      if (n.startsWith(`${CODEX_PUBLISHER}-`)) hits.push(join(root, n));
    }
  }
  // Prefer the lexically-greatest (version-sorted) install.
  return hits.sort().pop() ?? null;
}

function cmdPatchCodex() {
  requireConfig();
  const ext = codexExtDir();
  if (!ext) {
    console.error(`✶ Codex extension (${CODEX_PUBLISHER}) not found under ~/.vscode/extensions — install it first.`);
    process.exit(1);
  }
  const indexHtml = join(ext, "webview", "index.html");
  const extensionJs = join(ext, "out", "extension.js");
  for (const f of [indexHtml, extensionJs]) {
    if (!existsSync(f)) {
      console.error(`✶ expected ${f} — Codex layout changed; aborting without edits.`);
      process.exit(1);
    }
  }

  const webviewSrc = readFileSync(join(INJECT_DIR, "idleai-webview.js"), "utf8");
  const brokerSrc = readFileSync(join(INJECT_DIR, "host-broker.js"), "utf8");

  // 1. Copy the display-only pill next to Codex's assets (loaded from the same
  //    cspSource origin; prod CSP is `script-src ${cspSource}`). The pill NEVER
  //    calls acquireVsCodeApi — the host broker pushes ad state in via
  //    webview.postMessage, which the pill receives as a plain window message.
  //    So nothing here can touch Codex's one-shot API or its boot. No shim.
  const scriptDest = join(ext, "webview", "assets", "idleai-line.js");
  writeFileSync(scriptDest, withLib(webviewSrc));

  // 2. index.html — one module script tag before </head>.
  let html = readFileSync(indexHtml, "utf8");
  if (!html.includes("idleai-line.js")) {
    backup(indexHtml);
    const lineTag = `\n    <script type="module" crossorigin src="./assets/idleai-line.js"></script>`;
    html = html.replace("</head>", `${lineTag}\n  </head>`);
    writeFileSync(indexHtml, html);
  }

  // 3. extension.js — inject the host broker right after the webview seam.
  let js = readFileSync(extensionJs, "utf8");
  if (!js.includes(BROKER_MARKER)) {
    backup(extensionJs);
    const seam = "async initializeWebview(e,r,n,o){";
    const at = js.indexOf(seam);
    if (at < 0) {
      console.error(`✶ could not find the webview seam in extension.js — Codex internals changed. No edits made to extension.js.`);
      console.error(`  (index.html and the asset copy were applied; run \`idleai unpatch-codex\` to undo.)`);
      process.exit(1);
    }
    // Strip the outer /* … */ marker comment down to a one-line tag we can find,
    // and inline the shared lib (idleaiLib) ahead of the broker so it is defined
    // in the same extension.js scope before the broker calls it.
    const brokerInline = libSrc() + `/* ${BROKER_MARKER} */` + brokerSrc.replace(/\/\*[\s\S]*?\*\//, "");
    js = js.slice(0, at + seam.length) + brokerInline + js.slice(at + seam.length);
    writeFileSync(extensionJs, js);
  }

  console.log(`${GREEN}✶${RESET} Codex panel patched — the ad line renders inside the Codex webview while it works.`);
  console.log(`${DIM}  patched: ${ext}${RESET}`);
  console.log(`${DIM}  reload the VS Code window (Developer: Reload Window) to load it.${RESET}`);
  console.log(`${YELLOW}  note:${RESET}${DIM} a Codex update overwrites these files — re-run \`idleai patch-codex\`. Undo anytime with \`idleai unpatch-codex\`.${RESET}`);
}

function cmdUnpatchCodex() {
  const ext = codexExtDir();
  if (!ext) {
    console.error(`✶ Codex extension not found — nothing to unpatch.`);
    process.exit(1);
  }
  const restored = [];
  for (const f of [join(ext, "webview", "index.html"), join(ext, "out", "extension.js")]) {
    const bak = `${f}.idleai-backup`;
    if (existsSync(bak)) {
      copyFileSync(bak, f);
      restored.push(f);
    }
  }
  for (const name of ["idleai-line.js", "idleai-shim.js"]) {
    const p = join(ext, "webview", "assets", name);
    if (existsSync(p)) {
      try {
        rmSync(p);
      } catch {}
    }
  }
  if (restored.length) {
    console.log(`${GREEN}✶${RESET} Codex restored from backups — reload the VS Code window to finish.`);
  } else {
    console.log(`${DIM}✶ no idleai backups found — Codex was not patched (or already restored).${RESET}`);
  }
}

function backup(file) {
  const bak = `${file}.idleai-backup`;
  if (!existsSync(bak)) copyFileSync(file, bak);
}

// ---- Devin (Windsurf/Codeium) workbench injection (opt-in, reversible) ----
// Devin's Cascade chat is native workbench React (NOT an extension webview), so
// there's no CSP-bound chat webview to inject into like Codex — the chat lives
// in the main renderer DOM. `patch-devin` edits two plain unpacked files under
// /Applications/Devin.app (no asar), each backed up byte-exact to
// <file>.idleai-backup:
//   • out/vs/code/electron-browser/workbench/workbench.html — one extra
//     <script src="./idleai-pill.js" type="module"> after workbench.js; the
//     copied-in display-only pill polls the broker's 127.0.0.1 loopback (CSP
//     `connect-src http://127.0.0.1:*` permits it) and renders the ✶ line.
//   • extensions/windsurf/dist/extension.js — injects the host broker right
//     after the exported `e.activate=async function(A){` seam (A = context).
// The app lives in /Applications (root-owned), so writes fall back to sudo.
// `unpatch-devin` restores both backups byte-for-byte and removes the pill copy.
// Brittle by nature: a Devin update overwrites the files (re-run patch-devin).
const DEVIN_APP = "/Applications/Devin.app/Contents/Resources/app";
const DEVIN_INJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "devin-inject");

function devinPaths() {
  const workbenchDir = join(DEVIN_APP, "out", "vs", "code", "electron-browser", "workbench");
  return {
    html: join(workbenchDir, "workbench.html"),
    pill: join(workbenchDir, "idleai-pill.js"),
    ext: join(DEVIN_APP, "extensions", "windsurf", "dist", "extension.js"),
  };
}

// Write `content` to `dest`. Try a direct write; on EACCES/EPERM (root-owned
// /Applications) stage the bytes in a temp file and `sudo cp` them into place.
function writeMaybeSudo(dest, content) {
  try {
    writeFileSync(dest, content);
    return;
  } catch (e) {
    if (e.code !== "EACCES" && e.code !== "EPERM") throw e;
  }
  const tmp = join(homedir(), `.idleai-devin-stage-${Date.now()}`);
  writeFileSync(tmp, content);
  const r = spawnSync("sudo", ["cp", tmp, dest], { stdio: "inherit" });
  try { rmSync(tmp); } catch {}
  if (r.status !== 0) throw new Error(`sudo cp to ${dest} failed`);
}

// Same fallback for copy/remove (backups + pill delete).
function copyMaybeSudo(src, dest) {
  try {
    copyFileSync(src, dest);
    return;
  } catch (e) {
    if (e.code !== "EACCES" && e.code !== "EPERM") throw e;
  }
  const r = spawnSync("sudo", ["cp", src, dest], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`sudo cp to ${dest} failed`);
}

function rmMaybeSudo(target) {
  try {
    rmSync(target);
    return;
  } catch (e) {
    if (e.code === "ENOENT") return;
    if (e.code !== "EACCES" && e.code !== "EPERM") throw e;
  }
  spawnSync("sudo", ["rm", "-f", target], { stdio: "inherit" });
}

function backupMaybeSudo(file) {
  const bak = `${file}.idleai-backup`;
  if (!existsSync(bak)) copyMaybeSudo(file, bak);
}

// Pull the workbench.html CSP into a { directive: "value string" } map. Returns
// null if no CSP meta is present (older/looser builds — nothing to enforce).
function parseWorkbenchCsp(htmlSrc) {
  const m = htmlSrc.match(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/i);
  if (!m) return null;
  // The CSP value is double-quoted but contains single-quoted keywords ('self',
  // 'nonce-…'), so match the opening quote char and capture up to *that* quote —
  // a naive [^"'] class would truncate at the first inner single quote.
  const c = m[0].match(/content=("([^"]*)"|'([^']*)')/i);
  if (!c) return null;
  // Normalise all runs of whitespace (Cursor's CSP is pretty-printed across many
  // lines with tabs/newlines between the directive name and its values) to single
  // spaces, so directive/value splitting works regardless of formatting.
  const value = (c[2] !== undefined ? c[2] : c[3]).replace(/\s+/g, " ").trim();
  const map = {};
  for (const part of value.split(";")) {
    const t = part.trim();
    if (!t) continue;
    const sp = t.indexOf(" ");
    const name = (sp < 0 ? t : t.slice(0, sp)).toLowerCase();
    map[name] = sp < 0 ? "" : t.slice(sp + 1).trim();
  }
  return map;
}

// Both renderer-half assumptions are load-bearing: if either is wrong the pill
// silently no-ops. Verify against the *installed* workbench.html before writing,
// and abort with a specific message rather than shipping a dead injection.
function assertDevinCsp(htmlSrc) {
  const csp = parseWorkbenchCsp(htmlSrc);
  if (!csp) return; // no CSP meta → nothing blocks us; proceed.
  // (1) script-src must allow our same-origin ./idleai-pill.js module. A
  //     nonce-only script-src (no 'self') would CSP-block the injected tag.
  const scriptSrc = csp["script-src"];
  if (typeof scriptSrc === "string" && scriptSrc.length && !/(?:^|\s)'self'(?:\s|$)/.test(scriptSrc)) {
    console.error(`✶ workbench.html CSP script-src does not permit 'self' — the injected <script src="./idleai-pill.js"> would be blocked.`);
    console.error(`  script-src: ${scriptSrc}`);
    console.error(`  This build likely uses a nonce/hash script-src; the pill must be inlined with the page nonce or added to the CSP hash list. Aborting without edits.`);
    process.exit(1);
  }
  // (2) connect-src must permit the loopback the pill fetches. Without it every
  //     /state, /seen and /click is blocked and the bridge design fails here.
  const connectSrc = csp["connect-src"];
  if (typeof connectSrc === "string" && connectSrc.length &&
      !/127\.0\.0\.1|localhost|(?:^|\s)\*(?:\s|$)/.test(connectSrc)) {
    console.error(`✶ workbench.html CSP connect-src does not permit http://127.0.0.1:* — the pill→broker loopback would be blocked.`);
    console.error(`  connect-src: ${connectSrc}`);
    console.error(`  The broker↔pill bridge does not work on this build without a connect-src that allows loopback. Aborting without edits.`);
    process.exit(1);
  }
}

function cmdPatchDevin() {
  requireConfig();
  const { html, pill, ext } = devinPaths();
  for (const f of [html, ext]) {
    if (!existsSync(f)) {
      console.error(`✶ expected ${f} — Devin not installed at /Applications/Devin.app, or its layout changed. Aborting without edits.`);
      process.exit(1);
    }
  }

  // Both halves get the shared inject lib (idleaiLib) inlined ahead of them so
  // they call idleaiLib.usd/adText/reasonLabel/makeApi instead of local copies.
  const pillSrc = withLib(readFileSync(join(DEVIN_INJECT_DIR, "idleai-pill.js"), "utf8"));
  const brokerSrc = readFileSync(join(DEVIN_INJECT_DIR, "host-broker.js"), "utf8");

  let htmlSrc = readFileSync(html, "utf8");

  // Verify the two CSP assumptions the renderer half depends on BEFORE any write
  // — a wrong CSP silently kills the pill, so fail loudly instead.
  assertDevinCsp(htmlSrc);

  // 1. Copy the display-only pill next to workbench.js (same 'self' origin, so
  //    `script-src 'self'` in workbench.html allows it). Idempotent: only write
  //    when missing or changed, so a no-op re-patch prompts for no sudo.
  let pillCurrent = null;
  try { pillCurrent = readFileSync(pill, "utf8"); } catch {}
  if (pillCurrent !== pillSrc) writeMaybeSudo(pill, pillSrc);

  // 2. workbench.html — one extra module <script> after the workbench.js tag.
  if (!htmlSrc.includes("idleai-pill.js")) {
    backupMaybeSudo(html);
    const anchor = `<script src="./workbench.js" type="module"></script>`;
    if (!htmlSrc.includes(anchor)) {
      console.error(`✶ could not find the workbench.js script tag in workbench.html — Devin layout changed. No edits made.`);
      process.exit(1);
    }
    htmlSrc = htmlSrc.replace(
      anchor,
      `${anchor}\n\t<script src="./idleai-pill.js" type="module"></script>`
    );
    writeMaybeSudo(html, htmlSrc);
  }

  // 3. extension.js — inject the host broker at the top of e.activate.
  let js = readFileSync(ext, "utf8");
  if (!js.includes(BROKER_MARKER)) {
    backupMaybeSudo(ext);
    const seam = "e.activate=async function(A){";
    const at = js.indexOf(seam);
    if (at < 0) {
      console.error(`✶ could not find the activate seam in extension.js — Windsurf internals changed. No edits made to extension.js.`);
      console.error(`  (workbench.html and the pill copy were applied; run \`idleai unpatch-devin\` to undo.)`);
      process.exit(1);
    }
    // Strip the outer /* … */ doc comment down to a one-line marker we can find,
    // and inline the shared lib (idleaiLib) ahead of the broker so it is defined
    // in the same extension.js scope before the broker calls it.
    const brokerInline = libSrc() + `/* ${BROKER_MARKER} */` + brokerSrc.replace(/\/\*[\s\S]*?\*\//, "");
    js = js.slice(0, at + seam.length) + brokerInline + js.slice(at + seam.length);
    writeMaybeSudo(ext, js);
  }

  console.log(`${GREEN}✶${RESET} Devin patched — the ad line renders inside the Cascade panel while it works.`);
  console.log(`${DIM}  patched: ${DEVIN_APP}${RESET}`);
  console.log(`${DIM}  fully quit and reopen Devin to load it.${RESET}`);
  console.log(`${YELLOW}  note:${RESET}${DIM} a Devin update overwrites these files — re-run \`idleai patch-devin\`. Undo anytime with \`idleai unpatch-devin\`.${RESET}`);
}

function cmdUnpatchDevin() {
  const { html, pill, ext } = devinPaths();
  const restored = [];
  for (const f of [html, ext]) {
    const bak = `${f}.idleai-backup`;
    if (existsSync(bak)) {
      copyMaybeSudo(bak, f);
      rmMaybeSudo(bak);
      restored.push(f);
    }
  }
  rmMaybeSudo(pill);
  try { rmSync(join(homedir(), ".idleai-devin.json")); } catch {}
  if (restored.length) {
    console.log(`${GREEN}✶${RESET} Devin restored from backups — fully quit and reopen Devin to finish.`);
  } else {
    console.log(`${DIM}✶ no idleai backups found — Devin was not patched (or already restored).${RESET}`);
  }
}

// ---- Cursor (Anysphere fork of VS Code) workbench injection (opt-in, reversible) ----
// Cursor's Composer chat is native workbench SolidJS (NOT an extension webview),
// so — exactly like Devin — there's no CSP-bound chat webview to inject into; the
// chat lives in the main renderer DOM. `patch-cursor` edits three installed
// files under /Applications/Cursor.app, each backed up byte-exact to
// <file>.idleai-backup:
//   • out/vs/code/electron-sandbox/workbench/workbench.html — one extra
//     <script src="./idleai-pill.js" type="module"> after workbench.js; the
//     copied-in display-only pill polls the broker's 127.0.0.1 loopback (CSP
//     `connect-src http:` permits it) and renders the ✶ line.
//   • extensions/cursor-agent-exec/dist/main.js — wraps the builtin extension's
//     exported activate getter so the host broker (full Node) initialises with
//     the ExtensionContext when Cursor boots (activationEvents: ["*"]).
//   • product.json — its `checksums` map covers workbench.html; we recompute the
//     entry so the "installation corrupt" toast stays quiet.
//
// THE SIGNATURE PROBLEM (this is the whole point of the fix): Cursor.app is
// Developer-ID signed, notarized, hardened-runtime. workbench.html and
// product.json are sealed in Contents/_CodeSignature/CodeResources, so editing
// them breaks `codesign --verify` and `spctl` and can trigger Gatekeeper's "app
// is damaged" on relaunch. patch-cursor therefore, after editing, ad-hoc
// re-signs the bundle (`codesign --force --deep --sign - Cursor.app`) and strips
// the quarantine xattr so it still launches. This REPLACES Cursor's Developer-ID
// signature with an ad-hoc one — printed loudly, recovery command given, and NOT
// byte-reversible for the signature (the original _CodeSignature is not restored;
// only workbench.html/product.json/main.js are). Reinstall Cursor to get the real
// signature back. If ad-hoc re-sign is unavailable (no codesign), the edits are
// rolled back so the app is never left broken-but-unsigned.
const CURSOR_BUNDLE = "/Applications/Cursor.app";
const CURSOR_APP = `${CURSOR_BUNDLE}/Contents/Resources/app`;
const CURSOR_INJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "cursor-inject");

function cursorPaths() {
  const workbenchDir = join(CURSOR_APP, "out", "vs", "code", "electron-sandbox", "workbench");
  return {
    html: join(workbenchDir, "workbench.html"),
    pill: join(workbenchDir, "idleai-pill.js"),
    ext: join(CURSOR_APP, "extensions", "cursor-agent-exec", "dist", "main.js"),
    product: join(CURSOR_APP, "product.json"),
  };
}

// Verify the two CSP assumptions the renderer half depends on BEFORE any write —
// a wrong CSP silently kills the pill, so fail loudly instead. Reuses the same
// parser as Devin. Cursor's CSP value spans many lines, which the parser handles.
function assertCursorCsp(htmlSrc) {
  const csp = parseWorkbenchCsp(htmlSrc);
  if (!csp) return; // no CSP meta → nothing blocks us; proceed.
  const scriptSrc = csp["script-src"];
  if (typeof scriptSrc === "string" && scriptSrc.length && !/(?:^|\s)'self'(?:\s|$)/.test(scriptSrc)) {
    console.error(`✶ workbench.html CSP script-src does not permit 'self' — the injected <script src="./idleai-pill.js"> would be blocked.`);
    console.error(`  script-src: ${scriptSrc}`);
    console.error(`  Aborting without edits.`);
    process.exit(1);
  }
  // connect-src must permit the loopback the pill fetches. Cursor ships
  // `connect-src 'self' http: https: …`, so `http:` covers http://127.0.0.1:*.
  const connectSrc = csp["connect-src"];
  if (typeof connectSrc === "string" && connectSrc.length &&
      !/127\.0\.0\.1|localhost|(?:^|\s)https?:(?:\s|$)|(?:^|\s)\*(?:\s|$)/.test(connectSrc)) {
    console.error(`✶ workbench.html CSP connect-src does not permit http://127.0.0.1:* — the pill→broker loopback would be blocked.`);
    console.error(`  connect-src: ${connectSrc}`);
    console.error(`  Aborting without edits.`);
    process.exit(1);
  }
}

// Cursor keeps a checksums map in product.json; workbench.html is one entry.
// After editing the HTML, recompute base64(sha256(bytes)) with padding stripped
// (VS Code's exact convention) so the dismissible "installation corrupt" toast
// stays quiet. product.json is not in its own checksum list, so editing it is free.
function cursorChecksum(bytes) {
  return createHash("sha256").update(bytes).digest("base64").replace(/=+$/, "");
}

// Ad-hoc re-sign the whole bundle and strip quarantine so the edited (and thus
// signature-broken) Cursor.app still launches. Returns true on success. This
// REPLACES the Developer-ID signature with an ad-hoc one — the caller prints the
// consequence and the recovery command loudly.
function cursorResign() {
  const rs = spawnSync("codesign", ["--force", "--deep", "--sign", "-", CURSOR_BUNDLE], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (rs.status !== 0) {
    // Root-owned bundle may need sudo.
    const rs2 = spawnSync("sudo", ["codesign", "--force", "--deep", "--sign", "-", CURSOR_BUNDLE], { stdio: "inherit" });
    if (rs2.status !== 0) return false;
  }
  // Best-effort dequarantine (ignore failure — absence of the xattr is fine).
  spawnSync("xattr", ["-dr", "com.apple.quarantine", CURSOR_BUNDLE], { stdio: "ignore" });
  spawnSync("sudo", ["xattr", "-dr", "com.apple.quarantine", CURSOR_BUNDLE], { stdio: "ignore" });
  return true;
}

function cmdPatchCursor() {
  requireConfig();
  if (process.platform !== "darwin") {
    console.error(`✶ patch-cursor targets the macOS Cursor.app bundle; this platform isn't supported.`);
    process.exit(1);
  }
  const { html, pill, ext, product } = cursorPaths();
  for (const f of [html, ext, product]) {
    if (!existsSync(f)) {
      console.error(`✶ expected ${f} — Cursor not installed at ${CURSOR_BUNDLE}, or its layout changed. Aborting without edits.`);
      process.exit(1);
    }
  }
  if (!existsSync("/usr/bin/codesign") && spawnSync("which", ["codesign"]).status !== 0) {
    console.error(`✶ codesign not found — editing Cursor's sealed files without an ad-hoc re-sign would leave the app "damaged" and unlaunchable. Install Xcode command line tools first. Aborting without edits.`);
    process.exit(1);
  }

  // Both halves get the shared inject lib (idleaiLib) inlined ahead of them.
  const pillSrc = withLib(readFileSync(join(CURSOR_INJECT_DIR, "idleai-pill.js"), "utf8"));
  const brokerSrc = readFileSync(join(CURSOR_INJECT_DIR, "host-broker.js"), "utf8");

  let htmlSrc = readFileSync(html, "utf8");
  assertCursorCsp(htmlSrc);

  const touched = []; // for rollback if re-sign fails

  // 1. Copy the display-only pill next to workbench.js (same 'self' origin).
  let pillCurrent = null;
  try { pillCurrent = readFileSync(pill, "utf8"); } catch {}
  if (pillCurrent !== pillSrc) { writeMaybeSudo(pill, pillSrc); touched.push(pill); }

  // 2. workbench.html — one extra module <script> after the workbench.js tag.
  let htmlChanged = false;
  if (!htmlSrc.includes("idleai-pill.js")) {
    backupMaybeSudo(html);
    const anchor = `<script src="./workbench.js" type="module"></script>`;
    if (!htmlSrc.includes(anchor)) {
      console.error(`✶ could not find the workbench.js script tag in workbench.html — Cursor layout changed. No edits made.`);
      process.exit(1);
    }
    htmlSrc = htmlSrc.replace(
      anchor,
      `${anchor}\n\t<script src="./idleai-pill.js" type="module"></script>`
    );
    writeMaybeSudo(html, htmlSrc);
    htmlChanged = true;
    touched.push(html);
  }

  // 3. product.json — recompute the workbench.html checksum so the corruption
  //    toast stays quiet. Keyed by the repo-relative path VS Code uses.
  const CHECKSUM_KEY = "vs/code/electron-sandbox/workbench/workbench.html";
  let prod = null;
  try { prod = JSON.parse(readFileSync(product, "utf8")); } catch {}
  if (prod && prod.checksums && Object.prototype.hasOwnProperty.call(prod.checksums, CHECKSUM_KEY)) {
    const want = cursorChecksum(readFileSync(html));
    if (prod.checksums[CHECKSUM_KEY] !== want) {
      backupMaybeSudo(product);
      prod.checksums[CHECKSUM_KEY] = want;
      writeMaybeSudo(product, JSON.stringify(prod, null, "\t") + "\n");
      touched.push(product);
    }
  }

  // 4. extensions/cursor-agent-exec/dist/main.js — wrap the exported activate
  //    getter so the broker initialises with the ExtensionContext. The webpack
  //    output is `…{activate:()=>LOCAL,deactivate:()=>…}`; LOCAL is the activate
  //    function. We capture LOCAL by regex (its minified name varies per build)
  //    and rewrite the getter to `activate:()=>((...__ia)=>{ <broker>; return
  //    LOCAL(...__ia) })`, so VS Code's `ext.activate(context)` runs the broker
  //    first then delegates. Idempotent via BROKER_MARKER.
  let js = readFileSync(ext, "utf8");
  if (!js.includes(BROKER_MARKER)) {
    const m = js.match(/(\{|,)activate:\(\)=>([A-Za-z_$][\w$]*)/);
    if (!m) {
      console.error(`✶ could not find the webpack activate getter in cursor-agent-exec/main.js — Cursor internals changed. No edits made to main.js.`);
      if (touched.length) console.error(`  (other files were edited; run \`idleai unpatch-cursor\` to undo.)`);
      process.exit(1);
    }
    backupMaybeSudo(ext);
    const local = m[2];
    // Two-part edit, both idempotent behind BROKER_MARKER:
    //   (a) Prepend a prelude — the shared lib (defines globalThis.idleaiLib) and
    //       the broker (defines globalThis.__idleaiCursorBrokerInit(context)) —
    //       to the very top of main.js. These are plain statements (the broker is
    //       `globalThis.__idleaiCursorBrokerInit = function(context){…}`), so they
    //       execute once at require time with no dependency on webpack internals.
    //   (b) Rewrite the activate getter so `ext.activate(context)` fires the
    //       broker (with the real ExtensionContext) before delegating to the
    //       original activate `LOCAL`. The getter's minified target name (LOCAL)
    //       varies per build, so we captured it by regex above.
    const prelude = libSrc() + `\n/* ${BROKER_MARKER} */\n` + brokerSrc.replace(/\/\*[\s\S]*?\*\//, "") + "\n";
    const wrapped = `${m[1]}activate:()=>((...__ia)=>{try{globalThis.__idleaiCursorBrokerInit&&globalThis.__idleaiCursorBrokerInit(__ia[0]);}catch(e){}return ${local}(...__ia);})`;
    js = prelude + js.replace(m[0], wrapped);
    writeMaybeSudo(ext, js);
    touched.push(ext);
  }

  // 5. THE SIGNATURE FIX. The edits above broke the Developer-ID seal; ad-hoc
  //    re-sign + dequarantine so Cursor still launches. If re-sign fails, roll
  //    back every edit so we never leave a broken-but-unsigned app.
  console.log(`${DIM}  re-signing Cursor.app ad-hoc (its Developer-ID signature is being replaced)…${RESET}`);
  if (!cursorResign()) {
    console.error(`${YELLOW}✶ ad-hoc re-sign failed — rolling back all edits so Cursor is not left damaged.${RESET}`);
    cmdUnpatchCursor({ silent: true, skipResign: true });
    console.error(`  Restored. Cursor's original files and (still-valid) Developer-ID signature are intact.`);
    process.exit(1);
  }

  console.log(`${GREEN}✶${RESET} Cursor patched — the ad line renders inside the Composer panel while it works.`);
  console.log(`${DIM}  patched: ${CURSOR_APP}${RESET}`);
  console.log(`${DIM}  fully quit and reopen Cursor to load it.${RESET}`);
  console.log(``);
  console.log(`${YELLOW}  IMPORTANT — Cursor's code signature was replaced with an ad-hoc signature.${RESET}`);
  console.log(`${DIM}  Cursor was Developer-ID signed + notarized; editing its sealed files invalidated`);
  console.log(`  that. patch-cursor ad-hoc re-signed the bundle and stripped quarantine so it still`);
  console.log(`  launches, but macOS will no longer see the original signature. \`idleai unpatch-cursor\``);
  console.log(`  restores workbench.html / product.json / main.js byte-for-byte, but CANNOT restore the`);
  console.log(`  original Developer-ID signature. To get a fully genuine, notarized Cursor back, reinstall`);
  console.log(`  from cursor.com. Recovery is always: reinstall Cursor.${RESET}`);
  console.log(`${YELLOW}  note:${RESET}${DIM} a Cursor update overwrites these files and restores the real signature — re-run \`idleai patch-cursor\` after an update.${RESET}`);
}

function cmdUnpatchCursor(opts = {}) {
  const { silent = false, skipResign = false } = opts;
  const { html, pill, ext, product } = cursorPaths();
  const restored = [];
  for (const f of [html, ext, product]) {
    const bak = `${f}.idleai-backup`;
    if (existsSync(bak)) {
      copyMaybeSudo(bak, f);
      rmMaybeSudo(bak);
      restored.push(f);
    }
  }
  rmMaybeSudo(pill);
  try { rmSync(join(homedir(), ".idleai-cursor.json")); } catch {}

  // Re-sign ad-hoc again after restoring: the files are back to original bytes,
  // but the on-disk _CodeSignature still reflects the ad-hoc re-sign done at
  // patch time (or, if the app was updated, the update already restored it). An
  // ad-hoc re-sign over the restored bytes keeps codesign self-consistent so the
  // app launches. We do NOT and CANNOT restore the original Developer-ID seal.
  let resigned = false;
  if (restored.length && !skipResign && process.platform === "darwin") {
    resigned = cursorResign();
  }

  if (silent) return;
  if (restored.length) {
    console.log(`${GREEN}✶${RESET} Cursor restored from backups — fully quit and reopen Cursor to finish.`);
    if (resigned) {
      console.log(`${DIM}  files are byte-identical to before the patch; the bundle was ad-hoc re-signed again so it launches.${RESET}`);
    }
    console.log(`${YELLOW}  note:${RESET}${DIM} this does NOT restore Cursor's original Developer-ID signature. For a genuine notarized Cursor, reinstall from cursor.com.${RESET}`);
  } else {
    console.log(`${DIM}✶ no idleai backups found — Cursor was not patched (or already restored).${RESET}`);
  }
}

function cmdSetupClaude() {
  requireConfig();
  const settingsPath = join(homedir(), ".claude", "settings.json");
  mkdirSync(join(homedir(), ".claude"), { recursive: true });
  let settings = {};
  if (existsSync(settingsPath)) {
    copyFileSync(settingsPath, `${settingsPath}.idleai-backup`);
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      console.error(`Could not parse ${settingsPath} — fix it first (backup saved).`);
      process.exit(1);
    }
  }
  // Absolute paths: GUI-launched Claude Code (desktop app, IDE extensions)
  // runs statusline commands without the shell PATH, so bare `idleai` and
  // even `#!/usr/bin/env node` both fail to resolve there.
  const self = fileURLToPath(import.meta.url);
  settings.statusLine = { type: "command", command: `"${process.execPath}" "${self}" statusline` };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log(`${GREEN}✶${RESET} Claude Code wired — the ad takes over the thinking spinner (2.1+), earnings live in the statusline.`);
  console.log(`${DIM}  (backup at ${settingsPath}.idleai-backup — remove the "statusLine" and "spinnerVerbs" keys to undo)${RESET}`);
}

const [, , cmd, ...args] = process.argv;
switch (cmd) {
  case "login":
    await cmdLogin(args);
    break;
  case "run":
    await cmdRun();
    break;
  case "codex":
  case "gemini":
  case "grok":
    await cmdWrap(cmd, args);
    break;
  case "statusline":
    await cmdStatusline(args);
    break;
  case "open":
    await cmdOpen();
    break;
  case "setup-claude":
    cmdSetupClaude();
    break;
  case "patch-codex":
    cmdPatchCodex();
    break;
  case "unpatch-codex":
    cmdUnpatchCodex();
    break;
  case "patch-devin":
    cmdPatchDevin();
    break;
  case "unpatch-devin":
    cmdUnpatchDevin();
    break;
  case "patch-cursor":
    cmdPatchCursor();
    break;
  case "unpatch-cursor":
    cmdUnpatchCursor();
    break;
  case "pause":
    cmdPause(true);
    break;
  case "resume":
    cmdPause(false);
    break;
  default:
    console.log(`idleai — get paid while you code
usage:
  idleai login idl_xxx [--url https://your-idleai.app]
  idleai run            live earning line in this terminal (works in Replit too)
  idleai codex [args…]  run the Codex CLI with the ad line under it (needs tmux)
  idleai gemini|grok    same wrapper for the Gemini and Grok CLIs
  idleai statusline     one-shot line for statusbar integrations
  idleai open           open the current ad in your browser (a click pays 50× a view)
  idleai setup-claude   put the ad line under every Claude Code session
  idleai patch-codex    render the ad INSIDE the Codex VS Code panel (reversible)
  idleai unpatch-codex  restore Codex's original files
  idleai patch-devin    render the ad INSIDE the Devin (Windsurf) Cascade panel (reversible)
  idleai unpatch-devin  restore Devin's original files
  idleai patch-cursor   render the ad INSIDE the Cursor Composer panel (ad-hoc re-signs Cursor.app; reversible)
  idleai unpatch-cursor restore Cursor's original files
  idleai pause          stop serving on every local client (statusline, companion)
  idleai resume         start earning again`);
}
