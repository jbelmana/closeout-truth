'use strict';
// End-to-end CLI tests. These exist because the unit suite covered every pure function and still
// let the README's one copy-pasteable example crash: --trend appended to a path whose directory
// a fresh clone does not have, so the run died with ENOENT *after* a successful audit.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'closeout-truth.js');
const FIXTURES = path.join(__dirname, 'fixtures');

function run(args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ct-cli-')); }

test('the README example runs on a fresh clone — nested --out and --trend dirs are created', () => {
  const dir = tmp();
  const out = path.join(dir, 'reports', '2026-08-15.md');
  const trend = path.join(dir, 'state', 'trend.jsonl');
  const r = run(['--days', '36500', '--root', FIXTURES, '--no-net', '--out', out, '--trend', trend]);
  assert.equal(r.err, '', `expected no stderr, got: ${r.err}`);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}`);
  assert.ok(fs.existsSync(out), 'report file was not written');
  assert.ok(fs.existsSync(trend), 'trend file was not written');
  assert.match(fs.readFileSync(out, 'utf8'), /# closeout-truth/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('trend history accumulates and renders a trend line on the second run', () => {
  const dir = tmp();
  const trend = path.join(dir, 'state', 'trend.jsonl');
  const out = path.join(dir, 'r.md');
  const args = ['--days', '36500', '--root', FIXTURES, '--no-net', '--trend', trend, '--out', out];
  run(args);
  const first = fs.readFileSync(trend, 'utf8').trim().split('\n');
  assert.equal(first.length, 1, 'first run appends exactly one row');
  assert.ok(JSON.parse(first[0]).date, 'row is valid JSON with a date');

  run(args);
  assert.equal(fs.readFileSync(trend, 'utf8').trim().split('\n').length, 2, 'second run appends');
  assert.match(fs.readFileSync(out, 'utf8'), /Trend:/, 'second report renders a trend line');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a torn trailing trend row is tolerated, never rewritten', () => {
  const dir = tmp();
  const trend = path.join(dir, 'trend.jsonl');
  fs.writeFileSync(trend, '{"date":"2026-08-01","rate":90}\n{"date":"2026-08-02","ra');
  const r = run(['--days', '36500', '--root', FIXTURES, '--no-net', '--trend', trend, '--out', path.join(dir, 'r.md')]);
  assert.equal(r.code, 0, 'a torn row must not crash the run');
  const lines = fs.readFileSync(trend, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines[0].includes('2026-08-01'), 'existing history is preserved verbatim');
  fs.rmSync(dir, { recursive: true, force: true });
});

// The whole tool is about checkers that lie green.
test('a root with no transcripts exits 2 rather than reporting a clean bill of health', () => {
  const dir = tmp();
  const r = run(['--root', dir, '--no-net']);
  assert.equal(r.code, 2, `vacuous run must exit 2, got ${r.code}`);
  assert.match(r.out, /vacuous|FAIL/, 'and must say why');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--json emits parseable output with the score fields', () => {
  const r = run(['--days', '36500', '--root', FIXTURES, '--no-net', '--json']);
  const j = JSON.parse(r.out);
  assert.equal(j.closeouts, 2, 'both fixture close-outs are sampled');
  assert.ok(Array.isArray(j.rows));
  assert.ok('rate' in j && 'denom' in j);
});

test('--help prints only the leading header block', () => {
  const r = run(['--help']);
  assert.match(r.out, /Usage: closeout-truth/);
  assert.doesNotMatch(r.out, /append-only JSONL/, 'implementation notes must not leak into help');
  assert.equal(r.code, 0);
});
