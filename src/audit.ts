/**
 * An audit trail that works when you cannot keep the inputs.
 *
 * Two requirements that look like they contradict each other. Every decision
 * needs to be auditable after the fact, and the inputs are sensitive documents
 * that must not sit in a log. The resolution is to store a fingerprint instead
 * of the text: you can prove that this exact input, under this ruleset version,
 * produced this decision, without ever holding the input. Re-hash the document
 * later and the row either matches or it does not.
 */

import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AuditEntry {
  ts: string;
  /** Free-form label for where in your system this happened. */
  entryPoint: string;
  sessionId?: string;
  toolName?: string;
  /** SHA-256 of the input. Never the input itself. */
  inputHash: string;
  rulesetVersion?: string;
  guardrailTriggered: boolean;
  guardrailViolations: string[];
  evidenceKept?: number;
  evidenceDropped?: number;
  ungroundedRate?: number;
  durationMs?: number;
}

export function hashInput(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export interface AuditSinkOptions {
  /** JSONL file to append to. Omit for an in-memory sink (tests, evals). */
  file?: string;
  /**
   * Logging must never take a user-facing feature offline, so writes are
   * fire-and-forget by default and failures are swallowed. The cost of that
   * choice is `drain()`, below.
   */
  onError?: (err: unknown) => void;
}

/**
 * Fire-and-forget audit writer with a drain fence.
 *
 * The fence exists because of a real bug worth keeping in the story: unawaited
 * writes race process shutdown, which in a long-running cron job shows up as a
 * tail of "pool was closed" errors on every run. The first fix was a sleep,
 * which is not a fix. The real one is to track in-flight writes and await them
 * before disconnect. Non-fatal logging still means someone has to think about
 * shutdown.
 */
export class AuditLog {
  readonly #entries: AuditEntry[] = [];
  readonly #inFlight = new Set<Promise<void>>();
  readonly #file?: string;
  readonly #onError: (err: unknown) => void;
  #dirEnsured = false;

  constructor(opts: AuditSinkOptions = {}) {
    this.#file = opts.file;
    this.#onError = opts.onError ?? (() => {});
  }

  /** Non-blocking by design. Returns immediately; use drain() before exit. */
  record(entry: Omit<AuditEntry, 'ts'> & { ts?: string }): AuditEntry {
    const full: AuditEntry = { ts: entry.ts ?? new Date().toISOString(), ...entry };
    this.#entries.push(full);

    if (this.#file !== undefined) {
      const write = this.#append(full).catch(this.#onError);
      this.#inFlight.add(write);
      void write.finally(() => this.#inFlight.delete(write));
    }
    return full;
  }

  async #append(entry: AuditEntry): Promise<void> {
    if (!this.#dirEnsured) {
      await mkdir(dirname(this.#file as string), { recursive: true });
      this.#dirEnsured = true;
    }
    await appendFile(this.#file as string, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** Await every in-flight write. Call before process exit. */
  async drain(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight]);
    }
  }

  /** Everything recorded this process. The eval harness reads this. */
  entries(): readonly AuditEntry[] {
    return this.#entries;
  }

  /**
   * Aggregate the numbers the whole package exists to produce.
   *
   * blockRate is over calls. ungroundedRate is over citations, because one
   * answer citing ten fabricated ids is worse than ten answers citing one
   * each, and an average of per-call rates would hide that.
   */
  summary(): {
    calls: number;
    blocked: number;
    blockRate: number;
    citationsKept: number;
    citationsDropped: number;
    ungroundedRate: number;
    violationsByRule: Record<string, number>;
  } {
    let blocked = 0;
    let kept = 0;
    let dropped = 0;
    const violationsByRule: Record<string, number> = {};

    for (const e of this.#entries) {
      if (e.guardrailTriggered) blocked += 1;
      kept += e.evidenceKept ?? 0;
      dropped += e.evidenceDropped ?? 0;
      for (const rule of e.guardrailViolations) {
        violationsByRule[rule] = (violationsByRule[rule] ?? 0) + 1;
      }
    }

    const calls = this.#entries.length;
    const citations = kept + dropped;
    return {
      calls,
      blocked,
      blockRate: calls === 0 ? 0 : blocked / calls,
      citationsKept: kept,
      citationsDropped: dropped,
      ungroundedRate: citations === 0 ? 0 : dropped / citations,
      violationsByRule,
    };
  }
}
