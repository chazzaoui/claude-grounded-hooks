# claude-grounded-hooks

Evidence grounding, compliance blocking and hashed audit logging as [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/hooks) hooks.

The core check is **deterministic set membership**: the model returns citation ids, and any id that was not returned by retrieval is dropped before the answer is returned or persisted. No second model call, no network hop, no tokens.

```
fabrications caught         6/6
false drops                 0
mean overhead per call      0.185 ms
```

`npm run eval` reproduces that on a clean checkout with no API key.

## Why this exists

A model asked to cite its sources will invent identifiers. It invents them fluently, in the right format, and a fabricated id renders downstream as a perfectly convincing citation. That is worse than no citation, because it looks like diligence.

The existing answers to this are semantic: fetch the cited source, ask another model whether the claim follows from it. That works, and it costs a model call per citation, adds a network round trip, and can itself be wrong.

Most of the time you do not need semantics. You need to know whether the id exists. That is a set lookup, it takes microseconds, and it cannot hallucinate.

## Prior art, honestly

This pattern is not novel and this README will not pretend otherwise. Search GitHub for `hallucinated evidence id` and you will find teams who have each rebuilt the same few lines inside their own application: dropping model-returned ids against a candidate set in a genetics pipeline, a news summariser, a memory system, a graph store. There is even a draft standard, [`pic-standard`](https://github.com/pic-standard/pic-standard), proposing provenance-to-claim-to-evidence-id binding as a spec.

What does not exist is a packaged version wired into the Agent SDK's hook lifecycle, with the measurement attached. That is the gap this fills. Half a dozen independent reimplementations is evidence of demand, not a reason to write a seventh one inline.

## Install

```bash
npm i claude-grounded-hooks
```

`@anthropic-ai/claude-agent-sdk` is an optional peer. The pure functions work without it.

## Use with the Agent SDK

Two seams do the work, and the ordering is why this needs hooks rather than a wrapper: retrieval and citation happen in different turns of the agent loop, so something has to remember what was real in between.

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { compileRuleSet, createGroundedHooks } from 'claude-grounded-hooks';
import rules from 'claude-grounded-hooks/rules/default.rules.json' with { type: 'json' };

const grounded = createGroundedHooks({
  rules: compileRuleSet(rules),
  retrievalTools: ['search_documents'],   // PostToolUse: harvest ids that exist
  citingTools: ['submit_answer'],         // PreToolUse: check ids the model cites
  onUngrounded: 'sanitize',               // or 'deny'
});

for await (const msg of query({
  prompt,
  options: {
    hooks: {
      PreToolUse: [{ hooks: [grounded.preToolUse] }],
      PostToolUse: [{ hooks: [grounded.postToolUse] }],
    },
  },
})) { /* ... */ }

console.log(grounded.audit.summary());
await grounded.audit.drain();   // before exit; see Audit below
```

## Use without it

Every control is a plain function. If you are on a different framework, or doing a single call rather than an agent loop, use these directly.

```ts
import { filterCitations, sanitizeCitedRecords } from 'claude-grounded-hooks';

const valid = new Set(retrievedSpans.map((s) => s.id));
const { kept, dropped, ungroundedRate } = filterCitations(model.evidenceIds, valid);

// Or across a list of findings that each carry citations:
const clean = sanitizeCitedRecords(model.mappings, valid, 'evidenceIds');
```

## The three controls

**Rules are data, not prose.** The obvious place for "never guarantee an outcome" is the system prompt. That is necessary and insufficient: a prompt is a request, and requests to a model have a failure rate that is small, non-zero and not under your control. Rules live in a versioned JSON file that both the prompt text and the enforcement layer read, so the instruction and the check cannot drift apart. The version travels into every audit row, so months later you can answer which ruleset produced a given decision.

**The block runs on output, before anything is kept.** A `PreToolUse` hook is deterministic code that runs regardless of what the model decided, which is what makes it a guardrail rather than a suggestion. When it fires, the caller is told the category and never the matched pattern: the category is enough to be honest, the pattern is a bypass roadmap.

**The audit trail is built from hashes.** Two requirements that look contradictory: every decision must be auditable, and the inputs are sensitive documents that must not sit in a log. Storing SHA-256 of the input satisfies both. You can prove that this exact input, under this ruleset version, produced this decision, without ever holding the input.

## What this does not buy you

The package is deliberate about its own limits, because a control whose limits you cannot state is a control you are trusting further than you should.

**Existence is not correctness.** The filter kills fabricated provenance. It does nothing about a real citation attached to a claim it does not support. Those need different machinery, and conflating them is how teams end up believing they are covered when they are not.

**Pattern matching cannot see meaning.** "Every indication points to an award here" matches no guarantee pattern and does the same commercial damage as "you will win". The default ruleset ships that phrasing as a `warn` category precisely so it shows up in eval output rather than reading as a clean pass. A block rate of zero on a category is not evidence of safety; it is a question about whether your patterns are blind. The eval prints that question every run.

**Sanitize is not deletion.** A finding whose citations are all dropped is kept, without support, rather than removed. That is the honest presentation of what happened, and it means an unsupported claim still reaches your UI looking weaker than the model intended. If that is unacceptable in your domain, use `onUngrounded: 'deny'`.

**Audit writes are fire-and-forget.** A logging outage must never take a user-facing feature offline. The cost is that unawaited writes race process shutdown, which in a long-running job shows up as a tail of errors on every run. Hence `drain()`, which fences in-flight writes. Non-fatal logging still means someone has to think about shutdown.

## Eval

```bash
npm run eval                                    # synthetic fixtures, no API key
ANTHROPIC_API_KEY=... npx tsx eval/live.ts      # same scoring, real model
```

The offline fixtures are synthetic and the harness says so every run. They prove the controls behave as specified; they cannot tell you how often a model actually fabricates, because they were written to fabricate on purpose. `eval/live.ts` answers that, and deliberately does not tell the model which ids exist, since handing it the valid set would measure instruction-following rather than fabrication rate.

Reported: block rate, block-decision accuracy, ungrounded citation rate, fabrications caught versus missed, false drops, per-field extraction accuracy, and overhead.

## Background

The design comes from a production system: an LLM inside a public-sector bid workflow that is not allowed to lie, where a wrong answer costs a contractor three weeks of proposal work.

## License

MIT
