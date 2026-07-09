const usd = (m) => `$${(m / 1e6).toFixed(m !== 0 && m < 10000 ? 4 : 2)}`;
const send = (type, body) => new Promise((r) => chrome.runtime.sendMessage({ type, body }, r));

const pauseBtn = document.getElementById("pause");

async function refresh() {
  const cfg = await send("getConfig");
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
document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

refresh();
