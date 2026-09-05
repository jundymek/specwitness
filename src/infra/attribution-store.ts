/**
 * `AttributionStore` — the append-only log of FR-34 judgements (story 6.6).
 *
 * ============================================================================
 * LOCAL ONLY. THIS IS A PRODUCT RULE, NOT AN OVERSIGHT.
 * ============================================================================
 *
 * This module opens ONE file on the operator's own disk and speaks to nothing else. No
 * HTTP client, no socket, no telemetry endpoint, no "optional" remote sync — not here,
 * not in `src/schemas/scorecard-attribution.ts`, and not behind a flag. A founding
 * product rule (`CLAUDE.md`: *"Local-first: no SaaS, no web UI, no cloud telemetry"*) and
 * AC2's *"computed from local records only"* both require it, and the
 * `scorecard-is-local-only` rule in `.dependency-cruiser.cjs` — extended by this story to
 * cover both of its new modules — enforces it structurally rather than by memory.
 *
 * **If you are here to add "just send us anonymous counts": don't. Write an ADR.**
 *
 * ============================================================================
 * ⚠️ THE DELIBERATE ASYMMETRY WITH `ScorecardStore` NEXT DOOR
 * ============================================================================
 *
 * `ScorecardStore.appendRecord` **cannot reject**, for a good reason: it is
 * instrumentation hanging off a finished verdict, and instrumentation that can fail a
 * verification is worse than no instrumentation.
 *
 * **This store is the opposite, and must be.** It is not hanging off anything — it IS the
 * user's command. `specwitness scorecard add` exists solely to record a judgement, so a
 * write that fails is a command that failed and must say so, loudly, with a non-zero exit.
 * A silent failure here would tell a developer their attribution was saved when it was
 * not, and the north-star metric would quietly lose the one input no machine can
 * reconstruct.
 *
 * So: **every failure propagates.** The CLI edge classifies it through `src/cli/exit.ts`
 * as infra (exit 3). This module sets no exit code and prints nothing.
 *
 * ============================================================================
 * THE CONCURRENCY GUARANTEE, AND ITS LIMITS
 * ============================================================================
 *
 * Inherited from story 6.5's design, for the same reasons and with the same limits.
 *
 * **Guaranteed.** One record is one `write(2)` on a descriptor opened with `O_APPEND`
 * (`flag: 'a'`). POSIX requires the seek-to-end and the write to be atomic with respect
 * to other writers on a local filesystem, so concurrent appends interleave BETWEEN lines
 * and never within one. The record is bounded — two identifiers, an enum, a timestamp and
 * a note capped at 512 bytes — which keeps a line comfortably inside the size where that
 * holds in practice on ext4, APFS and HFS+.
 *
 * **Not guaranteed.** Network filesystems, NFS above all, do not provide `O_APPEND`
 * atomicity. Windows is out of scope for this epic. No lock is taken.
 *
 * **Why that is acceptable.** ADR-008 §5 makes a torn line survivable by design: `read`
 * below skips it with a warning and counts it, and `scorecard summary` reports the count,
 * so a silently shrinking denominator is impossible.
 *
 * AD-8: `RunStore` remains the sole writer beneath `.specwitness/runs/`. This store never
 * constructs a path under that directory — the log sits BESIDE `runs/` and beside
 * `scorecard.jsonl`, and the one path it can address is fixed at construction from the
 * project root alone. **No value from a command line ever builds this path.**
 *
 * AD-1: `src/infra/**` is an adapter. `node:fs` is legal here and nowhere in
 * `src/domain` or `src/schemas`.
 */

import { appendFile, open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { InfraError } from '../domain/errors.js';
import {
  ATTRIBUTIONS_FILENAME,
  parseAttributionLine,
  serializeAttributionRecord,
  type AttributionRecord,
  type AttributionSkipReason,
} from '../schemas/scorecard-attribution.js';

/**
 * The project-local SpecWitness directory.
 *
 * Declared here rather than imported, following the precedent every other module that
 * needs it already set — `src/infra/scaffold.ts`, `src/infra/run-store.ts`,
 * `src/infra/scorecard-store.ts`, `src/authoring/plan-file.ts`. A shared constant would
 * be an adapter-to-adapter import in most of those cases.
 */
const PROJECT_DIR = '.specwitness';

/** One line the reader could not use, and why. ADR-008 §5. */
export interface SkippedAttributionRecord {
  /** 1-based, counting every line in the file including blank ones, so it matches an editor. */
  readonly line: number;
  readonly reason: AttributionSkipReason;
  /** Ready to print. Carries no value from the file — see `parseAttributionLine`. */
  readonly message: string;
}

/** An attribution log as read back. */
export interface AttributionFile {
  /** In FILE ORDER, which is append order — the summary's tie-break depends on it. */
  readonly records: readonly AttributionRecord[];
  readonly skipped: readonly SkippedAttributionRecord[];
}

export class AttributionStore {
  readonly #path: string;

  constructor(projectRoot: string) {
    this.#path = join(projectRoot, PROJECT_DIR, ATTRIBUTIONS_FILENAME);
  }

  /** The one file this store can address. Fixed at construction. */
  get path(): string {
    return this.#path;
  }

  /**
   * Appends one record. **Rejects on failure** — see the asymmetry note in the header.
   *
   * Refuses a path that is not a regular file BEFORE opening it. Opening a FIFO for
   * append blocks until a reader arrives, which would hang the command forever; `stat`
   * answers immediately for a FIFO, a socket or a device because it does not open them.
   * A symlink pointing at a regular file still passes, because `stat` follows symlinks
   * and redirecting a log onto another disk is a reasonable thing to do.
   *
   * Like story 6.5's, this is a guard against accident and misconfiguration and NOT a
   * security control: stat-then-open is a TOCTOU race, and anyone able to plant a FIFO
   * inside `.specwitness/` can already rewrite the contract that lives beside it.
   */
  async append(record: AttributionRecord): Promise<void> {
    const existing = await stat(this.#path).catch(() => undefined);
    if (existing !== undefined && !existing.isFile()) {
      throw new InfraError(
        `cannot record the attribution: ${this.#path} is not a regular file`,
        'move or remove whatever is at that path, then run the command again',
      );
    }

    // ONE write, `O_APPEND`. Not read-modify-write, not open-truncate-write: either would
    // lose a concurrent writer's record rather than merely interleave with it. The
    // separator travels in the SAME buffer, so this stays one `write(2)`.
    try {
      await appendFile(
        this.#path,
        `${await this.#separatorForTornTail()}${serializeAttributionRecord(record)}`,
        { encoding: 'utf8', flag: 'a' },
      );
    } catch (cause) {
      // ⚠️ TRANSLATED AT THIS BOUNDARY, and it was a P2 from the codex review of this
      // branch. A raw Node `EACCES`/`ENOSPC` is not an `isSpecWitnessError`, so the global
      // handler in `main.ts` printed `unexpected internal failure: ...` with the hint
      // *"this is a SpecWitness bug — please report it"*. Reproduced against the built
      // binary with a read-only `.specwitness/`: the exit code was right (3) and the
      // MESSAGE told an operator with a permissions problem to file a bug report.
      //
      // The adapter's job is to turn an environment failure into an actionable one. The
      // cause's message is included because it names the errno and the path, which is what
      // makes it fixable; no stack, which would name paths nobody asked about.
      throw new InfraError(
        `the attribution could not be recorded: ${describe(cause)}`,
        `check that ${this.#path} is writable and that the disk is not full, then run the command again`,
      );
    }
  }

  /**
   * A newline to prepend when the file's last line was never terminated, else `''`.
   *
   * ⚠️ WITHOUT THIS, ONE TORN LINE COSTS TWO RECORDS — the damaged one and the next good
   * one. Story 6.5 learned it as a P2 and the reasoning carries over unchanged: a crash or
   * a short write leaves the file with no trailing newline, and appending then glues the
   * next COMPLETE record onto the fragment, so the reader skips the pair as one malformed
   * line. One casualty becomes two, and the second was healthy.
   *
   * It does not reintroduce the read-modify-write this module refuses: it reads ONE BYTE
   * and writes nothing, and the record and its separator go out in a single buffer. Two
   * concurrent writers can both observe a torn tail and both prepend, which yields one
   * BLANK LINE between records — and `read` skips blank lines without counting them. A
   * benign outcome was chosen over a lock, deliberately.
   *
   * Any failure answers `''`, so the worst case is exactly the behaviour without it.
   */
  async #separatorForTornTail(): Promise<string> {
    let handle;
    try {
      handle = await open(this.#path, 'r');
      const { size } = await handle.stat();
      if (size === 0) {
        return '';
      }
      const tail = Buffer.alloc(1);
      await handle.read(tail, 0, 1, size - 1);
      return tail[0] === 0x0a ? '' : '\n';
    } catch {
      // Includes ENOENT, the ordinary first-record case: no file, nothing to separate from.
      return '';
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /**
   * Reads every record, skipping the lines it cannot use.
   *
   * ADR-008 §5: a line whose only failure is unknown keys came from a newer SpecWitness
   * and is skipped with a warning; a malformed line is skipped with a DIFFERENT
   * diagnosis; both are counted, and the read continues over the rest. A partially
   * readable log is still evidence.
   *
   * An ABSENT file is an empty log, not an error — a project that has attributed nothing
   * has attributed nothing, and that is a fact rather than a fault. **Any other read
   * failure throws**, because a caller that asked for the data deserves to hear that it
   * could not be delivered; returning an empty log for an unreadable file would silently
   * shrink every denominator computed from it, which is the exact failure ADR-008 §5
   * exists to prevent.
   *
   * Records come back in FILE ORDER, which is append order. The summary's re-attribution
   * rule — the last record for a given `(runId, criterionId)` wins — depends on that, so
   * this must never be sorted.
   */
  async read(): Promise<AttributionFile> {
    let text: string;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        return { records: [], skipped: [] };
      }
      // Translated like the write path above, and for the same reason: an unreadable log
      // is an environment problem the operator can fix, not a SpecWitness bug to report.
      throw new InfraError(
        `the attribution log could not be read: ${describe(cause)}`,
        `check that ${this.#path} is readable, then run the command again`,
      );
    }

    const records: AttributionRecord[] = [];
    const skipped: SkippedAttributionRecord[] = [];

    for (const [index, line] of text.split('\n').entries()) {
      // A blank line is not damage. Every well-formed file ends with a newline, so
      // counting the empty tail as a skipped record would make the count alarm on every
      // healthy log — and an alarm that always fires is one nobody reads.
      if (line.trim() === '') {
        continue;
      }

      const parsed = parseAttributionLine(line, index + 1, this.#path);
      if (parsed.ok) {
        records.push(parsed.record);
      } else {
        skipped.push({ line: index + 1, reason: parsed.reason, message: parsed.message });
      }
    }

    return { records, skipped };
  }
}

/**
 * One line about a thrown value, for an `InfraError` message.
 *
 * The message only — never a stack trace, which is rendered and would name paths the
 * operator did not ask about. Mirrors `describe` in `src/infra/scorecard-store.ts`.
 */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
