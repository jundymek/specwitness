/**
 * `RunStore` — the SOLE writer under `.specwitness/runs/<run-id>/` (AD-8).
 *
 * That sole-writership is a reviewable, grep-level rule: outside this file, no
 * module in the repository may construct a path under `.specwitness/runs`.
 * Everything that needs one calls `runDir()`. The rule exists because run
 * storage is what makes crash cleanup possible — if paths are built in five
 * places, the sixth one leaks a worktree.
 *
 * AD-8 names two write disciplines for this store:
 *
 *  1. **Crash-durable incremental appends** — manifest writes, fsynced before
 *     the run acquires any resource, so `kill -9` never loses track of a
 *     worktree or a process group. That is implemented here, now, because
 *     story 3.2's `specwitness clean` depends on it.
 *
 *  2. **Atomic finalize (stage-and-rename)** for `result.json` — `writeResult`
 *     below, added by story 3.5. A half-written result is worse than none:
 *     `report` would render a partial verdict as though it were complete.
 *
 * Layering: this is `src/infra`, so `node:fs` is legal here and nowhere in
 * `src/domain` or `src/schemas` (dependency-cruiser enforces it). Time and
 * randomness arrive through the AD-9 ports rather than being read directly.
 *
 * WHAT STORY 3.2 ADDED, so story 3.5 can rebase over it knowingly:
 * `recordWorktree`, `recordProcessGroup`, `markReaped`, `readProcessGroupRecords`
 * and `writeEvidenceFile`, plus one private mutation queue and one private
 * manifest-update helper that reuses `#writeDurably`. Nothing existing moved:
 * `createRun`, `readManifest`, `listRuns`, `hasResult`, `runDir` and
 * `#syncDirectory` are byte-for-byte what story 1.6 wrote. `#writeDurably` is
 * NOT — story 3.2 rewrote it from truncate-in-place into stage-and-rename,
 * because truncating was harmless while 1.6 only created files with it and
 * destructive once appends made it rewrite the manifest on every record.
 *
 * WHAT STORY 3.5 ADDED: `writeResult` and `readResult`, i.e. discipline 2
 * above. It reuses 3.2's `#writeDurably` rather than opening a second write
 * path — once that helper renames, it IS the atomic finalize AD-8 names, and a
 * parallel implementation is how two versions of "publish a file" end up
 * disagreeing about atomicity.
 */

import { existsSync } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { InfraError } from '../domain/errors.js';
import type { Clock, Ids } from '../domain/ports.js';
import type { RunResult } from '../domain/run-result.js';
import { isRunId, makeRunId, parseRunId } from '../domain/run-id.js';
import {
  IsoUtcTimestamp,
  MANIFEST_FILENAME,
  newRunManifest,
  parseRunManifest,
  type RunManifest,
} from '../schemas/manifest.js';
import {
  parseRunResult,
  serializeRunResult,
  type RunResultDocument,
} from '../schemas/result.js';

/** The project-local SpecWitness directory. Committed except for `runs/`. */
const SPECWITNESS_DIR = '.specwitness';

/** Runs live here. Local-only — `init` writes the ignore entry (story 1.4). */
const RUNS_DIR = 'runs';

/** Story 3.5 writes this; 1.6 only reports whether it exists yet. */
const RESULT_FILENAME = 'result.json';

/**
 * Reaping evidence for `specwitness clean` — story 3.2.
 *
 * WHY A SECOND FILE RATHER THAN A RICHER MANIFEST FIELD. `clean` replays
 * manifests days later, and pid reuse is real: a pgid recorded last week may be
 * the operator's editor today. Killing the wrong process tree is the worst
 * outcome available in this story — worse than leaking, because leaking is
 * visible and recoverable while a wrongly-killed tree is neither — so `clean`
 * must be able to PROVE a live pgid is still the one we recorded.
 *
 * The proof is the instant the pgid was recorded. `RunStore` records the pgid
 * within milliseconds of the process being spawned, so the group leader's own
 * OS start time must sit essentially on top of it; a recycled pid would have
 * started far later. `clean` compares the two and refuses to signal when they
 * disagree.
 *
 * That instant lives HERE and not in `manifest.json` because the manifest's
 * `processGroups` is `number[]` in a `.strict()` schema that `src/schemas/`
 * owns, and this story's contract is to POPULATE the reserved arrays, not to
 * reshape them — a shape change without a version bump is exactly the kind of
 * quiet break the AD-5 policy exists to prevent. So the manifest stays the
 * authoritative list of what to reap, and this file is the evidence that makes
 * reaping safe. Missing or corrupt evidence is not fatal: it means `clean`
 * declines to signal and says so, which is the correct fail-closed direction.
 */
export const PROCESS_GROUPS_FILENAME = 'process-groups.json';

/**
 * Which SpecWitness process owns a run, so `clean` can tell a CRASHED run from
 * one that is still going.
 *
 * `clean` replays manifests, and a manifest cannot say whether its run is
 * finished. Without this, running `clean` in one terminal while `verify` runs in
 * another does two bad things at once: the active run's process groups pass
 * every liveness and identity check — they genuinely are groups SpecWitness
 * recorded moments ago — so `clean` SIGTERMs an in-progress verification; and it
 * then marks the run `reaped`, after which the still-running verify appends more
 * pgids and worktrees to a reaped manifest that later `clean` runs skip. A
 * permanent leak, created by the command whose job is to prevent leaks.
 *
 * The identity check runs in the opposite direction to the process-group one,
 * and is sound for the same reason. A run's owner must have STARTED BEFORE the
 * run was created. If the owner died, its pid can only have been reused by a
 * process that started after that death — which is after the run was created.
 * So "alive AND started before `createdAt`" identifies the true owner, and a
 * recycled pid fails it.
 */
export const OWNER_FILENAME = 'owner.json';

/**
 * A staging name reserved by agreement — and NOTHING WRITES IT ANY MORE.
 *
 * Story 3.2 reserved this when story 3.5 expected to stage under its own name.
 * 3.5 then reused `#writeDurably` instead, so the real staging name is
 * `.result.json.writing`, which the `.<name>.writing` pattern check below
 * already rejects. Kept as belt-and-braces, and labelled so nobody removes that
 * pattern check believing this constant covers `result.json`. It does not.
 *
 * The reasoning it was added for still stands and is worth keeping: clobbering
 * `result.json` directly is bad; landing on a STAGING name is worse, because
 * the next finalize renames it over `result.json`, so the substitution happens
 * later and looks like a normal successful write.
 */
const RESULT_STAGING_FILENAME = '.result.json.tmp';

/**
 * Files `RunStore` owns, which caller-named evidence may never overwrite.
 *
 * `writeEvidenceFile` takes a name chosen by a caller — ultimately derived from
 * a gate id in the operator's own config — and neither the crash record nor a
 * run result must be clobberable by an unlucky one.
 */
const RESERVED_FILENAMES: ReadonlySet<string> = new Set([
  MANIFEST_FILENAME,
  RESULT_FILENAME,
  RESULT_STAGING_FILENAME,
  PROCESS_GROUPS_FILENAME,
  OWNER_FILENAME,
]);

/**
 * What the atomic finalize did.
 *
 * Returning this rather than `void` is what makes the story's "post-rename failure is a
 * DISTINCT, NON-FATAL condition" real instead of a comment. `writeResult` resolves only
 * when the document has been PUBLISHED — the rename happened and a reader now sees the
 * new file. If the durability barrier after that rename did not complete, the finalize is
 * still a success and says so here, with the barrier's own message; it does not raise,
 * because raising would tell a caller the write did not happen when it did, and a caller
 * told that may retry or abandon a run whose result is already on disk. That is Epic 2
 * retro §5a defect (ii), and the whole point of this shape is not to repeat it.
 *
 * A genuine failure — one where the rename never happened — still throws.
 */
export interface FinalizeReport {
  /** False when the post-rename directory fsync did not complete. */
  readonly durable: boolean;
  /** What the barrier reported. Present only when `durable` is false. */
  readonly barrier?: string;
}

/**
 * A stored `result.json`, as both the validated document and the file's own bytes.
 *
 * `report --json` writes `text` verbatim; a renderer consumes `document`. Keeping the raw
 * text is what makes byte-equality with `--json` a property of construction rather than of
 * two key orderings agreeing — see `readResult`.
 */
export interface StoredResult {
  readonly document: RunResultDocument;
  /** Exactly the bytes on disk. Never a re-serialization of `document`. */
  readonly text: string;
  /** Absolute path, for error messages that name what was read. */
  readonly path: string;
}

/** Which process created a run, and when. See `OWNER_FILENAME`. */
export interface RunOwner {
  /** The pid of the SpecWitness process that created the run. */
  readonly pid: number;
  /** When the run recorded that ownership, ISO-8601 UTC from the AD-9 clock. */
  readonly recordedAt: string;
}

/** A newly created run. */
export interface CreatedRun {
  readonly runId: string;
  /** Absolute path to the run directory. Built by `runDir`, never by callers. */
  readonly dir: string;
}

export interface CreateRunOptions {
  /** Canonical epic id under verification, if this run is tied to one. */
  readonly epic?: string | undefined;
}

/**
 * Test seam for the durability path.
 *
 * Real crash durability is OS- and filesystem-dependent and cannot be asserted
 * portably. What can be asserted is that the code takes the fsync path, for
 * both the file and its directory, before `createRun` resolves — which is the
 * part that actually gets broken by a refactor.
 */
export interface RunStoreHooks {
  readonly onFsync?: (target: 'file' | 'directory' | 'runs-root') => void;
}

export class RunStore {
  readonly #projectRoot: string;
  readonly #clock: Clock;
  readonly #ids: Ids;
  readonly #hooks: RunStoreHooks;

  /**
   * Serialises every read-modify-write on this store's files (story 3.2).
   *
   * Appending is inherently read-modify-write, which is the obvious
   * implementation and the obviously wrong one: two in-flight appends both read
   * the same manifest and the second write erases the first. Gates and services
   * start in parallel, so that is the normal case rather than a stress test.
   *
   * A promise chain rather than a lock library, and PER INSTANCE rather than
   * global: one process owns one run. Cross-process serialisation is not
   * attempted and is not needed — two concurrent `specwitness` processes
   * verifying the same project would each create their own run directory.
   */
  #mutations: Promise<unknown> = Promise.resolve();

  constructor(projectRoot: string, clock: Clock, ids: Ids, hooks: RunStoreHooks = {}) {
    this.#projectRoot = projectRoot;
    this.#clock = clock;
    this.#ids = ids;
    this.#hooks = hooks;
  }

  /** `<projectRoot>/.specwitness/runs` — the only root this store touches. */
  get runsRoot(): string {
    return join(this.#projectRoot, SPECWITNESS_DIR, RUNS_DIR);
  }

  /** True when the project has a `.specwitness/` at all (i.e. `init` has run). */
  isInitialized(): boolean {
    return existsSync(join(this.#projectRoot, SPECWITNESS_DIR));
  }

  /**
   * The ONE place a run-directory path is constructed (AD-8).
   *
   * Validates the id first, so a traversal attempt cannot reach `join` through
   * this method or any other method on the store — every path below goes
   * through here. Throws `UsageError` (exit 64) via `parseRunId`, because a
   * malformed id is a bad invocation rather than a broken environment.
   *
   * Pure: never touches the filesystem, so callers can build a path without
   * scaffolding storage as a side effect.
   */
  runDir(runId: string): string {
    parseRunId(runId); // throws UsageError on anything non-canonical
    return join(this.runsRoot, runId);
  }

  /**
   * Creates a run directory with its manifest skeleton, durably.
   *
   * Returns only after the manifest is written AND fsynced — file first, then
   * the containing directory. AC1's "a manifest.json skeleton exists before
   * any resource use" is exactly this ordering: the caller may not create a
   * worktree or spawn a process group until this promise resolves, and once it
   * has, a `kill -9` still leaves a readable record of what to reap.
   */
  async createRun(options: CreateRunOptions = {}): Promise<CreatedRun> {
    const createdAt = this.#clock.now();
    const runId = makeRunId({ now: () => createdAt }, this.#ids);
    const dir = this.runDir(runId);

    // `recursive: true` is idempotent, so a runs root that `specwitness init`
    // already scaffolded is fine (agreed with story 1.4).
    await mkdir(this.runsRoot, { recursive: true });

    try {
      // NOT recursive, and therefore NOT idempotent — this is the collision
      // check. Two runs in the same second with the same 4-char suffix is
      // astronomically unlikely, but silently reusing the directory would let
      // them overwrite each other's evidence, so it fails closed.
      await mkdir(dir);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new InfraError(
          `run directory already exists: ${runId}`,
          'two runs generated the same id in the same second; rerun the command',
        );
      }
      throw new InfraError(
        `could not create the run directory for ${runId}: ${describe(cause)}`,
        `check that ${this.runsRoot} is writable`,
      );
    }

    // OWNERSHIP FIRST, before the manifest exists.
    //
    // The manifest is what makes a run readable to `clean`; a run whose
    // manifest cannot be read is reported rather than reaped. So writing the
    // owner first means there is no instant at which a run is reapable but
    // unprotected. Recording ownership only on first RESOURCE acquisition left
    // exactly that window: `clean` running in it saw a run with no owner and no
    // resources, reaped it, and set `reaped: true` — and the live verifier then
    // appended its first worktree or process group to a reaped manifest that
    // ordinary future cleans skip forever. The same leak the guard exists to
    // prevent, moved earlier in the run.
    //
    // `createdAt` is reused rather than reading the clock again, so run creation
    // still consumes exactly one instant (AD-9 fakes are scripted sequences).
    await this.#recordOwner(runId, createdAt);

    const manifest = newRunManifest({ runId, createdAt, epic: options.epic });
    await this.#writeDurably(dir, MANIFEST_FILENAME, `${JSON.stringify(manifest, null, 2)}\n`);

    // Persist the run directory's OWN entry, which lives in the parent.
    // Syncing `dir` above persists manifest.json's entry within it, but not
    // the fact that `dir` exists — so without this the entire run directory
    // can vanish after a crash even though createRun resolved, leaving
    // `clean` nothing to replay. The whole point of this story is that a
    // kill -9 leaves a readable record; a synced file inside an unsynced
    // directory entry does not provide one.
    await this.#syncDirectory(this.runsRoot, 'runs-root');

    return { runId, dir };
  }

  /**
   * Reads and validates a run's manifest.
   *
   * Pure read: creates nothing, even when the project has no run storage.
   */
  async readManifest(runId: string): Promise<RunManifest> {
    const path = join(this.runDir(runId), MANIFEST_FILENAME);

    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new InfraError(
          `no run found with id ${runId} (looked for ${path})`,
          "run 'specwitness report' with an id from a completed run, or check that you are in the right project",
        );
      }
      throw new InfraError(
        `could not read the run manifest for ${runId}: ${describe(cause)}`,
        `check that ${path} is readable`,
      );
    }

    return parseRunManifest(text, path);
  }

  /**
   * Run ids present on disk, newest first.
   *
   * Newest-first because that is what every caller wants; the compact
   * timestamp makes it a plain string sort with no date parsing.
   *
   * Returns `[]` rather than creating anything when there is no runs root — a
   * read must never scaffold storage. Non-run directories are skipped rather
   * than raised: a stray directory is not this store's business, and refusing
   * to list anything because of one would be worse than ignoring it.
   */
  async listRuns(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.runsRoot, { withFileTypes: true });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw new InfraError(
        `could not list runs: ${describe(cause)}`,
        `check that ${this.runsRoot} is readable`,
      );
    }

    return entries
      .filter((entry) => entry.isDirectory() && isRunId(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  }

  /**
   * Whether a run has a stored `result.json` yet.
   *
   * Story 3.5 writes that file; 1.6 only needs to tell the user whether a run
   * has results to render.
   */
  async hasResult(runId: string): Promise<boolean> {
    const path = join(this.runDir(runId), RESULT_FILENAME);
    try {
      await stat(path);
      return true;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      // ONLY "it is not there" means false. An unreadable directory (EACCES),
      // an I/O error (EIO), or a run directory that is not a directory
      // (ENOTDIR) are infrastructure failures — swallowing them would make
      // `report` exit 0 claiming the run has no result, which is precisely
      // the kind of infra-failure-as-product-answer this project treats as a
      // first-order defect.
      if (code === 'ENOENT') {
        return false;
      }
      throw new InfraError(
        `could not check for a stored result of ${runId}: ${describe(cause)}`,
        `check that ${path} and its directory are readable`,
      );
    }
  }

  /**
   * AD-8 discipline 2 — the ATOMIC FINALIZE for `result.json` (story 3.5).
   *
   * A half-written result is worse than none: `report` would render a partial verdict
   * as though it were complete. `#writeDurably` stages into the same directory, fsyncs,
   * renames and then fsyncs the directory, so a reader sees either the previous complete
   * document or the new complete one — never a mix. That is the whole mechanism, and it
   * is reused rather than reimplemented: a second write path is how two implementations
   * of "publish a file" end up disagreeing about atomicity.
   *
   * CALLED TWICE PER RUN, deliberately. The `persist` stage (position 10 of 11) writes
   * the crash-durable snapshot that survives a kill during teardown; `onComplete` writes
   * the finished document afterwards, with teardown's timeline entry and the real
   * `finishedAt`. One writer, one serializer, two moments — and the second overwrite is
   * atomic for the same reason the first is.
   *
   * ON A POST-RENAME FAILURE — the shape this story was told not to repeat (Epic 2 retro
   * §5a defect (ii)). Once the rename has published the document, a failed durability
   * barrier is NOT a failed write, and this method does not report it as one: it resolves
   * with `{durable: false}` and the barrier's message. Whether the rename happened is
   * settled by READING THE TARGET BACK, not by inferring it from an error class that
   * covers both cases.
   *
   * Story 3.2 makes the same failure fatal for `manifest.json`, deliberately and
   * correctly: that record is a PRECONDITION — a worktree is about to be created on the
   * strength of it. A run result is a published CONCLUSION with nothing downstream acting
   * on its fsync, so it sits with `src/authoring/contract-file.ts` instead. Three sites,
   * one rule — never describe a committed write as a failed one — and two different
   * fatality choices, each made knowingly.
   *
   * The bytes come from `serializeRunResult`, the one `RunResult` → bytes function in the
   * repository (`src/schemas/result.ts`). `--json` renders through that same function, so
   * stdout and this file are byte-identical by construction (Q53) rather than by two code
   * paths agreeing.
   */
  async writeResult(runId: string, result: RunResult): Promise<FinalizeReport> {
    // `runDir` validates the id before joining, so a traversal cannot reach the
    // filesystem through this method any more than through the others.
    const dir = this.runDir(runId);
    const contents = serializeRunResult(result);

    try {
      await this.#writeDurably(dir, RESULT_FILENAME, contents);
      return { durable: true };
    } catch (cause) {
      // DID THE RENAME ALREADY HAPPEN? That is the whole question, and it is answered by
      // LOOKING rather than by inferring from the error. `#writeDurably` raises the same
      // class for a staging failure and for a post-rename barrier failure, and sniffing
      // its message would couple this method to another story's wording.
      //
      // Reading the target back is exact: if it now holds the bytes we meant to publish,
      // the rename committed and only the barrier did not. (If the previous document
      // happened to be byte-identical, this reports committed — which is true in the only
      // sense that matters, since the file on disk is already what we wanted it to be.)
      if (!(await this.#holdsExactly(join(dir, RESULT_FILENAME), contents))) {
        throw cause;
      }

      return { durable: false, barrier: describe(cause) };
    }
  }

  /** True when `path` currently holds exactly `contents`. Any read failure means "no". */
  async #holdsExactly(path: string, contents: string): Promise<boolean> {
    try {
      return (await readFile(path, 'utf8')) === contents;
    } catch {
      return false;
    }
  }

  /**
   * Reads a stored result, validated, WITH the file's own bytes.
   *
   * Both halves are returned on purpose. The document is what a renderer needs; the raw
   * text is what `specwitness report --json` writes to stdout, verbatim.
   *
   * IT MUST BE THE FILE'S BYTES AND NOT A RE-SERIALIZATION. zod rebuilds a validated
   * object in schema declaration order, which is not the order the domain's evidence
   * constructors build their members in — so `serializeRunResult(parsed)` carries the same
   * VALUES as the file and a different byte sequence. Echoing the stored text is what
   * makes `report --json` byte-equal to `result.json` by construction, rather than only
   * while two independent key orderings happen to agree.
   *
   * Pure read: creates nothing, even in a project that has never been initialised.
   */
  async readResult(runId: string): Promise<StoredResult> {
    const path = join(this.runDir(runId), RESULT_FILENAME);

    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new InfraError(
          `run ${runId} has no stored result (looked for ${path})`,
          "the run ended before persisting; 'specwitness report <run-id>' shows its metadata, and 'specwitness clean' reaps anything it left behind",
        );
      }
      throw new InfraError(
        `could not read the stored result of ${runId}: ${describe(cause)}`,
        `check that ${path} is readable`,
      );
    }

    return { document: parseRunResult(text, path), text, path };
  }


  /**
   * Records a worktree path, durably, BEFORE the worktree is created (AD-8).
   *
   * Story 3.1 calls this immediately before `git worktree add`, so a `kill -9`
   * in between leaves a readable record of a directory that may or may not
   * exist — which is recoverable, because removing an absent worktree is a
   * no-op. The opposite ordering is not recoverable: a worktree nothing on disk
   * knows about is a leak `clean` can never find.
   *
   * Idempotent. Recording the same path twice keeps ONE entry and costs no
   * second fsync, because `clean` and a retrying pipeline both replay.
   */
  async recordWorktree(runId: string, worktreePath: string): Promise<void> {
    await this.#serialize(async () => {
      await this.#recordOwner(runId, this.#clock.now());
      await this.#updateManifest(runId, (manifest) =>
        manifest.worktrees.includes(worktreePath)
          ? null
          : { ...manifest, worktrees: [...manifest.worktrees, worktreePath] },
      );
    });
  }

  /**
   * Records a process-group id, durably, BEFORE the run observes the child.
   *
   * Pass this as `ProcessRunOptions.onProcessGroup`; the runner awaits it before
   * anything can observe the process, which is AC1's ordering.
   *
   * HONEST ABOUT THE ORDERING: a pgid cannot exist before `fork`, so the true
   * sequence is spawn → learn the pgid → fsync → let the run proceed. The child
   * is ALREADY RUNNING while this fsync happens and may fork children of its
   * own in that window — observed, not theorised. What is guaranteed is that
   * the record is durable before anything acts on the run. Claiming an ordering
   * the OS does not offer would be worse than naming the window.
   *
   * The reaping evidence is written FIRST, then the manifest. Crash between the
   * two and the manifest simply has no pgid — nothing claims a resource that
   * cannot be verified. The reverse order would leave `clean` with a pgid it
   * must refuse to signal.
   */
  async recordProcessGroup(runId: string, pgid: number): Promise<void> {
    // ONE serialized operation covering BOTH writes, not two in a row, so no
    // reader or writer can observe a half-recorded process group: every pgid
    // the manifest claims has its evidence already on disk, which is the
    // invariant `clean` leans on (a pgid without evidence is one it must refuse
    // to signal).
    //
    // Honest about the limit, since it was raised as preventing more than it
    // does: grouping does NOT stop `markReaped` running entirely after this and
    // leaving `reaped: true` over a freshly recorded live group. Whether a run
    // is marked reaped while it is still acquiring resources is a CALLER
    // ordering question and nothing here can decide it.
    await this.#serialize(async () => {
      await this.#recordOwner(runId, this.#clock.now());
      await this.#recordProcessGroupEvidence(runId, pgid);
      await this.#updateManifest(runId, (manifest) =>
        manifest.processGroups.includes(pgid)
          ? null
          : { ...manifest, processGroups: [...manifest.processGroups, pgid] },
      );
    });
  }

  /**
   * Marks a run's resources reaped. Idempotent.
   *
   * "Reaped" is about RESOURCES, never results (Q51): the run directory, its
   * evidence and its `result.json` all survive. V0 keeps every run, and the
   * dogfooding data Epic 7 exists to collect is precisely what a retention
   * policy would delete.
   */
  async markReaped(runId: string): Promise<void> {
    await this.#serialize(async () => {
      await this.#updateManifest(runId, (manifest) =>
        manifest.reaped ? null : { ...manifest, reaped: true },
      );
    });
  }

  /**
   * Which process owns this run, or `null` when it never acquired a resource.
   *
   * A missing file is not an error: a run that recorded nothing has nothing to
   * reap and nothing to protect. An unreadable one IS an error, because
   * treating it as absent would let `clean` reap a live run.
   */
  async readOwner(runId: string): Promise<RunOwner | null> {
    const path = join(this.runDir(runId), OWNER_FILENAME);

    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw new InfraError(
        `could not read the owner record for ${runId}: ${describe(cause)}`,
        `check that ${path} is readable`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new InfraError(
        `owner record is not valid JSON: ${path}`,
        'the file is corrupt, so SpecWitness cannot tell whether this run is still going; inspect it before reaping the run by hand',
      );
    }

    const record = parsed as { pid?: unknown; recordedAt?: unknown };

    // VALIDATED, not merely type-checked, because this record decides whether
    // `clean` may signal anything. A type-compatible but meaningless value
    // fails the guard OPEN, which is exactly backwards: a `recordedAt` of
    // "yesterday" parses to `Invalid Date`, every comparison against it is
    // false, the live verifier stops looking like the owner, and `clean`
    // terminates the process groups of a run that is still going. The whole
    // point of this file is that a doubtful answer means "leave it alone".
    const pidIsValid = typeof record.pid === 'number' && Number.isInteger(record.pid) && record.pid > 0;
    // Validated with the SHARED house validator from `src/schemas/manifest.ts`,
    // not a second copy. Story 3.5 exported it for exactly this reason and the
    // note there is right: two date validators in one codebase drift, and the
    // way they drift is that one starts accepting `2026-02-31T…`, which
    // JavaScript normalises to 3 March.
    //
    // Why anything stricter than `Date.parse` is needed here at all: this is a
    // SAFETY record. `Date.parse` accepts `"0"` (the year 2000), `"2026"` and
    // `"Mon Aug 31"`, and an accepted-but-meaningless old date makes the
    // genuine live owner's start time look NEWER than the record — so `clean`
    // decides the run has crashed and terminates the resources of a
    // verification that is still going. The guard would fail OPEN on exactly
    // the corruption it exists to catch.
    const recordedAtIsValid =
      typeof record.recordedAt === 'string' && IsoUtcTimestamp.safeParse(record.recordedAt).success;

    if (!pidIsValid || !recordedAtIsValid) {
      throw new InfraError(
        `owner record is malformed: ${path}`,
        'expected an object with a positive integer pid and an ISO-8601 UTC recordedAt (YYYY-MM-DDTHH:MM:SS.mmmZ); SpecWitness will not reap a run whose ownership it cannot read',
      );
    }

    return { pid: record.pid as number, recordedAt: record.recordedAt as string };
  }

  /**
   * Records this process as the run's owner, once, at run CREATION.
   *
   * Also called from each acquisition path, where it is a no-op for any run
   * created by this build — kept so a run directory created by an older one
   * still gains an owner the first time it acquires something, rather than
   * staying unprotected for its whole life.
   *
   * Written before the resource it protects, like everything else here: if the
   * process dies between this and the pgid append, `clean` sees an owner that is
   * gone and reaps normally, which is correct. The reverse order would leave a
   * window in which a live run looks crashed.
   *
   * NOT serialized here — its callers hold the queue, and `createRun` runs
   * before any queue exists for this run. See `#updateManifest`.
   */
  async #recordOwner(runId: string, recordedAt: Date): Promise<void> {
    const path = join(this.runDir(runId), OWNER_FILENAME);
    try {
      await stat(path);
      return; // already recorded; ownership does not change mid-run
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new InfraError(
          `could not check the owner record for ${runId}: ${describe(cause)}`,
          `check that ${path} is readable`,
        );
      }
    }

    const owner: RunOwner = {
      pid: process.pid,
      recordedAt: recordedAt.toISOString(),
    };
    await this.#writeDurably(
      this.runDir(runId),
      OWNER_FILENAME,
      `${JSON.stringify(owner, null, 2)}\n`,
    );
  }

  /**
   * The recorded-at instant for each pgid of a run — `clean`'s identity proof.
   *
   * Returns an empty map when no pgid was ever recorded. Throws `InfraError`
   * naming the path when the evidence exists but cannot be read: silently
   * treating corruption as "no evidence" would turn a manifest full of live
   * process groups into a clean-looking run.
   */
  async readProcessGroupRecords(runId: string): Promise<ReadonlyMap<number, string>> {
    const path = join(this.runDir(runId), PROCESS_GROUPS_FILENAME);

    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        return new Map();
      }
      throw new InfraError(
        `could not read the process-group record for ${runId}: ${describe(cause)}`,
        `check that ${path} is readable`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new InfraError(
        `process-group record is not valid JSON: ${path}`,
        'the file is corrupt, so the process groups this run recorded cannot be verified; inspect them with `ps` before killing anything by hand',
      );
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new InfraError(
        `process-group record is malformed: ${path}`,
        'expected an object mapping process-group ids to the instant each was recorded',
      );
    }

    const records = new Map<number, string>();
    for (const [key, value] of Object.entries(parsed)) {
      const pgid = Number(key);
      if (Number.isInteger(pgid) && typeof value === 'string') {
        records.set(pgid, value);
      }
    }
    return records;
  }

  /**
   * Writes one evidence file into a run directory and returns its RELATIVE path.
   *
   * The seam stories 3.4 and 3.5 asked for during intent-sync, landed here in
   * wave A so two wave-B stories do not collide in this file. The return value
   * goes straight into an `EvidenceRef` (Q48), and it is structurally incapable
   * of being absolute.
   *
   * CONTAINMENT IS THE POINT. `relativeName` ultimately derives from a gate id
   * in the operator's own config, which the merged schema constrains only to
   * "non-empty" — so a `..` really can arrive here. Escape is refused with the
   * offending name in the message rather than sanitised silently, because a
   * caller that hands this a dot-dot has a bug worth seeing. Nested names are
   * fine and their parent directories are created.
   */
  async writeEvidenceFile(runId: string, relativeName: string, contents: string): Promise<string> {
    return await this.#writeEvidence(runId, relativeName, contents);
  }

  /**
   * Writes one BINARY evidence file into a run directory and returns its RELATIVE
   * path. Story 5.2.
   *
   * The twin of `writeEvidenceFile`, sharing every containment, symlink-refusal and
   * durability guarantee with it - literally the same private implementation, differing
   * only in what reaches the file handle.
   *
   * IT EXISTS BECAUSE A TRACE IS A ZIP AND A SCREENSHOT IS A PNG. Story 5.2's AC1
   * requires both stored as evidence (Q32), and the text writer encodes as UTF-8, so
   * routing them through it would store an artifact of roughly the right size and
   * entirely the wrong bytes, which no trace viewer can open. Base64 was the alternative
   * and was rejected for the same reason: evidence a human cannot open is not evidence.
   *
   * IT IS ALSO WHY AD-8 SURVIVES CONTACT WITH PLAYWRIGHT. `RunStore` is the sole writer
   * beneath `.specwitness/runs/`, and a subprocess writing its own artifacts there is
   * exactly what that forbids - so the browser executor points Playwright at a temporary
   * directory outside the run and copies the bytes in through here.
   */
  async writeEvidenceBytes(
    runId: string,
    relativeName: string,
    contents: Uint8Array,
  ): Promise<string> {
    return await this.#writeEvidence(runId, relativeName, contents);
  }

  async #writeEvidence(
    runId: string,
    relativeName: string,
    contents: string | Uint8Array,
  ): Promise<string> {
    return this.#serialize(async () => {
      const dir = this.runDir(runId);
      const contained = this.#containedPath(dir, relativeName);
      const parent = dirname(contained.absolute);

      // Creates the parent directories, refusing at the first symlinked
      // component INSTEAD of creating through it. See the method below for why
      // the check cannot come afterwards.
      await this.#createContainedDirectory(dir, parent, relativeName);
      // Belt and braces, and cheap: prove the parent really resolves inside.
      await this.#assertResolvesInside(dir, parent, relativeName);

      await this.#writeDurably(parent, basename(contained.absolute), contents);

      return contained.relative;
    });
  }

  /**
   * Creates the parent directories of an evidence file WITHOUT ever descending
   * through a symlink.
   *
   * The obvious implementation — `mkdir(parent, {recursive: true})` and then
   * check where it landed — is wrong, and subtly so: for a name like
   * `linked/new/out.txt` where `linked` already points outside the run
   * directory, the recursive `mkdir` has CREATED `new` outside before any check
   * runs. Rejecting afterwards leaves the mutation behind. A containment
   * guarantee that only holds after the fact is not a containment guarantee.
   *
   * So each component is inspected before it is descended into: an existing
   * symlink is refused, an existing non-directory is refused, and a missing one
   * is created non-recursively — which cannot itself be a symlink, because this
   * is what just made it.
   *
   * HONEST LIMIT: this narrows but cannot close a TOCTOU race, since another
   * process could replace a component between the `lstat` and the `mkdir`.
   * Closing it entirely needs `openat`-style relative descent, which Node does
   * not expose. The realpath check that follows would still catch the result,
   * and the threat model is someone who already has write access inside
   * `.specwitness/runs/`.
   */
  async #createContainedDirectory(
    dir: string,
    parent: string,
    relativeName: string,
  ): Promise<void> {
    const segments = relative(dir, parent)
      .split(sep)
      .filter((segment) => segment.length > 0);

    let current = dir;
    for (const segment of segments) {
      const next = join(current, segment);
      const info = await lstat(next).catch(() => null);

      if (info === null) {
        try {
          await mkdir(next);
        } catch (cause) {
          throw new InfraError(
            `could not create the evidence directory for '${relativeName}': ${describe(cause)}`,
            'check free space and permissions on the run directory',
          );
        }
      } else if (info.isSymbolicLink()) {
        throw new InfraError(
          `refusing to write evidence to '${relativeName}': '${segment}' is a symbolic link`,
          'SpecWitness writes only inside the run directory, and will not follow a link out of it',
        );
      } else if (!info.isDirectory()) {
        throw new InfraError(
          `refusing to write evidence to '${relativeName}': '${segment}' exists and is not a directory`,
          'choose an evidence name whose parent directories are directories',
        );
      }

      current = next;
    }
  }

  /**
   * Fails unless `candidate` really lives inside `dir` once symlinks are
   * resolved.
   *
   * `realpath` on BOTH sides, because the run directory itself is commonly
   * reached through one — `os.tmpdir()` on macOS is `/var/folders/...`, a
   * symlink into `/private/var/...` — so resolving only one side would reject
   * every legitimate write on this platform.
   */
  async #assertResolvesInside(dir: string, candidate: string, relativeName: string): Promise<void> {
    let resolvedRoot: string;
    let resolvedCandidate: string;
    try {
      resolvedRoot = await realpath(dir);
      resolvedCandidate = await realpath(candidate);
    } catch (cause) {
      throw new InfraError(
        `could not verify that '${relativeName}' stays inside the run directory: ${describe(cause)}`,
        'check permissions on the run directory',
      );
    }

    if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)) {
      throw new InfraError(
        `refusing to write evidence to '${relativeName}': it resolves outside the run directory through a symbolic link`,
        'a component of that path links outside the run directory; SpecWitness writes only inside it',
      );
    }
  }

  /**
   * Resolves `relativeName` inside `dir`, refusing anything that leaves it.
   *
   * `resolve` + a prefix test rather than string inspection of the input: a
   * blacklist of `..` sequences is defeated by encodings and by symlink-free
   * paths that normalise outward, while asking the path module where the name
   * actually lands is not.
   */
  #containedPath(dir: string, relativeName: string): { absolute: string; relative: string } {
    const reject = (why: string): never => {
      throw new InfraError(
        `refusing to write evidence to '${relativeName}': ${why}`,
        'evidence file names are relative to the run directory and may not escape it or replace a file SpecWitness owns',
      );
    };

    if (relativeName.length === 0) {
      return reject('the name is empty');
    }
    if (isAbsolute(relativeName)) {
      return reject('it is an absolute path');
    }

    const absolute = resolve(dir, relativeName);
    if (absolute === dir || !absolute.startsWith(`${dir}${sep}`)) {
      return reject('it resolves outside the run directory');
    }

    const rel = relative(dir, absolute);
    if (RESERVED_FILENAMES.has(rel)) {
      return reject('that file belongs to SpecWitness');
    }
    // `#writeDurably` stages every write as `.<filename>.writing` in the target
    // directory. An evidence name landing on one could be renamed over the
    // manifest by a concurrent append, which is the same substitution rambo
    // identified for story 3.5's staging name — later, and looking like a
    // normal successful write.
    if (basename(rel).startsWith('.') && basename(rel).endsWith('.writing')) {
      return reject('that name is reserved for in-progress SpecWitness writes');
    }

    return { absolute, relative: rel };
  }

  /**
   * Reads a run's manifest, applies `mutate`, and writes it back durably.
   *
   * `mutate` returns `null` when nothing changed, and then nothing is written:
   * idempotence is not only about deduplicating entries, it is about not paying
   * an fsync per redundant append on a busy run.
   *
   * Serialised through `#mutations` so two concurrent appends cannot both read
   * the pre-append manifest and lose one of the entries. Reuses `#writeDurably`
   * rather than inventing a second write path — one durability discipline, one
   * place to get it wrong.
   */
  async #updateManifest(
    runId: string,
    mutate: (manifest: RunManifest) => RunManifest | null,
  ): Promise<void> {
    // NOT serialized here: every caller already holds the queue, and taking it
    // again from inside would deadlock on a chain waiting for itself. The
    // serialization boundary is the PUBLIC method, so that a method performing
    // two writes performs them as one indivisible fact.
    const manifest = await this.readManifest(runId);
    const next = mutate(manifest);
    if (next === null) {
      return;
    }
    await this.#writeDurably(
      this.runDir(runId),
      MANIFEST_FILENAME,
      `${JSON.stringify(next, null, 2)}\n`,
    );
  }

  /**
   * Adds one pgid to the reaping-evidence file, durably.
   *
   * NOT serialized here — see `#updateManifest`. Its caller holds the queue for
   * both writes together.
   */
  async #recordProcessGroupEvidence(runId: string, pgid: number): Promise<void> {
    const recordedAt = this.#clock.now().toISOString();

    const existing = await this.readProcessGroupRecords(runId);
    if (existing.has(pgid)) {
      return;
    }

    const merged: Record<string, string> = {};
    for (const [key, value] of existing) {
      merged[String(key)] = value;
    }
    merged[String(pgid)] = recordedAt;

    await this.#writeDurably(
      this.runDir(runId),
      PROCESS_GROUPS_FILENAME,
      `${JSON.stringify(merged, null, 2)}\n`,
    );
  }

  /**
   * Runs `work` after every previously queued mutation, whatever their outcome.
   *
   * A rejected mutation must not poison the queue: one failed append would
   * otherwise make every later append reject with an unrelated error, which is
   * how a single unlucky write turns into a run that cannot record anything.
   */
  async #serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#mutations.then(work, work);
    this.#mutations = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Writes a file durably, REPLACING any previous version atomically.
   *
   * Two properties, and the second was a defect until story 3.2 fixed it.
   *
   * 1. The directory fsync is not optional and is the step most often missed:
   *    fsyncing a file guarantees its CONTENTS survive a crash, but not that
   *    its name still appears in the directory. Without the second sync a run
   *    can come back from a crash as an empty directory — the exact case
   *    `specwitness clean` cannot recover from, because there is nothing left
   *    to tell it what to reap.
   *
   * 2. STAGE AND RENAME rather than `open(path, 'w')`. Truncating is harmless
   *    for a file being created, which is all story 1.6 ever did with this —
   *    but story 3.2 turned this into the path that REWRITES an existing
   *    manifest on every append, and truncation destroys the only recovery
   *    record before the replacement exists. A `kill -9` in that window leaves
   *    malformed JSON, so `clean` can no longer discover the process groups and
   *    worktrees the run had already recorded. That is precisely the crash this
   *    manifest exists for, so the write it uses may not have a window in which
   *    the record is unreadable. A reader now sees either the previous complete
   *    file or the new complete one.
   *
   * Note for story 3.5: this is NOT the atomic `result.json` finalize reserved
   * for you. That one is about publishing a completed document under its final
   * name; this is the manifest's own append discipline. The staging names do
   * not collide (`.<filename>.writing` here, `.result.json.tmp` there).
   */
  async #writeDurably(
    dir: string,
    filename: string,
    contents: string | Uint8Array,
  ): Promise<void> {
    const path = join(dir, filename);
    const staging = join(dir, `.${filename}.writing`);

    try {
      const file = await open(staging, 'w');
      try {
        // `'utf8'` FOR TEXT ONLY. Story 5.2 added the byte path because a Playwright
        // trace is a `.zip` and a screenshot is a `.png`, and encoding either as UTF-8
        // replaces every byte outside the ASCII range with U+FFFD - producing a file of
        // the right name and the wrong contents, which is worse than no artifact at all,
        // because a reference to it looks exactly like a reference to a good one.
        // A `Uint8Array` is written verbatim; a string keeps the encoding every caller
        // before 5.2 relied on.
        if (typeof contents === 'string') {
          await file.writeFile(contents, 'utf8');
        } else {
          await file.writeFile(contents);
        }
        await file.sync();
        this.#hooks.onFsync?.('file');
      } finally {
        await file.close();
      }

      // POSIX rename is atomic within a filesystem, and staging inside the
      // SAME directory is what keeps it so — a cross-filesystem rename is a
      // copy, which would reintroduce the window this exists to close.
      await rename(staging, path);
    } catch (cause) {
      // Leave no half-written staging file behind for `clean` or an operator to
      // puzzle over. Best-effort: the original error is what matters.
      await rm(staging, { force: true }).catch(() => undefined);
      // Never report a durability failure as success: the caller is about to
      // create a worktree on the strength of this manifest existing.
      throw new InfraError(
        `could not durably write ${path}: ${describe(cause)}`,
        'check free space and permissions on the run directory',
      );
    }

    // PAST THE POINT OF NO RETURN, and deliberately OUTSIDE the catch above.
    //
    // The rename has published the file. If the directory fsync then fails,
    // saying "could not durably write <path>" would be false: the write did
    // happen, and a caller told otherwise might retry or abandon a run whose
    // record is already on disk. That is Epic 2 retro §5a defect (ii) — the
    // same mistake `src/authoring/contract-file.ts` makes today, which the
    // owner assigned to story 3.7 — and adding the rename above is what would
    // have imported it into this shared helper. Caught by rambo (3.5) reading
    // the branch before building on it.
    //
    // `#syncDirectory` raises its own accurate message ("could not make <dir>
    // durable"), and it stays an ERROR rather than a warning: AC1's guarantee is
    // that the record is durable before the resource is used, and an unflushed
    // directory entry means it is not. Failing closed is right; describing the
    // failure wrongly is not.
    await this.#syncDirectory(dir, 'directory');
  }

  /**
   * Fsyncs a directory so its entries are durable.
   *
   * Directories are opened read-only to sync them. Some filesystems do not
   * support the operation and report EINVAL; that is not a durability failure
   * on those platforms, so it is tolerated rather than turned into an error
   * that would fail a run for no reason. Every other failure propagates.
   */
  async #syncDirectory(path: string, label: 'directory' | 'runs-root'): Promise<void> {
    let handle;
    try {
      handle = await open(path, 'r');
    } catch (cause) {
      throw new InfraError(
        `could not open ${path} to make its contents durable: ${describe(cause)}`,
        'check permissions on the run directory',
      );
    }

    try {
      await handle.sync();
      this.#hooks.onFsync?.(label);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EINVAL') {
        // Filesystem does not implement directory fsync. Nothing to do, and
        // nothing gained by failing the run over it.
        this.#hooks.onFsync?.(label);
        return;
      }
      throw new InfraError(
        `could not make ${path} durable: ${describe(cause)}`,
        'check free space and permissions on the run directory',
      );
    } finally {
      await handle.close();
    }
  }
}

/** Best-effort message from an unknown thrown value, for error text. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
