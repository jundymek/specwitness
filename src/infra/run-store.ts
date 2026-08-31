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
 *  2. **Atomic finalize (stage-and-rename)** for `result.json`. Deliberately
 *     NOT implemented here: its consumer arrives in story 3.5, and building a
 *     write discipline ahead of any caller means guessing at requirements
 *     nobody has stated yet. `RunStore` grows it in 3.2/3.5.
 *
 * Layering: this is `src/infra`, so `node:fs` is legal here and nowhere in
 * `src/domain` or `src/schemas` (dependency-cruiser enforces it). Time and
 * randomness arrive through the AD-9 ports rather than being read directly.
 *
 * WHAT STORY 3.2 ADDED, so story 3.5 can rebase over it knowingly:
 * `recordWorktree`, `recordProcessGroup`, `markReaped`, `readProcessGroupRecords`
 * and `writeEvidenceFile`, plus one private mutation queue and one private
 * manifest-update helper that reuses `#writeDurably`. Nothing existing moved:
 * `createRun`, `readManifest`, `listRuns`, `hasResult`, `runDir`,
 * `#writeDurably` and `#syncDirectory` are byte-for-byte what story 1.6 wrote.
 * Discipline 2 — atomic stage-and-rename for `result.json` — is STILL not
 * implemented here and is still story 3.5's, by name.
 */

import { existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { InfraError } from '../domain/errors.js';
import type { Clock, Ids } from '../domain/ports.js';
import { isRunId, makeRunId, parseRunId } from '../domain/run-id.js';
import {
  MANIFEST_FILENAME,
  newRunManifest,
  parseRunManifest,
  type RunManifest,
} from '../schemas/manifest.js';

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
 * Files `RunStore` owns, which caller-named evidence may never overwrite.
 *
 * `writeEvidenceFile` takes a name chosen by a caller — ultimately derived from
 * a gate id in the operator's own config — and the crash record must not be
 * clobberable by an unlucky one.
 */
const RESERVED_FILENAMES: ReadonlySet<string> = new Set([
  MANIFEST_FILENAME,
  RESULT_FILENAME,
  PROCESS_GROUPS_FILENAME,
]);

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
    await this.#updateManifest(runId, (manifest) =>
      manifest.worktrees.includes(worktreePath)
        ? null
        : { ...manifest, worktrees: [...manifest.worktrees, worktreePath] },
    );
  }

  /**
   * Records a process-group id, durably, BEFORE the run observes the child.
   *
   * Pass this as `ProcessRunOptions.onProcessGroup`; the runner awaits it before
   * anything can observe the process, which is AC1's ordering.
   *
   * HONEST ABOUT THE ORDERING: a pgid cannot exist before `fork`, so the true
   * sequence is spawn → learn the pgid → fsync → use the child, and the residual
   * window is one spawn syscall wide. Claiming an ordering the OS does not offer
   * would be worse than naming the window.
   *
   * The reaping evidence is written FIRST, then the manifest. Crash between the
   * two and the manifest simply has no pgid — nothing claims a resource that
   * cannot be verified. The reverse order would leave `clean` with a pgid it
   * must refuse to signal.
   */
  async recordProcessGroup(runId: string, pgid: number): Promise<void> {
    await this.#recordProcessGroupEvidence(runId, pgid);
    await this.#updateManifest(runId, (manifest) =>
      manifest.processGroups.includes(pgid)
        ? null
        : { ...manifest, processGroups: [...manifest.processGroups, pgid] },
    );
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
    await this.#updateManifest(runId, (manifest) =>
      manifest.reaped ? null : { ...manifest, reaped: true },
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
    const dir = this.runDir(runId);
    const contained = this.#containedPath(dir, relativeName);

    await mkdir(dirname(contained.absolute), { recursive: true });
    await this.#writeDurably(dirname(contained.absolute), basename(contained.absolute), contents);

    return contained.relative;
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
    await this.#serialize(async () => {
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
    });
  }

  /** Adds one pgid to the reaping-evidence file, durably. Serialised. */
  async #recordProcessGroupEvidence(runId: string, pgid: number): Promise<void> {
    const recordedAt = this.#clock.now().toISOString();

    await this.#serialize(async () => {
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
    });
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
   * Writes a file and fsyncs it, then fsyncs its directory.
   *
   * The directory fsync is not optional and is the step most often missed:
   * fsyncing a file guarantees its CONTENTS survive a crash, but not that its
   * name still appears in the directory. Without the second sync a run can
   * come back from a crash as an empty directory — the exact case story 3.2's
   * cleanup cannot recover from, because there is nothing left to tell it what
   * to reap.
   */
  async #writeDurably(dir: string, filename: string, contents: string): Promise<void> {
    const path = join(dir, filename);

    try {
      const file = await open(path, 'w');
      try {
        await file.writeFile(contents, 'utf8');
        await file.sync();
        this.#hooks.onFsync?.('file');
      } finally {
        await file.close();
      }

      await this.#syncDirectory(dir, 'directory');
    } catch (cause) {
      // Never report a durability failure as success: the caller is about to
      // create a worktree on the strength of this manifest existing.
      throw new InfraError(
        `could not durably write ${path}: ${describe(cause)}`,
        'check free space and permissions on the run directory',
      );
    }
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
