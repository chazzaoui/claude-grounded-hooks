import { describe, expect, it } from 'vitest';

import {
  EvidenceLedger,
  collectEvidenceIds,
  filterCitations,
  sanitizeCitedRecords,
} from '../src/evidence.js';

describe('filterCitations', () => {
  const valid = new Set(['ev_1', 'ev_2', 'ev_3']);

  it('keeps ids that exist and drops ids that do not', () => {
    const r = filterCitations(['ev_1', 'ev_999', 'ev_3'], valid);
    expect(r.kept).toEqual(['ev_1', 'ev_3']);
    expect(r.dropped).toEqual(['ev_999']);
    expect(r.ungroundedRate).toBeCloseTo(1 / 3);
  });

  it('counts a repeated fabrication once, not three times', () => {
    const r = filterCitations(['ev_999', 'ev_999', 'ev_999', 'ev_1'], valid);
    expect(r.dropped).toEqual(['ev_999']);
    expect(r.ungroundedRate).toBeCloseTo(0.5);
  });

  it('is 0 rather than NaN when nothing was cited', () => {
    expect(filterCitations([], valid).ungroundedRate).toBe(0);
    expect(filterCitations(null, valid).ungroundedRate).toBe(0);
    expect(filterCitations(undefined, valid).ungroundedRate).toBe(0);
  });

  it('ignores non-strings and blank ids rather than throwing on them', () => {
    const r = filterCitations(['ev_1', '', '   ', 42 as unknown as string], valid);
    expect(r.kept).toEqual(['ev_1']);
    expect(r.dropped).toEqual([]);
  });

  it('trims surrounding whitespace before comparing', () => {
    expect(filterCitations(['  ev_2  '], valid).kept).toEqual(['ev_2']);
  });

  it('does not treat a prefix or superstring as a match', () => {
    const r = filterCitations(['ev_', 'ev_11', 'EV_1'], valid);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual(['ev_', 'ev_11', 'EV_1']);
  });
});

describe('EvidenceLedger', () => {
  it('only admits ids from retrieval, so a citation before retrieval is dropped', () => {
    const ledger = new EvidenceLedger();
    expect(ledger.check(['ev_1']).dropped).toEqual(['ev_1']);
    ledger.admit(['ev_1']);
    expect(ledger.check(['ev_1']).kept).toEqual(['ev_1']);
  });

  it('accumulates across turns of the agent loop', () => {
    const ledger = new EvidenceLedger();
    ledger.admit(['ev_1']);
    ledger.admit(['ev_2', 'ev_3']);
    expect(ledger.size).toBe(3);
    expect(ledger.check(['ev_1', 'ev_3']).dropped).toEqual([]);
  });

  it('reports ungrounded rate over citations, not over checks', () => {
    const ledger = new EvidenceLedger();
    ledger.admit(['ev_1']);
    ledger.check(['ev_a', 'ev_b', 'ev_c', 'ev_d']); // one answer, four fabrications
    ledger.check(['ev_1']); // one answer, clean
    const s = ledger.stats();
    expect(s.checks).toBe(2);
    expect(s.dropped).toBe(4);
    expect(s.kept).toBe(1);
    expect(s.ungroundedRate).toBeCloseTo(0.8);
  });
});

describe('sanitizeCitedRecords', () => {
  const valid = new Set(['ev_1', 'ev_2']);

  it('strips fabricated ids but keeps the record', () => {
    const out = sanitizeCitedRecords(
      [
        { requirementId: 'r1', evidenceIds: ['ev_1', 'ev_fake'] },
        { requirementId: 'r2', evidenceIds: ['ev_nope'] },
      ],
      valid,
    );
    expect(out.records).toHaveLength(2);
    expect(out.records[0]?.evidenceIds).toEqual(['ev_1']);
    // A mapping that loses all support still renders, without support.
    expect(out.records[1]?.evidenceIds).toEqual([]);
    expect(out.dropped).toEqual(['ev_fake', 'ev_nope']);
  });

  it('does not mutate the caller-supplied records', () => {
    const input = [{ requirementId: 'r1', evidenceIds: ['ev_1', 'ev_fake'] }];
    sanitizeCitedRecords(input, valid);
    expect(input[0]?.evidenceIds).toEqual(['ev_1', 'ev_fake']);
  });

  it('honours a custom citations field', () => {
    const out = sanitizeCitedRecords(
      [{ claim: 'c', sources: ['ev_2', 'ev_x'] }],
      valid,
      'sources',
    );
    expect(out.records[0]?.sources).toEqual(['ev_2']);
  });

  it('treats a missing or non-array citation field as zero citations', () => {
    const input: { requirementId: string; evidenceIds?: string[] }[] = [{ requirementId: 'r1' }];
    const out = sanitizeCitedRecords(input, valid);
    // The key is added, so a downstream consumer always sees an array.
    expect(out.records[0]?.evidenceIds).toEqual([]);
    expect(out.ungroundedRate).toBe(0);
  });
});

describe('collectEvidenceIds', () => {
  it('finds ids in nested retrieval output', () => {
    const ids = collectEvidenceIds({
      results: [
        { id: 'ev_1', text: 'a', meta: { documentId: 'doc_1' } },
        { id: 'ev_2', text: 'b' },
      ],
    });
    expect(ids).toEqual(expect.arrayContaining(['ev_1', 'ev_2', 'doc_1']));
  });

  it('survives a cyclic payload instead of hanging', () => {
    const node: Record<string, unknown> = { id: 'ev_1' };
    node.self = node;
    expect(collectEvidenceIds(node)).toEqual(['ev_1']);
  });

  it('respects the depth bound', () => {
    const deep = { a: { b: { c: { d: { e: { id: 'ev_deep' } } } } } };
    expect(collectEvidenceIds(deep, { maxDepth: 2 })).toEqual([]);
    expect(collectEvidenceIds(deep, { maxDepth: 10 })).toEqual(['ev_deep']);
  });
});
