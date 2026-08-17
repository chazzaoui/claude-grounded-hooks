import { describe, expect, it } from 'vitest';

import defaultRules from '../rules/default.rules.json' with { type: 'json' };
import { AuditLog } from '../src/audit.js';
import { createGroundedHooks } from '../src/hooks.js';
import { compileRuleSet } from '../src/rules.js';

const rules = compileRuleSet(defaultRules);

function setup(onUngrounded: 'sanitize' | 'deny' = 'sanitize') {
  const audit = new AuditLog();
  const hooks = createGroundedHooks({
    rules,
    audit,
    retrievalTools: ['search_documents'],
    citingTools: ['submit_answer'],
    onUngrounded,
  });
  return { hooks, audit };
}

const post = (toolName: string, response: unknown) =>
  ({
    hook_event_name: 'PostToolUse',
    session_id: 's1',
    tool_name: toolName,
    tool_input: {},
    tool_response: response,
    tool_use_id: 't1',
  }) as never;

const pre = (toolName: string, input: unknown) =>
  ({
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    tool_name: toolName,
    tool_input: input,
    tool_use_id: 't2',
  }) as never;

describe('grounded hooks', () => {
  it('ignores tools it was not told about', async () => {
    const { hooks } = setup();
    expect(await hooks.preToolUse(pre('Bash', { command: 'ls' }))).toEqual({});
    expect(await hooks.postToolUse(post('Read', { id: 'ev_1' }))).toEqual({});
    expect(hooks.ledger.size).toBe(0);
  });

  it('harvests evidence ids from retrieval, then keeps a grounded citation intact', async () => {
    const { hooks } = setup();
    await hooks.postToolUse(post('search_documents', { results: [{ id: 'ev_1' }, { id: 'ev_2' }] }));
    expect(hooks.ledger.size).toBe(2);

    const out = await hooks.preToolUse(
      pre('submit_answer', { mappings: [{ requirementId: 'r1', evidenceIds: ['ev_1'] }] }),
    );
    expect(out).toEqual({});
  });

  it('rewrites the tool input to remove a fabricated citation', async () => {
    const { hooks } = setup();
    await hooks.postToolUse(post('search_documents', { results: [{ id: 'ev_1' }] }));

    const out = await hooks.preToolUse(
      pre('submit_answer', {
        mappings: [{ requirementId: 'r1', evidenceIds: ['ev_1', 'ev_fabricated'] }],
      }),
    );

    const specific = (out as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput;
    expect(specific?.hookEventName).toBe('PreToolUse');
    const updated = specific?.updatedInput as { mappings: { evidenceIds: string[] }[] };
    expect(updated.mappings[0]?.evidenceIds).toEqual(['ev_1']);
    expect(String(specific?.additionalContext)).toContain('did not exist');
  });

  it('denies instead of sanitizing when configured to', async () => {
    const { hooks } = setup('deny');
    await hooks.postToolUse(post('search_documents', { results: [{ id: 'ev_1' }] }));

    const out = await hooks.preToolUse(
      pre('submit_answer', { mappings: [{ requirementId: 'r1', evidenceIds: ['ev_fake'] }] }),
    );
    const specific = (out as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput;
    expect(specific?.permissionDecision).toBe('deny');
    expect(String(specific?.permissionDecisionReason)).toContain('do not exist');
  });

  it('blocks on a compliance pattern before it ever looks at citations', async () => {
    const { hooks, audit } = setup();
    const out = await hooks.preToolUse(
      pre('submit_answer', { summary: 'You will win this contract.', mappings: [] }),
    );
    const specific = (out as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput;
    expect(specific?.permissionDecision).toBe('deny');
    expect(String(specific?.permissionDecisionReason)).toContain('unsupportedClaims');

    // The reason names the category and never the matched pattern: the
    // category is enough to be honest, the pattern is a bypass roadmap.
    expect(String(specific?.permissionDecisionReason)).not.toContain('you will win');
    expect(audit.entries()[0]?.guardrailTriggered).toBe(true);
  });

  it('records a hash of the input and never the input itself', async () => {
    const { hooks, audit } = setup();
    await hooks.postToolUse(post('search_documents', { results: [{ id: 'ev_1' }] }));
    await hooks.preToolUse(
      pre('submit_answer', {
        mappings: [{ requirementId: 'SECRET_REQ', evidenceIds: ['ev_1'] }],
      }),
    );
    const serialized = JSON.stringify(audit.entries());
    expect(serialized).not.toContain('SECRET_REQ');
    expect(audit.entries().at(-1)?.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('summarises block rate and ungrounded rate across a session', async () => {
    const { hooks, audit } = setup();
    await hooks.postToolUse(post('search_documents', { results: [{ id: 'ev_1' }] }));
    await hooks.preToolUse(
      pre('submit_answer', { mappings: [{ evidenceIds: ['ev_1', 'ev_x', 'ev_y'] }] }),
    );
    await hooks.preToolUse(pre('submit_answer', { summary: 'guaranteed to win', mappings: [] }));

    const s = audit.summary();
    expect(s.citationsKept).toBe(1);
    expect(s.citationsDropped).toBe(2);
    expect(s.ungroundedRate).toBeCloseTo(2 / 3);
    expect(s.violationsByRule.unsupportedClaims).toBe(1);
  });
});
