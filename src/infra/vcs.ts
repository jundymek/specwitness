/**
 * The git implementation of the `Vcs` port (AD-8, ADR-004).
 *
 * SPAWNING: through the merged `ProcessRunner` (`src/infra/process-runner.ts`),
 * injected — NOT execa directly, and not a private `runGit` of its own. This is
 * a decision worth stating because the alternative was available and looked
 * cheaper.
 *
 * `runGit` in `src/cli/doctor/effects.ts` is this codebase's original proven
 * git-spawn shape, and it cannot be reused here: it is module-private (only
 * `createDoctorEffects` and `DoctorEffects` are exported), and
 * `nothing-imports-cli` forbids `src/infra/` importing `src/cli/` regardless.
 * So the choice was between a SECOND execa call site and routing through the
 * `ProcessRunner` that already exists. Routing wins, because both of those
 * files carry the same hard-won classification — an ENOENT means "the binary is
 * missing" ONLY when the cwd is a real directory, since an invalid `cwd` raises
 * the identical ENOENT — and that bug was found twice and fixed twice already
 * (story 2.3; Epic 2 retrospective learning 4). A third hand-rolled classifier
 * is a third place for it to come back. `ProcessRunner` also gives this module
 * `timed-out` handling and, from story 3.2, per-child process groups, so a hung
 * `git` cannot leak a subtree.
 *
 * Told to bob (3.2) during cohort intent-sync, since it makes this module a
 * call site of the port he extends this wave; his changes are additive by
 * design, so nothing here needs to move.
 *
 * SECURITY (AD-3): `git` is TRUSTED TOOLING spawned by fixed name with a fixed
 * argument array — the same footing as the provider CLIs, and deliberately NOT
 * a `DeclaredCommand`. That brand constrains project-declared SHELL STRINGS,
 * and there is no shell here to constrain: no `shell` option, no command line,
 * no `sh -c`. This matters more than usual in this module, because a branch
 * name is attacker-influenced input in the general case — `--head` comes from a
 * flag, and refs may legally contain characters a shell would interpret.
 * Passing a ref as ONE argv element is precisely what makes that safe.
 *
 * WRITES: `worktree add` and `worktree remove` are the only git writes
 * SpecWitness performs, anywhere (AD-8). This module never fetches, never
 * pushes, never commits, never creates a branch. The no-fetch rule in
 * particular is a correctness rule and not a convenience choice — see
 * `resolveRef`.
 *
 * NFR-1: nothing here reads `~/.claude/`, `~/.codex/` or any credential store,
 * and nothing reads `process.env` by name.
 */

import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { InfraError } from '../domain/errors.js';
import type { ProcessResult, ProcessRunner } from '../domain/process-runner.js';
import { SystemClock } from './clock.js';
import { createProcessRunner } from './process-runner.js';
import type {
  AddWorktreeHooks,
  CreatedWorktree,
  RefResolution,
  RefRole,
  RepoRoot,
  RootRequest,
  RootResolution,
  Vcs,
  WorktreeEntry,
} from '../domain/vcs.js';

/**
 * A bound on every read-only git call.
 *
 * `src/cli/doctor/checks/git.ts` uses 5s for a diagnostic; these run inside a
 * verification that may sit on a large or network-backed repository, so the
 * bound is looser — but it exists, because an unbounded spawn is how a verify
 * hangs instead of failing cleanly.
 */
export const GIT_QUERY_TIMEOUT_MS = 30_000;

/**
 * A separate, much looser bound for `worktree add` / `remove`.
 *
 * Creating a worktree writes out a whole checkout; on a large repository that
 * is legitimately slow, and killing it at the query timeout would report a hung
 * filesystem where there was only a big tree.
 */
export const GIT_WORKTREE_TIMEOUT_MS = 300_000;

/**
 * The oldest git whose behaviour this module actually relies on.
 *
 * Chosen from the features rather than from a round number, and it moved once
 * during development, which is worth recording:
 *
 *   - `git worktree list --porcelain`   2.7
 *   - `git worktree remove --force`     2.17
 *   - **`--end-of-options`**            **2.24**  <- the binding constraint
 *
 * The first draft said 2.17, counting only the worktree features. But
 * `revParseCommitArgs` passes `--end-of-options`, and that is an
 * argument-injection guard rather than a convenience: `--head` is operator
 * input, git refnames may begin with a dash, and without the separator a ref
 * named `--output=…` would be parsed as an OPTION to `rev-parse` instead of as
 * a revision. Dropping the guard to reach an older git would trade a security
 * property for compatibility with releases from before 2019, so the floor
 * moves instead.
 *
 * PROBED at runtime, never assumed — "a wrong answer from a git too old to
 * support the flag" is precisely the failure this story cannot have. Verified
 * present on the development machine (2.50.1, 2026-08-31).
 */
export const MIN_GIT_VERSION = '2.24.0';

/** Prefix of the `mkdtemp` container each worktree is created inside. */
const CONTAINER_PREFIX = 'specwitness-worktree-';

/** The worktree's directory name inside its container. */
const WORKTREE_DIR = 'worktree';

// ---------------------------------------------------------------------------
// Argument builders — exported because tests need the REAL argv
// ---------------------------------------------------------------------------

/**
 * `git rev-parse --verify <ref>^{commit}`.
 *
 * Both parts are load-bearing.
 *
 * `^{commit}` PEELS: without it an annotated tag resolves to the TAG OBJECT's
 * sha rather than the commit's, and the worktree would be created at a
 * different revision than the one recorded in `RunResult` — evidence
 * describing a revision that was never verified. Measured on git 2.50.1
 * against an annotated tag: `f043638…` unpeeled, `04f090d…` peeled.
 *
 * `--verify` makes a missing ref a NON-ZERO EXIT rather than an echo of the
 * input string. Without it, `rev-parse nonsense` prints `nonsense` and exits 0,
 * and this function would hand back a "sha" that is the operator's typo.
 */
export function revParseCommitArgs(ref: string): readonly string[] {
  return ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`];
}

/** `git worktree add --detach <path> <sha>` — the only creation form used. */
export function worktreeAddArgs(worktreePath: string, sha: string): readonly string[] {
  return ['worktree', 'add', '--detach', '--', worktreePath, sha];
}

/**
 * `git worktree remove --force <path>`.
 *
 * `--force` because the worktree is ours and may hold build output a gate
 * produced; git refuses to remove a dirty worktree without it. `worktree
 * remove` rather than `rm -rf` because git keeps administrative files under
 * `.git/worktrees/<name>` that an `rm -rf` leaves behind — a registration that
 * outlives its directory, which then makes the next `worktree add` at that path
 * fail with a confusing error.
 */
export function worktreeRemoveArgs(worktreePath: string): readonly string[] {
  return ['worktree', 'remove', '--force', '--', worktreePath];
}

/** `git worktree list --porcelain` — main worktree first, by git's contract. */
export function worktreeListArgs(): readonly string[] {
  return ['worktree', 'list', '--porcelain'];
}

// ---------------------------------------------------------------------------
// Porcelain parsing
// ---------------------------------------------------------------------------

/**
 * Parses `git worktree list --porcelain`.
 *
 * The format is stanzas separated by blank lines, each beginning with
 * `worktree <path>`, followed by some of `HEAD <sha>`, `branch <ref>`,
 * `detached`, `bare`, `prunable <reason>`. Parsed by line prefix rather than by
 * position, because git adds attribute lines over time and a positional parser
 * would silently mis-read a newer git's output.
 */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: { path: string; head: string | null; branch: string | null; detached: boolean; prunable: boolean } | null =
    null;

  const flush = (): void => {
    if (current !== null) {
      entries.push({ ...current });
      current = null;
    }
  };

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      flush();
      current = {
        path: line.slice('worktree '.length),
        head: null,
        branch: null,
        detached: false,
        prunable: false,
      };
      continue;
    }
    if (current === null) {
      continue;
    }
    if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      current.prunable = true;
    }
  }
  flush();

  return entries;
}

/**
 * Compares two dotted version strings numerically.
 *
 * Returns a negative number when `a < b`. Non-numeric trailers are ignored —
 * Apple ships `2.50.1 (Apple Git-155)` and Windows appends `.windows.1`, and
 * neither changes which features are present.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] =>
    v
      .split('.')
      .map((piece) => Number.parseInt(piece, 10))
      .map((n) => (Number.isNaN(n) ? 0 : n));

  const left = parts(a);
  const right = parts(b);
  const width = Math.max(left.length, right.length);

  for (let i = 0; i < width; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/** Extracts `2.50.1` from `git version 2.50.1 (Apple Git-155)`. */
export function parseGitVersion(stdout: string): string | null {
  const match = /\bversion\s+(\d+(?:\.\d+)*)/.exec(stdout);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface GitVcsOptions {
  /** The merged subprocess port. Injected so tests need no real spawn policy. */
  readonly runner: ProcessRunner;
  readonly queryTimeoutMs?: number;
  readonly worktreeTimeoutMs?: number;
}

/** What a git invocation produced, plus the argv, so errors can quote it. */
interface GitCall {
  readonly result: ProcessResult;
  readonly args: readonly string[];
}

/**
 * True for a git object id: 40 hex characters (SHA-1) or 64 (SHA-256).
 *
 * Both are current. `git init --object-format=sha256` produces a repository
 * whose every object id is 64 characters, and it is not exotic enough to
 * refuse — treating one as malformed would report an existing ref as missing.
 */
export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value) || /^[0-9a-f]{64}$/.test(value);
}

/** True when the path exists and is a directory. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** realpath, falling back to a lexical resolve when the path does not exist. */
async function resolveReal(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/** True when `child` is `parent` or sits underneath it. Both must be resolved. */
export function isInside(parent: string, child: string): boolean {
  if (child === parent) {
    return true;
  }
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

export function createGitVcs(options: GitVcsOptions): Vcs {
  const queryTimeoutMs = options.queryTimeoutMs ?? GIT_QUERY_TIMEOUT_MS;
  const worktreeTimeoutMs = options.worktreeTimeoutMs ?? GIT_WORKTREE_TIMEOUT_MS;

  /**
   * One git invocation.
   *
   * The environment is constructed rather than inherited wholesale-and-forgotten:
   * `GIT_TERMINAL_PROMPT=0` so git can never block on a credential prompt (the
   * verify path is prompt-free by contract — a hung prompt on an agent-driven
   * run is indistinguishable from a hang), and `GIT_OPTIONAL_LOCKS=0` so a
   * read-only query cannot take a lock in the SOURCE repository, which is the
   * repository this whole story promises not to disturb. Both mirror the
   * merged `runGit` in `src/cli/doctor/effects.ts`.
   */
  const runGit = async (
    cwd: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<GitCall> => {
    const result = await options.runner.run({
      binary: 'git',
      args,
      cwd,
      timeoutMs,
      env: {
        inherit: true,
        set: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      },
      input: '',
    });
    return { result, args };
  };

  /**
   * Why git itself could not be used, or `null` when it ran and answered.
   *
   * "Ran and answered" INCLUDES a non-zero exit — that is git saying no, which
   * is a result for the caller to interpret rather than a failure of git. The
   * wording mirrors `describeGitFailure` in `src/cli/doctor/checks/git.ts` so
   * that "missing" / "hung" / "said no" stay one vocabulary across the product.
   * That file cannot be imported here (`nothing-imports-cli`), so this is a
   * deliberate mirror rather than an accidental second dialect.
   */
  const describeUnavailable = (call: GitCall): string | null => {
    switch (call.result.outcome) {
      case 'completed':
        return null;
      case 'not-found':
        return 'git not found on PATH';
      case 'timed-out':
        return `git timed out running 'git ${call.args.join(' ')}'`;
      case 'spawn-failed':
        return `git could not be started: ${call.result.stderr.trim() || 'no detail'}`;
      default: {
        // Fail closed: an outcome this module has never heard of must not read
        // as "git is fine". The merged union has exactly four arms today.
        const unreachable: never = call.result.outcome;
        return `git returned an unrecognised outcome: ${String(unreachable)}`;
      }
    }
  };

  /**
   * The git capability probe, run once per adapter and cached.
   *
   * Cached because every public method would otherwise pay for it, and the
   * answer cannot change inside one run. `null` means usable.
   */
  let capabilityCheck: Promise<string | null> | null = null;

  const checkGitUsable = async (cwd: string): Promise<string | null> => {
    capabilityCheck ??= (async (): Promise<string | null> => {
      const call = await runGit(cwd, ['--version'], queryTimeoutMs);
      const unavailable = describeUnavailable(call);
      if (unavailable !== null) {
        return unavailable;
      }
      if (call.result.exitCode !== 0) {
        // Spawning successfully is not the same as working: a broken install, a
        // missing shared library or an erroring wrapper script all get here.
        // `git-present.ts` makes the same distinction for the same reason.
        const reason = call.result.stderr.trim() || call.result.stdout.trim() || 'no output';
        return `git --version exited ${call.result.exitCode ?? 'without a code'}: ${reason}`;
      }
      const version = parseGitVersion(call.result.stdout);
      if (version === null) {
        // Unparseable but working: do not refuse over it. Refusing here would
        // block a perfectly good git because its banner changed format.
        return null;
      }
      if (compareVersions(version, MIN_GIT_VERSION) < 0) {
        return `git ${version} is too old: SpecWitness needs git >= ${MIN_GIT_VERSION}`;
      }
      return null;
    })();

    return await capabilityCheck;
  };

  /**
   * The outcome of a read-only git query, with the THREE cases kept apart.
   *
   * This type exists because collapsing them produced four separate defects in
   * this story, each found by review and each the same mistake: an earlier
   * `query()` returned `string | null`, and every caller had to read `null` as
   * "git said no" — so a hung or unspawnable git became "this is not a
   * repository", "nothing is registered", or "no candidates, therefore
   * unambiguous". Every one of those is an infrastructure failure wearing a
   * product answer's clothes, which is the failure this codebase treats as
   * first-order.
   *
   * Keeping `said-no` and `unavailable` distinct makes that mistake
   * unspellable rather than merely discouraged: a caller has to name the case
   * it is handling.
   */
  type QueryOutcome =
    /** git ran and answered. */
    | { readonly kind: 'ok'; readonly stdout: string }
    /** git ran and answered NO (non-zero exit) — a fact about the repository. */
    | { readonly kind: 'said-no'; readonly stderr: string }
    /** git could not run at all — a fact about the environment. */
    | { readonly kind: 'unavailable'; readonly detail: string };

  const query = async (cwd: string, args: readonly string[]): Promise<QueryOutcome> => {
    const call = await runGit(cwd, args, queryTimeoutMs);
    const unavailable = describeUnavailable(call);
    if (unavailable !== null) {
      return { kind: 'unavailable', detail: unavailable };
    }
    if (call.result.exitCode !== 0) {
      return { kind: 'said-no', stderr: call.result.stderr.trim() };
    }
    return { kind: 'ok', stdout: call.result.stdout.trim() };
  };

  /** Trimmed stdout, or `null` for BOTH failure kinds — for callers that cannot act on the difference. */
  const queryText = async (cwd: string, args: readonly string[]): Promise<string | null> => {
    const outcome = await query(cwd, args);
    return outcome.kind === 'ok' ? outcome.stdout : null;
  };

  /**
   * The registered worktrees, or `null` when git could not answer.
   *
   * The `null` is the whole point, and it replaces an earlier version that
   * returned `[]` on failure. That was a genuine defect with a nasty shape: a
   * timed-out or unspawnable `worktree list` made EVERY recorded worktree look
   * already-absent, so `removeWorktreeAt` returned successfully and story 3.2's
   * `clean` would report a clean sweep while the checkout and its registration
   * were still there. An empty list and an unanswerable question are different
   * facts, and only one of them means "nothing to reap".
   *
   * Callers decide what a `null` means for them: a refusal during root
   * resolution, a thrown `InfraError` during removal. Leaking loudly beats
   * leaking silently — a reaper that cannot see must say so.
   */
  const listWorktreesIn = async (cwd: string): Promise<WorktreeEntry[] | null> => {
    const stdout = await queryText(cwd, worktreeListArgs());
    return stdout === null ? null : parseWorktreeList(stdout);
  };

  /** `listWorktreesIn`, with an unanswerable question raised rather than hidden. */
  const requireWorktrees = async (root: RepoRoot): Promise<WorktreeEntry[]> => {
    const entries = await listWorktreesIn(root.worktreeRoot);
    if (entries === null) {
      throw new InfraError(
        `could not list the worktrees of ${root.mainWorktreeRoot}`,
        'git could not answer; check for a stale index.lock or a hung filesystem, then retry',
      );
    }
    return entries;
  };

  const resolveRoot = async (request: RootRequest): Promise<RootResolution> => {
    const requested = request.explicitRoot ?? request.cwd;

    // Statted before git is spawned, so "you pointed at nothing" is answered
    // precisely rather than arriving as the invalid-cwd ENOENT that looks
    // exactly like a missing binary.
    if (!(await isDirectory(requested))) {
      const exists = await stat(requested).then(
        () => true,
        () => false,
      );
      return exists
        ? {
            outcome: 'not-a-repo',
            path: requested,
            detail: 'path is not a directory',
          }
        : {
            outcome: 'not-found',
            path: requested,
            detail: 'no such directory',
          };
    }

    const cwd = await resolveReal(requested);

    const unusable = await checkGitUsable(cwd);
    if (unusable !== null) {
      return { outcome: 'git-unavailable', path: cwd, detail: unusable };
    }

    // Asked FIRST, because a bare repository has no working tree and
    // `--show-toplevel` fails there for a reason that is not "no repository".
    // Distinguishing the two is what lets the refusal say which it was.
    //
    // And note which failure kind means what: only git ANSWERING no means
    // "there is no repository here". A git that could not run at all says
    // nothing about the directory, and reporting `not-a-repo` for a hung git
    // would tell an operator their perfectly good repository is not one.
    const bare = await query(cwd, ['rev-parse', '--is-bare-repository']);
    if (bare.kind === 'unavailable') {
      return { outcome: 'git-unavailable', path: cwd, detail: bare.detail };
    }
    if (bare.kind === 'said-no') {
      return {
        outcome: 'not-a-repo',
        path: cwd,
        detail:
          request.explicitRoot === undefined
            ? 'no git repository at or above this directory'
            : 'not a git repository',
      };
    }
    if (bare.stdout === 'true') {
      return {
        outcome: 'not-a-repo',
        path: cwd,
        detail: 'this is a bare git repository, which has no working tree',
      };
    }

    const toplevel = await query(cwd, ['rev-parse', '--show-toplevel']);
    if (toplevel.kind === 'unavailable') {
      return { outcome: 'git-unavailable', path: cwd, detail: toplevel.detail };
    }
    if (toplevel.kind === 'said-no' || toplevel.stdout === '') {
      return { outcome: 'not-a-repo', path: cwd, detail: 'no working tree' };
    }
    const worktreeRoot = await resolveReal(toplevel.stdout);

    const commonDir = await query(cwd, ['rev-parse', '--git-common-dir']);
    if (commonDir.kind === 'unavailable') {
      return { outcome: 'git-unavailable', path: cwd, detail: commonDir.detail };
    }
    if (commonDir.kind === 'said-no' || commonDir.stdout === '') {
      return { outcome: 'not-a-repo', path: cwd, detail: 'no git directory' };
    }
    const commonDirRaw = commonDir.stdout;
    // `--git-common-dir` answers RELATIVELY from a main worktree (literally
    // `.git`) and absolutely from a linked one. `--path-format=absolute` would
    // settle it but is git 2.31+, above this module's floor, so it is resolved
    // here instead — against the cwd git was run in, which is what git means.
    const gitCommonDir = await resolveReal(
      isAbsolute(commonDirRaw) ? commonDirRaw : join(cwd, commonDirRaw),
    );

    // git documents the FIRST entry of `worktree list` as the main worktree,
    // and that is the only reliable way to find it: walking up from a linked
    // worktree finds a `.git` FILE, and deriving the main tree from the common
    // dir's parent assumes the `.git` directory is named `.git` and sits inside
    // its working tree — true by default, not true with `GIT_DIR` or a
    // separate git dir.
    const entries = await listWorktreesIn(cwd);
    if (entries === null) {
      // Same rule as every other probe in this function, and it is stated once
      // more here because this was the last place it was still wrong: a git
      // that could not run says nothing about the directory. Only git ANSWERING
      // means "no repository here".
      return { outcome: 'git-unavailable', path: cwd, detail: 'git could not list worktrees' };
    }
    const first = entries[0];
    if (first === undefined) {
      return { outcome: 'not-a-repo', path: cwd, detail: 'git listed no worktrees' };
    }
    const mainWorktreeRoot = await resolveReal(first.path);

    return {
      outcome: 'resolved',
      root: {
        worktreeRoot,
        mainWorktreeRoot,
        gitCommonDir,
        linkedWorktree: worktreeRoot !== mainWorktreeRoot,
      },
    };
  };

  const resolveRef = async (
    root: RepoRoot,
    role: RefRole,
    ref: string,
  ): Promise<RefResolution> => {
    const unusable = await checkGitUsable(root.worktreeRoot);
    if (unusable !== null) {
      return { outcome: 'git-unavailable', role, ref, detail: unusable };
    }

    const call = await runGit(root.worktreeRoot, revParseCommitArgs(ref), queryTimeoutMs);
    const unavailable = describeUnavailable(call);
    if (unavailable !== null) {
      return { outcome: 'git-unavailable', role, ref, detail: unavailable };
    }

    if (call.result.exitCode === 0) {
      const sha = call.result.stdout.trim();
      // 40 hex for a SHA-1 repository, 64 for one created with
      // `git init --object-format=sha256`. Accepting only 40 reported an
      // existing ref in a perfectly valid sha256 repository as `not-found` —
      // an infra misclassification dressed up as a product answer, which is
      // the failure this codebase treats as first-order.
      if (!isObjectId(sha)) {
        // `--verify` should make this unreachable. Refusing rather than
        // trusting it keeps a malformed answer from becoming a worktree at a
        // bogus revision — fail closed, then explain.
        return {
          outcome: 'not-found',
          role,
          ref,
          detail: `git returned something that is not a commit sha: '${sha}'`,
        };
      }

      // A SUCCESSFUL rev-parse is not yet an answer we may use.
      //
      // Measured on git 2.50.1, and it is the trap in this whole function:
      // when a name is answered by both a branch and a tag, `rev-parse
      // --verify` does NOT fail. It prints `warning: refname 'release' is
      // ambiguous.` to stderr, exits 0, and silently returns the TAG's commit
      // by its precedence rules. An operator who passed `--head release`
      // meaning their branch would get a verdict about a different revision,
      // and nothing in the output would say so.
      //
      // So ambiguity is decided here, by TWO independent signals — either one
      // is enough to refuse. Defence in depth, because each covers the other's
      // blind spot:
      //
      //  (a) git's own warning. It is authoritative about git's lookup, which
      //      includes namespaces this module does not enumerate — notably the
      //      pseudorefs at `$GIT_DIR/<name>` (`FETCH_HEAD`, `ORIG_HEAD`,
      //      `MERGE_HEAD`…), which are step ONE of the documented order. A
      //      branch named `FETCH_HEAD` alongside a real `.git/FETCH_HEAD` at a
      //      different commit is genuinely two answers to one name, and an
      //      enumeration that walked only `refs/**` would call that
      //      unambiguous. Matching prose is brittle on its own, which is why it
      //      is not on its own.
      //
      //  (b) enumerating the `refs/**` candidates and comparing the COMMITS
      //      they resolve to. This keeps working if git rewords or drops the
      //      warning, and — because it compares commits rather than counting
      //      refs — it does NOT refuse the everyday harmless case where a
      //      branch and its remote-tracking ref sit at the same commit.
      const warnedAmbiguous = /\bambiguous\b/i.test(call.result.stderr);
      const candidates = await candidateRefs(root, ref);
      if (candidates === null) {
        // The ambiguity check could not run. Returning `resolved` here would
        // accept git's precedence pick BECAUSE the check that guards against it
        // failed — exactly backwards. Fail closed.
        return {
          outcome: 'git-unavailable',
          role,
          ref,
          detail: `could not enumerate the refs named '${ref}' to check for ambiguity`,
        };
      }

      const distinct = new Set(candidates.map((candidate) => candidate.commit));

      // Git's warning alone is NOT sufficient grounds to refuse, and this is
      // the line that got it wrong first: git warns whenever more than one
      // thing answers to a name, INCLUDING the everyday harmless case where a
      // branch and its remote-tracking ref sit at the same commit. Refusing on
      // the warning alone failed a run that had exactly one possible meaning.
      //
      // The precise question is not "did git see several candidates" but "did
      // git resolve to something this module cannot account for". If the sha
      // git returned is one of the commits the enumerated refs point at, the
      // answer is unambiguous whatever git warned. If it is NOT, git resolved
      // through a namespace invisible here — a pseudoref at `$GIT_DIR/<name>`,
      // step one of its documented order — and there is no way to compare that
      // candidate, so the only safe answer is to refuse.
      const accountedFor = candidates.some((candidate) => candidate.commit === sha);
      if (distinct.size > 1 || (warnedAmbiguous && !accountedFor)) {
        return {
          outcome: 'ambiguous',
          role,
          ref,
          candidates: candidates.map((candidate) => candidate.refname),
          detail:
            distinct.size > 1
              ? `${distinct.size} refs named '${ref}' point at different commits`
              : `git reports '${ref}' as ambiguous and resolved it outside refs/ (a pseudoref such as FETCH_HEAD)`,
        };
      }

      return { outcome: 'resolved', role, ref, sha };
    }

    const stderr = call.result.stderr.trim();

    // A non-zero `rev-parse` USUALLY means "no such ref" — but not always, and
    // the difference matters because `not-found` carries a `git fetch` hint.
    // A repository that became unreadable between root resolution and here (a
    // deleted or corrupted `.git`, a permission change, an unmounted network
    // filesystem) also exits non-zero, and telling that operator to run
    // `git fetch` is a confidently wrong diagnosis — worse than a vague one,
    // and exactly the mistake `isBinaryNotFound` was fixed twice to avoid.
    //
    // So the repository is re-probed rather than assumed. This is the only
    // thing that makes `resolveRef`'s `not-a-repo` arm reachable; an arm no
    // code path can produce is a sign the classification is wrong, not that
    // the arm is spare.
    const stillARepository = await query(root.worktreeRoot, ['rev-parse', '--is-inside-work-tree']);
    if (stillARepository.kind !== 'ok') {
      return {
        outcome: 'not-a-repo',
        role,
        ref,
        detail:
          stderr === ''
            ? `${root.worktreeRoot} is no longer a readable git repository`
            : stderr,
      };
    }

    return {
      outcome: 'not-found',
      role,
      ref,
      detail: stderr === '' ? 'unknown revision' : stderr,
    };
  };

  /**
   * The refs under `refs/**` that a short name could mean, or `null` when git
   * could not answer.
   *
   * These are the five `refs/`-rooted namespaces `gitrevisions(7)` searches, in
   * its order. Spelling them out mirrors git's rule rather than inventing a
   * looser one: a `**\/<ref>` glob would also match `refs/heads/topic/release`
   * for the input `release`, which git would never resolve, and refusing a run
   * over a ref git considers unrelated would be its own kind of wrong.
   *
   * NOT covered here, deliberately: step ONE of git's order, the pseudorefs at
   * `$GIT_DIR/<name>` (`FETCH_HEAD`, `ORIG_HEAD`, `MERGE_HEAD`…). They are not
   * refs and `for-each-ref` cannot see them. Rather than reimplementing git's
   * pseudoref resolution — including `FETCH_HEAD`'s own multi-line format —
   * `resolveRef` leans on git's own ambiguity warning for that case, which is
   * authoritative about git's lookup by construction. The two signals together
   * cover the whole documented order; this function alone does not, and an
   * earlier version of this comment wrongly claimed it did.
   *
   * `%(*objectname)` is the DEREFERENCED object — non-empty only for annotated
   * tags, where `%(objectname)` is the tag object rather than the commit. Using
   * it applies the same `^{commit}` peel the resolution itself performs, so a
   * tag and a branch at one commit compare equal instead of looking like two
   * different revisions.
   */
  const candidateRefs = async (
    root: RepoRoot,
    ref: string,
  ): Promise<{ refname: string; commit: string }[] | null> => {
    const stdout = await queryText(root.worktreeRoot, [
      'for-each-ref',
      '--format=%(refname) %(objectname) %(*objectname)',
      '--',
      `refs/${ref}`,
      `refs/tags/${ref}`,
      `refs/heads/${ref}`,
      `refs/remotes/${ref}`,
      `refs/remotes/${ref}/HEAD`,
    ]);
    // `null` is git failing to answer; `''` is git answering "no such refs".
    // Collapsing the two is what let a failed ambiguity check read as "no
    // candidates, therefore unambiguous".
    if (stdout === null) {
      return null;
    }
    if (stdout === '') {
      return [];
    }

    return stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        const [refname = '', objectName = '', dereferenced = ''] = line.split(' ');
        return { refname, commit: dereferenced !== '' ? dereferenced : objectName };
      });
  };

  const listWorktrees = async (root: RepoRoot): Promise<readonly WorktreeEntry[]> => {
    const unusable = await checkGitUsable(root.worktreeRoot);
    if (unusable !== null) {
      throw new InfraError(
        `git could not be run: ${unusable}`,
        'install git and reopen your shell',
      );
    }
    return await requireWorktrees(root);
  };

  /** True when a worktree at `path` is currently registered in the repository. */
  const isRegistered = async (root: RepoRoot, path: string): Promise<boolean> => {
    const entries = await requireWorktrees(root);
    const target = await resolveReal(path);
    for (const entry of entries) {
      if ((await resolveReal(entry.path)) === target) {
        return true;
      }
    }
    return false;
  };

  const addWorktree = async (
    root: RepoRoot,
    sha: string,
    hooks?: AddWorktreeHooks,
  ): Promise<CreatedWorktree> => {
    const unusable = await checkGitUsable(root.worktreeRoot);
    if (unusable !== null) {
      throw new InfraError(
        `git could not be run: ${unusable}`,
        'install git and reopen your shell',
      );
    }

    // AD-8: under the OS temp dir, NEVER inside the source repository's working
    // tree. An `mkdtemp` inside the repo would put SpecWitness files in the
    // project working tree and show up in the operator's `git status` — the
    // exact thing AC2 forbids. realpath'd first because on macOS `tmpdir()` is
    // a symlink and git reports the resolved form; comparing the two later
    // without this silently answers the wrong question.
    const tempRoot = await resolveReal(tmpdir());
    const container = await resolveReal(await mkdtemp(join(tempRoot, CONTAINER_PREFIX)));
    const worktreePath = join(container, WORKTREE_DIR);

    // Belt and braces: if some future tmpdir configuration ever pointed inside
    // the repository, the invariant is checked rather than trusted.
    if (isInside(root.mainWorktreeRoot, container)) {
      await rm(container, { recursive: true, force: true });
      throw new InfraError(
        `refusing to create a worktree inside the source repository: ${container}`,
        'the OS temp directory resolves inside the repository being verified; set TMPDIR to a location outside it',
      );
    }

    // AD-8's ordering, made STRUCTURAL: the manifest write happens here, before
    // any git write, and a rejecting hook aborts creation. A worktree therefore
    // cannot come into existence unrecorded.
    //
    // The residual window, stated honestly rather than papered over: the
    // `mkdtemp` above already created an empty container directory, so a
    // `kill -9` between mkdtemp and the hook leaves one empty temp directory
    // with no git registration. Nothing needs to reap that — it holds no
    // resource, `clean` correctly treats an unregistered path as a no-op, and
    // the OS temp policy removes it. What matters for crash recovery is the
    // REGISTRATION, and that is strictly after the record. (bob's 3.2 header
    // documents the same one-syscall shape for pgids, for the same reason: a
    // pgid cannot be known before fork.)
    try {
      await hooks?.onPathReserved?.(worktreePath);
    } catch (cause) {
      await rm(container, { recursive: true, force: true });
      throw cause;
    }

    const call = await runGit(
      root.worktreeRoot,
      worktreeAddArgs(worktreePath, sha),
      worktreeTimeoutMs,
    );
    const unavailable = describeUnavailable(call);
    if (unavailable !== null || call.result.exitCode !== 0) {
      // A FAILED add may still have REGISTERED. The clearest case is a timeout
      // arriving after `git worktree add` wrote `.git/worktrees/<name>` but
      // before it finished; deleting only the container would then leave a
      // registration whose directory is gone, and the next `worktree add` at
      // that path fails with a confusing error. So the registration is cleared
      // first, and the container second.
      //
      // Best-effort, deliberately: if this cleanup also fails we still throw
      // the ORIGINAL error, because it explains what actually went wrong.
      // Nothing is lost by that — the path was recorded in the run manifest
      // before any of this ran, so story 3.2's `clean` reaps it. That ordering
      // is precisely what the manifest is for.
      await removeWorktreeAt(root, worktreePath).catch(() => undefined);
      await rm(container, { recursive: true, force: true });
      const detail = unavailable ?? call.result.stderr.trim();
      throw new InfraError(
        `could not create the verification worktree at ${worktreePath}: ${detail || 'git failed without output'}`,
        'check free space and permissions on the OS temp directory',
      );
    }

    return { path: worktreePath, sha, container };
  };

  const removeWorktreeAt = async (root: RepoRoot, worktreePath: string): Promise<void> => {
    const unusable = await checkGitUsable(root.worktreeRoot);
    if (unusable !== null) {
      throw new InfraError(
        `git could not be run: ${unusable}`,
        'install git and reopen your shell',
      );
    }

    // Checked against the registration LIST rather than by attempting the
    // removal and interpreting the failure. `git worktree remove` on an
    // unregistered path exits 128 with `fatal: '…' is not a working tree`
    // (measured on 2.50.1), and matching that message would tie this module to
    // git's prose. An already-absent worktree is a NO-OP because `clean`
    // replays manifests: a reaper that fails on an already-reaped entry stops
    // reaping the entries that are still live.
    if (!(await isRegistered(root, worktreePath))) {
      return;
    }

    const call = await runGit(
      root.worktreeRoot,
      worktreeRemoveArgs(worktreePath),
      worktreeTimeoutMs,
    );
    const unavailable = describeUnavailable(call);
    if (unavailable !== null || call.result.exitCode !== 0) {
      const detail = unavailable ?? call.result.stderr.trim();
      throw new InfraError(
        `could not remove the verification worktree at ${worktreePath}: ${detail || 'git failed without output'}`,
        `run 'git worktree prune' in ${root.mainWorktreeRoot}`,
      );
    }

    // The registration is what matters, not the directory. git keeps admin
    // files under `.git/worktrees/<name>` that survive an `rm -rf` of the
    // checkout, and a registration that outlives its directory makes the next
    // `worktree add` at that path fail confusingly. Verified rather than
    // assumed, because "removed" must mean one thing to this module and to
    // 3.2's `clean`.
    if (await isRegistered(root, worktreePath)) {
      throw new InfraError(
        `worktree removal left a registration behind for ${worktreePath}`,
        `run 'git worktree prune' in ${root.mainWorktreeRoot}`,
      );
    }
  };

  const removeWorktree = async (root: RepoRoot, worktree: CreatedWorktree): Promise<void> => {
    await removeWorktreeAt(root, worktree.path);
    // Only the happy path knows the container, so only the happy path removes
    // it. `force: true` so a container already gone is not an error.
    await rm(worktree.container, { recursive: true, force: true });
  };

  return {
    resolveRoot,
    resolveRef,
    listWorktrees,
    addWorktree,
    removeWorktree,
    removeWorktreeAt,
  };
}

/**
 * `clean`'s entry point (story 3.2) — removal addressed by plain paths.
 *
 * bob asked for this shape explicitly during cohort intent-sync, and the reason
 * is worth keeping next to the code: `clean` replays a run manifest after a
 * crash. It holds a project root and a list of recorded worktree paths, nothing
 * else. Requiring a resolved `RepoRoot` first would mean a repository that has
 * become strange since the crash could make `clean` REFUSE TO REAP — at exactly
 * the moment reaping matters most. So this form does the minimum: it treats
 * `repoRootPath` as a cwd for git and never asks whether the repository is one
 * SpecWitness would agree to verify.
 */
export async function removeWorktreeAtPath(
  repoRootPath: string,
  worktreePath: string,
  options?: GitVcsOptions,
): Promise<void> {
  // The runner defaults so `clean` can call this with the two arguments bob
  // asked for. Defaulting a port rather than requiring it is the shape the
  // merged `createDoctorEffects(clock = new SystemClock())` already uses, and
  // it keeps injection available for tests — which is what AD-9 is protecting.
  const vcs = createGitVcs(options ?? { runner: createProcessRunner(new SystemClock()) });
  const root: RepoRoot = {
    worktreeRoot: repoRootPath,
    mainWorktreeRoot: repoRootPath,
    gitCommonDir: join(repoRootPath, '.git'),
    linkedWorktree: false,
  };
  await vcs.removeWorktreeAt(root, worktreePath);
}
