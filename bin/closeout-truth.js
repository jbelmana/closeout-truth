#!/usr/bin/env node
'use strict';
// closeout-truth — audit an AI coding agent's own completion claims against ground truth.
//
// WHY THIS EXISTS: a session close-out claimed it had pushed a PR. It had not. Process gates
// measure ritual ("did the agent say it was done?"); this measures the truth RATE of "done".
//
// Usage: closeout-truth [options]
//   --days N     transcript window in days           (default 45)
//   --limit N    close-outs sampled, newest first    (default 30)
//   --root PATH  transcripts root                    (default ~/.claude/projects)
//   --out PATH   write the Markdown report here      (default stdout only)
//   --trend PATH append/read JSONL trend history
//   --no-net     skip all gh calls (PRs become UNVERIFIABLE)
//   --json       emit JSON instead of Markdown
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { listTranscripts, closeoutsFromFile, mineClaims } = require('../lib/extract.js');
const { makeVerifier } = require('../lib/verify.js');
const { score, status, render } = require('../lib/report.js');

function parseArgs(argv) {
  const o = { days: 45, limit: 30, noNet: false, json: false, out: null, trend: null,
    root: path.join(os.homedir(), '.claude', 'projects') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') o.days = Number(argv[++i]) || o.days;
    else if (a === '--limit') o.limit = Number(argv[++i]) || o.limit;
    else if (a === '--root') o.root = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--trend') o.trend = argv[++i];
    else if (a === '--no-net') o.noNet = true;
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

function audit(opts) {
  const files = listTranscripts(opts.root, opts.days, Date.now());
  const closeouts = files.flatMap(closeoutsFromFile)
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
    .slice(0, opts.limit);
  const verifier = makeVerifier();
  const rows = [];
  for (const co of closeouts) {
    for (const claim of mineClaims(co)) {
      const v = verifier.verify(claim, co, opts);
      rows.push({
        ts: String(co.ts || '').slice(0, 10), project: co.project, session: co.session,
        type: claim.type, ref: claim.ref, claim: claim.line,
        verdict: v.verdict, evidence: v.evidence,
      });
    }
  }
  return { closeouts, rows, ghCalls: verifier.ghCallsUsed(), filesScanned: files.length };
}

// Trend rows are append-only JSONL: tolerate a torn trailing line, never rewrite history. Read
// BEFORE appending so "prev" excludes the current run.
function readTrend(p) {
  if (!p) return [];
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
      .flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
  } catch { return []; }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    // Only the LEADING comment block is the help text. Filtering every `//` line in the file
    // pulled in unrelated implementation notes from further down.
    const lines = fs.readFileSync(__filename, 'utf8').split('\n');
    const head = [];
    for (const l of lines.slice(2)) { if (!l.startsWith('//')) break; head.push(l.slice(3)); }
    process.stdout.write(head.join('\n').trim() + '\n');
    return;
  }
  const a = audit(opts);
  const sc = score(a.rows);
  const st = status(a, sc);
  const prev = readTrend(opts.trend);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ ...sc, status: st.label, why: st.why,
      closeouts: a.closeouts.length, filesScanned: a.filesScanned, rows: a.rows }, null, 2) + '\n');
  } else {
    const md = render(a, sc, opts, st, prev);
    if (opts.out) {
      fs.mkdirSync(path.dirname(opts.out), { recursive: true });
      fs.writeFileSync(opts.out, md);
      process.stdout.write(`closeout-truth: ${st.label} — truth rate ${sc.rate === null ? 'n/a' : sc.rate + '%'} ` +
        `(${sc.t}T/${sc.f}F/${sc.s}S/${sc.u}U over ${a.closeouts.length} close-outs) -> ${opts.out}\n`);
    } else {
      process.stdout.write(md);
    }
  }
  if (opts.trend) {
    // mkdir BEFORE appending: --trend points at a path the user has not created yet (the README's
    // own example uses state/trend.jsonl, and state/ is gitignored, so a fresh clone has no such
    // dir). A bare appendFileSync threw ENOENT and took the whole run down AFTER the audit had
    // already succeeded — the report was written and then the process died reporting it.
    fs.mkdirSync(path.dirname(path.resolve(opts.trend)), { recursive: true });
    fs.appendFileSync(opts.trend, JSON.stringify({ date: new Date().toISOString().slice(0, 10),
      rate: sc.rate, t: sc.t, f: sc.f, s: sc.s, u: sc.u, closeouts: a.closeouts.length }) + '\n');
  }
  process.exit(st.code);
}

if (require.main === module) main();
module.exports = { audit, parseArgs };
