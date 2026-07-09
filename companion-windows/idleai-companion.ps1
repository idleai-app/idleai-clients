# idleai companion — Windows tray ticker.
# Same rules as the macOS companion: serves ONLY while an assistant app owns the
# foreground window — or a terminal does while an agent CLI (Codex/Gemini/Grok)
# is actively writing session files — a view pays after 5 continuous seconds,
# rotation every 12s, clicks from the tray menu pay 50x. Auth reuses
# ~\.idleai.json (idleai login).
# Windows trays are icon-only, so the "line" lives in the tray tooltip + balloon.
#
# Run:  powershell -ExecutionPolicy Bypass -File idleai-companion.ps1
# Stop: tray icon -> Quit.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Win32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@

$ConfigPath = Join-Path $env:USERPROFILE ".idleai.json"
$Assistants = @("claude","chatgpt","codex","grok","gemini","perplexity","deepseek","mistral","le chat","cursor","windsurf")
# Terminals count only while an agent CLI is actually working (fresh session
# writes) — same second tier as the macOS companion.
$Terminals = @("windowsterminal","wezterm","alacritty","hyper","tabby","conemu","ghostty","cmd","powershell","pwsh","conhost")
$ViewSeconds = 5      # a view pays only after this long on screen
$RotateSeconds = 12
$AgentFreshSeconds = 15  # session writes can pause mid-turn; don't strobe

$State = [hashtable]::Synchronized(@{
  cfg = $null; ad = $null; shownAt = $null; paid = $false
  today = [long]0; paused = $false; focused = $false; serving = $false; reason = $null
  agentCheckAt = [datetime]::MinValue; agentCheck = $false
})

function Load-Config {
  if (Test-Path $ConfigPath) {
    try { return Get-Content $ConfigPath -Raw | ConvertFrom-Json } catch { return $null }
  }
  $null
}

function Format-Usd([long]$Micros) {
  $digits = if ($Micros -ne 0 -and $Micros -lt 10000) { 4 } else { 2 }
  "$" + ($Micros / 1e6).ToString("F$digits")
}

function Invoke-Api([string]$Path, [string]$Method = "GET", $Body = $null) {
  if (-not $State.cfg) { return $null }
  try {
    $args = @{
      Uri = "$($State.cfg.baseUrl)$Path"; Method = $Method; TimeoutSec = 5
      Headers = @{ Authorization = "Bearer $($State.cfg.token)" }
    }
    if ($Body) {
      $args.ContentType = "application/json"
      $args.Body = ($Body | ConvertTo-Json -Compress)
    }
    Invoke-RestMethod @args
  } catch { $null }
}

# Agent CLIs (Codex, Gemini, Grok) write session artifacts on every turn
# event — a fresh write under their home dir means that agent works right now.
function Test-DirFreshWrite([string]$Dir, [int]$Depth) {
  if (-not (Test-Path $Dir)) { return $false }
  $cut = (Get-Date).AddSeconds(-$AgentFreshSeconds)
  try {
    $newest = Get-ChildItem -Path $Dir -Recurse -Depth $Depth -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    return ($newest -and $newest.LastWriteTime -gt $cut)
  } catch { return $false }
}

function Test-AgentCliWorking {
  # Cached briefly: the 1s tick must not turn into a constant directory crawl.
  if (((Get-Date) - $State.agentCheckAt).TotalSeconds -lt 2) { return $State.agentCheck }
  $State.agentCheckAt = Get-Date
  $State.agentCheck =
    (Test-DirFreshWrite (Join-Path $env:USERPROFILE ".codex\sessions") 4) -or
    (Test-DirFreshWrite (Join-Path $env:USERPROFILE ".gemini\tmp") 5) -or
    (Test-DirFreshWrite (Join-Path $env:USERPROFILE ".grok") 4)
  $State.agentCheck
}

function Test-SurfaceWatched {
  $hwnd = [Win32]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  [void][Win32]::GetWindowText($hwnd, $sb, 512)
  $title = $sb.ToString().ToLower()
  $procId = [uint32]0
  [void][Win32]::GetWindowThreadProcessId($hwnd, [ref]$procId)
  $proc = ""
  try { $proc = (Get-Process -Id $procId -ErrorAction Stop).ProcessName.ToLower() } catch {}
  foreach ($a in $Assistants) {
    if ($title.Contains($a) -or $proc.Contains($a)) { return $true }
  }
  foreach ($t in $Terminals) {
    if ($proc.Contains($t)) { return Test-AgentCliWorking }
  }
  $false
}

# --- tray UI ---
$Icon = New-Object System.Windows.Forms.NotifyIcon
$Icon.Icon = [System.Drawing.SystemIcons]::Application
$Icon.Visible = $true

$Menu = New-Object System.Windows.Forms.ContextMenuStrip
$OpenItem  = $Menu.Items.Add("Open ad (pays 50x)")
$TodayItem = $Menu.Items.Add("Today: `$0.00")
$TodayItem.Enabled = $false
[void]$Menu.Items.Add("-")
$PauseItem = $Menu.Items.Add("Pause")
$QuitItem  = $Menu.Items.Add("Quit idleai")
$Icon.ContextMenuStrip = $Menu

function Effective-Paused {
  $State.paused -or ($State.cfg -and $State.cfg.PSObject.Properties["paused"] -and $State.cfg.paused)
}

$ReasonLabels = @{
  vpn_detected = "VPN detected - disconnect to earn"
  geo_mismatch = "country mismatch - fix your location"
  busy_elsewhere = "another device is earning - this one stands by"
}

function Render {
  # NotifyIcon.Text caps at 63 chars — truncate hard.
  $text =
    if (-not $State.cfg) { "idleai - run: idleai login" }
    elseif (Effective-Paused) { "idleai paused" }
    elseif ($State.focused -and -not $State.ad -and $State.reason -and $ReasonLabels[$State.reason]) {
      "idleai - $($ReasonLabels[$State.reason])"
    }
    elseif ($State.focused -and $State.ad) {
      $t = ($State.ad.text -replace '\s*↗\s*$', '')
      "$t | $(Format-Usd $State.today)"
    }
    else { "idleai | $(Format-Usd $State.today)" }
  if ($text.Length -gt 63) { $text = $text.Substring(0, 62) + "…" }
  $Icon.Text = $text
  $OpenItem.Enabled = [bool]$State.ad
  $TodayItem.Text = "Today: $(Format-Usd $State.today)"
  $PauseItem.Text = if ($State.paused) { "Resume" } else { "Pause" }
}

function Serve {
  if ($State.serving) { return }
  $State.serving = $true
  $res = Invoke-Api "/api/serve"
  $State.serving = $false
  $State.reason = if ($res) { $res.reason } else { $null }
  if ($res -and $res.ad) {
    $newAd = $State.ad -eq $null -or $res.ad.campaignId -ne $State.ad.campaignId
    $State.ad = $res.ad
    $State.shownAt = Get-Date
    $State.paid = $false
    if ($newAd) {
      $clean = ($res.ad.text -replace '\s*↗\s*$', '')
      $Icon.BalloonTipTitle = "idleai"
      $Icon.BalloonTipText = $clean
      $Icon.ShowBalloonTip(4000)
    }
  } else {
    $State.ad = $null; $State.shownAt = $null
  }
  Render
}

$OpenItem.Add_Click({
  if (-not $State.ad) { return }
  Start-Process $State.ad.url
  $ev = Invoke-Api "/api/events" "POST" @{ campaignId = $State.ad.campaignId; type = "click" }
  if ($ev -and $ev.ok) { $State.today += [long]$ev.customer_share_micros; Render }
})
$PauseItem.Add_Click({
  $State.paused = -not $State.paused
  if ($State.paused) { $State.ad = $null; $State.shownAt = $null }
  Render
})
$QuitItem.Add_Click({ $Icon.Visible = $false; [System.Windows.Forms.Application]::Exit() })

# --- 1s tick: focus, view threshold, rotation ---
$Tick = New-Object System.Windows.Forms.Timer
$Tick.Interval = 1000
$Tick.Add_Tick({
  $State.focused = Test-SurfaceWatched
  if (-not $State.cfg -or (Effective-Paused) -or -not $State.focused) {
    if ($State.ad) { $State.ad = $null; $State.shownAt = $null; Render }
    return
  }
  if (-not $State.ad) { Serve; return }
  $elapsed = ((Get-Date) - $State.shownAt).TotalSeconds
  if (-not $State.paid -and $elapsed -ge $ViewSeconds) {
    $State.paid = $true
    $ev = Invoke-Api "/api/events" "POST" @{ campaignId = $State.ad.campaignId; type = "impression" }
    if ($ev -and $ev.ok) { $State.today += [long]$ev.customer_share_micros; Render }
  }
  if ($State.paid -and $elapsed -ge $RotateSeconds) { Serve }
})

# --- 60s: reload config (picks up `idleai pause` / login) + resync stats ---
$Slow = New-Object System.Windows.Forms.Timer
$Slow.Interval = 60000
$Slow.Add_Tick({
  $State.cfg = Load-Config
  $s = Invoke-Api "/api/customer/stats"
  if ($s -and $s.stats) { $State.today = [long]$s.stats.today_micros }
  Render
})

$State.cfg = Load-Config
$s = Invoke-Api "/api/customer/stats"
if ($s -and $s.stats) { $State.today = [long]$s.stats.today_micros }
Render
$Tick.Start(); $Slow.Start()
[System.Windows.Forms.Application]::Run()
