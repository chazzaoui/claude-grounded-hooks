/**
 * The eval harness.
 *
 * Every control costs something, in latency, tokens or blocked output. The
 * point of this file is to make that cost legible instead of asserted, and to
 * make the guardrails' own blind spots visible rather than letting a zero read
 * as safety.
 *
 *   npm run eval
 */

import defaultRules from '../rules/default.rules.json' with { type: 'json' };
import { EvidenceLedger, sanitizeCitedRecords } from '../src/evidence.js';
import { compileRuleSet } from '../src/rules.js';
import { CASES, type Case } from './fixtures.js';

const rules = compileRuleSet(defaultRules);

interface Row {
  id: string;
  blocked: boolean;
  blockedCorrectly: boolean;
  warned: string[];
  citations: number;
  droppedCorrectly: number;
  droppedIncorrectly: number;
  missedFabrications: number;
  fieldsTotal: number;
  fieldsCorrect: number;
  durationMs: number;
}

function scoreCase(c: Case): Row {
  const started = process.hrtime.bigint();

  const ledger = new EvidenceLedger().admit(c.retrieved);
  const serialized = JSON.stringify(c.modelOutput);
  const guardrail = rules.validate(serialized);

  const blocked = !guardrail.passed;
  const firedBlock = guardrail.violations.filter((v) => v.severity === 'block').map((v) => v.rule);
  const warned = guardrail.violations.filter((v) => v.severity === 'warn').map((v) => v.rule);

  const expectBlock = c.expected.blockedBy.length > 0;
  const blockedCorrectly =
    blocked === expectBlock &&
    c.expected.blockedBy.every((r) => firedBlock.includes(r));

  const sanitized = sanitizeCitedRecords(c.modelOutput.mappings, ledger.validIds, 'evidenceIds');
  const fabricated = new Set(c.expected.fabricatedIds);
  const dropped = new Set(sanitized.dropped);

  let droppedCorrectly = 0;
  let droppedIncorrectly = 0;
  for (const id of dropped) {
    if (fabricated.has(id)) droppedCorrectly += 1;
    else droppedIncorrectly += 1;
  }
  let missedFabrications = 0;
  for (const id of fabricated) if (!dropped.has(id)) missedFabrications += 1;

  let fieldsTotal = 0;
  let fieldsCorrect = 0;
  for (const [reqId, expected] of Object.entries(c.expected.decisions)) {
    fieldsTotal += 1;
    const got = c.modelOutput.mappings.find((m) => m.requirementId === reqId)?.decision;
    if (got === expected) fieldsCorrect += 1;
  }

  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;

  return {
    id: c.id,
    blocked,
    blockedCorrectly,
    warned,
    citations: sanitized.kept.length + sanitized.dropped.length,
    droppedCorrectly,
    droppedIncorrectly,
    missedFabrications,
    fieldsTotal,
    fieldsCorrect,
    durationMs,
  };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const pad = (s: string, n: number) => s.padEnd(n);

function main(): void {
  const rows = CASES.map(scoreCase);

  console.log(`\nclaude-grounded-hooks eval  ·  ruleset ${rules.version}  ·  ${rows.length} cases\n`);
  console.log(
    pad('case', 24) + pad('block', 8) + pad('cited', 7) + pad('dropped', 9) + pad('missed', 8) + pad('fields', 8) + 'ms',
  );
  console.log('-'.repeat(72));
  for (const r of rows) {
    console.log(
      pad(r.id, 24) +
        pad(r.blocked ? (r.blockedCorrectly ? 'yes ok' : 'yes X') : r.blockedCorrectly ? '-' : 'MISS', 8) +
        pad(String(r.citations), 7) +
        pad(`${r.droppedCorrectly}${r.droppedIncorrectly > 0 ? ` (+${r.droppedIncorrectly} bad)` : ''}`, 9) +
        pad(String(r.missedFabrications), 8) +
        pad(`${r.fieldsCorrect}/${r.fieldsTotal}`, 8) +
        r.durationMs.toFixed(3),
    );
  }

  const totals = rows.reduce(
    (a, r) => ({
      blocked: a.blocked + (r.blocked ? 1 : 0),
      blockedCorrectly: a.blockedCorrectly + (r.blockedCorrectly ? 1 : 0),
      citations: a.citations + r.citations,
      droppedCorrectly: a.droppedCorrectly + r.droppedCorrectly,
      droppedIncorrectly: a.droppedIncorrectly + r.droppedIncorrectly,
      missed: a.missed + r.missedFabrications,
      fieldsTotal: a.fieldsTotal + r.fieldsTotal,
      fieldsCorrect: a.fieldsCorrect + r.fieldsCorrect,
      ms: a.ms + r.durationMs,
    }),
    {
      blocked: 0, blockedCorrectly: 0, citations: 0, droppedCorrectly: 0,
      droppedIncorrectly: 0, missed: 0, fieldsTotal: 0, fieldsCorrect: 0, ms: 0,
    },
  );

  const totalFabrications = CASES.reduce((n, c) => n + new Set(c.expected.fabricatedIds).size, 0);

  console.log(`
Summary
  block rate                  ${pct(totals.blocked / rows.length)}  (${totals.blocked}/${rows.length} cases)
  block decisions correct     ${pct(totals.blockedCorrectly / rows.length)}
  citations checked           ${totals.citations}
  ungrounded citation rate    ${pct(totals.citations === 0 ? 0 : (totals.droppedCorrectly + totals.droppedIncorrectly) / totals.citations)}
  fabrications caught         ${totals.droppedCorrectly}/${totalFabrications}
  false drops                 ${totals.droppedIncorrectly}
  fabrications missed         ${totals.missed}
  field accuracy              ${pct(totals.fieldsCorrect / totals.fieldsTotal)}  (${totals.fieldsCorrect}/${totals.fieldsTotal})
  mean overhead per call      ${(totals.ms / rows.length).toFixed(3)} ms
`);

  const warnedCases = rows.filter((r) => r.warned.length > 0);
  console.log(`The part the numbers do not flatter
  ${warnedCases.length} case(s) conveyed certainty without matching any block pattern:
${warnedCases.map((r) => `    - ${r.id} (warn: ${r.warned.join(', ')})`).join('\n') || '    none'}
  Pattern matching cannot see meaning. These are caught here only because a
  'warn' category was written for them after the fact. A phrasing nobody
  anticipated passes every regex in the file and does the same damage, so a
  block rate of zero on a category is not evidence of safety, it is a question.

  Overhead above is set membership and regex only: no model call, no network,
  no tokens. The grounding check cannot itself hallucinate, time out, or bill.

  These are synthetic fixtures, not a live model. Run eval/live.ts with an
  ANTHROPIC_API_KEY to score the same way against real output.
`);

  if (totals.missed > 0 || totals.droppedIncorrectly > 0) process.exitCode = 1;
}

main();
