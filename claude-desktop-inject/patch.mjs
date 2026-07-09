#!/usr/bin/env node
/**
 * idleai — Claude Desktop (Claude.app) asar patcher. Opt-in, reversible.
 *
 *   node patch.mjs patch      inject the ✶ ad line into the Claude Desktop chat
 *   node patch.mjs unpatch    restore the byte-identical original app.asar
 *   node patch.mjs status     report whether the installed asar is patched
 *   node patch.mjs verify <extractedDir>   dry-run: check both seams exist
 *
 * Claude Desktop's real chat UI is REMOTE claude.ai loaded into a main-process
 * WebContentsView, so there is no local HTML to inject a pill into. The pill
 * must ride the preload (mainView.js) Electron loads into that remote page, and
 * the ad-server broker rides the main process (index.js). This patcher:
 *   1. backs up app.asar byte-identical to app.asar.idleai-backup (+ sha256),
 *   2. extracts it, edits the two build files, repacks over the installed asar,
 *   3. rewrites the ElectronAsarIntegrity header-hash pin in Info.plist so the
 *      embedded-asar-integrity fuse still validates (else Electron aborts boot).
 * unpatch restores the backup (asar + Info.plist) exactly, then removes it.
 *
 * WHY THE PLIST STEP IS MANDATORY: the real Claude.app ships with the Electron
 * fuse EnableEmbeddedAsarIntegrityValidation = Enabled, and Info.plist pins
 * ElectronAsarIntegrity:Resources/app.asar:hash to the sha256 of app.asar's
 * header block. At boot Electron recomputes that header hash and aborts if it
 * differs from the plist value — independently of the code signature. Patching
 * app.asar changes index.js's size/offset/integrity in the header JSON, so the
 * header hash changes and the app would refuse to launch. Re-signing does NOT
 * fix this (integrity is read from the plist, not the signature). So we back up
 * Info.plist and rewrite the pinned hash to the new header hash; unpatch puts
 * the original plist back. No ad-hoc re-signing is needed or advised.
 *
 * Env overrides (for dry-runs / tests):
 *   IDLEAI_CLAUDE_APP   path to Claude.app (default /Applications/Claude.app)
 *   IDLEAI_ASAR         path to app.asar directly (overrides the app path)
 *   IDLEAI_PLIST        path to Info.plist directly (overrides the app path)
 *   IDLEAI_INJECT_DIR   dir holding idleai-preload.js + host-broker.js
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, rmSync, mkdtempSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { editAsarFiles, readAsarFile, asarHeaderHash } from "./asar.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const INJECT_DIR = process.env.IDLEAI_INJECT_DIR || HERE;

const PILL_MARKER = "__IDLEAI_PILL__";
const BROKER_MARKER = "__IDLEAI_BROKER__";
const LIB_MARKER = "__IDLEAI_LIB__";
// asar-internal paths (forward slashes — these are archive keys, not FS paths).
const PRELOAD_REL = ".vite/build/mainView.js";
const MAIN_REL = ".vite/build/index.js";

// Shared inject library — ONE canonical usd()/adText()/REASONS/Codex-signal/
// Bearer-fetch, inlined ahead of both the preload pill and the main broker so
// they call idleaiLib.* instead of carrying their own byte-identical copies.
// Overridable for tests via IDLEAI_LIB_FILE; defaults to the sibling
// clients/shared copy then a local copy in INJECT_DIR (packaging convenience).
function libSrc() {
  const candidates = [
    process.env.IDLEAI_LIB_FILE,
    join(HERE, "..", "shared", "idleai-inject-lib.js"),
    join(INJECT_DIR, "idleai-inject-lib.js"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  throw new Error("shared idleai-inject-lib.js not found (looked in: " + candidates.join(", ") + ")");
}

const GREEN = "\x1b[38;2;0;184;148m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function appPath() {
  return process.env.IDLEAI_CLAUDE_APP || "/Applications/Claude.app";
}

function asarPath() {
  if (process.env.IDLEAI_ASAR) return process.env.IDLEAI_ASAR;
  return join(appPath(), "Contents", "Resources", "app.asar");
}

// Info.plist that carries the ElectronAsarIntegrity pin. When patching a bare
// app.asar via IDLEAI_ASAR (no bundle), IDLEAI_PLIST can point at the plist; if
// neither a bundle nor IDLEAI_PLIST resolves an existing plist, integrity is
// treated as "not enforced" (bare-asar dry-runs) and the plist step is skipped.
function plistPath() {
  if (process.env.IDLEAI_PLIST) return process.env.IDLEAI_PLIST;
  if (process.env.IDLEAI_ASAR && !process.env.IDLEAI_CLAUDE_APP) return null;
  return join(appPath(), "Contents", "Info.plist");
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

// ---- Info.plist ElectronAsarIntegrity hash (PlistBuddy, macOS-native) ----

const PLIST_HASH_KEY = ":ElectronAsarIntegrity:Resources/app.asar:hash";

// The pinned integrity hash currently in the plist, or null if the app does not
// enforce asar integrity (key/plist absent — e.g. an older build or a bare-asar
// dry-run). A present value means the fuse is on and boot WILL abort on mismatch.
function readPlistHash(plist) {
  if (!plist || !existsSync(plist)) return null;
  try {
    const out = execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print ${PLIST_HASH_KEY}`, plist], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null; // key absent → integrity not pinned
  }
}

// Does this plist carry an ElectronAsarIntegrity dict at all? Used to tell
// "integrity genuinely off (key absent)" apart from "PlistBuddy failed / the pin
// is unreadable" — the latter must fail LOUDLY, never be treated as off, or we'd
// patch app.asar without fixing the pin and brick boot. Tri-state:
//   "present"  the ElectronAsarIntegrity dict exists (fuse is on)
//   "absent"   PlistBuddy ran and the dict is not there (fuse off / old build /
//              no plist to enforce against, e.g. a bare-asar dry-run)
//   "unknown"  PlistBuddy is missing or errored for another reason (bail loud)
function integrityState(plist) {
  if (!plist || !existsSync(plist)) return "absent";
  try {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :ElectronAsarIntegrity", plist], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    return "present";
  } catch (e) {
    const msg = ((e && e.stderr ? e.stderr.toString() : "") + (e && e.message ? e.message : "")) || "";
    if (/Does Not Exist/i.test(msg)) return "absent"; // key truly not there
    if (e && e.code === "ENOENT") return "unknown";   // no PlistBuddy binary
    return "unknown";                                  // corrupt/unreadable plist
  }
}

function writePlistHash(plist, hash) {
  execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set ${PLIST_HASH_KEY} ${hash}`, plist], {
    stdio: ["ignore", "ignore", "pipe"],
  });
}

// ---- the two edits, computed on the in-archive file contents (strings) ----

// 1) Append the display-only pill to the END of the claude.ai preload, before
//    its trailing sourceMappingURL comment. The preload does zero DOM injection
//    today, so appending is clean. Idempotent via PILL_MARKER.
function editPreload(src) {
  if (src.includes(PILL_MARKER)) return { content: src, skipped: true };
  // Inline the shared lib (idleaiLib) ahead of the pill so usd()/adText() resolve
  // in the preload's isolated world before the pill runs.
  const lib = src.includes(LIB_MARKER) ? "" : libSrc() + "\n";
  const pill = lib + `/* ${PILL_MARKER} */\n` + readFileSync(join(INJECT_DIR, "idleai-preload.js"), "utf8");
  const smIdx = src.lastIndexOf("//# sourceMappingURL=");
  const out = smIdx >= 0 ? src.slice(0, smIdx) + pill + "\n" + src.slice(smIdx) : src + "\n" + pill + "\n";
  return { content: out, skipped: false };
}

// 2) Inject the broker into the main process, hooked into the content-view
//    factory. Minified identifiers change every app version (JSt/ue/aT/kp/oA
//    today, Q3e/le/LT/hp/gA before), so we match STRUCTURALLY: a factory whose
//    body is `return <VAR>=new <ns>.WebContentsView(<param>), <fn>(<VAR>
//    .webContents, <enum>.CLAUDE_AI_WEB), … , <VAR>}` — tolerating extra
//    statements (e.g. setMaxListeners) between the CLAUDE_AI_WEB call and the
//    trailing `,<VAR>}`. We capture <VAR>, define the broker function once, and
//    splice `,__idleaiInitBroker(<VAR>)` before the final `,<VAR>}` so it runs
//    on every view creation. Idempotent via BROKER_MARKER.
const FACTORY_RE =
  /return ([A-Za-z0-9_$]+)=new [A-Za-z0-9_$.]+\.WebContentsView\([A-Za-z0-9_$]+\),[A-Za-z0-9_$]+\(\1\.webContents,[A-Za-z0-9_$.]+\.CLAUDE_AI_WEB\)((?:,(?!\1\})[^}]*?)*),\1\}/;

function editMain(src) {
  if (src.includes(BROKER_MARKER)) return { content: src, skipped: true };
  const matches = src.match(new RegExp(FACTORY_RE, "g"));
  if (!matches || matches.length === 0) {
    throw new Error("content-view factory seam not found in index.js (Claude internals changed)");
  }
  if (matches.length > 1) {
    throw new Error(`content-view factory seam is ambiguous (${matches.length} matches) — aborting`);
  }
  const m = FACTORY_RE.exec(src);
  const capture = m[1];
  // Broker function body, comment stripped to a one-line marker. The shared lib
  // (idleaiLib) is inlined ahead of the broker fn (idempotent via LIB_MARKER) so
  // it is defined in the main-process module scope before __idleaiInitBroker runs.
  const brokerSrc = readFileSync(join(INJECT_DIR, "host-broker.js"), "utf8");
  const lib = src.includes(LIB_MARKER) ? "" : libSrc();
  const brokerFn = lib + `/* ${BROKER_MARKER} */` + brokerSrc.replace(/\/\*[\s\S]*?\*\//, "");
  // Define the broker fn just before the whole matched return statement, then
  // splice the init call into the return's comma-expression (before `,<VAR>}`).
  const patchedReturn = m[0].replace(new RegExp(",(" + capture + ")\\}$"), `,__idleaiInitBroker($1),$1}`);
  const out = src.replace(m[0], brokerFn + patchedReturn);
  return { content: out, skipped: false };
}

// Parse-check a JS string by writing it to a temp file and running `node --check`.
function nodeCheck(label, code) {
  const tmp = join(mkdtempSync(join(tmpdir(), "idleai-check-")), "check.js");
  writeFileSync(tmp, code);
  try {
    execFileSync(process.execPath, ["--check", tmp]);
  } finally {
    try { rmSync(dirname(tmp), { recursive: true, force: true }); } catch {}
  }
}

// ---- top-level commands ----

function cmdVerify(target) {
  // Dry-run seam check. `target` may be an asar file OR an extracted tree with
  // .vite/build/*.js inside; mutates nothing.
  let pre, main;
  const asarCandidate = existsSync(target) && statSync(target).isFile();
  if (asarCandidate) {
    pre = readAsarFile(target, PRELOAD_REL);
    main = readAsarFile(target, MAIN_REL);
    pre = pre && pre.toString("utf8");
    main = main && main.toString("utf8");
  } else {
    const pf = join(target, ".vite", "build", "mainView.js");
    const mf = join(target, ".vite", "build", "index.js");
    pre = existsSync(pf) ? readFileSync(pf, "utf8") : null;
    main = existsSync(mf) ? readFileSync(mf, "utf8") : null;
  }
  let ok = true;
  if (!pre) { console.error(`${RED}✗${RESET} missing ${PRELOAD_REL}`); ok = false; }
  else {
    const hasSm = pre.includes("//# sourceMappingURL=");
    console.log(`${hasSm ? GREEN + "✓" : YELLOW + "•"}${RESET} preload sourceMappingURL anchor ${hasSm ? "present" : "absent (append at EOF)"}`);
  }
  if (!main) { console.error(`${RED}✗${RESET} missing ${MAIN_REL}`); ok = false; }
  else {
    const g = main.match(new RegExp(FACTORY_RE, "g"));
    const n = g ? g.length : 0;
    const cap = n === 1 ? FACTORY_RE.exec(main)[1] : null;
    if (n === 1) console.log(`${GREEN}✓${RESET} content-view factory seam: unique (capture var "${cap}")`);
    else { console.error(`${RED}✗${RESET} content-view factory seam: ${n} matches (need exactly 1)`); ok = false; }
  }
  process.exit(ok ? 0 : 1);
}

function cmdStatus() {
  const asarFile = asarPath();
  if (!existsSync(asarFile)) { console.error(`${RED}✗${RESET} app.asar not found at ${asarFile}`); process.exit(1); }
  const bak = `${asarFile}.idleai-backup`;
  const plist = plistPath();
  const plistBak = plist ? `${plist}.idleai-backup` : null;
  console.log(`asar:   ${asarFile} (${statSync(asarFile).size} bytes, sha256 ${sha256(asarFile).slice(0, 12)}…)`);
  console.log(`backup: ${existsSync(bak) ? bak + " present (patched)" : "none (not patched)"}`);
  const pinned = readPlistHash(plist);
  if (pinned) {
    const live = asarHeaderHash(asarFile);
    const match = pinned === live;
    console.log(`integrity: pinned ${pinned.slice(0, 12)}… · header ${live.slice(0, 12)}… · ${match ? "match (boots)" : "MISMATCH (would abort boot)"}`);
    console.log(`plist bak: ${plistBak && existsSync(plistBak) ? plistBak + " present" : "none"}`);
  } else {
    console.log(`integrity: not enforced (no ElectronAsarIntegrity pin)`);
  }
  process.exit(0);
}

function cmdPatch() {
  const asarFile = asarPath();
  if (!existsSync(asarFile)) {
    console.error(`${RED}✗${RESET} app.asar not found at ${asarFile} — is Claude Desktop installed?`);
    process.exit(1);
  }
  const bak = `${asarFile}.idleai-backup`;
  const plist = plistPath();
  const plistBak = plist ? `${plist}.idleai-backup` : null;
  // Is asar integrity enforced? Gate LOUDLY before touching anything: the whole
  // patch is unsafe if we cannot both read AND rewrite the ElectronAsarIntegrity
  // pin, because a patched app.asar with a stale pin bricks Claude.app boot.
  //   present + readable hash → rewrite it after patching (the normal path).
  //   absent                  → fuse off / bare-asar dry-run; skip the plist step.
  //   unknown                 → refuse; do NOT guess it is off.
  const state = integrityState(plist);
  if (state === "unknown") {
    console.error(`${RED}✗${RESET} could not determine asar-integrity state from Info.plist (${plist}).`);
    console.error(`${DIM}  PlistBuddy is missing or the plist is unreadable. Refusing to patch —${RESET}`);
    console.error(`${DIM}  a patched app.asar with a stale ElectronAsarIntegrity pin would brick Claude.app boot.${RESET}`);
    console.error(`${DIM}  fix: ensure /usr/libexec/PlistBuddy exists and ${plist} is readable, then re-run.${RESET}`);
    process.exit(1);
  }
  const integrityEnforced = state === "present";
  if (integrityEnforced) {
    // Fuse is on: we MUST have a readable pin AND be able to write it back, or we
    // would brick boot. Verify the hash is readable up front.
    const pinnedHash = readPlistHash(plist);
    if (pinnedHash === null) {
      console.error(`${RED}✗${RESET} ElectronAsarIntegrity is present but its Resources/app.asar hash is unreadable.`);
      console.error(`${DIM}  refusing to patch — a mismatched header hash would brick Claude.app boot.${RESET}`);
      process.exit(1);
    }
  }
  // 1) byte-identical backup + sha record (only on first patch).
  if (!existsSync(bak)) {
    copyFileSync(asarFile, bak);
    writeFileSync(`${bak}.sha256`, sha256(bak) + "  app.asar\n");
    console.log(`${DIM}  backed up → ${bak}${RESET}`);
  } else {
    console.log(`${DIM}  backup already exists (re-patching over a fresh extract)${RESET}`);
  }
  // 1b) byte-identical Info.plist backup so unpatch restores the original pin.
  if (integrityEnforced && plistBak && !existsSync(plistBak)) {
    copyFileSync(plist, plistBak);
    console.log(`${DIM}  backed up → ${plistBak}${RESET}`);
  }
  // 2) edit the two packed files in place (app.asar.unpacked is untouched).
  try {
    const preSrc = readAsarFile(asarFile, PRELOAD_REL);
    const mainSrc = readAsarFile(asarFile, MAIN_REL);
    if (!preSrc) throw new Error(`${PRELOAD_REL} not found in app.asar (Claude layout changed)`);
    if (!mainSrc) throw new Error(`${MAIN_REL} not found in app.asar (Claude layout changed)`);
    const p = editPreload(preSrc.toString("utf8"));
    const b = editMain(mainSrc.toString("utf8"));
    // Sanity: both edited files must still parse before we commit them.
    nodeCheck(PRELOAD_REL, p.content);
    nodeCheck(MAIN_REL, b.content);
    const edits = {};
    if (!p.skipped) edits[PRELOAD_REL] = p.content;
    if (!b.skipped) edits[MAIN_REL] = b.content;
    if (Object.keys(edits).length) editAsarFiles(asarFile, edits);
    // Confirm the markers landed and the archive still reads back.
    const check = readAsarFile(asarFile, MAIN_REL).toString("utf8");
    if (!check.includes(BROKER_MARKER)) throw new Error("post-write verification failed (broker marker absent)");
    // 3) Rewrite the ElectronAsarIntegrity header-hash pin so the fuse validates
    //    the patched asar instead of aborting boot on the stale hash.
    if (integrityEnforced) {
      const newHash = asarHeaderHash(asarFile);
      writePlistHash(plist, newHash);
      const confirm = readPlistHash(plist);
      if (confirm !== newHash) {
        throw new Error(`Info.plist integrity hash did not update (got ${confirm}, expected ${newHash})`);
      }
      console.log(`${DIM}  integrity pin updated → ${newHash.slice(0, 12)}…${RESET}`);
    }
    console.log(`${GREEN}✶${RESET} Claude Desktop patched — the ✶ ad line renders in the chat while Claude thinks.`);
    console.log(`${DIM}  preload: ${p.skipped ? "already injected" : "injected"} · broker: ${b.skipped ? "already injected" : "injected"}${RESET}`);
    console.log(`${DIM}  fully quit and reopen Claude.app to load it.${RESET}`);
    console.log(`${YELLOW}  note:${RESET}${DIM} a Claude Desktop update overwrites app.asar and Info.plist — re-run patch. Undo: unpatch.${RESET}`);
  } catch (e) {
    // Roll back to the backups so neither a half-written archive nor a mismatched
    // integrity pin ever ships (either alone would break boot).
    try { if (existsSync(bak)) copyFileSync(bak, asarFile); } catch {}
    try { if (plistBak && existsSync(plistBak)) copyFileSync(plistBak, plist); } catch {}
    console.error(`${RED}✗${RESET} patch failed: ${e.message}`);
    console.error(`${DIM}  app.asar${integrityEnforced ? " and Info.plist" : ""} restored from backup; nothing left half-written.${RESET}`);
    process.exit(1);
  }
}

function cmdUnpatch() {
  const asarFile = asarPath();
  const bak = `${asarFile}.idleai-backup`;
  const plist = plistPath();
  const plistBak = plist ? `${plist}.idleai-backup` : null;
  if (!existsSync(bak) && !(plistBak && existsSync(plistBak))) {
    console.log(`${DIM}✶ no idleai backup found — Claude Desktop was not patched (or already restored).${RESET}`);
    process.exit(0);
  }
  let okSha = true;
  if (existsSync(bak)) {
    copyFileSync(bak, asarFile);
    okSha = existsSync(`${bak}.sha256`)
      ? readFileSync(`${bak}.sha256`, "utf8").trim().split(/\s+/)[0] === sha256(asarFile)
      : true;
    rmSync(bak);
    try { rmSync(`${bak}.sha256`); } catch {}
  }
  // Restore the original Info.plist (with its original integrity pin) so the
  // fuse validates the restored asar. We never touched the code signature, so
  // the original signature is intact — no re-signing was ever needed.
  let plistRestored = false;
  if (plistBak && existsSync(plistBak)) {
    copyFileSync(plistBak, plist);
    rmSync(plistBak);
    plistRestored = true;
  }
  console.log(`${GREEN}✶${RESET} Claude Desktop restored from backup${okSha ? " (sha256 verified)" : ""} — fully quit and reopen Claude.app.`);
  if (plistRestored) console.log(`${DIM}  Info.plist integrity pin restored; the original code signature was never touched.${RESET}`);
  process.exit(0);
}

const [, , cmd, arg] = process.argv;
switch (cmd) {
  case "patch": cmdPatch(); break;
  case "unpatch": cmdUnpatch(); break;
  case "status": cmdStatus(); break;
  case "verify":
    if (!arg) { console.error("usage: node patch.mjs verify <extractedAsarDir>"); process.exit(1); }
    cmdVerify(arg);
    break;
  default:
    console.log(`idleai — Claude Desktop asar patcher
usage:
  node patch.mjs patch      inject the ✶ ad line into Claude Desktop (backs up app.asar)
  node patch.mjs unpatch    restore the byte-identical original app.asar
  node patch.mjs status     is the installed asar patched?
  node patch.mjs verify <extractedDir>   dry-run seam check (mutates nothing)`);
}
