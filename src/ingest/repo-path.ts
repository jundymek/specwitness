/**
 * Repo-relative path construction and the containment boundary.
 *
 * Two rules live here because both readers need them and neither may get them
 * subtly different:
 *
 *  1. Every path an `EpicSpec` carries is repo-relative and forward-slashed, so
 *     a spec is portable between machines and diffable between runs.
 *  2. Ingestion reads nothing outside the configured artifact roots. Checking
 *     the ROOT alone is not enough — a symlinked `epics.md` or story directory
 *     inside a legitimate root still walks out of the repository — so every
 *     file and directory is resolved and checked before it is opened.
 */

import { realpathSync } from 'node:fs';
import { sep } from 'node:path';

import { IngestError } from '../domain/errors.js';

/**
 * Joins path segments into a repo-relative, forward-slashed path.
 *
 * Empty and `.` segments are dropped. That is what makes an artifact root of
 * `.` work: `relative(projectRoot, projectRoot)` is the empty string, and naive
 * interpolation would produce `/epics.md` — a path that reads correctly but
 * looks absolute, so it is neither portable nor accepted by `sourceRefSchema`.
 */
export function repoPath(...segments: readonly string[]): string {
  return segments
    .flatMap((segment) => segment.split(/[\\/]/))
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
}

/** The real path of `candidate`, or undefined when it does not exist. */
export function realPathOrUndefined(candidate: string): string | undefined {
  try {
    return realpathSync(candidate);
  } catch {
    return undefined;
  }
}

/** True when `candidate` is `root` or lives beneath it. */
export function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Refuses an artifact entry whose real path escapes its configured root.
 *
 * An `IngestError`, deliberately, rather than the `ConfigError` used when a
 * configured ROOT escapes: here the config named a legitimate root and the
 * planning artifacts themselves contain the escaping symlink, so the fault —
 * and the thing to go and look at — is the artifact tree.
 *
 * A path that does not exist is not an escape; the readers report absence
 * themselves, with a better message than this could give.
 */
export function assertInsideRoot(
  realRoot: string | undefined,
  absoluteCandidate: string,
  relativeCandidate: string,
): void {
  if (realRoot === undefined) return;

  const real = realPathOrUndefined(absoluteCandidate);
  if (real === undefined || isInside(realRoot, real)) return;

  throw new IngestError(
    `${relativeCandidate} resolves to ${real}, which is outside the configured artifact root`,
    'SpecWitness reads only inside the configured artifact roots — remove the symlink ' +
      'or point planning.planningArtifacts / planning.implementationArtifacts at the real location',
  );
}
