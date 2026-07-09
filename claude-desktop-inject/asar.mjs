// Minimal, dependency-free asar reader/writer for in-place FILE edits.
//
// Why not `@electron/asar extract`+`pack`? Claude.app ships a 48MB
// `app.asar.unpacked` sibling of native binaries (.node/.dylib) that live
// OUTSIDE the archive. A naive extract fails without that sibling present, and a
// repack must reproduce the EXACT set of unpacked files or it silently pulls the
// natives back into the archive and corrupts the app. So instead we edit the two
// packed JS files in place and leave `app.asar.unpacked` completely untouched
// (unpacked entries carry no body bytes here — only their header metadata).
//
// asar layout: [pickle: u32 payloadSize][u32 headerStrSize][u32 headerJsonLen]
//   [headerJson (padded to 4 bytes)][concatenated file bodies]. Each file entry
// is { size, offset (string, from body start), integrity }. Directories have
// `files`. Unpacked entries have `unpacked:true` and no offset.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const BLOCK = 4 * 1024 * 1024; // asar integrity blockSize

function integrity(buf) {
  const blocks = [];
  for (let i = 0; i < buf.length; i += BLOCK) {
    blocks.push(createHash("sha256").update(buf.subarray(i, i + BLOCK)).digest("hex"));
  }
  if (blocks.length === 0) blocks.push(createHash("sha256").update(Buffer.alloc(0)).digest("hex"));
  return {
    algorithm: "SHA256",
    hash: createHash("sha256").update(buf).digest("hex"),
    blockSize: BLOCK,
    blocks,
  };
}

function readHeader(buf) {
  const headerJsonLen = buf.readUInt32LE(12);
  const headerStart = 16;
  const header = JSON.parse(buf.subarray(headerStart, headerStart + headerJsonLen).toString("utf8"));
  const bodyStart = headerStart + Math.ceil(headerJsonLen / 4) * 4;
  return { header, bodyStart };
}

// Collect every packed file entry (offset present) in ascending offset order.
function packedEntries(header) {
  const out = [];
  (function walk(node) {
    if (!node.files) return;
    for (const name of Object.keys(node.files)) {
      const e = node.files[name];
      if (e.files) walk(e);
      else if (e.offset !== undefined && !e.unpacked) out.push(e);
    }
  })(header);
  out.sort((a, b) => Number(a.offset) - Number(b.offset));
  return out;
}

function findEntry(header, relPath) {
  const parts = relPath.split("/");
  let node = header;
  for (const p of parts) {
    if (!node.files || !node.files[p]) return null;
    node = node.files[p];
  }
  return node;
}

function writeAsar(headerObj, body, outPath) {
  // Chromium Pickle framing used by asar (verified against Claude.app's header):
  //   u32[0]  = 4                         (payload size of the size-pickle: one u32)
  //   u32[4]  = 8 + align4(jsonLen)       (outer payload: string-pickle + its size u32)
  //   u32[8]  = 4 + align4(jsonLen)       (string-pickle payload: length u32 + padded json)
  //   u32[12] = jsonLen                   (actual header-string byte length)
  //   [jsonLen bytes of header][pad to 4] then the body.
  // Verified against Claude.app: u32[4] = u32[8] + 4.
  const headerJson = Buffer.from(JSON.stringify(headerObj), "utf8");
  const jsonLen = headerJson.length;
  const alignedLen = Math.ceil(jsonLen / 4) * 4;
  const pad = alignedLen - jsonLen;
  const headerPadded = Buffer.concat([headerJson, Buffer.alloc(pad)]);
  const stringPickleSize = 4 + alignedLen;
  const pickle = Buffer.alloc(16);
  pickle.writeUInt32LE(4, 0);
  pickle.writeUInt32LE(stringPickleSize + 4, 4);
  pickle.writeUInt32LE(stringPickleSize, 8);
  pickle.writeUInt32LE(jsonLen, 12);
  writeFileSync(outPath, Buffer.concat([pickle, headerPadded, body]));
}

// The "ElectronAsarIntegrity" header hash Electron validates against Info.plist
// when the EnableEmbeddedAsarIntegrityValidation fuse is on: sha256 of the
// header-string block — the UTF-8 JSON of length `jsonLen` at offset 16, with
// NEITHER the 16-byte pickle NOR the trailing 4-byte pad included. Any change to
// a file's size/offset/integrity in the header JSON changes this hash, so after
// patching we must rewrite Info.plist's pinned value to match or Electron aborts
// boot. Reads an on-disk asar (post-write) so we hash exactly what shipped.
export function asarHeaderHash(asarPath) {
  const buf = readFileSync(asarPath);
  const jsonLen = buf.readUInt32LE(12);
  return createHash("sha256").update(buf.subarray(16, 16 + jsonLen)).digest("hex");
}

/**
 * Edit named files inside an asar, in place, rewriting offsets + integrity for
 * all packed entries. `edits` = { "relative/path": Buffer|string }. Returns the
 * list of paths actually changed. Leaves app.asar.unpacked untouched.
 */
export function editAsarFiles(asarPath, edits) {
  const buf = readFileSync(asarPath);
  const { header, bodyStart } = readHeader(buf);

  // Read the ORIGINAL bytes of every packed file (before we shift anything).
  const entries = packedEntries(header);
  const originalBytes = new Map();
  for (const e of entries) {
    const start = bodyStart + Number(e.offset);
    originalBytes.set(e, buf.subarray(start, start + e.size));
  }

  // Resolve the edits to entries and validate they exist and are packed.
  const editByEntry = new Map();
  const changed = [];
  for (const [rel, content] of Object.entries(edits)) {
    const entry = findEntry(header, rel);
    if (!entry) throw new Error(`asar entry not found: ${rel}`);
    if (entry.offset === undefined || entry.unpacked) throw new Error(`asar entry is not packed: ${rel}`);
    editByEntry.set(entry, Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"));
    changed.push(rel);
  }

  // Rebuild the body in offset order, substituting edited content, and reassign
  // sequential offsets + integrity. Only packed files carry body bytes.
  const parts = [];
  let cursor = 0;
  for (const e of entries) {
    const bytes = editByEntry.has(e) ? editByEntry.get(e) : originalBytes.get(e);
    e.offset = String(cursor);
    e.size = bytes.length;
    e.integrity = integrity(bytes);
    parts.push(bytes);
    cursor += bytes.length;
  }
  writeAsar(header, Buffer.concat(parts), asarPath);
  return changed;
}

/** Read one packed file's bytes out of an asar (for verification). */
export function readAsarFile(asarPath, relPath) {
  const buf = readFileSync(asarPath);
  const { header, bodyStart } = readHeader(buf);
  const entry = findEntry(header, relPath);
  if (!entry || entry.offset === undefined) return null;
  const start = bodyStart + Number(entry.offset);
  return buf.subarray(start, start + entry.size);
}
