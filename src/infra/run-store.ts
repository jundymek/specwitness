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
 */

import { existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

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
  readonly onFsync?: (target: 'file' | 'directory') => void;
}

export class RunStore {
  readonly #projectRoot: string;
  readonly #clock: Clock;
  readonly #ids: Ids;
  readonly #hooks: RunStoreHooks;

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
    try {
      await stat(join(this.runDir(runId), RESULT_FILENAME));
      return true;
    } catch {
      return false;
    }
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

      // Directories are opened read-only to fsync them; this is a no-op on
      // filesystems that do not need it and harmless where it is unsupported.
      const handle = await open(dir, 'r');
      try {
        await handle.sync();
        this.#hooks.onFsync?.('directory');
      } finally {
        await handle.close();
      }
    } catch (cause) {
      // Never report a durability failure as success: the caller is about to
      // create a worktree on the strength of this manifest existing.
      throw new InfraError(
        `could not durably write ${path}: ${describe(cause)}`,
        'check free space and permissions on the run directory',
      );
    }
  }
}

/** Best-effort message from an unknown thrown value, for error text. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
