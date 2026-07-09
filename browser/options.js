const $ = (id) => document.getElementById(id);

chrome.storage.sync.get(["token", "baseUrl"]).then(({ token, baseUrl }) => {
  $("token").value = token ?? "";
  $("baseUrl").value = baseUrl ?? "http://localhost:3000";
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
