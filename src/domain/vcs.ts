/**
 * AD-8 — the git / worktree seam.
 *
 * `src/domain/ports.ts` reserves this for Epic 3 in its own header ("Epic 3
 * brings the process runner and the git/worktree seam"). It lives in its own
 * file rather than inside `ports.ts` because three Epic 3 stories land in the
 * same wave and a shared file is a merge conflict waiting to happen — not
 * because this is any less a port than `Clock` or `Ids`.
 *
 * WHAT THIS PORT IS FOR: resolving a revision to a SHA, and creating the
 * detached worktree a verification run executes in. It is deliberately NARROW.
 * The only git WRITES SpecWitness ever performs are `worktree add` and
 * `worktree remove` (AD-8, ADR-004). There is no fetch, no push, no commit and
 * no branch creation here, and adding one is an ADR rather than a method.
 *
 * WHY RESOLUTION RETURNS AN OUTCOME RATHER THAN THROWING. `resolveRoot` and
 * `resolveRef` hand back a closed discriminated union — `resolved`,
 * `not-found`, `ambiguous`, `not-a-repo`, `git-unavailable` — modelled on the
 * merged `ProcessOutcome`, for the reason recorded there: a caller that must
 * tell "the ref does not exist" from "git is not installed" from "you named
 * something two refs answer to" should classify a VALUE, not pattern-match an
 * error message. The adapter maps these to `InfraError` once, at the point a
 * message is actually needed.
 *
 * The WRITES (`addWorktree`, `removeWorktree`, `removeWorktreeAt`) throw
 * instead. There is no classification of "the worktree could not be created"
 * that a caller would branch on — every arm is exit 3 — and giving them an
 * outcome type would only invite a caller to ignore it.
 *
 * AD-1: this module imports NOTHING. Not a sibling, not a node builtin, not
 * zod — `tsPreCompilationDeps: true` means even `import type { z } from 'zod'`
 * fails `domain-is-dependency-free`, which story 2.3 verified the hard way.
 */

/**
 * A repository, resolved — with BOTH roots kept, because they are different
 * places and confusing them verifies the wrong tree.
 *
 * The distinction is not academic. This project's own agents each work in a
 * LINKED worktree (`/Users/jundymek/dev/specwitness-agents/<agent>`), where a
 * naive walk upward finds a `.git` FILE pointing into the main repository
 * rather than a `.git` directory. Measured from one of them on 2026-08-31:
 * `--show-toplevel` answers `…/specwitness-agents/alice` while the repository
 * is `/Users/jundymek/dev/specwitness`. FR-19 exists because the first-client
 * survey found exactly this shape.
 *
 * Which one is "the repo"? Both, for different purposes, so both are recorded:
 *
 *   - `worktreeRoot` is where the operator invoked from. Git commands run with
 *     this as their cwd, which is what makes worktree registrations land in the
 *     shared common dir no matter which checkout you started in.
 *   - `mainWorktreeRoot` is the repository itself — the "source repo" whose
 *     read-only-ness AC2 proves, and the one every error message names. It is
 *     the first entry of `git worktree list --porcelain`, which git documents
 *     as always being the main worktree.
 *
 * Every path here is absolute and realpath-resolved. On macOS `os.tmpdir()` is
 * `/var/folders/…`, a symlink into `/private/var/…`, and git reports the
 * resolved form — so a containment check against an unresolved path answers
 * "no" for a directory that is in fact inside. Measured, not assumed: a
 * `mktemp -d /tmp/x` came back from `git worktree list` as `/private/tmp/x`.
 */
export interface RepoRoot {
  /** The working tree containing the requested path. May be a linked worktree. */
  readonly worktreeRoot: string;
  /** The repository's main worktree. The "source repo" in every message. */
  readonly mainWorktreeRoot: string;
  /** The `.git` directory shared by every worktree (`--git-common-dir`). */
  readonly gitCommonDir: string;
  /** True when the invocation came from a linked worktree, not the main one. */
  readonly linkedWorktree: boolean;
}

/**
 * Why a root could not be resolved (AC3).
 *
 * `ambiguous` is for a root that cannot be DECIDED, as distinct from one that
 * is merely absent. Refusing is always correct here: guessing verifies a
 * repository nobody asked about, and the report would look completely normal.
 */
export type RootResolution =
  | { readonly outcome: 'resolved'; readonly root: RepoRoot }
  | { readonly outcome: 'not-found'; readonly path: string; readonly detail: string }
  | { readonly outcome: 'not-a-repo'; readonly path: string; readonly detail: string }
  | { readonly outcome: 'ambiguous'; readonly path: string; readonly detail: string }
  | { readonly outcome: 'git-unavailable'; readonly path: string; readonly detail: string };

/**
 * Which revision was asked for, so an error names the flag the operator typed
 * rather than saying "a ref" and leaving them to work it out.
 *
 * `base` is resolved and RECORDED but never checked out: V0 runs one worktree,
 * at head. Base exists in the model because differential BASE/HEAD
 * verification is a v2 feature the run record must already accommodate (spine
 * Deferred, Q67). A base that does not resolve is still an error — recording a
 * null base would silently disable that future feature.
 */
export type RefRole = 'base' | 'head';

/**
 * The outcome of resolving one ref to a commit SHA.
 *
 * `sha` is always a COMMIT's sha, never a tag object's — see the `^{commit}`
 * peel in the adapter. Measured on git 2.50.1: an annotated tag `v1` gives
 * `f043638…` unpeeled and `04f090d…` peeled. A worktree created at the former
 * sits at a revision the run record does not name, so the evidence would
 * describe something that was never verified.
 */
export type RefResolution =
  | {
      readonly outcome: 'resolved';
      readonly role: RefRole;
      readonly ref: string;
      readonly sha: string;
    }
  | {
      readonly outcome: 'not-found';
      readonly role: RefRole;
      readonly ref: string;
      readonly detail: string;
    }
  | {
      readonly outcome: 'ambiguous';
      readonly role: RefRole;
      readonly ref: string;
      /** Every ref the input matched, named in the error so the fix is obvious. */
      readonly candidates: readonly string[];
      readonly detail: string;
    }
  | {
      readonly outcome: 'not-a-repo';
      readonly role: RefRole;
      readonly ref: string;
      readonly detail: string;
    }
  | {
      readonly outcome: 'git-unavailable';
      readonly role: RefRole;
      readonly ref: string;
      readonly detail: string;
    };

/**
 * One entry of `git worktree list --porcelain`.
 *
 * The first entry is always the main worktree; that documented ordering is how
 * `RepoRoot.mainWorktreeRoot` is found.
 */
export interface WorktreeEntry {
  readonly path: string;
  /** The checked-out commit, or `null` for a bare or prunable entry. */
  readonly head: string | null;
  /** The checked-out branch, or `null` when detached. Ours are always detached. */
  readonly branch: string | null;
  readonly detached: boolean;
  /** Git considers the registration stale — its directory is gone. */
  readonly prunable: boolean;
}

/**
 * A worktree SpecWitness created.
 *
 * `path` is the string recorded in the run manifest, carried as
 * `RunEnvironment.worktreePath`, and persisted into `result.json` verbatim
 * (confirmed with rambo, 3.5). It is absolute and realpath-resolved, and it
 * will usually NOT exist by the time anyone reads the stored result — it is
 * provenance, not a link.
 *
 * `container` is the `mkdtemp` directory the worktree sits inside. Two
 * directories rather than one because `git worktree add` wants a path that does
 * not yet exist, and `mkdtemp` is the only race-free way to get a unique one.
 * Only the happy path knows the container; `clean` (3.2) replaying a manifest
 * has a path alone and must not guess at deleting a temp directory it did not
 * create.
 */
export interface CreatedWorktree {
  readonly path: string;
  /** The commit the worktree is detached at. Equals the `RefResolution.sha`. */
  readonly sha: string;
  /** The `mkdtemp` parent under the OS temp dir. Removed with the worktree. */
  readonly container: string;
}

/** What `resolveRoot` is asked. `explicitRoot` is `--root`, and it always wins. */
export interface RootRequest {
  /** `--root <dir>`, when the operator passed one. */
  readonly explicitRoot?: string | undefined;
  /** Where to start walking up from when `explicitRoot` is absent. */
  readonly cwd: string;
}

/**
 * Hooks around worktree creation.
 *
 * `onPathReserved` is what makes AD-8's "manifest written and fsynced BEFORE
 * the resource exists-in-use" ordering STRUCTURAL rather than a convention
 * somebody has to remember. The adapter reserves the path, awaits this hook,
 * and only then runs `git worktree add`. A hook that rejects aborts creation,
 * so a worktree cannot come into existence unrecorded.
 */
export interface AddWorktreeHooks {
  /** Called with the reserved path before any git write. Rejecting aborts. */
  readonly onPathReserved?: (worktreePath: string) => Promise<void>;
}

/**
 * The port.
 *
 * Implemented by `src/infra/vcs.ts` (git); faked in tests. Nothing in
 * `src/pipeline/**` spawns git directly — it calls this.
 */
export interface Vcs {
  /**
   * Resolves the repository to verify. `--root` wins; otherwise walk up from
   * `cwd`. NEVER guesses — an ambiguous or unresolvable root is refused with a
   * named outcome (AC3).
   */
  resolveRoot(request: RootRequest): Promise<RootResolution>;

  /**
   * Resolves one ref to a commit SHA.
   *
   * NEVER fetches, even when the ref is missing and a fetch would find it.
   * That is a security and correctness rule rather than a convenience choice:
   * an implicit fetch would make the verdict depend on network state, and
   * would WRITE to the source repository — in a story whose entire point is
   * that the repository is read-only.
   */
  resolveRef(root: RepoRoot, role: RefRole, ref: string): Promise<RefResolution>;

  /** Every worktree registered in the repository, the main one first. */
  listWorktrees(root: RepoRoot): Promise<readonly WorktreeEntry[]>;

  /**
   * Creates a detached worktree at `sha`, under the OS temp dir — never inside
   * the source repository's working tree (AD-8). Throws `InfraError`.
   */
  addWorktree(root: RepoRoot, sha: string, hooks?: AddWorktreeHooks): Promise<CreatedWorktree>;

  /**
   * Removes a worktree created by `addWorktree`, and its `mkdtemp` container.
   * Verifies the registration is gone afterwards. Throws `InfraError`.
   */
  removeWorktree(root: RepoRoot, worktree: CreatedWorktree): Promise<void>;

  /**
   * Removes a worktree known only by its path — story 3.2's `clean` replaying a
   * run manifest.
   *
   * An already-absent worktree is a NO-OP, not an error: manifest replay hits
   * that constantly, and a reaper that fails on an already-reaped entry stops
   * reaping the ones that are still live. Touches no container directory,
   * because a path alone does not identify one.
   */
  removeWorktreeAt(root: RepoRoot, worktreePath: string): Promise<void>;
}

/**
 * The one-method seam by which the worktree stage records its path into the run
 * manifest BEFORE the worktree exists-in-use (AD-8).
 *
 * Story 3.2's `RunStore.recordWorktree` satisfies this structurally, which is
 * the point. `RunStore` is the sole writer under `.specwitness/runs/` and this
 * story must not become a second one — but neither may this story's branch
 * depend on 3.2's merge order. Name and signature agreed with bob (3.2) during
 * cohort intent-sync; they are his.
 */
export interface WorktreeRecorder {
  /** Records `worktreePath` in the run manifest, written and fsynced. */
  recordWorktree(runId: string, worktreePath: string): Promise<void>;
}
