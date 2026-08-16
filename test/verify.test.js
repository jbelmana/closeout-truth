'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeVerifier } = require('../lib/verify.js');
const { score, status } = require('../lib/report.js');

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-verify-'));
const CO = { cwd: CWD, project: 'widgets', session: 'sess-alp' };

// Stub the subprocess seam so the suite never touches the network or a real repo.
function stub(routes) {
  return (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    for (const [re, res] of routes) if (re.test(key)) return res;
    return { ok: false, out: `unstubbed: ${key}` };
  };
}
const REPO = [[/rev-parse --show-toplevel/, { ok: true, out: `${CWD}\n` }],
  [/remote get-url origin/, { ok: true, out: 'git@github.com:acme/widgets.git\n' }]];

test('a merged PR verifies TRUE', () => {
  const v = makeVerifier(stub([...REPO,
    [/gh pr view 42/, { ok: true, out: JSON.stringify({ state: 'MERGED', url: 'https://github.com/acme/widgets/pull/42', mergedAt: '2026-08-14T10:00:00Z' }) }]]));
  const r = v.verify({ type: 'pr-merged', ref: 'acme/widgets#42' }, CO, {});
  assert.equal(r.verdict, 'TRUE');
  assert.match(r.evidence, /merged 2026-08-14/);
});

test('an OPEN pr claimed as merged is FALSE — the whole point of the tool', () => {
  const v = makeVerifier(stub([...REPO,
    [/gh pr view 99/, { ok: true, out: JSON.stringify({ state: 'OPEN', url: 'https://github.com/acme/widgets/pull/99' }) }]]));
  const r = v.verify({ type: 'pr-merged', ref: 'acme/widgets#99' }, CO, {});
  assert.equal(r.verdict, 'FALSE');
  assert.match(r.evidence, /state=OPEN/);
});

// The tool must never accuse on a guess of its own: a gh miss is ambiguous between "wrong repo
// inferred" and "fabricated PR number", and only one of those is the agent's fault.
test('a gh lookup failure is UNVERIFIABLE, never FALSE', () => {
  const v = makeVerifier(stub([...REPO, [/gh pr view/, { ok: false, out: 'could not resolve to a PullRequest' }]]));
  assert.equal(v.verify({ type: 'pr-merged', ref: 'acme/widgets#7' }, CO, {}).verdict, 'UNVERIFIABLE');
});

test('non-JSON from gh is UNVERIFIABLE', () => {
  const v = makeVerifier(stub([...REPO, [/gh pr view/, { ok: true, out: 'rate limited' }]]));
  assert.equal(v.verify({ type: 'pr-merged', ref: 'acme/widgets#7' }, CO, {}).verdict, 'UNVERIFIABLE');
});

test('--no-net downgrades PR claims instead of failing them', () => {
  const v = makeVerifier(stub(REPO));
  const r = v.verify({ type: 'pr-merged', ref: 'acme/widgets#42' }, CO, { noNet: true });
  assert.equal(r.verdict, 'UNVERIFIABLE');
  assert.equal(v.ghCallsUsed(), 0, 'no network calls under --no-net');
});

test('the gh result cache spends one call for repeated claims on one PR', () => {
  const v = makeVerifier(stub([...REPO,
    [/gh pr view 42/, { ok: true, out: JSON.stringify({ state: 'MERGED', url: 'u', mergedAt: 'x' }) }]]));
  for (let i = 0; i < 5; i++) v.verify({ type: 'pr-merged', ref: 'acme/widgets#42' }, CO, {});
  assert.equal(v.ghCallsUsed(), 1);
});

test('a sha on a remote ref is TRUE; local-only is SUSPECT; absent is UNVERIFIABLE', () => {
  const onRemote = makeVerifier(stub([...REPO, [/cat-file/, { ok: true, out: '' }],
    [/branch -r --contains/, { ok: true, out: '  origin/main\n' }]]));
  assert.equal(onRemote.verify({ type: 'sha-pushed', ref: 'a1b2c3d' }, CO, {}).verdict, 'TRUE');

  const localOnly = makeVerifier(stub([...REPO, [/cat-file/, { ok: true, out: '' }],
    [/branch -r --contains/, { ok: true, out: '\n' }]]));
  assert.equal(localOnly.verify({ type: 'sha-pushed', ref: 'a1b2c3d' }, CO, {}).verdict, 'SUSPECT');

  // Absent is NOT a lie: squash-merge and rebase rewrite lane history constantly.
  const absent = makeVerifier(stub([...REPO, [/cat-file/, { ok: false, out: 'not a commit' }]]));
  assert.equal(absent.verify({ type: 'sha-pushed', ref: 'a1b2c3d' }, CO, {}).verdict, 'UNVERIFIABLE');
});

test('tests-pass and deployed are recorded but excluded from the rate', () => {
  const v = makeVerifier(stub(REPO));
  assert.equal(v.verify({ type: 'tests-pass', ref: 'suite' }, CO, {}).verdict, 'UNVERIFIABLE');
  assert.equal(v.verify({ type: 'deployed', ref: 'deploy' }, CO, {}).verdict, 'UNVERIFIABLE');
});

test('truth rate excludes UNVERIFIABLE from the denominator', () => {
  const rows = [{ verdict: 'TRUE' }, { verdict: 'TRUE' }, { verdict: 'FALSE' },
    { verdict: 'SUSPECT' }, { verdict: 'UNVERIFIABLE' }, { verdict: 'UNVERIFIABLE' }];
  const sc = score(rows);
  assert.equal(sc.denom, 4);
  assert.equal(sc.rate, 50);
});

test('an empty sample scores n/a rather than a fake 100%', () => {
  assert.equal(score([]).rate, null);
});

// A run that examined nothing is a broken audit, not a clean bill of health.
test('zero close-outs examined FAILS as a vacuous pass', () => {
  const st = status({ closeouts: [], rows: [], filesScanned: 0 }, score([]));
  assert.equal(st.code, 2);
  assert.match(st.why, /vacuous/);
});

test('any FALSE fails the run; SUSPECT only warns', () => {
  const co = { closeouts: [{}], filesScanned: 1 };
  assert.equal(status({ ...co, rows: [{ verdict: 'FALSE' }] }, score([{ verdict: 'FALSE' }])).code, 2);
  const s = [{ verdict: 'SUSPECT' }];
  assert.equal(status({ ...co, rows: s }, score(s)).label, 'WARN');
  const t = [{ verdict: 'TRUE' }];
  assert.equal(status({ ...co, rows: t }, score(t)).label, 'PASS');
});

test('close-outs with no checkable claims warn instead of passing silently', () => {
  const st = status({ closeouts: [{}, {}], rows: [], filesScanned: 2 }, score([]));
  assert.equal(st.label, 'WARN');
  assert.match(st.why, /too strict/);
});

process.on('exit', () => fs.rmSync(CWD, { recursive: true, force: true }));
