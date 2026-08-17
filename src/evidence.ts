/**
 * Evidence grounding: deterministic set membership, no model call.
 *
 * A model asked to cite its sources will invent identifiers. It invents them
 * fluently, in the right format, and a fabricated id renders downstream as a
 * perfectly convincing citation. The fix is not to ask another model whether
 * the citation is plausible; it is to check whether the id exists.
 *
 * Everything here is synchronous, allocation-light and network-free. That is
 * the point: a grounding check that can itself hallucinate, time out, or cost
 * money is not a grounding check.
 */

export type EvidenceId = string;

export interface CitationFilterResult {
  /** Cited ids that exist in the candidate set, in first-seen order. */
  kept: EvidenceId[];
  /** Cited ids that do not exist. These are fabrications. */
  dropped: EvidenceId[];
  /** dropped / (kept + dropped). NaN-free: 0 when nothing was cited. */
  ungroundedRate: number;
}

/**
 * The core operation. Split cited ids into those that exist and those that
 * do not.
 *
 * Duplicates in `cited` collapse to a single entry, because "the model cited
 * the same fake id three times" is one fabrication, not three, and counting
 * it as three inflates the ungrounded rate.
 */
export function filterCitations(
  cited: readonly EvidenceId[] | null | undefined,
  valid: ReadonlySet<EvidenceId>,
): CitationFilterResult {
  const kept: EvidenceId[] = [];
  const dropped: EvidenceId[] = [];
  const seen = new Set<EvidenceId>();

  for (const raw of cited ?? []) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    (valid.has(id) ? kept : dropped).push(id);
  }

  const total = kept.length + dropped.length;
  return { kept, dropped, ungroundedRate: total === 0 ? 0 : dropped.length / total };
}

/**
 * Per-session record of which evidence ids were actually produced by
 * retrieval, plus running counts of what the model tried to cite.
 *
 * The ledger is the half that makes this work in an agent loop rather than a
 * single call: retrieval happens in one tool call and citation happens in a
 * later one, so something has to remember what was real in between.
 */
export class EvidenceLedger {
  readonly #valid = new Set<EvidenceId>();
  #keptCount = 0;
  #droppedCount = 0;
  #checkCount = 0;

  /** Record ids returned by a retrieval step as genuinely existing. */
  admit(ids: Iterable<EvidenceId>): this {
    for (const raw of ids) {
      if (typeof raw !== 'string') continue;
      const id = raw.trim();
      if (id !== '') this.#valid.add(id);
    }
    return this;
  }

  /** Filter cited ids against everything admitted so far, and tally. */
  check(cited: readonly EvidenceId[] | null | undefined): CitationFilterResult {
    const result = filterCitations(cited, this.#valid);
    this.#keptCount += result.kept.length;
    this.#droppedCount += result.dropped.length;
    this.#checkCount += 1;
    return result;
  }

  has(id: EvidenceId): boolean {
    return this.#valid.has(id);
  }

  /** Read-only view of everything admitted, for passing to the pure helpers. */
  get validIds(): ReadonlySet<EvidenceId> {
    return this.#valid;
  }

  get size(): number {
    return this.#valid.size;
  }

  /**
   * Session totals. `ungroundedRate` is over citations, not over checks: one
   * answer citing ten fake ids is worse than ten answers citing one each, and
   * the metric should say so.
   */
  stats(): {
    admitted: number;
    checks: number;
    kept: number;
    dropped: number;
    ungroundedRate: number;
  } {
    const total = this.#keptCount + this.#droppedCount;
    return {
      admitted: this.#valid.size,
      checks: this.#checkCount,
      kept: this.#keptCount,
      dropped: this.#droppedCount,
      ungroundedRate: total === 0 ? 0 : this.#droppedCount / total,
    };
  }

  reset(): void {
    this.#valid.clear();
    this.#keptCount = 0;
    this.#droppedCount = 0;
    this.#checkCount = 0;
  }
}

/**
 * Apply the filter across an array of objects that each carry citations, which
 * is the shape real extraction output takes: a list of findings, each pointing
 * at the evidence that supports it.
 *
 * A record whose citations are all dropped is kept, not deleted. That is
 * deliberate. An unsupported finding rendered without support is the honest
 * presentation of what happened; silently removing it hides that the model
 * produced it at all, and the audit trail is worth more than the tidiness.
 */
export function sanitizeCitedRecords<T extends object>(
  records: readonly T[] | null | undefined,
  valid: ReadonlySet<EvidenceId>,
  key = 'evidenceIds',
): { records: T[]; kept: EvidenceId[]; dropped: EvidenceId[]; ungroundedRate: number } {
  const out: T[] = [];
  const kept: EvidenceId[] = [];
  const dropped: EvidenceId[] = [];

  for (const record of records ?? []) {
    const cited = (record as Record<string, unknown>)[key];
    const result = filterCitations(Array.isArray(cited) ? (cited as EvidenceId[]) : [], valid);
    kept.push(...result.kept);
    dropped.push(...result.dropped);
    out.push({ ...record, [key]: result.kept } as T);
  }

  const total = kept.length + dropped.length;
  return {
    records: out,
    kept,
    dropped,
    ungroundedRate: total === 0 ? 0 : dropped.length / total,
  };
}

/**
 * Pull evidence ids out of an arbitrary retrieval tool result.
 *
 * Retrieval tools return wildly different shapes, so this walks the structure
 * looking for the configured id field rather than demanding one schema. Depth
 * is bounded because tool output is untrusted input and a cyclic or absurdly
 * nested payload should not be able to hang a hook.
 */
export function collectEvidenceIds(
  payload: unknown,
  opts: { idFields?: readonly string[]; maxDepth?: number } = {},
): EvidenceId[] {
  const idFields = opts.idFields ?? ['id', 'evidenceId', 'evidence_id', 'chunkId', 'documentId'];
  const maxDepth = opts.maxDepth ?? 8;
  const found: EvidenceId[] = [];
  const seen = new Set<unknown>();

  const walk = (node: unknown, depth: number): void => {
    if (depth > maxDepth || node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      if (idFields.includes(key) && typeof value === 'string' && value.trim() !== '') {
        found.push(value.trim());
      } else {
        walk(value, depth + 1);
      }
    }
  };

  walk(payload, 0);
  return found;
}
