/**
 * The SOLE writer of `.specwitness/contracts/<epic>.yaml` (AD-5).
 *
 * Sole-writership is the same reviewable, grep-level rule `RunStore` applies to
 * `.specwitness/runs/` — and for the same reason: a path built in five places
 * is a path written inconsistently in the sixth. Story 2.7's amend flow routes
 * its single write through `writeContractFileAtomically` rather than adding a
 * second writer, agreed in the cohort intent-sync.
 *
 * `RunStore` is deliberately NOT extended to cover this. It is the sole writer
 * under `runs/`, whose contents are local-only and crash-reaped;
 * `contracts/` is committed product artifact and not its territory (AD-8/AD-5).
 *
 * WHY STAGE-AND-RENAME. `rename(2)` within a directory is atomic: a reader sees
 * either the whole old file or the whole new one, never a prefix. Writing in
 * place would mean that an interrupted generation — Ctrl-C, a full disk, a
 * killed process — leaves a truncated YAML document that story 2.2's parser
 * then rejects, or worse, one that parses but no longer matches its stored
 * fingerprint. The operator would be told their contract was tampered with,
 * for a reason nobody could explain. The temp file is created in the SAME
 * directory so the rename never has to cross a filesystem boundary, which is
 * the failure mode `/tmp`-staging quietly introduces.
 *
 * PARSING IS NOT HERE. This module moves text; `parseContract` /
 * `serializeContract` (story 2.2, `src/schemas/contract.ts`) are the only
 * implementations of contract syntax, and the caller applies them. That keeps
 * this file testable without a contract model and keeps the parser single.
 *
 * AD-1: application layer. It may reach `domain/`; it must not import
 * `src/cli/**`, and does not.
 */

import { constants } from 'node:fs';
import { access, mkdtemp, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { InfraError } from '../domain/errors.js';
import { normalizeEpicId } from '../domain/ids.js';

/** The project-local SpecWitness directory, as `init` scaffolds it. */
const PROJECT_DIR = '.specwitness';

/** Contracts live here. Committed to git, unlike `runs/` (questions doc Q11). */
export const CONTRACTS_RELATIVE_DIR = `${PROJECT_DIR}/contracts`;

const INIT_HINT =
  "run 'specwitness init' at the project root first — SpecWitness does not create the project directory on your behalf";

/**
 * The absolute path of an epic's contract file.
 *
 * The epic id is normalised first, so `7`, `epic-07` and `EPIC-7` all resolve
 * to one file — two spellings resolving to two contracts would mean verifying
 * an epic against a contract nobody reviewed. A malformed id throws
 * `UsageError` (exit 64) from `normalizeEpicId` before any filesystem access.
 */
export function resolveContractPath(projectRoot: string, epicId: string): string {
  const canonical = normalizeEpicId(epicId);
  return join(projectRoot, PROJECT_DIR, 'contracts', `${canonical}.yaml`);
}

/** The repo-relative path, for messages the operator has to act on. */
export function contractRelativePath(epicId: string): string {
  return `${CONTRACTS_RELATIVE_DIR}/${normalizeEpicId(epicId)}.yaml`;
}

/**
 * Refuses unless `.specwitness/contracts/` already exists.
 *
 * Story 1.4's `init` creates that tree. Creating it here instead would mean a
 * `contract` command silently initialising a project — scaffolding a directory
 * in whatever happens to be the current working directory, which for a
 * mistyped `cd` is somebody's home directory. Fail closed, then explain.
 */
export async function assertProjectInitialised(projectRoot: string): Promise<void> {
  const contractsDir = join(projectRoot, PROJECT_DIR, 'contracts');

  try {
    const info = await stat(contractsDir);
    if (!info.isDirectory()) {
      throw new InfraError(`${CONTRACTS_RELATIVE_DIR} exists but is not a directory`, INIT_HINT);
    }
  } catch (cause) {
    if (cause instanceof InfraError) {
      throw cause;
    }
    // Only "it is not there" means "not initialised". An unreadable parent
    // (EACCES) or an I/O error is a different problem, and telling the operator
    // to run `init` would send them to fix the wrong thing — `init` would fail
    // too, for the same underlying reason, with a second misleading message.
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw new InfraError(
        `could not check for ${CONTRACTS_RELATIVE_DIR} in ${projectRoot}: ${describe(cause)}`,
        `check that ${contractsDir} and its parents are readable`,
      );
    }
    throw new InfraError(
      `this project is not initialised for SpecWitness (no ${CONTRACTS_RELATIVE_DIR} in ${projectRoot})`,
      INIT_HINT,
    );
  }
}

/**
 * Reads an epic's contract file, or `undefined` when there is none.
 *
 * ONLY "it is not there" yields `undefined`. An unreadable file (EACCES), an
 * I/O error (EIO), or a directory where a file belongs is an `InfraError` —
 * swallowing those would make `--status` report "no contract" for an epic whose
 * contract exists and cannot be read, which is an infra failure disguised as a
 * product answer.
 */
export async function readContractFile(
  projectRoot: string,
  epicId: string,
): Promise<string | undefined> {
  const path = resolveContractPath(projectRoot, epicId);

  try {
    return await readFile(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw new InfraError(
      `could not read ${contractRelativePath(epicId)}: ${describe(cause)}`,
      `check that ${path} is readable`,
    );
  }
}

/** True when a contract file exists for this epic. */
export async function contractFileExists(projectRoot: string, epicId: string): Promise<boolean> {
  try {
    await access(resolveContractPath(projectRoot, epicId), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export interface WriteContractOptions {
  /**
   * Called with the staged temp path once its contents are durable, before the
   * rename. Exists so a test can interrupt the write exactly where a crash
   * would hurt most; production passes nothing.
   */
  readonly onStage?: (stagedPath: string) => void;
  /**
   * The post-rename durability barrier. Injectable for the same reason
   * `onStage` exists: fsyncing a directory cannot be made to fail portably from
   * outside the process, so the one failure this module must classify correctly
   * would otherwise be the one failure no test could produce. Production passes
   * nothing and gets `syncDirectory` below.
   */
  readonly syncDirectory?: (path: string) => Promise<void>;
  /**
   * Called when the rename succeeded but the barrier did not. NOT an error: the
   * new contract is on disk and readable: only its survival of a power loss in
   * the next moments is unproven. Optional because no caller surfaces it today.
   */
  readonly onDurabilityWarning?: (message: string) => void;
}

/**
 * Writes a contract file atomically: stage, fsync, rename, fsync the directory.
 *
 * On any failure BEFORE the rename the staged file is removed and the previous
 * contract is left exactly as it was. The directory fsync is the step most
 * often skipped, and the one that matters after the rename: fsyncing a file
 * makes its CONTENTS durable, not the directory entry naming it.
 *
 * The rename is the commit point, and the two sides of it fail differently: a
 * pre-rename failure means nothing changed and raises `InfraError`; a
 * post-rename barrier failure means the write LANDED and only its durability is
 * unproven, so it is reported through `onDurabilityWarning` and never as a
 * failed write. See the comment at that boundary.
 */
export async function writeContractFileAtomically(
  projectRoot: string,
  epicId: string,
  contents: string,
  options: WriteContractOptions = {},
): Promise<void> {
  const target = resolveContractPath(projectRoot, epicId);
  const directory = dirname(target);

  let stagingDir: string | undefined;
  let staged: string | undefined;

  try {
    // A private staging directory inside the contracts directory: same
    // filesystem (so the rename is atomic) and a unique name, so two concurrent
    // generations cannot overwrite each other's temp file.
    stagingDir = await mkdtemp(join(directory, '.contract-'));
    staged = join(stagingDir, 'contract.yaml');

    const file = await open(staged, 'w');
    try {
      await file.writeFile(contents, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }

    options.onStage?.(staged);

    await rename(staged, target);
    staged = undefined;
  } catch (cause) {
    throw new InfraError(
      `could not write ${contractRelativePath(epicId)}: ${describe(cause)}`,
      `check free space and permissions on ${directory}`,
    );
  } finally {
    // Never leave debris. `force` so a successful rename (staged already gone)
    // is not itself an error, and so cleanup never masks the original failure.
    if (stagingDir !== undefined) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // PAST THIS LINE THE WRITE HAS COMMITTED. `rename(2)` is atomic, so the new
  // contract IS the file on disk and every reader already sees it. A failure of
  // the durability barrier below is therefore not a failed write, and it sits
  // outside the try above for exactly that reason.
  //
  // It used to sit inside it (story 2.6), so a post-rename fsync failure
  // reported "could not write .specwitness/contracts/<epic>.yaml" about a file
  // that had in fact been replaced — a lie about state in the module whose
  // entire purpose is that state is never ambiguous, and one that invites the
  // operator to regenerate over a contract that already changed underneath
  // them. Epic 2 retrospective §5a defect (ii), assigned to story 3.7 by the
  // owner on 2026-08-31. Story 3.5's `result.json` finalize treats a
  // post-rename failure the same way, agreed in cohort intent-sync, so the two
  // stage-and-rename implementations in this epic cannot disagree about what a
  // post-rename failure means.
  //
  // Non-fatal is not silent. What is unproven is survival of a power loss in
  // the next moments, and a caller that wants to say so gets the reason
  // verbatim rather than a swallowed exception.
  try {
    await (options.syncDirectory ?? syncDirectory)(directory);
  } catch (cause) {
    options.onDurabilityWarning?.(
      `${contractRelativePath(epicId)} was written, but its directory entry could not be made durable: ${describe(cause)}`,
    );
  }
}

/**
 * Fsyncs a directory so a rename is durable.
 *
 * Some filesystems do not support the operation and report EINVAL; that is not
 * a durability failure on those platforms, so it is tolerated rather than
 * failing a write that actually succeeded. Every other failure propagates.
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
