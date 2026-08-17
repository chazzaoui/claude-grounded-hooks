/**
 * The same scoring, against a real model.
 *
 * The offline eval proves the controls behave as specified. It cannot tell you
 * how often a model actually fabricates a citation, because the fixtures were
 * written to fabricate on purpose. This file answers that question, which is
 * the one that matters when you are deciding whether the filter earns its
 * place.
 *
 *   ANTHROPIC_API_KEY=... npx tsx eval/live.ts [--model claude-sonnet-5] [--n 40] [--repeat 5]
 *
 * Cost is dominated by the number of cases; each is a single short call. There
 * is no second model call for grounding, because grounding is set membership.
 *
 * Fabrication is stochastic, so a single pass over a handful of cases reports
 * one draw from a distribution and calls it a rate. `--repeat N` runs every case
 * N times and prints the spread, so that a zero can be read as a zero over a
 * stated sample rather than as an absence of evidence.
 */

import defaultRules from '../rules/default.rules.json' with { type: 'json' };
import { EvidenceLedger, sanitizeCitedRecords } from '../src/evidence.js';
import { compileRuleSet } from '../src/rules.js';
import { AuditLog, hashInput } from '../src/audit.js';
import { CASES, type Case } from './fixtures.js';

const API = 'https://api.anthropic.com/v1/messages';
const rules = compileRuleSet(defaultRules);

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? (process.argv[i + 1] as string) : fallback;
}

const MODEL = arg('model', 'claude-sonnet-5');
const LIMIT = Number(arg('n', String(CASES.length)));
const REPEAT = Math.max(1, Math.trunc(Number(arg('repeat', '1'))) || 1);

interface Mapping {
  requirementId: string;
  decision: string;
  evidenceIds: string[];
}

/**
 * Deliberately does NOT tell the model which ids exist beyond the retrieved
 * block. Handing it the valid set would measure instruction-following, not
 * fabrication rate.
 */
function buildPrompt(c: Case): string {
  const requirementIds = Object.keys(c.expected.decisions);
  return [
    rules.toPromptSection(),
    '',
    'Retrieved evidence spans:',
    ...c.retrieved.map((id) => `  ${id}: ${c.spans[id] ?? ''}`),
    '',
    'Requirements to assess:',
    ...requirementIds.map((id) => `  ${id}: ${c.requirements[id] ?? ''}`),
    '',
    'Return ONLY minified JSON of the form:',
    '{"summary":"...","mappings":[{"requirementId":"R1","decision":"met|partial|not_met","evidenceIds":["ev_x"]}]}',
    'Cite only evidence ids that support your judgement.',
  ].join('\n');
}

/**
 * A retrieved id with no span, or a requirement with no text, silently turns this
 * back into the null measurement it used to be. Fail loudly instead.
 */
function assertCasesUsable(cases: Case[]): void {
  const problems: string[] = [];
  for (const c of cases) {
    for (const id of c.retrieved) {
      if ((c.spans[id] ?? '').trim() === '') problems.push(`${c.id}: no span text for ${id}`);
    }
    for (const id of Object.keys(c.expected.decisions)) {
      if ((c.requirements[id] ?? '').trim() === '') problems.push(`${c.id}: no requirement text for ${id}`);
    }
  }
  if (problems.length > 0) {
    console.error(`Fixtures are not usable for a live run:\n  ${problems.join('\n  ')}`);
    process.exit(2);
  }
}

async function callModel(prompt: string, apiKey: string): Promise<{ text: string; ms: number }> {
  const started = Date.now();
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body = (await res.json()) as { content: { type: string; text?: string }[] };
  const text = body.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  return { text, ms: Date.now() - started };
}

function parseMappings(text: string): { summary: string; mappings: Mapping[] } | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (match === null) return null;
  try {
    const parsed = JSON.parse(match[0]) as { summary?: string; mappings?: Mapping[] };
    return { summary: parsed.summary ?? '', mappings: parsed.mappings ?? [] };
  } catch {
    return null;
  }
}

interface RunResult {
  cited: number;
  fabricated: number;
  droppedIds: string[];
  blocked: boolean;
}

interface CaseStats {
  id: string;
  runs: RunResult[];
  unparseable: number;
  failed: number;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const pad = (s: string, n: number) => s.padEnd(n);

/** Constant across runs prints as one number; anything else shows the spread. */
function spread(values: number[]): string {
  const first = values[0];
  if (first === undefined) return '-';
  let min = first;
  let max = first;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return min === max ? String(min) : `${(sum / values.length).toFixed(1)} [${min}-${max}]`;
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    console.error('ANTHROPIC_API_KEY is not set. The offline eval needs no key: npm run eval');
    process.exit(2);
  }

  const cases = CASES.slice(0, LIMIT);
  assertCasesUsable(cases);

  const audit = new AuditLog();
  const stats: CaseStats[] = [];
  let totalMs = 0;

  console.log(
    `\nlive eval · model ${MODEL} · ${cases.length} cases · ${REPEAT} run(s) each` +
      ` · ${cases.length * REPEAT} calls · ruleset ${rules.version}\n`,
  );

  for (const c of cases) {
    const st: CaseStats = { id: c.id, runs: [], unparseable: 0, failed: 0 };
    const prompt = buildPrompt(c);

    for (let i = 0; i < REPEAT; i += 1) {
      let text: string;
      let ms: number;
      try {
        ({ text, ms } = await callModel(prompt, apiKey));
      } catch (err) {
        st.failed += 1;
        console.log(`  ${pad(c.id, 24)} run ${i + 1} request failed: ${String(err).slice(0, 80)}`);
        continue;
      }
      totalMs += ms;

      const parsed = parseMappings(text);
      if (parsed === null) {
        st.unparseable += 1;
        console.log(`  ${pad(c.id, 24)} run ${i + 1} unparseable output (schema adherence failure)`);
        continue;
      }

      const guardrail = rules.validate(JSON.stringify(parsed));
      const ledger = new EvidenceLedger().admit(c.retrieved);
      const sanitized = sanitizeCitedRecords(parsed.mappings, ledger.validIds, 'evidenceIds');

      audit.record({
        entryPoint: 'live-eval',
        toolName: c.id,
        inputHash: hashInput(prompt),
        rulesetVersion: guardrail.version,
        guardrailTriggered: !guardrail.passed,
        guardrailViolations: guardrail.violations.map((v) => v.rule),
        evidenceKept: sanitized.kept.length,
        evidenceDropped: sanitized.dropped.length,
        ungroundedRate: sanitized.ungroundedRate,
        durationMs: ms,
      });

      st.runs.push({
        cited: sanitized.kept.length + sanitized.dropped.length,
        fabricated: sanitized.dropped.length,
        droppedIds: sanitized.dropped,
        blocked: !guardrail.passed,
      });

      if (sanitized.dropped.length > 0) {
        console.log(`  ${pad(c.id, 24)} run ${i + 1} dropped ungrounded: ${sanitized.dropped.join(', ')}`);
      }
    }

    stats.push(st);
  }

  console.log(
    '\n' + pad('case', 24) + pad('runs', 6) + pad('cited', 14) + pad('fabricated', 14) + pad('ungrounded', 12) + 'blocked',
  );
  console.log('-'.repeat(78));
  for (const st of stats) {
    const cited = st.runs.map((r) => r.cited);
    const citedTotal = cited.reduce((a, b) => a + b, 0);
    const fabTotal = st.runs.reduce((a, r) => a + r.fabricated, 0);
    const fabRuns = st.runs.filter((r) => r.fabricated > 0).length;
    const blockedRuns = st.runs.filter((r) => r.blocked).length;
    console.log(
      pad(st.id, 24) +
        pad(`${st.runs.length}${st.failed + st.unparseable > 0 ? `(-${st.failed + st.unparseable})` : ''}`, 6) +
        pad(spread(cited), 14) +
        pad(fabTotal === 0 ? '0' : `${fabTotal} in ${fabRuns}/${st.runs.length}`, 14) +
        pad(citedTotal === 0 ? '-' : pct(fabTotal / citedTotal), 12) +
        `${blockedRuns}/${st.runs.length}`,
    );
  }

  const s = audit.summary();
  const scoredRuns = stats.reduce((a, st) => a + st.runs.length, 0);
  const fabRunsAll = stats.reduce((a, st) => a + st.runs.filter((r) => r.fabricated > 0).length, 0);
  const citations = s.citationsKept + s.citationsDropped;
  const failedAll = stats.reduce((a, st) => a + st.failed, 0);
  const unparseableAll = stats.reduce((a, st) => a + st.unparseable, 0);

  console.log(`
Summary (live, ${MODEL})
  cases                       ${cases.length}
  runs per case               ${REPEAT}
  calls scored                ${s.calls}
  requests failed             ${failedAll}
  unparseable responses       ${unparseableAll}
  block rate                  ${pct(s.blockRate)}
  citations checked           ${citations}
  ungrounded citations        ${s.citationsDropped}
  ungrounded citation rate    ${pct(s.ungroundedRate)}  (${s.citationsDropped} of ${citations} citations, n=${scoredRuns} calls)
  runs with any fabrication   ${fabRunsAll}/${scoredRuns}
  violations by rule          ${JSON.stringify(s.violationsByRule)}
  mean model latency          ${s.calls === 0 ? 0 : Math.round(totalMs / s.calls)} ms

  The grounding check added no model call and no tokens to any of the above.
`);

  if (citations > 0 && s.citationsDropped === 0) {
    console.log(`  On this run the model fabricated no evidence ids across ${scoredRuns} calls and
  ${citations} citations. That is a real result and it is reported as one: the
  filter dropped nothing because there was nothing to drop. It is not evidence
  that the filter is unnecessary, because ${scoredRuns} calls cannot bound a rate
  that only has to be non-zero once to publish a fabricated citation. Raise
  --repeat and re-run before concluding anything about the rate.
`);
  }

  await audit.drain();
}

void main();
