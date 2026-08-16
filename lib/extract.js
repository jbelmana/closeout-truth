'use strict';
// Close-out extraction: find session-ending "Summary: / - Done:" trailers in Claude Code
// transcripts and mine the checkable assertions out of them.
//
// WHY THE TRAILER: if a Stop hook forces every session-ending message into a fixed shape, the
// agent's completion claims become MACHINE-PARSEABLE for free. This module deliberately reads
// only that enforced surface — free-text mid-session claims are far noisier, and the trailer is
// a contract that already exists. See README "Requirements" if your setup has no such hook.
//
// PRIVACY: never returns transcript prose beyond the claim line (capped at 160 chars) and the
// Done text (capped at 600). Tool payloads and sidechain (subagent) lines are skipped entirely —
// a subagent's close-out is its orchestrator's problem, not the operator's.
const fs = require('node:fs');
const path = require('node:path');

const FILE_CAP = 150;        // newest transcripts only — a rolling audit, not archaeology
const PER_FILE_CAP = 3;      // last N close-outs per session; one session must not own the sample
const MIN_SIZE = 2048;       // metadata-only stubs carry no close-outs
const CONTEXT_TAIL = 2500;   // headline tables sit just above the trailer; this window holds both

function listTranscripts(root, days, now) {
  const cutoff = (now || Date.now()) - days * 86400e3;
  const out = [];
  let dirents;
  try { dirents = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const dp = path.join(root, d.name);
    let files; try { files = fs.readdirSync(dp); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(dp, f);
      let st; try { st = fs.statSync(fp); } catch { continue; }
      if (st.mtimeMs < cutoff || st.size < MIN_SIZE) continue;
      out.push({ fp, project: d.name, stem: f.slice(0, 8), mtime: st.mtimeMs });
    }
  }
  // Newest first, hard cap: beyond this we are re-reading history a previous run already covered.
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, FILE_CAP);
}

function textOf(message) {
  const c = message && message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n');
  }
  return '';
}

// One transcript -> its last few close-outs. String prefilter before JSON.parse: these files run
// to 15MB and parsing every line of every one is the difference between 2s and 2min.
function closeoutsFromFile(file) {
  let raw;
  try { raw = fs.readFileSync(file.fp, 'utf8'); } catch { return []; }
  const found = [];
  for (const line of raw.split('\n')) {
    if (!line.includes('Summary:') || !line.includes('- Done:')) continue;
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || obj.type !== 'assistant' || obj.isSidechain) continue;
    const text = textOf(obj.message);
    const m = text.match(/(^|\n)Summary:[\s\S]*$/);
    if (!m) continue;
    const done = (m[0].match(/- Done:([\s\S]*?)(\n- Next:|$)/) || [, ''])[1].trim();
    if (!done) continue;
    found.push({
      ts: obj.timestamp || null,
      cwd: obj.cwd || null,
      project: file.project,
      session: file.stem,
      done: done.slice(0, 600),
      context: text.slice(-CONTEXT_TAIL),
    });
  }
  return found.slice(-PER_FILE_CAP);
}

// Claim mining. Conservative by design: every claim minted here costs a git or gh probe in
// verify.js, so PRECISION BEATS RECALL. An auditor that fabricates accusations is worse than no
// auditor. Types:
//   pr-merged   — "#N" and a past-tense merge word on the same line -> gh pr view
//   sha-pushed  — a hex token and a push/land/commit word on the same line -> git
//   tests-pass  — recorded but UNVERIFIABLE (re-running suites is not free)
//   deployed    — recorded but UNVERIFIABLE (no deploy-target registry)
const SHA_RE = /\b[0-9a-f]{7,40}\b/g;
const PR_RE = /(?:\b([\w.-]+\/[\w.-]+))?#(\d{2,5})\b/g;
const CLAIM_CAP = 8; // per close-out; a claim-stuffed trailer must not eat the whole gh budget

function mineClaims(closeout) {
  const claims = [];
  const seen = new Set();
  const push = (type, ref, line) => {
    const key = `${type}|${ref}`;
    if (seen.has(key) || claims.length >= CLAIM_CAP) return;
    seen.add(key);
    claims.push({ type, ref, line: line.trim().slice(0, 160) });
  };
  for (const line of closeout.context.split('\n')) {
    // Past-tense "merged" ONLY, with future/negated forms excluded. A naive /\bmerg/ prefix match
    // minted pr-merged claims off "poller armed for merge-on-green" and accused an HONEST
    // close-out of lying — the claim text itself said "open". Measured, then fixed.
    const merged = /\bmerged\b/i.test(line)
      && !/merge-on-green|will merge|to merge|not (yet )?merged|unmerged|pending|when (green|CI)/i.test(line);
    const pushed = /\b(push|land|commit)/i.test(line);
    if (merged) {
      for (const m of line.matchAll(PR_RE)) push('pr-merged', `${m[1] || ''}#${m[2]}`, line);
    }
    if (merged || pushed) {
      for (const sha of line.match(SHA_RE) || []) {
        // Require a hex letter: "#1234567" is an issue number and "20260814" is a date. Both match
        // the hex charset; neither is a commit. Measured false-positive class.
        if (!/[a-f]/.test(sha)) continue;
        push('sha-pushed', sha, line);
      }
    }
    if (/\b\d+ (tests? )?pass(ed|ing)?\b|\b0 fail(ures|ed)?\b/i.test(line)) {
      push('tests-pass', 'suite', line);
    }
    if (/\bdeploy(ed)?\b/i.test(line) && /\b(live|prod|production|deployed)\b/i.test(line)) {
      push('deployed', 'deploy', line);
    }
  }
  return claims;
}

module.exports = { listTranscripts, closeoutsFromFile, mineClaims, textOf };
