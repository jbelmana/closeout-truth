'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { listTranscripts, closeoutsFromFile, mineClaims } = require('../lib/extract.js');

const FIXTURE_ROOT = path.join(__dirname, 'fixtures');
const FIXTURE = { fp: path.join(FIXTURE_ROOT, 'widgets', 'session-alpha.jsonl'), project: 'widgets', stem: 'sess-alp' };
const closeouts = closeoutsFromFile(FIXTURE);
const byTs = ts => closeouts.find(c => String(c.ts).startsWith(ts));

test('extracts only assistant trailers, skipping user turns', () => {
  assert.equal(closeouts.length, 2, 'two real close-outs in the fixture');
});

test('SIDECHAIN close-outs are skipped — a subagent claim is not the operator\'s', () => {
  const leaked = closeouts.filter(c => c.done.includes('#1234'));
  assert.deepEqual(leaked, [], 'subagent close-out must not enter the sample');
});

test('mines a merged PR, a pushed sha, and a test claim from an honest close-out', () => {
  const claims = mineClaims(byTs('2026-08-14T10'));
  const types = claims.map(c => `${c.type}:${c.ref}`);
  assert.ok(types.includes('pr-merged:acme/widgets#42'), `expected pr-merged, got ${types}`);
  assert.ok(types.includes('sha-pushed:a1b2c3d'), `expected sha-pushed, got ${types}`);
  assert.ok(types.includes('tests-pass:suite'), `expected tests-pass, got ${types}`);
});

// REGRESSION (the false-accusation class): a naive /\bmerg/ prefix match minted a pr-merged claim
// off "armed a poller for merge-on-green" and returned FALSE against a close-out whose own text
// said the PR was open. The auditor accused an honest report. This test pins the fix.
test('"merge-on-green" on an OPEN pr mints no merged claim', () => {
  const claims = mineClaims(byTs('2026-08-14T11'));
  const merged = claims.filter(c => c.type === 'pr-merged');
  assert.deepEqual(merged, [], `merge-on-green must not mint a merged claim, got ${JSON.stringify(merged)}`);
});

test('digit-only tokens are not treated as shas', () => {
  const claims = mineClaims({ context: 'Pushed the fix in #1234567 on 20260814.' });
  assert.deepEqual(claims.filter(c => c.type === 'sha-pushed'), [], 'issue numbers and dates are not commits');
});

test('claim mining is capped and deduped', () => {
  const line = Array.from({ length: 20 }, (_, i) => `merged acme/w#${100 + i}`).join('\n');
  const claims = mineClaims({ context: line });
  assert.ok(claims.length <= 8, `cap is 8, got ${claims.length}`);
  assert.equal(new Set(claims.map(c => `${c.type}|${c.ref}`)).size, claims.length, 'no dupes');
});

test('listTranscripts honors the day window and the size floor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-'));
  const proj = path.join(dir, 'proj'); fs.mkdirSync(proj);
  const big = path.join(proj, 'big.jsonl');
  fs.writeFileSync(big, 'x'.repeat(4096));
  fs.writeFileSync(path.join(proj, 'tiny.jsonl'), 'x');           // under MIN_SIZE
  fs.writeFileSync(path.join(proj, 'notes.txt'), 'x'.repeat(4096)); // not jsonl
  const now = Date.now();
  assert.deepEqual(listTranscripts(dir, 30, now).map(f => f.fp), [big]);
  const stale = now + 31 * 86400e3; // window has moved past the file's mtime
  assert.deepEqual(listTranscripts(dir, 30, stale), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing root yields no transcripts instead of throwing', () => {
  assert.deepEqual(listTranscripts('/nonexistent/closeout-truth', 30, Date.now()), []);
});
