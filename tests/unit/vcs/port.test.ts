/**
 * Story 3.1 — the `Vcs` port's vocabulary (AD-1, AD-8).
 *
 * These are type-level tests. They compile-fail rather than assert-fail when the
 * union is widened without every consumer being updated, which is the whole
 * point of a CLOSED vocabulary: the merged `ProcessOutcome` chose the same shape
 * for the same reason, and `verdict.ts` / `exit.ts` both show the `never`
 * pattern this file follows.
 *
 * The `never` checks below are not ceremony. A `switch` over a discriminated
 * union that silently falls through is how an unresolvable ref becomes a PASS,
 * and this project's house rule is that any switch over a closed union gets an
 * exhaustiveness check. If a sixth outcome is ever added, these stop compiling
 * until someone decides what it means.
 *
 * WHERE THIS FILE'S GUARD ACTUALLY LIVES: `pnpm typecheck`, not `pnpm test`.
 * Worth stating, because it was briefly misleading in development — vitest
 * erases type-only imports, so this suite went GREEN against a `src/domain/vcs.ts`
 * that did not exist yet. Under `tsc --noEmit` the same file failed three ways
 * (TS2307 for the missing module, TS2322 twice for the `never` arms). The
 * runtime assertions below are real but secondary; the exhaustiveness proof is
 * a compile-time one, and `typecheck` is part of the pre-commit gate for
 * exactly this reason.
 */

import { describe, expect, it } from 'vitest';

import type {
  CreatedWorktree,
  RefResolution,
  RefRole,
  RepoRoot,
  RootResolution,
  WorktreeEntry,
} from '../../../src/domain/vcs.js';

/** Exhaustive over `RootResolution`; the `never` arm is the guard. */
function describeRoot(resolution: RootResolution): string {
  switch (resolution.outcome) {
    case 'resolved':
      return resolution.root.mainWorktreeRoot;
    case 'not-found':
    case 'not-a-repo':
    case 'ambiguous':
    case 'git-unavailable':
      return `${resolution.outcome}: ${resolution.path}`;
    default: {
      const unreachable: never = resolution;
      return unreachable;
    }
  }
}

/** Exhaustive over `RefResolution`. */
function describeRef(resolution: RefResolution): string {
  switch (resolution.outcome) {
    case 'resolved':
      return resolution.sha;
    case 'ambiguous':
      return resolution.candidates.join(', ');
    case 'not-found':
    case 'not-a-repo':
    case 'git-unavailable':
      return `${resolution.role}/${resolution.outcome}`;
    default: {
      const unreachable: never = resolution;
      return unreachable;
    }
  }
}

describe('RootResolution', () => {
  it('carries both roots on the resolved arm', () => {
    const root: RepoRoot = {
      worktreeRoot: '/repo/linked',
      mainWorktreeRoot: '/repo',
      gitCommonDir: '/repo/.git',
      linkedWorktree: true,
    };

    expect(describeRoot({ outcome: 'resolved', root })).toBe('/repo');
  });

  it('names the offending path on every refusal arm', () => {
    const refusals: RootResolution[] = [
      { outcome: 'not-found', path: '/nope', detail: 'no such directory' },
      { outcome: 'not-a-repo', path: '/tmp', detail: 'no .git' },
      { outcome: 'ambiguous', path: '/w', detail: 'two candidates' },
      { outcome: 'git-unavailable', path: '/w', detail: 'git not found on PATH' },
    ];

    // Every refusal must be renderable without the caller knowing which one it
    // got — that is what lets one error site handle all four.
    expect(refusals.map(describeRoot)).toEqual([
      'not-found: /nope',
      'not-a-repo: /tmp',
      'ambiguous: /w',
      'git-unavailable: /w',
    ]);
  });
});

describe('RefResolution', () => {
  it('carries the resolved commit sha', () => {
    const role: RefRole = 'head';
    const resolved: RefResolution = {
      outcome: 'resolved',
      role,
      ref: 'origin/epic/7-slug',
      sha: '04f090d71bcfbdfb217583ed36ad815744884cc4',
    };

    expect(describeRef(resolved)).toBe('04f090d71bcfbdfb217583ed36ad815744884cc4');
  });

  it('lists the candidates that made a ref ambiguous', () => {
    const ambiguous: RefResolution = {
      outcome: 'ambiguous',
      role: 'head',
      ref: 'epic/7',
      candidates: ['refs/heads/epic/7', 'refs/tags/epic/7'],
      detail: 'two refs match',
    };

    expect(describeRef(ambiguous)).toBe('refs/heads/epic/7, refs/tags/epic/7');
  });

  it('distinguishes base from head so an error can name the flag', () => {
    const base: RefResolution = {
      outcome: 'not-found',
      role: 'base',
      ref: 'master',
      detail: 'unknown revision',
    };

    expect(describeRef(base)).toBe('base/not-found');
  });
});

describe('WorktreeEntry', () => {
  it('models a detached entry with no branch', () => {
    const entry: WorktreeEntry = {
      path: '/tmp/specwitness-x/worktree',
      head: '04f090d71bcfbdfb217583ed36ad815744884cc4',
      branch: null,
      detached: true,
      prunable: false,
    };

    expect(entry.branch).toBeNull();
    expect(entry.detached).toBe(true);
  });
});

describe('CreatedWorktree', () => {
  it('keeps the container separate from the worktree path', () => {
    // `clean` (3.2) replays only `path`; it must never infer and delete a
    // container it did not create. Keeping them distinct is what makes that
    // distinction expressible.
    const created: CreatedWorktree = {
      path: '/private/tmp/specwitness-ab12/worktree',
      sha: '04f090d71bcfbdfb217583ed36ad815744884cc4',
      container: '/private/tmp/specwitness-ab12',
    };

    expect(created.path.startsWith(created.container)).toBe(true);
    expect(created.path).not.toBe(created.container);
  });
});
