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
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { InfraError } from '../domain/errors.js';
import type { Clock, Ids } from '../domain/ports.js';
import type { RunResult } from '../domain/run-result.js';
import { isRunId, makeRunId, parseRunId } from '../domain/run-id.js';
import {
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
]);

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
   * ON A POST-RENAME FAILURE. `#writeDurably` publishes the file, then fsyncs the
   * directory OUTSIDE its catch, so a barrier failure raises `#syncDirectory`'s own
   * accurate message rather than claiming the write did not happen. That distinction is
   * Epic 2 retro §5a defect (ii) — the shape this story was told not to repeat — and it
   * is settled the same way in all three of this epic's stage-and-rename sites. The
   * failure stays an ERROR here rather than a warning, because the entire point of
   * persisting is that the run survives the crash it was written for; it is recorded on
   * the `persist` timeline entry and NEVER rewrites the verdict.
   *
   * The bytes come from `serializeRunResult`, the one `RunResult` → bytes function in the
   * repository (`src/schemas/result.ts`). `--json` renders through that same function, so
   * stdout and this file are byte-identical by construction (Q53) rather than by two code
   * paths agreeing.
   */
  async writeResult(runId: string, result: RunResult): Promise<void> {
    // `runDir` validates the id before joining, so a traversal cannot reach the
    // filesystem through this method any more than through the others.
    const dir = this.runDir(runId);
    await this.#writeDurably(dir, RESULT_FILENAME, serializeRunResult(result));
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
    return this.#serialize(async () => {
      const dir = this.runDir(runId);
      const contained = this.#containedPath(dir, relativeName);
      const parent = dirname(contained.absolute);

      await mkdir(parent, { recursive: true });
      // The lexical check above proves the NAME cannot escape. It does not
      // prove the PATH cannot: a component inside the run directory could be a
      // symlink pointing elsewhere, and `mkdir`/`open` follow symlinks happily.
      // So the resolved parent is checked against the resolved run directory
      // after the directories exist — the only point at which the question can
      // actually be answered.
      await this.#assertResolvesInside(dir, parent, relativeName);

      await this.#writeDurably(parent, basename(contained.absolute), contents);

      return contained.relative;
    });
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
  async #writeDurably(dir: string, filename: string, contents: string): Promise<void> {
    const path = join(dir, filename);
    const staging = join(dir, `.${filename}.writing`);

    try {
      const file = await open(staging, 'w');
      try {
        await file.writeFile(contents, 'utf8');
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
