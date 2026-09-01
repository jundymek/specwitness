/**
 * The SOLE writer of `.specwitness/plans/<epic>.yaml` (AD-5).
 *
 * The same rule, for the same reason, as `contract-file.ts` is for `contracts/` and
 * `RunStore` is for `runs/`: a path built in five places is a path written inconsistently
 * in the sixth. Story 4.7 auto-compiles a plan from inside `verify`; when it does, it routes
 * its write through `writePlanFileAtomically` rather than adding a second writer.
 *
 * WHY STAGE-AND-RENAME. `rename(2)` within a directory is atomic: a reader sees either the
 * whole old file or the whole new one, never a prefix. Writing in place means an
 * interrupted compilation — Ctrl-C, a full disk, a killed process — leaves a truncated YAML
 * document, and for a plan that is worse than for a contract: a half-written plan either
 * fails to parse or, if the truncation lands on a criterion boundary, parses into a plan
 * that silently verifies FEWER criteria than the contract requires. The temp file is created
 * in the SAME directory so the rename never crosses a filesystem boundary.
 *
 * PARSING IS NOT HERE. This module moves text; `parsePlan` / `serializePlan`
 * (`src/schemas/plan.ts`) are the only implementations of plan syntax, and the caller
 * applies them.
 *
 * KNOWN DUPLICATION, NAMED RATHER THAN HIDDEN. The stage-fsync-rename-fsync mechanism now
 * exists three times: here, in `contract-file.ts` (story 2.6) and in `RunStore`'s
 * `result.json` finalize (story 3.5). All three agree on the post-rename rule below — that
 * agreement was reached in Epic 3's cohort intent-sync — but they are three copies of one
 * algorithm. Hoisting it into a shared `src/infra/atomic-write.ts` was NOT done here
 * because it would mean editing two merged files this story does not own, in a story that
 * four other agents are blocked behind. It is recorded in the PR body as a follow-up.
 *
 * AD-1: application layer. It may reach `domain/`; it must not import `src/cli/**`, and
 * does not.
 */

import { constants } from 'node:fs';
import { access, mkdtemp, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { InfraError } from '../domain/errors.js';
import { normalizeEpicId } from '../domain/ids.js';

/** The project-local SpecWitness directory, as `init` scaffolds it. */
const PROJECT_DIR = '.specwitness';

/**
 * Plans live here. COMMITTED to git, unlike `runs/` (questions doc Q11).
 *
 * Story 1.4's `init` already creates this directory and already excludes it from the
 * nested `.specwitness/.gitignore`, which lists only `runs/` and `scorecard.jsonl`.
 * Verified against the merged `src/infra/scaffold.ts` rather than assumed: nothing in this
 * story edits that file.
 */
export const PLANS_RELATIVE_DIR = `${PROJECT_DIR}/plans`;

const INIT_HINT =
  "run 'specwitness init' at the project root first — SpecWitness does not create the project directory on your behalf";

/**
 * The absolute path of an epic's plan file.
 *
 * The epic id is normalised first, so `7`, `epic-07` and `EPIC-7` all resolve to one file —
 * two spellings resolving to two plans would mean verifying an epic against a plan nobody
 * reviewed. A malformed id throws `UsageError` (exit 64) before any filesystem access.
 */
export function resolvePlanPath(projectRoot: string, epicId: string): string {
  return join(projectRoot, PROJECT_DIR, 'plans', `${normalizeEpicId(epicId)}.yaml`);
}

/** The repo-relative path, for messages the operator has to act on. */
export function planRelativePath(epicId: string): string {
  return `${PLANS_RELATIVE_DIR}/${normalizeEpicId(epicId)}.yaml`;
}

/**
 * Refuses unless `.specwitness/plans/` already exists.
 *
 * Creating it here instead would mean a `plan` command silently initialising a project —
 * scaffolding a directory in whatever happens to be the current working directory, which
 * for a mistyped `cd` is somebody's home directory. Fail closed, then explain.
 */
export async function assertPlansDirectory(projectRoot: string): Promise<void> {
  const plansDir = join(projectRoot, PROJECT_DIR, 'plans');

  try {
    const info = await stat(plansDir);
    if (!info.isDirectory()) {
      throw new InfraError(`${PLANS_RELATIVE_DIR} exists but is not a directory`, INIT_HINT);
    }
  } catch (cause) {
    if (cause instanceof InfraError) {
      throw cause;
    }
    // Only "it is not there" means "not initialised". An unreadable parent (EACCES) or an
    // I/O error is a different problem, and telling the operator to run `init` would send
    // them to fix the wrong thing — `init` would fail too, for the same reason.
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw new InfraError(
        `could not check for ${PLANS_RELATIVE_DIR} in ${projectRoot}: ${describe(cause)}`,
        `check that ${plansDir} and its parents are readable`,
      );
    }
    throw new InfraError(
      `this project is not initialised for SpecWitness (no ${PLANS_RELATIVE_DIR} in ${projectRoot})`,
      INIT_HINT,
    );
  }
}

/**
 * Reads an epic's plan file, or `undefined` when there is none.
 *
 * ONLY "it is not there" yields `undefined`. An unreadable file (EACCES), an I/O error, or
 * a directory where a file belongs is an `InfraError` — swallowing those would let story
 * 4.7 report "no plan, compiling one" for an epic whose reviewed plan exists and cannot be
 * read, silently replacing it.
 */
export async function readPlanFile(
  projectRoot: string,
  epicId: string,
): Promise<string | undefined> {
  const path = resolvePlanPath(projectRoot, epicId);

  try {
    return await readFile(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw new InfraError(
      `could not read ${planRelativePath(epicId)}: ${describe(cause)}`,
      `check that ${path} is readable`,
    );
  }
}

/** True when a plan file exists for this epic. */
export async function planFileExists(projectRoot: string, epicId: string): Promise<boolean> {
  try {
    await access(resolvePlanPath(projectRoot, epicId), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export interface WritePlanOptions {
  /**
   * The post-rename durability barrier. Injectable because fsyncing a directory cannot be
   * made to fail portably from outside the process, so the one failure this module must
   * classify correctly would otherwise be the one failure no test could produce.
   */
  readonly syncDirectory?: (path: string) => Promise<void>;
  /**
   * Called when the rename succeeded but the barrier did not. NOT an error: the plan is on
   * disk and readable; only its survival of a power loss in the next moments is unproven.
   */
  readonly onDurabilityWarning?: (message: string) => void;
}

/**
 * Writes a plan file atomically: stage, fsync, rename, fsync the directory.
 *
 * On any failure BEFORE the rename the staged file is removed and the previous plan is left
 * exactly as it was. The rename is the commit point, and the two sides of it fail
 * differently: a pre-rename failure means nothing changed and raises `InfraError`; a
 * post-rename barrier failure means the write LANDED and only its durability is unproven,
 * so it is reported through `onDurabilityWarning` and never as a failed write.
 *
 * That split is not a preference. Reporting "could not write .specwitness/plans/<epic>.yaml"
 * about a file that HAD in fact been replaced is a lie about state, and it invites the
 * operator to regenerate over a plan that already changed underneath them — Epic 2
 * retrospective §5a defect (ii), fixed in `contract-file.ts` by story 3.7. This module is
 * written that way from the start rather than repeating the defect.
 */
export async function writePlanFileAtomically(
  projectRoot: string,
  epicId: string,
  contents: string,
  options: WritePlanOptions = {},
): Promise<void> {
  const target = resolvePlanPath(projectRoot, epicId);
  const directory = dirname(target);

  let stagingDir: string | undefined;
  let staged: string | undefined;

  try {
    // A private staging directory inside the plans directory: same filesystem (so the
    // rename is atomic) and a unique name, so two concurrent compilations cannot overwrite
    // each other's temp file.
    stagingDir = await mkdtemp(join(directory, '.plan-'));
    staged = join(stagingDir, 'plan.yaml');

    const file = await open(staged, 'w');
    try {
      await file.writeFile(contents, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }

    await rename(staged, target);
    staged = undefined;
  } catch (cause) {
    throw new InfraError(
      `could not write ${planRelativePath(epicId)}: ${describe(cause)}`,
      `check free space and permissions on ${directory}`,
    );
  } finally {
    // Never leave debris. `force` so a successful rename (staged already gone) is not
    // itself an error, and so cleanup never masks the original failure.
    if (stagingDir !== undefined) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // PAST THIS LINE THE WRITE HAS COMMITTED — see the note above; this sits outside the try
  // for exactly that reason.
  try {
    await (options.syncDirectory ?? syncDirectory)(directory);
  } catch (cause) {
    options.onDurabilityWarning?.(
      `${planRelativePath(epicId)} was written, but its directory entry could not be made durable: ${describe(cause)}`,
    );
  }
}

/**
 * Fsyncs a directory so a rename is durable.
 *
 * Some filesystems do not support the operation and report EINVAL; that is not a durability
 * failure on those platforms, so it is tolerated rather than failing a write that actually
 * succeeded. Every other failure propagates.
 */
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EINVAL') {
      throw cause;
    }
  } finally {
    await handle.close();
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
