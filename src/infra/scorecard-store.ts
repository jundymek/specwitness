/**
 * `ScorecardStore` — the append-only writer for `.specwitness/scorecard.jsonl` (story 6.5).
 *
 * ============================================================================
 * LOCAL ONLY. THIS IS A PRODUCT RULE, NOT AN OVERSIGHT.
 * ============================================================================
 *
 * This module opens ONE file on the operator's own disk and speaks to nothing else. No
 * HTTP client, no socket, no telemetry endpoint, no "optional" remote sync — not here,
 * not in `src/schemas/scorecard.ts`, and not behind a flag. AC1 of this story requires
 * it and so does a founding product rule (`CLAUDE.md`: *"Local-first: no SaaS, no web
 * UI, no cloud telemetry"*). The `scorecard-is-local-only` rule in
 * `.dependency-cruiser.cjs` enforces it structurally so it does not depend on anyone
 * remembering, and `tests/unit/dependency-rules.test.ts` plants a violation and watches
 * that rule fire.
 *
 * **If you are here to add "just send us anonymous counts": don't. Write an ADR.**
 *
 * ============================================================================
 * ⚠️ THE HARDEST RULE: RECORDING NEVER CHANGES A RUN'S OUTCOME
 * ============================================================================
 *
 * `appendRecord` CANNOT REJECT. Not for a full disk, not for a read-only directory, not
 * for a `.specwitness/` somebody deleted mid-run, not for anything. Its whole contract is
 * that a caller need not — and must not — defend against it:
 *
 *   - the run's verdict and exit code are unaffected, always;
 *   - the failure is SURFACED through the injected `warn`, never swallowed. A scorecard
 *     that silently stops recording is a metric that silently becomes wrong, which is
 *     worse than one that visibly breaks;
 *   - it is never an `InfraError`, and never a FAIL.
 *
 * That is the opposite of `RunStore` next door, which throws on a failed finalize and is
 * right to: `result.json` is the product's evidence, and this is instrumentation about
 * it. Instrumentation that can fail a verification is worse than no instrumentation.
 *
 * ============================================================================
 * THE CONCURRENCY GUARANTEE, AND ITS LIMITS
 * ============================================================================
 *
 * Two `specwitness verify` processes can run at once — this product is built for a
 * multi-agent harness, and Epic 6's own wave ran six agents in parallel. So:
 *
 * **WHAT IS GUARANTEED.** One record is one `write(2)` on a descriptor opened with
 * `O_APPEND` (`flag: 'a'`). POSIX requires the seek-to-end and the write to be atomic
 * with respect to other writers on a local filesystem, so concurrent appends interleave
 * BETWEEN lines and never within one. The record is bounded — counts, enums, timestamps
 * and constrained identifiers, every string capped at 256 bytes by
 * `src/schemas/scorecard.ts` — which keeps a line comfortably inside the size where that
 * holds in practice on ext4, APFS and HFS+.
 *
 * **WHAT IS NOT.** Network filesystems, NFS above all, do not provide `O_APPEND`
 * atomicity; a record written to a scorecard on an NFS mount may be interleaved or lost.
 * Windows is out of scope for this epic entirely. And no lock is taken: locking a file
 * that every run must write would make a verification wait on instrumentation, which is
 * the dependency this module exists to avoid.
 *
 * **WHY THAT IS ACCEPTABLE.** ADR-008 §5 makes a torn line survivable by design: `read`
 * below skips it with a warning and counts it, and 6.6's `scorecard summary` reports the
 * count, so a silently shrinking denominator is impossible. The guarantee and the
 * reader's tolerance are two halves of one decision, not a gap papered over.
 *
 * AD-8: `RunStore` remains the sole writer beneath `.specwitness/runs/`. This store never
 * constructs a path under that directory — the scorecard sits BESIDE `runs/`, and the
 * one path it can address is fixed at construction.
 *
 * AD-1: `src/infra/**` is an adapter. `node:fs` is legal here and nowhere in
 * `src/domain` or `src/schemas`.
 */

import { appendFile, open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  parseScorecardLine,
  SCORECARD_FILENAME,
  serializeScorecardRecord,
  type ScorecardRecord,
  type ScorecardSkipReason,
} from '../schemas/scorecard.js';

/**
 * The project-local SpecWitness directory.
 *
 * Declared here rather than imported, following the precedent every other module that
 * needs it already set — `src/infra/scaffold.ts:29`, `src/infra/run-store.ts:64`,
 * `src/authoring/plan-file.ts:41`, `src/authoring/contract-file.ts:41`. A shared
 * constant would be an adapter-to-adapter import in three of those four cases.
 */
const PROJECT_DIR = '.specwitness';

/** One line the reader could not use, and why. ADR-008 §5. */
export interface SkippedScorecardRecord {
  /** 1-based, counting every line in the file including blank ones, so it matches an editor. */
  readonly line: number;
  readonly reason: ScorecardSkipReason;
  /** Ready to print. Carries no value from the file — see `parseScorecardLine`. */
  readonly message: string;
}

/**
 * A scorecard as read back.
 *
 * **`skipped` is the field story 6.6 must surface.** ADR-008 §5 requires `scorecard
 * summary` to report the count of skipped records, so a silently shrinking denominator
 * is impossible. This store produces the count; 6.6 owns the arithmetic and the CLI, and
 * this story deliberately builds neither.
 */
export interface ScorecardFile {
  readonly records: readonly ScorecardRecord[];
  readonly skipped: readonly SkippedScorecardRecord[];
}

export class ScorecardStore {
  readonly #path: string;

  constructor(projectRoot: string) {
    this.#path = join(projectRoot, PROJECT_DIR, SCORECARD_FILENAME);
  }

  /** The one file this store can address, absolute. Fixed at construction. */
  get path(): string {
    return this.#path;
  }

  /**
   * Appends one record. **Resolves on every path, including failure.**
   *
   * @param warn how a failure reaches the operator. Bound at the CLI edge to
   * `printWarning`, which writes `WARNING:` to stderr — stderr because stdout carries the
   * `--json` document a harness parses, and a diagnostic there would corrupt it.
   */
  async appendRecord(record: ScorecardRecord, warn: (message: string) => void): Promise<void> {
    // Serialization happens INSIDE the try. It cannot realistically throw — the record is
    // built from counts, enums and bounded strings — but "realistically" is not a
    // guarantee, and the one thing this method promises is that it has no failure route
    // at all. A throw here would be instrumentation changing a verdict.
    try {
      // ⚠️ REFUSE A PATH THAT IS NOT A REGULAR FILE, BEFORE OPENING IT.
      //
      // Raised as a P2 by the codex review of this branch: opening a FIFO for append
      // BLOCKS until a reader arrives, and `verify` awaits this call before rendering and
      // before returning its exit code — so a named pipe sitting at this path would hang a
      // completed verification forever. A run that never produces its verdict is the most
      // total way instrumentation can affect an outcome, and this method exists to make
      // that impossible.
      //
      // `stat` answers immediately for a FIFO, a socket or a device — it does not open
      // them — so this converts an indefinite hang into the ordinary warning every other
      // failure here becomes. A symlink pointing at a regular file still passes, because
      // `stat` follows symlinks and someone redirecting their scorecard onto another disk
      // is doing something reasonable.
      //
      // It is a guard against accident and misconfiguration, NOT a security control:
      // stat-then-open is a TOCTOU race, and anyone able to plant a FIFO inside
      // `.specwitness/` can already rewrite the contract and the plan that live beside it.
      const existing = await stat(this.#path).catch(() => undefined);
      if (existing !== undefined && !existing.isFile()) {
        warnSafely(
          warn,
          `the run was verified, but its scorecard record could not be appended: ${this.#path} ` +
            `is not a regular file. The verdict and exit code are unaffected; this run is ` +
            `missing from the dogfooding measurement.`,
        );
        return;
      }

      // ONE write, `O_APPEND`. Not read-modify-write, not open-truncate-write: either of
      // those would lose a concurrent run's record rather than merely interleave with it.
      // The separator is part of the SAME buffer, so this stays one `write(2)` — see
      // `#separatorForTornTail`.
      await appendFile(this.#path, `${await this.#separatorForTornTail()}${serializeScorecardRecord(record)}`, {
        encoding: 'utf8',
        flag: 'a',
      });
    } catch (cause) {
      // ⚠️ THE REPORT IS ITSELF CONTAINED, and this inner boundary is the difference
      // between a guarantee and a claim. Raised as a P2 by the codex review of this
      // branch: `warn` is caller-supplied and bound at the edge to `printWarning`, which
      // writes to `process.stderr` — and `specwitness verify | head -1` destroys that
      // stream. An EPIPE from the WARNING would have escaped this catch, reached
      // `main.ts` and become exit 3, turning a completed verification into "the
      // environment is broken, retry" by way of the instrumentation that exists to be
      // invisible. A broken pipe is an ordinary way to run a CLI, not an exotic one.
      //
      // AND WHAT IT DOES ON FAILURE IS NOTHING, deliberately. There is no third channel:
      // we cannot report a failure to report, and every remaining option — rethrowing,
      // writing to stdout (which carries the `--json` document a harness parses), exiting
      // — changes something this method promises not to change. Silence about a warning
      // is the least-bad outcome available; silence about a VERDICT never is, and that is
      // the distinction. The verdict is already decided and untouched by anything here.
      warnSafely(
        warn,
        `the run was verified, but its scorecard record could not be appended to ${this.#path}: ` +
          `${describe(cause)}. The verdict and exit code are unaffected; this run is missing from ` +
          `the dogfooding measurement.`,
      );
    }
  }

  /**
   * A newline to prepend when the file's last line was never terminated, else `''`.
   *
   * ⚠️ WITHOUT THIS, ONE TORN LINE COSTS TWO RECORDS — the damaged one and the next good
   * one. Raised as a P2 by the codex review of this story, and it is the failure this
   * whole module exists to prevent: a completed run vanishing from the measurement with no
   * symptom anywhere.
   *
   * ADR-008 §5 makes a single torn line survivable, and a crash or a short write is
   * exactly how one arises — leaving the file with no trailing newline. Appending then
   * glues the next COMPLETE record onto the fragment, and the reader skips the pair as one
   * malformed line. One casualty becomes two, and the second was healthy.
   *
   * WHY THIS DOES NOT REINTRODUCE THE READ-MODIFY-WRITE THIS MODULE REFUSES. It reads ONE
   * BYTE and writes nothing; the record and its separator go out in a single buffer, so
   * the append is still one `write(2)` and still atomic. The read is a separate syscall,
   * so two concurrent writers can both observe a torn tail and both prepend a newline —
   * which yields one BLANK LINE between records, and `read` below skips blank lines
   * without counting them. A benign outcome was chosen over a lock, deliberately: locking
   * a file that every run must write would make a verification wait on its own
   * instrumentation.
   *
   * Any failure answers `''`. A store that could not inspect the tail must still record —
   * the worst case is then exactly today's behaviour, which is the right direction to fail
   * in for something that may never change an outcome.
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
      // Includes ENOENT, which is the ordinary first-record case: no file, nothing to
      // separate from.
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
   * An ABSENT file is an empty scorecard, not an error — a project that has never run a
   * verification has recorded nothing, and that is a fact rather than a fault. Any other
   * read failure throws, because unlike the write path this is nobody's run: reading is
   * story 6.6's path, and a caller that asked for the data deserves to hear that it could
   * not be delivered.
   */
  async read(): Promise<ScorecardFile> {
    let text: string;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        return { records: [], skipped: [] };
      }
      throw cause;
    }

    const records: ScorecardRecord[] = [];
    const skipped: SkippedScorecardRecord[] = [];

    const lines = text.split('\n');
    for (const [index, line] of lines.entries()) {
      // A blank line is not damage. Every well-formed file ends with a newline, so
      // counting the empty tail as a skipped record would make `skippedRecords` alarm on
      // every healthy scorecard — and an alarm that always fires is one nobody reads.
      if (line.trim() === '') {
        continue;
      }

      const parsed = parseScorecardLine(line, index + 1, this.#path);
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
 * Reports through a caller-supplied `warn`, and swallows a SYNCHRONOUS throw from it.
 *
 * ⚠️ READ THE LIMIT BEFORE TRUSTING THIS. It contains a synchronous throw and nothing
 * else. It CANNOT contain an asynchronous stream error — and on the most likely route,
 * a closed stderr, that is exactly what arrives: `process.stderr.write` on a broken pipe
 * surfaces `EPIPE` as an `'error'` EVENT on the stream, after this function has already
 * returned. An earlier version of this comment claimed the boundary made
 * `appendRecord`'s promise true outright. It does not, and the codex review of this
 * branch was right to say so.
 *
 * MEASURED, not reasoned about (round 6, story 6.5). With the report piped to a consumer
 * that exits after one line: one stderr line exits 0; TWO stderr lines exit 1; and piping
 * stdout alone while discarding stderr exits 0. So the fatal event is the second write to
 * a closed pipe, delivered asynchronously, and no `try`/`catch` anywhere can catch it.
 *
 * THE REMEDY IS NOT HERE. It is a one-time `'error'` listener on the process's own
 * standard streams, which is process-global state at the CLI edge, owned by no Epic 6
 * story, and it would change behaviour for every other warning this product prints. It
 * is reported with its reproduction in this story's PR body and Dev Agent Record rather
 * than fixed from a scorecard module. What this function still buys is real and worth
 * keeping: a `warn` that throws synchronously — an injected one, a future edge that
 * validates its argument — cannot escape `appendRecord`.
 *
 * It was itself a P2 from an earlier round of the same review, before it existed. `warn` is bound at the CLI edge to
 * `printWarning`, which writes to `process.stderr` — and `specwitness verify | head -1`
 * destroys that stream. Without this, an EPIPE from the WARNING escaped `appendRecord`,
 * reached `main.ts` and became exit 3: a completed verification reported as a broken
 * environment by the instrumentation that exists to be invisible.
 *
 * WHAT IT DOES ON FAILURE IS NOTHING, deliberately. There is no third channel. We cannot
 * report a failure to report, and every remaining option — rethrowing, writing to stdout
 * (which carries the `--json` document a harness parses), exiting — changes something this
 * module promises not to change. Silence about a WARNING is the least-bad outcome
 * available; silence about a VERDICT never is, and the verdict is already decided and
 * untouched by anything here.
 */
function warnSafely(warn: (message: string) => void, message: string): void {
  try {
    warn(message);
  } catch {
    // Intentionally empty. See above: there is nowhere left to say it.
  }
}

/**
 * One line about a thrown value, for the warning.
 *
 * The message only — never a stack trace, which is rendered and would name paths the
 * operator did not ask about.
 */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
