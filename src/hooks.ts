/**
 * Claude Agent SDK wiring.
 *
 * Two seams do the work:
 *
 *   PostToolUse on retrieval tools  -> harvest the evidence ids that actually
 *                                      exist, into a per-session ledger.
 *   PreToolUse on the answer tool   -> intersect the model's cited ids against
 *                                      that ledger and rewrite the tool input
 *                                      before it is executed or persisted.
 *
 * The ordering matters and is the reason this needs hooks rather than a
 * wrapper: retrieval and citation happen in different turns of the agent loop,
 * so something has to remember what was real in between.
 *
 * Hooks are deterministic code, not model judgement. A PreToolUse hook runs
 * regardless of what the model decided, which is what makes it a guardrail
 * rather than a suggestion.
 */

import type {
  HookJSONOutput,
  PostToolUseHookInput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

import { AuditLog, hashInput } from './audit.js';
import { EvidenceLedger, collectEvidenceIds, sanitizeCitedRecords } from './evidence.js';
import type { CompiledRuleSet } from './rules.js';

export interface GroundedHooksOptions {
  rules: CompiledRuleSet;
  /** Defaults to a fresh in-memory ledger. Pass your own to share a session. */
  ledger?: EvidenceLedger;
  /** Defaults to an in-memory audit log. Pass `{ file }` to persist. */
  audit?: AuditLog;
  /** Tool names whose results contain real evidence, e.g. ['search_documents']. */
  retrievalTools: readonly string[];
  /** Tool names that carry the model's citations, e.g. ['submit_answer']. */
  citingTools: readonly string[];
  /** Field on the citing tool's input holding the records. Default 'mappings'. */
  recordsField?: string;
  /** Field on each record holding cited ids. Default 'evidenceIds'. */
  citationsField?: string;
  /** Fields to treat as evidence ids in retrieval output. */
  idFields?: readonly string[];
  /**
   * What to do when the model cites something that does not exist.
   *
   * 'sanitize' (default) strips the fabricated ids and lets the call proceed,
   * which converts the most dangerous failure mode into a visibly weaker answer
   * instead of a confidently wrong one. 'deny' blocks the call outright, which
   * is right when a partially-supported answer is itself unacceptable.
   */
  onUngrounded?: 'sanitize' | 'deny';
}

export interface GroundedHooks {
  ledger: EvidenceLedger;
  audit: AuditLog;
  preToolUse: (input: PreToolUseHookInput) => Promise<HookJSONOutput>;
  postToolUse: (input: PostToolUseHookInput) => Promise<HookJSONOutput>;
}

export function createGroundedHooks(opts: GroundedHooksOptions): GroundedHooks {
  const ledger = opts.ledger ?? new EvidenceLedger();
  const audit = opts.audit ?? new AuditLog();
  const recordsField = opts.recordsField ?? 'mappings';
  const citationsField = opts.citationsField ?? 'evidenceIds';
  const onUngrounded = opts.onUngrounded ?? 'sanitize';
  const retrieval = new Set(opts.retrievalTools);
  const citing = new Set(opts.citingTools);

  const preToolUse = async (input: PreToolUseHookInput): Promise<HookJSONOutput> => {
    if (!citing.has(input.tool_name)) return {};

    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const serialized = JSON.stringify(toolInput);

    // 1. Pattern block. Runs on what is about to leave, which is the only
    //    place you can see what the model actually said.
    const guardrail = opts.rules.validate(serialized);
    if (!guardrail.passed) {
      const rules = guardrail.violations.filter((v) => v.severity === 'block').map((v) => v.rule);
      audit.record({
        entryPoint: 'preToolUse',
        sessionId: input.session_id,
        toolName: input.tool_name,
        inputHash: hashInput(serialized),
        rulesetVersion: guardrail.version,
        guardrailTriggered: true,
        guardrailViolations: rules,
      });
      // Name the category, never the matched pattern. The category is enough
      // to be honest; the pattern is a bypass roadmap.
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `Blocked by compliance ruleset ${guardrail.version}: ${rules.join(', ')}`,
        },
      };
    }

    // 2. Evidence intersection. Deterministic set membership, no model call.
    const records = toolInput[recordsField];
    if (!Array.isArray(records)) {
      audit.record({
        entryPoint: 'preToolUse',
        sessionId: input.session_id,
        toolName: input.tool_name,
        inputHash: hashInput(serialized),
        rulesetVersion: guardrail.version,
        guardrailTriggered: false,
        guardrailViolations: [],
      });
      return {};
    }

    const sanitized = sanitizeCitedRecords(
      records as Record<string, unknown>[],
      ledger.validIds,
      citationsField,
    );

    ledger.check([...sanitized.kept, ...sanitized.dropped]);

    audit.record({
      entryPoint: 'preToolUse',
      sessionId: input.session_id,
      toolName: input.tool_name,
      inputHash: hashInput(serialized),
      rulesetVersion: guardrail.version,
      guardrailTriggered: sanitized.dropped.length > 0 && onUngrounded === 'deny',
      guardrailViolations: sanitized.dropped.length > 0 ? ['ungroundedCitation'] : [],
      evidenceKept: sanitized.kept.length,
      evidenceDropped: sanitized.dropped.length,
      ungroundedRate: sanitized.ungroundedRate,
    });

    if (sanitized.dropped.length === 0) return {};

    if (onUngrounded === 'deny') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `${sanitized.dropped.length} cited evidence id(s) do not exist in the retrieved set.`,
        },
      };
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { ...toolInput, [recordsField]: sanitized.records },
        additionalContext:
          `${sanitized.dropped.length} cited evidence id(s) did not exist and were removed. ` +
          `Do not cite identifiers that were not returned by retrieval.`,
      },
    };
  };

  const postToolUse = async (input: PostToolUseHookInput): Promise<HookJSONOutput> => {
    if (!retrieval.has(input.tool_name)) return {};

    const ids = collectEvidenceIds(input.tool_response, { idFields: opts.idFields });
    ledger.admit(ids);

    audit.record({
      entryPoint: 'postToolUse',
      sessionId: input.session_id,
      toolName: input.tool_name,
      inputHash: hashInput(JSON.stringify(input.tool_input ?? {})),
      guardrailTriggered: false,
      guardrailViolations: [],
      durationMs: input.duration_ms,
    });

    return {};
  };

  return { ledger, audit, preToolUse, postToolUse };
}
