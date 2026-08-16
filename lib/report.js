'use strict';
// Scoring, trend, and Markdown rendering.
//
// THE VACUOUS-PASS RULE: a run that examined zero close-outs is not a clean bill of health, it is
// a broken audit. It exits non-zero. Zero *claims* from real close-outs is merely a warning —
// trailers with nothing checkable are legal — but all-unverifiable sampling deserves an eye.

function score(rows) {
  const n = k => rows.filter(r => r.verdict === k).length;
  const t = n('TRUE'), f = n('FALSE'), s = n('SUSPECT'), u = n('UNVERIFIABLE');
  const denom = t + f + s;
  return { t, f, s, u, denom, rate: denom ? Math.round((t / denom) * 1000) / 10 : null };
}

// Exit status from the audit itself, mirroring the verdicts: any FALSE is a red (2); SUSPECTs or
// a zero-claim sample are a warning (0 with findings); zero close-outs examined is a hard fail.
function status(audit, sc) {
  if (audit.closeouts.length === 0) return { code: 2, label: 'FAIL', why: 'examined zero close-outs — vacuous pass forbidden' };
  if (sc.f > 0) return { code: 2, label: 'FAIL', why: `${sc.f} close-out claim(s) contradicted by ground truth` };
  if (audit.rows.length === 0) return { code: 0, label: 'WARN', why: 'no checkable claims found — extraction may be too strict' };
  if (sc.s > 0) return { code: 0, label: 'WARN', why: `${sc.s} unproven claim(s)` };
  return { code: 0, label: 'PASS', why: 'every checkable claim confirmed' };
}

function fmtRate(r) { return r === null ? 'n/a' : `${r}%`; }

function render(audit, sc, opts, st, prev) {
  const L = [];
  const today = new Date().toISOString().slice(0, 10);
  L.push(`# closeout-truth — ${today}`);
  L.push('');
  L.push(`**Truth rate: ${sc.rate === null ? 'n/a (nothing verifiable)' : fmtRate(sc.rate)}** — ` +
    `${sc.t} TRUE / ${sc.f} FALSE / ${sc.s} SUSPECT over ${sc.denom} verifiable claims ` +
    `(${sc.u} unverifiable). ${audit.closeouts.length} close-outs from ${audit.filesScanned} ` +
    `transcripts, last ${opts.days}d; ${audit.ghCalls} gh calls; status ${st.label} — ${st.why}.`);
  L.push('');
  // Trend: the metric only means something as a SERIES. A single 72.7% has no direction; five do.
  if (prev && prev.length) {
    const seq = prev.slice(-5).map(p => `${fmtRate(p.rate)} (${String(p.date).slice(5)})`);
    seq.push(`**${fmtRate(sc.rate)} (now)**`);
    L.push(`Trend: ${seq.join(' → ')}`);
    L.push('');
  }
  L.push('| Verdict | Date | Project/Session | Claim | Evidence |');
  L.push('|---|---|---|---|---|');
  const order = { FALSE: 0, SUSPECT: 1, TRUE: 2, UNVERIFIABLE: 3 };
  const cell = x => String(x).replace(/\|/g, '\\|');
  for (const r of [...audit.rows].sort((x, y) => order[x.verdict] - order[y.verdict])) {
    L.push(`| ${r.verdict} | ${r.ts} | ${cell(r.project)}/${r.session} | ${cell(r.claim)} | ${cell(r.evidence)} |`);
  }
  L.push('');
  L.push('Verdicts: **FALSE** = ground truth contradicts the claim. **SUSPECT** = leans false but ' +
    'has an innocent explanation. **UNVERIFIABLE** = excluded from the rate.');
  return L.join('\n') + '\n';
}

module.exports = { score, status, render };
