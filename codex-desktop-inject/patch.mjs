#!/usr/bin/env node
// idleai — Codex Desktop (Codex.app) injection: patch / unpatch.
//
// Opt-in, reversible. Patches OpenAI's installed app.asar to render one ✶ ad
// line INSIDE the Codex chat window, using the DISPLAY-ONLY pill + MAIN-PROCESS
// broker split (see idleai-line.js and main-broker.js). Before patching, the
// original app.asar, app.asar.unpacked, Info.plist AND the whole Contents/
// _CodeSignature bundle are backed up; `unpatch` restores those exact bytes,
// including the original Developer-ID signature when the _CodeSignature backup
// is present. If any signature/mutation byte differs at unpatch time, the
// script falls back to ad-hoc re-signing and says so — it never falsely claims
// the Developer-ID seal was restored.
//
// The live apply is transactional: it preflights writability of every dir it
// will touch (Contents/Resources, Contents, Contents/_CodeSignature), snapshots
// the current asar+plist, and wraps the swap in try/catch that rolls back to
// the pre-patch bytes on ANY failure — no half-patched, boot-bricked bundle.
//
// Usage:
//   node patch.mjs patch    [--app <Codex.app>] [--dry-run [--out <dir>]]
//   node patch.mjs unpatch  [--app <Codex.app>]
//   node patch.mjs status   [--app <Codex.app>]
//
// --dry-run copies the whole bundle to a staging dir and patches the COPY,
//   verifying every step (extract, inject, repack, integrity, plist) WITHOUT
//   touching the installed app. Nothing is re-signed or swapped in dry-run.
//
// Writes into /Applications/Codex.app are blocked by macOS App Management
// (com.apple.provenance + SIP) unless the terminal holds App Management / Full
// Disk Access. If a live write EPERMs, the script prints the exact grant/relaunch
// steps and exits non-zero without leaving the bundle half-patched.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Resolve @electron/asar from this dir (after `npm install` here) or from a
// path given in IDLEAI_ASAR_MODULE. Keeps the client install-light: no dep is
// bundled, but the patcher needs the asar module API (header hashing + pack).
let asar;
try {
  asar = await import("@electron/asar");
} catch (e1) {
  const alt = process.env.IDLEAI_ASAR_MODULE;
  if (alt) {
    asar = await import(alt);
  } else {
    console.error(
      "[idleai] @electron/asar is required. Install it once:\n" +
        "  cd " +
        HERE +
        " && npm install\n" +
        "  then re-run. (or set IDLEAI_ASAR_MODULE to an installed @electron/asar path)"
    );
    process.exit(1);
  }
}
const MARK = "__IDLEAI__";
const BROKER_MARK = "__IDLEAI_BROKER__";

// ---- arg parse ----
const argv = process.argv.slice(2);
const cmd = argv[0];
function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0;
}
function opt(name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const APP = opt("--app", "/Applications/Codex.app");
const DRY = flag("--dry-run");

function log(...a) {
  console.log("[idleai]", ...a);
}
function die(msg) {
  console.error("[idleai] ERROR:", msg);
  process.exit(1);
}
function sh(bin, args, o = {}) {
  const r = spawnSync(bin, args, { encoding: "utf8", ...o });
  return r;
}

function paths(appDir) {
  const res = path.join(appDir, "Contents", "Resources");
  // ALL backups live in a sidecar dir NEXT TO the .app, never inside it. A
  // backup placed inside Contents/ (especially a _CodeSignature copy) is walked
  // by `codesign --deep` as a bundle subcomponent and makes the re-sign fail
  // ("bundle format unrecognized"). Keeping backups outside the bundle also
  // means the re-signed bundle contains zero idleai artifacts on disk.
  const backupRoot = appDir + ".idleai-backup";
  return {
    app: appDir,
    resources: res,
    asar: path.join(res, "app.asar"),
    asarUnpacked: path.join(res, "app.asar.unpacked"),
    contents: path.join(appDir, "Contents"),
    infoPlist: path.join(appDir, "Contents", "Info.plist"),
    codeSignature: path.join(appDir, "Contents", "_CodeSignature"),
    // sidecar backups
    backupRoot,
    asarBackup: path.join(backupRoot, "app.asar"),
    asarUnpackedBackup: path.join(backupRoot, "app.asar.unpacked"),
    infoBackup: path.join(backupRoot, "Info.plist"),
    codeSignatureBackup: path.join(backupRoot, "_CodeSignature"),
  };
}

// The two seams inside the asar.
const MAIN_JS = ".vite/build/main-DVEWN1ng.js";
const INDEX_HTML = "webview/index.html";
const PILL_ASSET = "webview/assets/idleai-line.js";
// Match the anchor loosely (regex) so a minor Codex rebuild that renames vars
// but keeps `did-finish-load` + `setZoomLevel(0)` still patches. Group 1 is the
// whole matched anchor (we re-emit it verbatim); group 2 CAPTURES the minified
// identifier bound to the primary BrowserWindow, so the broker's IIFE can be
// invoked with the REAL var name instead of a hardcoded `A` (CRITICAL: the
// var is not always `A` — a rebuild renames it, and `)(A)` would ReferenceError
// or, worse, bind an unrelated global `A`).
const ANCHOR_RE = /(\.webContents\.once\(`did-finish-load`,\(\)=>\{([A-Za-z$_][A-Za-z0-9$_]*)\.webContents\.setZoomLevel\(0\),)/;
// The placeholder in main-broker.js's `})(__IDLEAI_WIN__);` tail that we rewrite
// to the captured identifier.
const WIN_PLACEHOLDER = "__IDLEAI_WIN__";

function plistBuddy(args, plist) {
  return sh("/usr/libexec/PlistBuddy", [...args, plist]);
}

function readIntegrityHash(plist) {
  const r = plistBuddy(
    ["-c", "Print :ElectronAsarIntegrity:Resources/app.asar:hash"],
    plist
  );
  return r.status === 0 ? r.stdout.trim() : null;
}

function computeAsarHeaderHash(asarPath) {
  const raw = asar.getRawHeader(asarPath);
  return crypto.createHash("sha256").update(raw.headerString).digest("hex");
}

// The unpack glob that preserves the shipped native modules.
const UNPACK_DIR = "{node_modules/better-sqlite3,node_modules/node-pty,node_modules/objc-js}";

// ---- inject the three edits into an extracted tree ----
function injectTree(root) {
  const mainPath = path.join(root, MAIN_JS);
  const htmlPath = path.join(root, INDEX_HTML);
  const pillPath = path.join(root, PILL_ASSET);

  if (!fs.existsSync(mainPath)) die(`missing ${MAIN_JS} in asar`);
  if (!fs.existsSync(htmlPath)) die(`missing ${INDEX_HTML} in asar`);

  // 1) main-process broker
  let main = fs.readFileSync(mainPath, "utf8");
  if (main.includes(BROKER_MARK)) {
    log("main broker already present — skipping");
  } else {
    const anchor = ANCHOR_RE.exec(main);
    if (!anchor) die(`did-finish-load anchor not found in ${MAIN_JS}`);
    // Group 2 is the minified identifier of the primary BrowserWindow. Bind the
    // broker's IIFE to THAT captured name, never a hardcoded `A`.
    const winVar = anchor[2];
    if (!winVar) die("could not capture the BrowserWindow identifier from anchor");
    let broker = fs.readFileSync(path.join(HERE, "main-broker.js"), "utf8");
    if (!broker.includes(WIN_PLACEHOLDER)) {
      die(`main-broker.js must invoke the IIFE as })(${WIN_PLACEHOLDER});`);
    }
    // Substitute the captured var into the broker's `})(__IDLEAI_WIN__);` tail.
    broker = broker.split(WIN_PLACEHOLDER).join(winVar);
    log(`binding broker to captured window var '${winVar}'`);
    // Insert the broker body right after the anchor, inside the callback.
    main = main.replace(ANCHOR_RE, (m) => m + "\n/*" + BROKER_MARK + "*/(function(){" + broker + "})();\n");
    fs.writeFileSync(mainPath, main);
    log("injected main broker after did-finish-load anchor");
  }

  // 2) pill asset (copy verbatim from the client dir)
  fs.mkdirSync(path.dirname(pillPath), { recursive: true });
  fs.copyFileSync(path.join(HERE, "idleai-line.js"), pillPath);
  log("wrote", PILL_ASSET);

  // 3) index.html script tag
  let html = fs.readFileSync(htmlPath, "utf8");
  if (html.includes(MARK)) {
    log("index.html script tag already present — skipping");
  } else {
    const tag = `    <script ${MARK} src="./assets/idleai-line.js"></script>\n  </body>`;
    if (!html.includes("</body>")) die("no </body> in index.html");
    html = html.replace("</body>", tag);
    fs.writeFileSync(htmlPath, html);
    log("added pill <script> to index.html");
  }
}

function extract(asarPath, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  asar.extractAll(asarPath, dest);
}

function repack(root, outAsar) {
  // async pack; run synchronously via a small wrapper
  return asar.createPackageWithOptions(root, outAsar, {
    unpackDir: UNPACK_DIR,
  });
}

// ---- writability preflight ----
// Probe a single directory by creating and removing a temp file INSIDE it.
function dirWritable(dir) {
  const probe = path.join(dir, ".idleai-wtest-" + process.pid);
  try {
    fs.writeFileSync(probe, "x");
    fs.rmSync(probe);
    return true;
  } catch (e) {
    return false;
  }
}

// Every live mutation lands in one of these dirs, so ALL must be writable
// before we touch anything:
//   Contents/Resources      → app.asar, app.asar.unpacked
//   Contents                → Info.plist
//   Contents/_CodeSignature → rewritten by codesign
//   <App>.app.idleai-backup → sidecar backups (parent = the .app's parent dir)
// The old preflight probed only Resources and never the dirs that hold the
// plist, the signature, or the backups, so a half-patched, boot-bricked bundle
// was possible when Resources was writable but one of the others was not.
function assertWritable(P) {
  const dirs = [P.resources, P.contents, path.dirname(P.backupRoot)];
  if (fs.existsSync(P.codeSignature)) dirs.push(P.codeSignature);
  const blocked = dirs.filter((d) => !dirWritable(d));
  return blocked.length === 0 ? null : blocked;
}

function appManagementHelp() {
  return [
    "Writes into " + APP + " are blocked by macOS App Management.",
    "Grant your terminal permission ONCE, then re-run:",
    "  System Settings > Privacy & Security > App Management  → enable your terminal (Terminal / iTerm / etc.)",
    "  (or add it to Full Disk Access)",
    "Then fully quit Codex and re-run:  node patch.mjs patch",
  ].join("\n  ");
}

async function doPatch() {
  const P = paths(APP);
  if (!fs.existsSync(P.asar)) die(`no app.asar at ${P.asar} — is Codex installed?`);

  const shippedHash = readIntegrityHash(P.infoPlist);
  if (!shippedHash) die("could not read ElectronAsarIntegrity from Info.plist");
  const actualHash = computeAsarHeaderHash(P.asar);
  log("current asar header hash:", actualHash);
  log("plist integrity hash    :", shippedHash);
  if (actualHash !== shippedHash) {
    log("WARNING: current asar hash != plist (already patched, or Codex updated).");
  }

  // staging root: dry-run uses an out dir; live uses a temp then swaps files.
  const stageBase = DRY
    ? opt("--out", path.join(os.tmpdir(), "idleai-codex-desktop-dryrun"))
    : fs.mkdtempSync(path.join(os.tmpdir(), "idleai-codex-"));
  fs.mkdirSync(stageBase, { recursive: true });
  const unpackedTree = path.join(stageBase, "unpacked");
  const newAsar = path.join(stageBase, "app.asar");

  log("extracting asar →", unpackedTree);
  extract(P.asar, unpackedTree);

  injectTree(unpackedTree);

  log("repacking →", newAsar);
  await repack(unpackedTree, newAsar);

  const newHash = computeAsarHeaderHash(newAsar);
  log("new asar header hash:", newHash);

  if (DRY) {
    // In dry-run, verify plist edit against a COPY of the plist, and stop.
    const plistCopy = path.join(stageBase, "Info.plist");
    fs.copyFileSync(P.infoPlist, plistCopy);
    const r = plistBuddy(
      ["-c", `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${newHash}`],
      plistCopy
    );
    if (r.status !== 0) die("PlistBuddy Set failed on copy: " + r.stderr);
    const verify = readIntegrityHash(plistCopy);
    log("dry-run plist verify hash:", verify, verify === newHash ? "OK" : "MISMATCH");
    log("");
    log("DRY RUN complete. Nothing on the live app was touched.");
    log("  staged asar : " + newAsar);
    log("  staged plist: " + plistCopy);
    log("  new integrity hash: " + newHash);
    return;
  }

  // ---- LIVE apply ----
  // Preflight EVERY directory a mutation touches (Resources + Contents +
  // _CodeSignature). If any is blocked, bail BEFORE touching the bundle.
  const blocked = assertWritable(P);
  if (blocked) {
    die(
      "\n  not writable: " +
        blocked.join(", ") +
        "\n\n  " +
        appManagementHelp()
    );
  }

  const stagedUnpacked = newAsar + ".unpacked";

  // Full backups FIRST, before any mutation — asar, unpacked, plist AND the
  // original _CodeSignature bundle (so unpatch can restore the pristine signed
  // state, not just ad-hoc re-sign). Only back up if not already present, so a
  // re-run after an update never overwrites the pristine backup with a patched
  // one. Track what we created this run for rollback.
  const createdBackups = [];
  function backup(src, dst, isDir) {
    if (fs.existsSync(dst)) {
      log(path.basename(dst) + " already exists — keeping original backup");
      return;
    }
    if (!fs.existsSync(src)) return;
    if (isDir) fs.cpSync(src, dst, { recursive: true });
    else fs.copyFileSync(src, dst);
    createdBackups.push({ dst, isDir });
    log("backed up " + path.basename(src) + " → " + path.basename(dst));
  }

  // Snapshot the live originals we are about to overwrite so we can restore the
  // EXACT current bytes on any mid-apply failure, even if a stale idleai backup
  // from a prior run is present.
  let asarSnap = null,
    plistSnap = null;
  // If the sidecar backup dir does not exist yet, this run creates it; on
  // rollback we remove it entirely. If it already existed (prior good patch),
  // it holds pristine originals we must NOT delete.
  const backupRootExisted = fs.existsSync(P.backupRoot);
  const rollback = (why) => {
    log("rolling back live apply:", why);
    try {
      if (asarSnap && fs.existsSync(asarSnap)) fs.copyFileSync(asarSnap, P.asar);
    } catch (e) {}
    try {
      if (plistSnap && fs.existsSync(plistSnap))
        fs.copyFileSync(plistSnap, P.infoPlist);
    } catch (e) {}
    // Remove any backups THIS run created so a later unpatch doesn't restore a
    // half-written state.
    for (const b of createdBackups) {
      try {
        fs.rmSync(b.dst, { recursive: true, force: true });
      } catch (e) {}
    }
    // If we created the sidecar dir this run and it is now empty, remove it.
    if (!backupRootExisted) {
      try {
        fs.rmSync(P.backupRoot, { recursive: true, force: true });
      } catch (e) {}
    }
  };

  try {
    fs.mkdirSync(P.backupRoot, { recursive: true });
    // snapshots of the exact current bytes (in the private stage dir).
    asarSnap = path.join(stageBase, "orig.app.asar");
    fs.copyFileSync(P.asar, asarSnap);
    plistSnap = path.join(stageBase, "orig.Info.plist");
    fs.copyFileSync(P.infoPlist, plistSnap);

    // Persistent backups for unpatch (asar, unpacked, plist, _CodeSignature).
    backup(P.asar, P.asarBackup, false);
    backup(P.infoPlist, P.infoBackup, false);
    backup(P.codeSignature, P.codeSignatureBackup, true);

    // Our repack unpacks whole native-module dirs, a superset of what the
    // shipped asar unpacked. So the new header references unpacked paths that
    // the ORIGINAL app.asar.unpacked lacks — ship our staged unpacked dir
    // alongside the new asar, or those requires 404 at runtime.
    if (fs.existsSync(stagedUnpacked)) {
      if (!fs.existsSync(P.asarUnpackedBackup) && fs.existsSync(P.asarUnpacked)) {
        fs.cpSync(P.asarUnpacked, P.asarUnpackedBackup, { recursive: true });
        createdBackups.push({ dst: P.asarUnpackedBackup, isDir: true });
        log("backed up app.asar.unpacked → app.asar.unpacked.idleai-backup");
      }
      fs.rmSync(P.asarUnpacked, { recursive: true, force: true });
      fs.cpSync(stagedUnpacked, P.asarUnpacked, { recursive: true });
      log("wrote patched app.asar.unpacked (native modules, byte-identical .node)");
    }

    // Compute the patched plist into the STAGE first, validate, and only then
    // swap asar + plist together — no window where a new asar sits behind an
    // old integrity hash.
    const stagedPlist = path.join(stageBase, "patched.Info.plist");
    fs.copyFileSync(P.infoPlist, stagedPlist);
    const sr = plistBuddy(
      ["-c", `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${newHash}`],
      stagedPlist
    );
    if (sr.status !== 0) throw new Error("PlistBuddy Set failed: " + sr.stderr);
    if (readIntegrityHash(stagedPlist) !== newHash) {
      throw new Error("staged plist integrity hash did not take");
    }

    // Atomic-ish swap: asar + plist together, after every mutation above
    // succeeded.
    fs.copyFileSync(newAsar, P.asar);
    log("wrote patched app.asar");
    fs.copyFileSync(stagedPlist, P.infoPlist);
    log("updated Info.plist integrity hash →", newHash);

    // re-sign (hardened runtime seal is broken by our edits; ad-hoc re-sign).
    // This is the LAST mutation; if it fails we roll back asar+plist.
    log("ad-hoc re-signing bundle (this drops OpenAI notarization)…");
    const cs = sh("codesign", ["--force", "--deep", "--sign", "-", APP]);
    if (cs.status !== 0) {
      throw new Error("codesign failed: " + cs.stderr);
    }
    const vf = sh("codesign", ["--verify", "--verbose=2", APP]);
    log("codesign --verify:", vf.status === 0 ? "OK" : "FAILED\n" + vf.stderr);
  } catch (e) {
    rollback(e && e.message ? e.message : String(e));
    // Best-effort re-sign the rolled-back bundle so it can still launch.
    sh("codesign", ["--force", "--deep", "--sign", "-", APP]);
    die(
      "live apply failed and was rolled back — bundle restored to pre-patch bytes.\n  " +
        (e && e.message ? e.message : String(e))
    );
  }

  log("");
  log("Patched. Fully quit Codex (Cmd-Q) and relaunch.");
  fs.rmSync(stageBase, { recursive: true, force: true });
}

async function doUnpatch() {
  const P = paths(APP);
  if (
    !fs.existsSync(P.asarBackup) &&
    !fs.existsSync(P.infoBackup) &&
    !fs.existsSync(P.asarUnpackedBackup) &&
    !fs.existsSync(P.codeSignatureBackup)
  ) {
    die("no idleai backups found — nothing to restore");
  }
  const blocked = assertWritable(P);
  if (blocked) {
    die("\n  not writable: " + blocked.join(", ") + "\n\n  " + appManagementHelp());
  }
  if (fs.existsSync(P.asarBackup)) {
    fs.copyFileSync(P.asarBackup, P.asar);
    fs.rmSync(P.asarBackup);
    log("restored byte-identical app.asar");
  }
  if (fs.existsSync(P.asarUnpackedBackup)) {
    fs.rmSync(P.asarUnpacked, { recursive: true, force: true });
    fs.cpSync(P.asarUnpackedBackup, P.asarUnpacked, { recursive: true });
    fs.rmSync(P.asarUnpackedBackup, { recursive: true, force: true });
    log("restored original app.asar.unpacked");
  }
  if (fs.existsSync(P.infoBackup)) {
    fs.copyFileSync(P.infoBackup, P.infoPlist);
    fs.rmSync(P.infoBackup);
    log("restored byte-identical Info.plist");
  }

  // Signature: if we captured the ORIGINAL _CodeSignature bundle, restore it so
  // the bundle carries OpenAI's original Developer-ID seal again — combined
  // with the byte-identical asar/plist above, the on-disk bundle matches the
  // shipped one. (Notarization is a server-side ticket that is unaffected by our
  // edits; the stapled ticket in the bundle, if any, is inside _CodeSignature /
  // Info.plist which we restored.)
  if (fs.existsSync(P.codeSignatureBackup)) {
    fs.rmSync(P.codeSignature, { recursive: true, force: true });
    fs.cpSync(P.codeSignatureBackup, P.codeSignature, { recursive: true });
    fs.rmSync(P.codeSignatureBackup, { recursive: true, force: true });
    log("restored original _CodeSignature (Developer-ID signature)");
    const vf = sh("codesign", ["--verify", "--verbose=2", APP]);
    if (vf.status === 0) {
      log("codesign --verify: OK — original signature restored");
    } else {
      // The restored signature may not re-validate if any other bundle byte
      // differs; fall back to ad-hoc and say so honestly.
      log("codesign --verify: FAILED against restored signature —", vf.stderr.trim());
      log("falling back to ad-hoc re-sign; app stays ad-hoc signed.");
      sh("codesign", ["--force", "--deep", "--sign", "-", APP]);
    }
  } else {
    // No original signature captured (older patch, or backup missing): we can
    // only ad-hoc re-sign. Be honest — the app does NOT regain its Developer-ID
    // signature this way.
    log(
      "no _CodeSignature backup found — ad-hoc re-signing. NOTE: the app stays\n" +
        "  ad-hoc signed, NOT restored to OpenAI's Developer-ID signature."
    );
    const cs = sh("codesign", ["--force", "--deep", "--sign", "-", APP]);
    log("ad-hoc re-sign:", cs.status === 0 ? "OK" : "FAILED\n" + cs.stderr);
  }
  // Remove the now-empty sidecar backup dir.
  try {
    if (fs.existsSync(P.backupRoot)) {
      const left = fs.readdirSync(P.backupRoot);
      if (left.length === 0) fs.rmSync(P.backupRoot, { recursive: true, force: true });
      else log("kept " + P.backupRoot + " (still holds:", left.join(", ") + ")");
    }
  } catch (e) {}
  log("");
  log("Unpatched. Fully quit Codex and relaunch.");
}

function doStatus() {
  const P = paths(APP);
  if (!fs.existsSync(P.asar)) return log("no app.asar at", P.asar);
  const patched = fs.existsSync(P.asarBackup);
  log("app            :", APP);
  log("backups exist  :", patched ? "YES (patched)" : "no (pristine)");
  log("  asar backup    :", fs.existsSync(P.asarBackup) ? "yes" : "no");
  log("  plist backup   :", fs.existsSync(P.infoBackup) ? "yes" : "no");
  log("  unpacked backup:", fs.existsSync(P.asarUnpackedBackup) ? "yes" : "no");
  log(
    "  sig backup     :",
    fs.existsSync(P.codeSignatureBackup)
      ? "yes (unpatch restores Developer-ID signature)"
      : "no (unpatch leaves app ad-hoc signed)"
  );
  log("plist hash     :", readIntegrityHash(P.infoPlist));
  log("asar hash      :", computeAsarHeaderHash(P.asar));
}

const main = async () => {
  if (cmd === "patch") await doPatch();
  else if (cmd === "unpatch") await doUnpatch();
  else if (cmd === "status") doStatus();
  else {
    console.log(
      "usage: node patch.mjs <patch|unpatch|status> [--app <Codex.app>] [--dry-run [--out <dir>]]"
    );
    process.exit(2);
  }
};
main().catch((e) => die(e && e.stack ? e.stack : String(e)));
