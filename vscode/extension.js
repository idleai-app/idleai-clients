// idleai — VS Code / Cursor status-bar client.
// Same contract as every idleai surface: Bearer device token →
// GET /api/serve (what to show) → 5s on screen → POST /api/events impression;
// a click on the status bar opens the ad and posts a click (pays 50×).
const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");

const VIEW_SECONDS = 5; // a view only pays after the line sat on screen this long
// Must stay > VIEW_SECONDS: if a cycle re-serves the moment the 5s impression
// timeout is due, a rotated campaign would silently forfeit a legitimate view.
const SERVE_INTERVAL_MS = 8000;
const STATS_INTERVAL_MS = 60000;
const THINKING_STALE_MS = 10 * 60 * 1000; // a crashed turn must not pin the window open

const REASONS = {
  vpn_detected: "VPN detected — disconnect to earn",
  geo_mismatch: "country mismatch — fix your location in the dashboard",
  busy_elsewhere: "another device is earning — this one stands by",
};

let item;
let ad = null;
let lastReason = null;
let todayMicros = 0;
let sessionMicros = 0;
let paused = false;
let cfg = null; // { token, baseUrl }
let timers = [];

const usd = (m) => `$${(m / 1e6).toFixed(m !== 0 && m < 10000 ? 4 : 2)}`;
// Creatives may end with the brand ↗ — the client renders its own arrow.
const adText = (t) => t.replace(/\s*↗\s*$/u, "");

function cliConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".idleai.json"), "utf8"));
  } catch {
    return null;
  }
}

async function loadConfig(context) {
  const token = await context.secrets.get("idleai.token");
  const baseUrl =
    vscode.workspace.getConfiguration("idleai").get("baseUrl") || cliConfig()?.baseUrl || "";
  if (token && baseUrl) return { token, baseUrl };
  // Fall back to the CLI's login so one `idleai login` covers every surface.
  const fromCli = cliConfig();
  if (fromCli?.token && fromCli?.baseUrl) return fromCli;
  return null;
}

async function api(pathname, init = {}) {
  const res = await fetch(`${cfg.baseUrl}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data;
}

function render() {
  if (!cfg) {
    item.text = "✶ idleai — sign in";
    item.tooltip = "Idleai: sign in with a device token to start earning";
    item.command = "idleai.login";
    return;
  }
  item.command = "idleai.openAd";
  if (paused) {
    item.text = "✶ idleai paused";
    item.tooltip = "Idleai is paused — run “Idleai: Pause / resume” to earn again";
    return;
  }
  if (ad) {
    const clean = adText(ad.text);
    const text = clean.length > 64 ? `${clean.slice(0, 63)}…` : clean;
    item.text = `${ad.takeover ? "✶⭐" : "✶"} ${text} ↗ · ${usd(todayMicros)} today`;
    item.tooltip = new vscode.MarkdownString(
      `**${ad.text}**\n\nClick opens the ad — a click pays 50× a view.\n\n` +
        `Today \`${usd(todayMicros)}\` · this session \`+${usd(sessionMicros)}\``
    );
  } else if (REASONS[lastReason]) {
    item.text = "✶ idleai — not earning";
    item.tooltip = `Idleai: ${REASONS[lastReason]}`;
  } else {
    item.text = `✶ idleai · ${usd(todayMicros)} today`;
    item.tooltip = "Idleai — waiting for inventory";
  }
}

// `idleai pause` (CLI) pauses every client on the machine; the in-editor
// toggle is a local control on top.
function machinePaused() {
  return !!cliConfig()?.paused;
}

// Thinking signals, one per assistant that can live in this editor:
//
// 1. Claude Code — the plugin's hooks stamp the machine-wide thinking window
//    into ~/.idleai/claude-state.json.
// 2. Agent CLIs (Codex IDE extension/CLI, Gemini CLI, Grok CLI) — no hooks to
//    lean on, but each writes session artifacts under its home dir on every
//    turn event, so a fresh mtime there means that agent is working right now.
//
// If any signal says thinking → eligible; if a signal exists but none are
// thinking → only the linger window after the last stop stays eligible; if no
// assistant leaves a signal on this machine → every focused moment stays
// eligible (there is nothing to time against).
let lingerSeconds = 30;
const CLI_ACTIVE_MS = 15 * 1000; // session writes can pause mid-turn; don't strobe

// Newest numeric child of a directory — Codex sessions are laid out as
// sessions/<year>/<month>/<day>/rollout-*.jsonl (padding not guaranteed).
function newestNumericDir(dir) {
  try {
    const subs = fs.readdirSync(dir).filter((n) => /^\d+$/.test(n));
    if (!subs.length) return null;
    return path.join(dir, subs.sort((a, b) => Number(a) - Number(b)).pop());
  } catch {
    return null;
  }
}

function codexLastActivity() {
  let dir = path.join(os.homedir(), ".codex", "sessions");
  for (let depth = 0; depth < 3 && dir; depth++) dir = newestNumericDir(dir);
  if (!dir) return 0; // no Codex on this machine
  let latest = 0;
  try {
    for (const n of fs.readdirSync(dir)) {
      try {
        latest = Math.max(latest, fs.statSync(path.join(dir, n)).mtimeMs);
      } catch {}
    }
  } catch {}
  return latest;
}

// Newest file mtime under a directory tree, bounded so the poll stays cheap:
// depth-limited, at most `budget.files` stats, and an early exit the moment
// anything fresh enough turns up (freshness is all the caller needs).
// Subdirectories are visited newest-mtime-first so the active session's
// branch is reached before months of stale ones exhaust the budget.
function newestFileUnder(dir, depth, budget, freshMs) {
  let latest = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const dirs = [];
  for (const e of entries) {
    if (budget.files <= 0) return latest;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      try {
        dirs.push([p, fs.statSync(p).mtimeMs]);
      } catch {}
      continue;
    }
    budget.files--;
    try {
      const m = fs.statSync(p).mtimeMs;
      if (m > latest) latest = m;
      if (Date.now() - latest < freshMs) return latest;
    } catch {}
  }
  if (depth <= 0) return latest;
  dirs.sort((a, b) => b[1] - a[1]);
  for (const [p] of dirs) {
    if (budget.files <= 0) return latest;
    const m = newestFileUnder(p, depth - 1, budget, freshMs);
    if (m > latest) latest = m;
    if (Date.now() - latest < freshMs) return latest;
  }
  return latest;
}

// Gemini CLI writes per-session artifacts (tracker, tasks, plans, chats,
// logs) under ~/.gemini/tmp/<project>/…; Grok CLI keeps its state under
// ~/.grok. A missing dir simply yields no signal.
function agentCliSignals() {
  return [
    codexLastActivity(),
    newestFileUnder(path.join(os.homedir(), ".gemini", "tmp"), 5, { files: 600 }, CLI_ACTIVE_MS),
    newestFileUnder(path.join(os.homedir(), ".grok"), 4, { files: 400 }, CLI_ACTIVE_MS),
  ].filter((ts) => ts > 0);
}

function inThinkingWindow() {
  const now = Date.now();
  const signals = [];
  try {
    const state = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".idleai", "claude-state.json"), "utf8")
    );
    const sessions = Object.values(state);
    if (sessions.length) {
      signals.push({
        thinking: sessions.some((s) => s.thinking && now - (s.ts ?? 0) < THINKING_STALE_MS),
        lastStop: Math.max(0, ...sessions.filter((s) => !s.thinking).map((s) => s.ts ?? 0)),
      });
    }
  } catch {}
  for (const ts of agentCliSignals()) {
    signals.push({ thinking: now - ts < CLI_ACTIVE_MS, lastStop: ts });
  }
  if (!signals.length) return true;
  if (signals.some((s) => s.thinking)) return true;
  const lastStop = Math.max(...signals.map((s) => s.lastStop));
  return now - lastStop < lingerSeconds * 1000;
}

async function refreshStats() {
  if (!cfg || paused || machinePaused()) return;
  const s = await api("/api/customer/stats").catch(() => null);
  if (s) {
    todayMicros = s.stats.today_micros;
    render();
  }
}

async function cycle() {
  if (!cfg || paused) return;
  if (machinePaused()) {
    ad = null;
    item.text = "✶ idleai paused";
    item.tooltip = "Paused machine-wide via `idleai pause` — `idleai resume` to earn again";
    return;
  }
  // Honest views only: the window must actually be on the developer's screen.
  if (!vscode.window.state.focused) return;
  if (!inThinkingWindow()) {
    if (ad) {
      ad = null;
      render();
    }
    return;
  }
  const res = await api("/api/serve").catch(() => ({ ad: null }));
  if (typeof res.lingerSeconds === "number") lingerSeconds = res.lingerSeconds;
  const served = res.ad;
  ad = served;
  lastReason = res.reason ?? null;
  render();
  if (!served) return;
  setTimeout(async () => {
    // Still the same ad, still focused, after the full view threshold.
    if (paused || !vscode.window.state.focused || ad?.campaignId !== served.campaignId) return;
    const ev = await api("/api/events", {
      method: "POST",
      body: JSON.stringify({ campaignId: served.campaignId, type: "impression" }),
    }).catch(() => null);
    if (ev?.ok) {
      sessionMicros += ev.customer_share_micros;
      todayMicros += ev.customer_share_micros;
      render();
    }
  }, VIEW_SECONDS * 1000);
}

// Dockable pane (View → idleai, or drag next to the Claude chat panel):
// the ✶ pill + earnings, fed by the same serve loop as the status bar.
let paneView = null;
function pushPane() {
  if (!paneView) return;
  paneView.webview.postMessage({
    ad: ad ? { text: adText(ad.text), takeover: !!ad.takeover } : null,
    today: usd(todayMicros),
    session: usd(sessionMicros),
    note: !ad && REASONS[lastReason] ? REASONS[lastReason] : paused ? "paused" : "",
  });
}

class IdleaiPane {
  resolveWebviewView(view) {
    paneView = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = `<!doctype html><html><body style="margin:0;background:#0b0f0e;color:#e8f0ed;
      font:13px/1.6 ui-monospace,Menlo,monospace;display:flex;align-items:center;gap:14px;padding:10px 16px">
      <div id="pill" style="display:flex;align-items:center;gap:8px;background:#121816;border:1px solid #253430;
        border-radius:999px;padding:8px 14px;cursor:pointer;white-space:nowrap">
        <span id="star" style="color:#00b894;animation:p 1.2s ease-in-out infinite">✶</span>
        <span id="txt" style="color:#8aa39b">waiting for inventory…</span>
        <span style="color:#00b894">↗</span></div>
      <span id="earn" style="color:#8aa39b"></span>
      <style>@keyframes p{0%,100%{opacity:1}50%{opacity:.35}}</style>
      <script>
        const vs = acquireVsCodeApi();
        document.getElementById("pill").addEventListener("click", () => vs.postMessage({ open: true }));
        window.addEventListener("message", (e) => {
          const { ad, today, session, note } = e.data;
          document.getElementById("txt").textContent = ad ? ad.text : (note || "waiting for inventory…");
          document.getElementById("txt").style.color = ad ? "#e8f0ed" : "#8aa39b";
          document.getElementById("star").style.color = ad && ad.takeover ? "#fde047" : "#00b894";
          document.getElementById("earn").textContent = "today " + today + " · session +" + session;
        });
      </script></body></html>`;
    view.webview.onDidReceiveMessage((m) => {
      if (m.open) vscode.commands.executeCommand("idleai.openAd");
    });
    pushPane();
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("idleai.pane", new IdleaiPane())
  );
  timers.push(setInterval(pushPane, 2000));
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(item);
  item.show();

  context.subscriptions.push(
    vscode.commands.registerCommand("idleai.login", async () => {
      const token = await vscode.window.showInputBox({
        prompt: "Paste your idleai device token (dashboard → Connect your tools)",
        placeHolder: "idl_xxxxxxxx",
        password: true,
        ignoreFocusOut: true,
      });
      if (!token) return;
      let baseUrl = vscode.workspace.getConfiguration("idleai").get("baseUrl") || cliConfig()?.baseUrl;
      if (!baseUrl) {
        baseUrl = await vscode.window.showInputBox({
          prompt: "Your idleai server URL",
          value: "https://idleai.app",
          ignoreFocusOut: true,
        });
        if (!baseUrl) return;
        await vscode.workspace
          .getConfiguration("idleai")
          .update("baseUrl", baseUrl, vscode.ConfigurationTarget.Global);
      }
      cfg = { token, baseUrl };
      try {
        const me = await api("/api/me");
        await context.secrets.store("idleai.token", token);
        vscode.window.showInformationMessage(`✶ idleai — signed in as ${me.user.email}`);
        await refreshStats();
        render();
      } catch (e) {
        cfg = null;
        render();
        vscode.window.showErrorMessage(`idleai: token rejected (${e.message})`);
      }
    }),
    vscode.commands.registerCommand("idleai.logout", async () => {
      await context.secrets.delete("idleai.token");
      cfg = null;
      ad = null;
      render();
    }),
    vscode.commands.registerCommand("idleai.openAd", async () => {
      if (!ad) return;
      vscode.env.openExternal(vscode.Uri.parse(ad.url));
      const ev = await api("/api/events", {
        method: "POST",
        body: JSON.stringify({ campaignId: ad.campaignId, type: "click" }),
      }).catch(() => null);
      if (ev?.ok) {
        sessionMicros += ev.customer_share_micros;
        todayMicros += ev.customer_share_micros;
        render();
      }
    }),
    vscode.commands.registerCommand("idleai.toggle", () => {
      paused = !paused;
      if (paused) ad = null;
      render();
    })
  );

  // The 5s view must be continuous — losing window focus mid-view forfeits it
  // (the impression timeout sees a different/absent ad and never fires).
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((s) => {
      if (!s.focused && ad) {
        ad = null;
        render();
      }
    })
  );

  loadConfig(context).then((loaded) => {
    cfg = loaded;
    render();
    if (!cfg) return;
    refreshStats().then(cycle);
    timers.push(setInterval(cycle, SERVE_INTERVAL_MS));
    timers.push(setInterval(refreshStats, STATS_INTERVAL_MS));
  });
}

function deactivate() {
  for (const t of timers) clearInterval(t);
  timers = [];
}

module.exports = { activate, deactivate };
// Detector internals, exposed for the sandboxed-$HOME test harness only.
module.exports._test = { inThinkingWindow, agentCliSignals, codexLastActivity, newestFileUnder };
