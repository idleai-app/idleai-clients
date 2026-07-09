#!/usr/bin/env node
// idleai MCP server — the utility-connector build for tool catalogs
// (Claude Code/Desktop, Codex, Gemini CLI, Grok, ChatGPT dev mode).
//
// Deliberately NOT an ad slot: connectors are model-invoked, so tools here are
// honest utilities (earnings, current ad, pause control). Views/clicks are only
// ever paid by real rendering clients — never from a tool call.
//
// Zero deps. stdio transport (newline-delimited JSON-RPC 2.0).
// Auth: ~/.idleai.json (idleai login idl_xxx).
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";

const CONFIG_PATH = join(homedir(), ".idleai.json");
const PROTOCOL = "2025-06-18";

const loadConfig = () => {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
};

async function api(path) {
  const cfg = loadConfig();
  if (!cfg?.token) throw new Error("Not logged in — run: idleai login idl_xxx");
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
    signal: AbortSignal.timeout(5000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data;
}

const usd = (m) => `$${(m / 1e6).toFixed(m !== 0 && m < 10000 ? 4 : 2)}`;

const TOOLS = [
  {
    name: "check_earnings",
    description:
      "The developer's idleai earnings: today, balance, streak, level and leaderboard position.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      const s = await api("/api/customer/stats");
      const me = s.leaderboard?.find((r) => r.is_me);
      return [
        `Today: ${usd(s.stats.today_micros)} · Balance: ${usd(s.balance_micros ?? 0)}`,
        `Streak: ${s.streak} days · Level: ${s.level?.name ?? "—"}`,
        me ? `Leaderboard: #${s.leaderboard.indexOf(me) + 1} of ${s.leaderboard.length}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    },
  },
  {
    name: "current_ad",
    description:
      "The ad currently winning the developer's screen (text, advertiser URL, what a view/click pays). Informational — does not record a view.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      const { ad, reason } = await api("/api/serve");
      if (!ad) return `No live ad (${reason ?? "no inventory"}).`;
      return `${ad.takeover ? "✶ TAKEOVER: " : "✶ "}${ad.text}\n${ad.url}\nview pays ${usd(ad.perImpressionMicros)} · click pays ${usd(ad.perClickMicros)}`;
    },
  },
  {
    name: "set_paused",
    description:
      "Pause or resume idleai on this machine (all local clients honor the shared flag).",
    inputSchema: {
      type: "object",
      properties: { paused: { type: "boolean", description: "true = stop serving everywhere" } },
      required: ["paused"],
      additionalProperties: false,
    },
    run: async ({ paused }) => {
      const cfg = loadConfig();
      if (!cfg?.token) throw new Error("Not logged in — run: idleai login idl_xxx");
      cfg.paused = !!paused;
      writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
      return paused ? "idleai paused on this machine." : "idleai resumed — earning again.";
    },
  },
];

const respond = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const respondErr = (id, message, code = -32000) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // notification — nothing to do
  try {
    switch (method) {
      case "initialize":
        respond(id, {
          protocolVersion: params?.protocolVersion ?? PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "idleai", version: "0.1.0" },
        });
        break;
      case "ping":
        respond(id, {});
        break;
      case "tools/list":
        respond(id, {
          tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
        break;
      case "tools/call": {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) return respondErr(id, `unknown tool: ${params?.name}`, -32602);
        try {
          const text = await tool.run(params?.arguments ?? {});
          respond(id, { content: [{ type: "text", text }], isError: false });
        } catch (e) {
          respond(id, { content: [{ type: "text", text: e.message }], isError: true });
        }
        break;
      }
      default:
        respondErr(id, `method not found: ${method}`, -32601);
    }
  } catch (e) {
    respondErr(id, e.message);
  }
});
