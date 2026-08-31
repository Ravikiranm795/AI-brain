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
 */
async function hashFile(absPath) {
  const { h64ToString } = await getHasher();
  const content = fs.readFileSync(absPath);
  return h64ToString(content.toString('utf8'));
}

module.exports = { hashFile };
