const usd = (m) => `$${(m / 1e6).toFixed(m !== 0 && m < 10000 ? 4 : 2)}`;
const send = (type, body) => new Promise((r) => chrome.runtime.sendMessage({ type, body }, r));
const DEFAULT_BASE = "https://idleai.app";

const pauseBtn = document.getElementById("pause");

async function refresh() {
  const cfg = await send("getConfig");
  // No token yet → show the one-click connect prompt instead of empty stats.
  document.getElementById("connected").style.display = cfg?.hasToken ? "block" : "none";
  document.getElementById("disconnected").style.display = cfg?.hasToken ? "none" : "block";
  if (!cfg?.hasToken) return;
  pauseBtn.textContent = cfg?.paused ? "resume" : "pause";
  const s = await send("stats");
  if (s?.stats) {
    document.getElementById("today").textContent = usd(s.stats.today_micros);
    document.getElementById("balance").textContent = usd(s.balance_micros ?? 0);
  }
}

pauseBtn.addEventListener("click", async () => {
  const cfg = await send("getConfig");
  await send("setConfig", { paused: !cfg.paused });
  refresh();
});
document.getElementById("connect").addEventListener("click", async () => {
  const cfg = await send("getConfig");
  const base = (cfg?.baseUrl || DEFAULT_BASE).replace(/\/$/, "");
  chrome.tabs.create({ url: `${base}/connect/extension?ext=${encodeURIComponent(chrome.runtime.id)}` });
});
document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
// Reflect the token arriving from the connect page without reopening the popup.
chrome.storage.onChanged.addListener((c, area) => {
  if (area === "sync" && c.token) refresh();
});

refresh();
