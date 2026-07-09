// idleai service worker — the only place that talks to the idleai server.
// Content scripts message here so the device token never enters page contexts.
async function getConfig() {
  const { token, baseUrl, paused } = await chrome.storage.sync.get(["token", "baseUrl", "paused"]);
  return { token: token || "", baseUrl: baseUrl || "http://localhost:3000", paused: !!paused };
}

async function api(cfg, path, init = {}) {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data;
}

async function handle(msg) {
  const cfg = await getConfig();
  switch (msg.type) {
    case "getConfig":
      return { hasToken: !!cfg.token, baseUrl: cfg.baseUrl, paused: cfg.paused };
    case "setConfig":
      await chrome.storage.sync.set(msg.body);
      return { ok: true };
  }
  if (!cfg.token) return { error: "no_token" };
  switch (msg.type) {
    case "serve":
      return cfg.paused ? { ad: null, reason: "paused" } : api(cfg, "/api/serve");
    case "event":
      return api(cfg, "/api/events", { method: "POST", body: JSON.stringify(msg.body) });
    case "stats":
      return api(cfg, "/api/customer/stats");
    case "me":
      return api(cfg, "/api/me");
    case "openAd":
      await chrome.tabs.create({ url: msg.body.url, active: true });
      return api(cfg, "/api/events", {
        method: "POST",
        body: JSON.stringify({ campaignId: msg.body.campaignId, type: "click" }),
      }).catch(() => ({ ok: false }));
    default:
      return { error: `unknown message: ${msg.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ error: e.message }));
  return true; // async response
});

// One-click connect: the idleai.app connect page (allowed via
// externally_connectable) mints a device token for the signed-in developer and
// hands it here, so the token never gets copy-pasted or shown on screen. Chrome
// already restricts senders to the declared origins; we still sanity-check the
// shape and only store an idl_ token.
chrome.runtime.onMessageExternal.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "idleai-connect" || typeof msg.token !== "string" || !msg.token.startsWith("idl_")) {
    sendResponse({ ok: false });
    return;
  }
  const body = { token: msg.token };
  if (typeof msg.baseUrl === "string" && /^https?:\/\//.test(msg.baseUrl)) body.baseUrl = msg.baseUrl;
  chrome.storage.sync.set(body).then(() => sendResponse({ ok: true }));
  return true; // async response
});
