const $ = (id) => document.getElementById(id);

// Where the one-click connect flow lives when no server is configured yet.
const DEFAULT_BASE = "https://idleai.app";

chrome.storage.sync.get(["token", "baseUrl"]).then(({ token, baseUrl }) => {
  $("token").value = token ?? "";
  $("baseUrl").value = baseUrl ?? "http://localhost:3000";
});

// Connect: open the idleai connect page, passing our extension id so the page
// can hand the minted token straight back over externally_connectable. We never
// see or store the token here — the service worker's onMessageExternal does.
$("connect").addEventListener("click", () => {
  const base = ($("baseUrl").value.trim() || DEFAULT_BASE).replace(/\/$/, "");
  const url = `${base}/connect/extension?ext=${encodeURIComponent(chrome.runtime.id)}`;
  chrome.tabs.create({ url });
});

// When the connect page delivers the token, reflect it here without a reload.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes.token) $("token").value = changes.token.newValue ?? "";
  if (changes.baseUrl) $("baseUrl").value = changes.baseUrl.newValue ?? "";
  if (changes.token?.newValue) {
    const msg = $("msg");
    msg.className = "ok";
    msg.textContent = "✶ connected — open claude.ai/chatgpt/grok/gemini/mistral and start a prompt";
  }
});

$("save").addEventListener("click", async () => {
  const msg = $("msg");
  msg.className = "";
  msg.textContent = "testing…";
  const body = { token: $("token").value.trim(), baseUrl: $("baseUrl").value.trim().replace(/\/$/, "") };
  await chrome.storage.sync.set(body);
  const me = await new Promise((r) => chrome.runtime.sendMessage({ type: "me" }, r));
  if (me?.user) {
    msg.className = "ok";
    msg.textContent = `✶ signed in as ${me.user.email} — open claude.ai/chatgpt/grok/gemini/mistral and start a prompt`;
  } else {
    msg.className = "err";
    msg.textContent = `token rejected: ${me?.error ?? "no response"}`;
  }
});
