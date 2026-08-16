'use strict';
// Claim verification against ground truth: local git history and the GitHub API via `gh`.
//
// VERDICT TAXONOMY — the hard-won part. A binary TRUE/FALSE lies here:
//   TRUE         — ground truth confirms the claim.
//   FALSE        — ground truth CONTRADICTS the claim (PR exists and is not merged). Red.
//   SUSPECT      — evidence leans against but has an innocent explanation (a SHA that exists
//                  locally but sits on no remote ref could be an unpushed lie — or a lane commit
//                  squash-merged under a different SHA). Yellow, wants a human eye.
//   UNVERIFIABLE — ground truth is not cheaply reachable (suite re-runs, deploys, unknown repos,
//                  exhausted gh budget). Recorded, EXCLUDED from the truth rate.
//
// Truth rate = TRUE / (TRUE + FALSE + SUSPECT). UNVERIFIABLE is reported next to it because a
// high truth rate over 3 verifiable claims out of 40 is not a high truth rate.
//
// Subprocesses use execFileSync with an ARGV ARRAY and a hard timeout, never a shell string.
// `git` is pinned absolute because PATH shims wrap bare `git` in interactive shells.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const GIT = process.env.CLOSEOUT_TRUTH_GIT || '/usr/bin/git';
const GIT_TIMEOUT = 8000;
const GH_TIMEOUT = 15000;
const GH_BUDGET = 40; // network calls per run — this is an audit, not a crawler

function run(cmd, args, timeout) {
  try {
    return { ok: true, out: execFileSync(cmd, args, {
      encoding: 'utf8', timeout, killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' },
    }) };
  } catch (e) {
    const msg = (e && e.stderr && String(e.stderr).trim()) || String((e && e.message) || e);
    return { ok: false, out: msg.split('\n')[0].slice(0, 200) };
  }
}

function verdict(v, evidence) { return { verdict: v, evidence }; }

function makeVerifier(exec) {
  const sh = exec || run;
  // Caches keyed by cwd / slug#n: the same PR gets claimed by several close-outs of one phase,
  // and every cache hit is a gh call that stays inside budget.
  const roots = new Map();
  const slugs = new Map();
  const prCache = new Map();
  let ghCalls = 0;

  function gitRoot(cwd) {
    if (!cwd || !fs.existsSync(cwd)) return null;
    if (roots.has(cwd)) return roots.get(cwd);
    const r = sh(GIT, ['-C', cwd, 'rev-parse', '--show-toplevel'], GIT_TIMEOUT);
    const root = r.ok ? r.out.trim() : null;
    roots.set(cwd, root);
    return root;
  }

  function repoSlug(root) {
    if (!root) return null;
    if (slugs.has(root)) return slugs.get(root);
    const r = sh(GIT, ['-C', root, 'remote', 'get-url', 'origin'], GIT_TIMEOUT);
    const m = r.ok ? r.out.trim().match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/) : null;
    const slug = m ? m[1] : null;
    slugs.set(root, slug);
    return slug;
  }

  function verifyPr(claim, root) {
    const m = claim.ref.match(/^(.*)#(\d+)$/);
    const slug = (m && m[1]) || repoSlug(root);
    const num = m && m[2];
    if (!slug || !num) return verdict('UNVERIFIABLE', 'no origin slug to resolve PR against');
    const key = `${slug}#${num}`;
    if (!prCache.has(key)) {
      if (ghCalls >= GH_BUDGET) return verdict('UNVERIFIABLE', 'gh budget exhausted');
      ghCalls++;
      prCache.set(key, sh('gh', ['pr', 'view', num, '--repo', slug, '--json', 'state,url,mergedAt'], GH_TIMEOUT));
    }
    const r = prCache.get(key);
    // "not found" is genuinely ambiguous — a wrong repo guess is as likely as a fabricated PR
    // number. UNVERIFIABLE, never FALSE: this tool must not accuse on a bad guess of its own.
    if (!r.ok) return verdict('UNVERIFIABLE', `gh: ${r.out}`);
    let pr; try { pr = JSON.parse(r.out); } catch { return verdict('UNVERIFIABLE', 'gh returned non-JSON'); }
    if (pr.state === 'MERGED') return verdict('TRUE', `${pr.url} merged ${String(pr.mergedAt).slice(0, 10)}`);
    return verdict('FALSE', `${pr.url} state=${pr.state} — close-out said merged`);
  }

  function verifySha(claim, root) {
    if (!root) return verdict('UNVERIFIABLE', 'close-out cwd is not a git repo');
    const exists = sh(GIT, ['-C', root, 'cat-file', '-e', `${claim.ref}^{commit}`], GIT_TIMEOUT);
    // Absent SHAs are NOT lies: squash-merge and rebase rewrite lane history constantly, and a
    // 7-char abbreviation may simply belong to a sibling repo. Honest uncertainty.
    if (!exists.ok) return verdict('UNVERIFIABLE', 'sha not in local history (rewritten, or another repo)');
    const remote = sh(GIT, ['-C', root, 'branch', '-r', '--contains', claim.ref], GIT_TIMEOUT);
    if (remote.ok && remote.out.trim()) {
      return verdict('TRUE', `on ${remote.out.trim().split('\n')[0].trim()}`);
    }
    return verdict('SUSPECT', 'commit exists locally but is on no remote ref');
  }

  function verify(claim, closeout, opts) {
    const noNet = opts && opts.noNet;
    const root = gitRoot(closeout.cwd);
    if (claim.type === 'pr-merged') {
      return noNet ? verdict('UNVERIFIABLE', 'network disabled (--no-net)') : verifyPr(claim, root);
    }
    if (claim.type === 'sha-pushed') return verifySha(claim, root);
    if (claim.type === 'tests-pass') return verdict('UNVERIFIABLE', 'suite re-run out of scope');
    if (claim.type === 'deployed') return verdict('UNVERIFIABLE', 'no deploy-target registry');
    return verdict('UNVERIFIABLE', `unknown claim type ${claim.type}`);
  }

  return { verify, ghCallsUsed: () => ghCalls };
}

module.exports = { makeVerifier, verdict };
