'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  splitIdentifier,
  indexableParts,
  identifierParts,
  isCompoundIdentifier,
  MAX_PARTS_PER_CHUNK
} = require('../src/identifiers');

test('splitIdentifier handles camelCase, acronyms, digits, snake and kebab', () => {
  assert.deepEqual(splitIdentifier('getDomainTokenHeader'), ['get', 'Domain', 'Token', 'Header']);
  assert.deepEqual(splitIdentifier('encryptUsingAES256'), ['encrypt', 'Using', 'AES', '256']);
  assert.deepEqual(splitIdentifier('HTTP_PROXY_URL'), ['HTTP', 'PROXY', 'URL']);
  assert.deepEqual(splitIdentifier('reader-launcher'), ['reader', 'launcher']);
  assert.deepEqual(splitIdentifier('HTTPServer'), ['HTTP', 'Server']);
});

test('isCompoundIdentifier is false for single words', () => {
  assert.equal(isCompoundIdentifier('token'), false);
  assert.equal(isCompoundIdentifier('domainToken'), true);
});

test('indexableParts lowercases and drops sub-tokens below the minimum length', () => {
  assert.deepEqual(indexableParts('getXToken'), ['get', 'token']);
});

test('identifierParts emits each compound identifier as a contiguous run', () => {
  assert.equal(identifierParts('getDomainToken()'), 'get domain token');
});

test("identifierParts does not let an earlier identifier swallow a later one's sub-tokens", () => {
  // Regression: per-sub-token dedupe turned this into "set domain get token",
  // so the phrase `domain token` (from a query for domainToken) was unfindable.
  const parts = identifierParts('setDomain(); getDomainToken();');
  assert.ok(parts.includes('domain token'), `expected adjacent "domain token" in: ${parts}`);
});

test('identifierParts dedupes repeated identifiers and skips single words', () => {
  assert.equal(identifierParts('fooBar fooBar fooBar token'), 'foo bar');
});

test('identifierParts returns empty for empty input', () => {
  assert.equal(identifierParts(''), '');
  assert.equal(identifierParts(null), '');
});

test('identifierParts caps the stream and never emits a truncated run', () => {
  // Every identifier is exactly 3 parts, so a truncated run would leave the
  // token count off a multiple of 3.
  const letters = (n) => [n % 26, Math.floor(n / 26) % 26, Math.floor(n / 676) % 26].map((c) => String.fromCharCode(97 + c)).join('');
  const code = Array.from({ length: 500 }, (_, i) => {
    const tail = letters(i + 1000);
    return `${letters(i)}Mid${tail[0].toUpperCase()}${tail.slice(1)}`;
  }).join(' ');
  const count = identifierParts(code).split(' ').length;
  assert.ok(count > 0 && count <= MAX_PARTS_PER_CHUNK);
  assert.equal(count % 3, 0);
});
