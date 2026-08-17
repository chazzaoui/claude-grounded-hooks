/**
 * The same scoring, against a real model.
 *
 * The offline eval proves the controls behave as specified. It cannot tell you
 * how often a model actually fabricates a citation, because the fixtures were
 * written to fabricate on purpose. This file answers that question, which is
 * the one that matters when you are deciding whether the filter earns its
 * place.
 *
 *   ANTHROPIC_API_KEY=... npx tsx eval/live.ts [--model claude-sonnet-5] [--n 40]
 *
 * Cost is dominated by the number of cases; each is a single short call. There
 * is no second model call for grounding, because grounding is set membership.
 */

import defaultRules from '../rules/default.rules.json' with { type: 'json' };
import { EvidenceLedger, sanitizeCitedRecords } from '../src/evidence.js';
import { compileRuleSet } from '../src/rules.js';
import { AuditLog, hashInput } from '../src/audit.js';
import { CASES } from './fixtures.js';

const API = 'https://api.anthropic.com/v1/messages';
const rules = compileRuleSet(defaultRules);

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? (process.argv[i + 1] as string) : fallback;
}

const MODEL = arg('model', 'claude-sonnet-5');
const LIMIT = Number(arg('n', String(CASES.length)));

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
function buildPrompt(retrieved: string[], requirementIds: string[]): string {
  return [
    rules.toPromptSection(),
    '',
    'Retrieved evidence spans:',
    ...retrieved.map((id) => `  ${id}: (span text elided for this evaluation)`),
    '',
    `Requirements to assess: ${requirementIds.join(', ')}`,
    '',
    'Return ONLY minified JSON of the form:',
    '{"summary":"...","mappings":[{"requirementId":"R1","decision":"met|partial|not_met","evidenceIds":["ev_x"]}]}',
    'Cite only evidence ids that support your judgement.',
  ].join('\n');
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

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    console.error('ANTHROPIC_API_KEY is not set. The offline eval needs no key: npm run eval');
    process.exit(2);
  }

  const audit = new AuditLog();
  const cases = CASES.slice(0, LIMIT);
  let unparseable = 0;
  let totalMs = 0;

  console.log(`\nlive eval · model ${MODEL} · ${cases.length} cases · ruleset ${rules.version}\n`);

  for (const c of cases) {
    const requirementIds = Object.keys(c.expected.decisions);
    const prompt = buildPrompt(c.retrieved, requirementIds);

    let text: string;
    let ms: number;
    try {
      ({ text, ms } = await callModel(prompt, apiKey));
    } catch (err) {
      console.log(`  ${c.id.padEnd(24)} request failed: ${String(err).slice(0, 80)}`);
      continue;
    }
    totalMs += ms;

    const parsed = parseMappings(text);
    if (parsed === null) {
      unparseable += 1;
      console.log(`  ${c.id.padEnd(24)} unparseable output (schema adherence failure)`);
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

    console.log(
      `  ${c.id.padEnd(24)} cited ${String(sanitized.kept.length + sanitized.dropped.length).padEnd(3)}` +
        ` fabricated ${String(sanitized.dropped.length).padEnd(3)}` +
        ` ${guardrail.passed ? 'pass' : `BLOCK ${guardrail.violations.map((v) => v.rule).join(',')}`}` +
        `  ${ms}ms` +
        (sanitized.dropped.length > 0 ? `   -> ${sanitized.dropped.join(', ')}` : ''),
    );
  }

  const s = audit.summary();
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  console.log(`
Summary (live, ${MODEL})
  calls scored                ${s.calls}
  unparseable responses       ${unparseable}
  block rate                  ${pct(s.blockRate)}
  citations checked           ${s.citationsKept + s.citationsDropped}
  ungrounded citation rate    ${pct(s.ungroundedRate)}
  violations by rule          ${JSON.stringify(s.violationsByRule)}
  mean model latency          ${s.calls === 0 ? 0 : Math.round(totalMs / s.calls)} ms

  The grounding check added no model call and no tokens to any of the above.
`);

  await audit.drain();
}

void main();
