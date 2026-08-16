/**
 * Crash-injectable durable storage.
 *
 * Models a disk: survives Kernel instance death, dies only when the test says so.
 * `crashAt` fires a CrashError before the Nth durable write completes; `tornWrite`
 * makes that write land as a truncated prefix, which recovery MUST discard.
 */

import { createHash } from 'node:crypto';

export class CrashError extends Error {
  readonly at: string;
  constructor(at: string) {
    super(`simulated crash at ${at}`);
    this.at = at;
    this.name = 'CrashError';
  }
}

export function sha(input: unknown): string {
  return createHash('sha256').update(canonical(input)).digest('hex').slice(0, 32);
}

/** Deterministic canonical serialization: sorted keys, no floating ambiguity. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

/** Phase-2 record format: the checksum covers the events array. */
export function verifyEventsChecksum(record: unknown): boolean {
  const rec = record as { events?: unknown; checksum?: unknown };
  return typeof rec.checksum === 'string' && rec.checksum === sha(rec.events);
}

export interface StorageStats {
  readonly journalRecords: number;
  readonly blobs: number;
  readonly checkpoints: number;
  readonly writes: number;
}

export class Storage {
  /** Durable journal: one line per commit record. */
  private journal: string[] = [];
  /** Content-addressed blob store. */
  private blobs = new Map<string, string>();
  /** Durable checkpoint records. */
  private checkpoints = new Map<string, string>();
  private writeCount = 0;

  /** Crash controls (test-driven). */
  crashAt: number | null = null;
  crashWhen: ((serialized: string) => boolean) | null = null;
  tornWrite = false;
  private crashLabel = 'write';

  /** Crash before the Nth durable write. */
  armCrash(nthWrite: number, opts?: { torn?: boolean; label?: string }): void {
    this.crashAt = nthWrite;
    this.crashWhen = null;
    this.tornWrite = opts?.torn ?? false;
    this.crashLabel = opts?.label ?? 'write';
  }

  /**
   * Crash before the first write whose serialized payload satisfies `predicate`.
   *
   * Counting writes to reach a semantic position is brittle: the count changes whenever
   * the record format does, and a stale count silently tests the wrong moment (or, worse,
   * never fires and the test passes for the wrong reason). Naming the position instead
   * keeps crash tests pinned to meaning.
   */
  armCrashWhen(predicate: (serialized: string) => boolean, opts?: { torn?: boolean; label?: string }): void {
    this.crashAt = null;
    this.crashWhen = predicate;
    this.tornWrite = opts?.torn ?? false;
    this.crashLabel = opts?.label ?? 'match';
  }

  disarm(): void {
    this.crashAt = null;
    this.crashWhen = null;
    this.tornWrite = false;
  }

  private tick(payload: string, sink: (v: string) => void): void {
    this.writeCount += 1;
    const byCount = this.crashAt !== null && this.writeCount >= this.crashAt;
    const byMatch = this.crashWhen !== null && this.crashWhen(payload);
    if (byCount || byMatch) {
      if (this.tornWrite) sink(payload.slice(0, Math.max(1, Math.floor(payload.length / 2))));
      throw new CrashError(this.crashLabel);
    }
    sink(payload);
  }

  appendCommit(record: unknown): void {
    this.tick(JSON.stringify(record), (v) => this.journal.push(v));
  }

  putBlob(content: unknown): string {
    const ref = sha(content);
    if (this.blobs.has(ref)) {
      // Content dedup happens HERE, at the storage layer only. It never suppresses a
      // journal record — that is invariant I14 and the loop-prototype's observed bug.
      return ref;
    }
    this.tick(canonical(content), (v) => this.blobs.set(ref, v));
    return ref;
  }

  getBlob(ref: string): unknown {
    const raw = this.blobs.get(ref);
    if (raw === undefined) throw new Error(`blob not found: ${ref}`);
    return JSON.parse(raw) as unknown;
  }

  hasBlob(ref: string): boolean {
    return this.blobs.has(ref);
  }

  putCheckpoint(id: string, record: unknown): void {
    this.tick(JSON.stringify(record), (v) => this.checkpoints.set(id, v));
  }

  getCheckpoint(id: string): unknown | undefined {
    const raw = this.checkpoints.get(id);
    return raw === undefined ? undefined : (JSON.parse(raw) as unknown);
  }

  /** All durable checkpoints. Recovery must reload these or forks die at restart. */
  allCheckpoints(): unknown[] {
    const out: unknown[] = [];
    for (const raw of this.checkpoints.values()) {
      try {
        out.push(JSON.parse(raw) as unknown);
      } catch {
        // A torn checkpoint record is discarded, exactly like a torn commit record.
      }
    }
    return out;
  }

  /**
   * Read the journal, discarding any record that does not parse or does not verify.
   *
   * WHICH BYTES THE CHECKSUM COVERS IS A RECORD-FORMAT DECISION, NOT A DISK DECISION.
   * A disk cannot know a format's integrity recipe, so the caller supplies one. The
   * default is the phase-2 recipe (checksum over events); the S1 format covers the whole
   * record and passes its own verifier.
   *
   * (Found while writing the S1 race suite: with the recipe hard-coded here, every S1
   * record verified as torn and recovery silently saw an empty journal — a
   * catastrophic-yet-quiet failure. Recorded as F-11.)
   */
  readJournal(verify: (record: unknown) => boolean = verifyEventsChecksum): { records: unknown[]; discarded: number } {
    const out: unknown[] = [];
    let discarded = 0;
    for (const line of this.journal) {
      let rec: unknown;
      try {
        rec = JSON.parse(line) as unknown;
      } catch {
        discarded += 1;
        continue;
      }
      if (!verify(rec)) {
        discarded += 1;
        continue;
      }
      out.push(rec);
    }
    return { records: out, discarded };
  }

  stats(): StorageStats {
    return {
      journalRecords: this.journal.length,
      blobs: this.blobs.size,
      checkpoints: this.checkpoints.size,
      writes: this.writeCount,
    };
  }

  /** Total durable writes so far — used to enumerate crash points. */
  get writes(): number {
    return this.writeCount;
  }
}
