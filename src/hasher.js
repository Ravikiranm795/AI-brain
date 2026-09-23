'use strict';

const fs = require('fs');
const xxhashWasmFactory = require('xxhash-wasm');

let hasherPromise = null;
async function getHasher() {
  if (!hasherPromise) hasherPromise = xxhashWasmFactory();
  return hasherPromise;
}

/**
 * xxhash64 is used purely for change-detection, not for security, so it's
 * a deliberate choice over SHA-256: much faster on large binaries of text,
 * and "good enough collision resistance" is all this needs.
 *
 * Hashes the raw bytes directly (h64Raw takes a Uint8Array) rather than
 * decoding to a UTF-8 string first (h64ToString takes a string) - decoding
 * is lossy for any file that isn't valid UTF-8 (BOM'd/legacy-encoded
 * source, a file with a stray binary byte), which would corrupt the
 * change-detection hash for exactly the files where getting it right
 * matters most.
 */
async function hashFile(absPath) {
  const { h64Raw } = await getHasher();
  const content = fs.readFileSync(absPath);
  return h64Raw(content).toString(16).padStart(16, '0');
}

/**
 * Same hash, for a caller that has already read the bytes - lets a forced
 * build hash and parse from one read instead of reading the whole repo
 * twice (see buildBrain.js). Synchronous, so it requires the wasm module to
 * already be resolved; warmHasher() below is how a caller guarantees that.
 */
let syncHasher = null;
function hashBuffer(buf) {
  if (!syncHasher) throw new Error('hashBuffer() called before warmHasher() - the xxhash wasm module has to be loaded first');
  return syncHasher.h64Raw(buf).toString(16).padStart(16, '0');
}

async function warmHasher() {
  syncHasher = await getHasher();
}

module.exports = { hashFile, hashBuffer, warmHasher };
