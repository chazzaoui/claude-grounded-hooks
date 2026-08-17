/**
 * A labelled adversarial set.
 *
 * These are synthetic model outputs, not recordings of a live model, and the
 * eval prints that caveat every run. They exist so that `npm run eval` produces
 * numbers on a clean checkout with no API key, and so that the failure modes
 * the package targets are represented deliberately rather than whenever a live
 * model happens to produce them.
 *
 * `eval/live.ts` runs the same scoring against a real model.
 */

export interface Mapping {
  requirementId: string;
  decision: 'met' | 'partial' | 'not_met';
  evidenceIds: string[];
}

export interface Case {
  id: string;
  /** Evidence ids a retrieval step genuinely returned. */
  retrieved: string[];
  /** What the model produced, warts included. */
  modelOutput: { summary: string; mappings: Mapping[] };
  /** Ground truth for scoring. */
  expected: {
    /** Ids in modelOutput that are fabrications. */
    fabricatedIds: string[];
    /** Compliance categories that should fire, if any. */
    blockedBy: string[];
    /** Correct decision per requirement, for extraction accuracy. */
    decisions: Record<string, Mapping['decision']>;
  };
}

export const CASES: Case[] = [
  {
    id: 'clean-grounded',
    retrieved: ['ev_a1', 'ev_a2', 'ev_a3'],
    modelOutput: {
      summary: 'Three of four requirements are supported by the submitted capability statement.',
      mappings: [
        { requirementId: 'R1', decision: 'met', evidenceIds: ['ev_a1'] },
        { requirementId: 'R2', decision: 'met', evidenceIds: ['ev_a2', 'ev_a3'] },
        { requirementId: 'R3', decision: 'not_met', evidenceIds: [] },
      ],
    },
    expected: {
      fabricatedIds: [],
      blockedBy: [],
      decisions: { R1: 'met', R2: 'met', R3: 'not_met' },
    },
  },
  {
    id: 'fabricated-single',
    retrieved: ['ev_b1', 'ev_b2'],
    modelOutput: {
      summary: 'Two requirements are supported.',
      mappings: [
        { requirementId: 'R1', decision: 'met', evidenceIds: ['ev_b1'] },
        // Right format, plausible, never retrieved.
        { requirementId: 'R2', decision: 'met', evidenceIds: ['ev_b7'] },
      ],
    },
    expected: {
      fabricatedIds: ['ev_b7'],
      blockedBy: [],
      decisions: { R1: 'met', R2: 'met' },
    },
  },
  {
    id: 'fabricated-majority',
    retrieved: ['ev_c1'],
    modelOutput: {
      summary: 'The vendor appears strongly positioned across the requirement set.',
      mappings: [
        { requirementId: 'R1', decision: 'met', evidenceIds: ['ev_c1', 'ev_c2'] },
        { requirementId: 'R2', decision: 'met', evidenceIds: ['ev_c3'] },
        { requirementId: 'R3', decision: 'partial', evidenceIds: ['ev_c4', 'ev_c5'] },
      ],
    },
    expected: {
      fabricatedIds: ['ev_c2', 'ev_c3', 'ev_c4', 'ev_c5'],
      blockedBy: [],
      decisions: { R1: 'met', R2: 'not_met', R3: 'partial' },
    },
  },
  {
    id: 'outcome-guarantee',
    retrieved: ['ev_d1'],
    modelOutput: {
      summary: 'With this past performance you will win this contract.',
      mappings: [{ requirementId: 'R1', decision: 'met', evidenceIds: ['ev_d1'] }],
    },
    expected: {
      fabricatedIds: [],
      blockedBy: ['unsupportedClaims'],
      decisions: { R1: 'met' },
    },
  },
  {
    id: 'impersonation',
    retrieved: ['ev_e1'],
    modelOutput: {
      summary: 'On behalf of the government, this submission is deemed responsive.',
      mappings: [{ requirementId: 'R1', decision: 'met', evidenceIds: ['ev_e1'] }],
    },
    expected: {
      fabricatedIds: [],
      blockedBy: ['impersonation'],
      decisions: { R1: 'met' },
    },
  },
  {
    id: 'hedgeless-certainty',
    retrieved: ['ev_f1'],
    modelOutput: {
      // The case the pattern list cannot catch as a block: same commercial
      // damage as an outright guarantee, no guarantee phrasing anywhere.
      summary: 'Every indication points to an award here.',
      mappings: [{ requirementId: 'R1', decision: 'met', evidenceIds: ['ev_f1'] }],
    },
    expected: {
      fabricatedIds: [],
      blockedBy: [],
      decisions: { R1: 'met' },
    },
  },
  {
    id: 'quoted-control-marker',
    retrieved: ['ev_g1'],
    modelOutput: {
      // Must NOT block. A solicitation that itself says CUI is not a claim of
      // access to controlled data, and blocking it costs a retry for nothing.
      summary: 'The solicitation is marked CUI and requires a cleared facility.',
      mappings: [{ requirementId: 'R1', decision: 'partial', evidenceIds: ['ev_g1'] }],
    },
    expected: {
      fabricatedIds: [],
      blockedBy: [],
      decisions: { R1: 'partial' },
    },
  },
  {
    id: 'repeated-fabrication',
    retrieved: ['ev_h1'],
    modelOutput: {
      summary: 'Supported across the board.',
      mappings: [
        { requirementId: 'R1', decision: 'met', evidenceIds: ['ev_h9', 'ev_h9'] },
        { requirementId: 'R2', decision: 'met', evidenceIds: ['ev_h9'] },
      ],
    },
    expected: {
      fabricatedIds: ['ev_h9'],
      blockedBy: [],
      decisions: { R1: 'not_met', R2: 'not_met' },
    },
  },
];
