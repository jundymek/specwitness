/**
 * FR-1 — scaffolding for `.specwitness/`.
 *
 * Everything this module writes lives inside `<projectRoot>/.specwitness/`.
 * Nothing else in the user's repository is created, modified or deleted — not
 * even their `.gitignore` (AD-8 spirit; the local-only entries go in a nested
 * `.specwitness/.gitignore` instead, which is Q11's outcome without editing a
 * file the user owns).
 *
 * No subprocess, no network, no environment reads: repository detection and
 * branch discovery are pure filesystem reads, so `init` has no execution
 * surface at all.
 *
 * AD-8 note: `runs/` is created here as an empty directory and nothing is ever
 * written inside it. `RunStore` remains the sole writer under
 * `.specwitness/runs/<run-id>/`; creating the parent root does not cross that
 * boundary (confirmed with the owner of story 1.6).
 */

import { lstat, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stringify } from 'yaml';

import { InfraError } from '../domain/errors.js';

/** The project directory. Fixed name — Epic 2 and 3 both address it literally. */
export const PROJECT_DIR = '.specwitness';

/**
 * Subdirectories, in creation order. These names are contract: Epic 2 commits
 * contracts/ and plans/, Epic 3+ writes runs/. Renaming one breaks stories
 * that have not been written yet.
 */
const SUBDIRECTORIES = ['contracts', 'plans', 'runs'] as const;

/**
 * Local-only artifacts (spine "Git vs local"). config.yaml, contracts/ and
 * plans/ are reviewable product artifacts and stay committed; run evidence and
 * the scorecard are machine-local.
 */
const GITIGNORE_CONTENTS = [
  '# Local-only SpecWitness artifacts — evidence of runs on THIS machine.',
  '# config.yaml, contracts/ and plans/ are deliberately not listed: they are',
  '# reviewable product artifacts and belong in version control.',
  'runs/',
  'scorecard.jsonl',
  '',
].join('\n');

/** The literal the template ships, replaced with the repository's real branch. */
const TEMPLATE_BASE_BRANCH = 'master';

/** Used when HEAD cannot be read, or points at a commit rather than a branch. */
const FALLBACK_BASE_BRANCH = 'master';

export interface ScaffoldOptions {
  /**
   * Overwrite `config.yaml`. Deliberately narrow: it never deletes or rewrites
   * the contents of contracts/, plans/ or runs/, which hold committed
   * artifacts and run evidence.
   */
  readonly force?: boolean;
}

export interface ScaffoldResult {
  /** Repo-relative paths created by this call, in creation order. */
  readonly created: readonly string[];
  /** Repo-relative paths that already existed and were left untouched. */
  readonly skipped: readonly string[];
  /**
   * Repo-relative paths that existed and were overwritten. Only ever
   * `.specwitness/config.yaml`, and only under `force` — reporting a replaced
   * file as "created" would misdescribe what happened to the user's data.
   */
  readonly replaced: readonly string[];
  /** Whether `config.yaml` was written (fresh scaffold or `--force`). */
  readonly configWritten: boolean;
}

/**
 * True when `projectRoot` is the top of a Git working tree.
 *
 * Accepts a `.git` FILE as well as a directory: linked worktrees and
 * submodules use a file containing `gitdir: <path>`. Rejecting those would
 * make `init` unusable inside any worktree.
 *
 * Deliberately does NOT search upward. `init` scaffolds where it is pointed or
 * refuses — an upward search would silently write into a directory the user
 * never named (`--root` arrives in Epic 3).
 */
export async function isGitRepository(projectRoot: string): Promise<boolean> {
  const dotGit = join(projectRoot, '.git');
  const entry = await stat(dotGit).catch(() => undefined);
  if (entry === undefined) {
    return false;
  }
  if (entry.isDirectory()) {
    return true;
  }

  // A `.git` FILE is only a repository when it actually points at a real
  // gitdir. A stale or unrelated file of that name is junk, and scaffolding
  // into it would contradict AC3 — the directory genuinely is not a working
  // tree. Resolution stays filesystem-only.
  //
  // Deliberately NOT stricter than that: a `.git` DIRECTORY is accepted on
  // existence alone, without requiring a readable HEAD. The spec's rule is
  // "presence of a `.git` entry", `git init` always writes HEAD, and doctor's
  // git checks are the right place to diagnose a corrupted repository.
  return (await resolveGitDir(projectRoot)) !== undefined;
}

/**
 * The repository's DEFAULT branch — the one an epic is verified against — or
 * `master` when it cannot be determined.
 *
 * Deliberately not "the branch that is checked out". `project.baseBranch` is
 * the branch a finished epic is compared to, and `init` is very often run from
 * a feature branch. Writing the current branch there would produce a valid,
 * plausible, silently WRONG config: verification would diff the epic against
 * itself and see no changes. A placeholder the user must correct is far better
 * than a value that looks right and is not.
 *
 * Sources, best first, all filesystem-only:
 *   1. `refs/remotes/origin/HEAD` — what the remote calls its default branch.
 *   2. A local `main` or `master`, whichever exists.
 *   3. `HEAD`'s branch, but ONLY when its ref does not exist yet — that is a
 *      freshly initialised repository with no commits, where the checked-out
 *      branch genuinely IS the intended default.
 *   4. `master`.
 *
 * Never throws: a repository we cannot read still gets a config file, and only
 * the placeholder's accuracy is affected. `doctor` reports the rest.
 */
export async function readBaseBranch(projectRoot: string): Promise<string> {
  try {
    const gitDir = await resolveGitDir(projectRoot);
    if (gitDir === undefined) {
      return FALLBACK_BASE_BRANCH;
    }

    // Refs live in the COMMON dir, which is the gitdir itself for an ordinary
    // repository but the main repository's `.git` for a linked worktree — a
    // worktree gitdir has its own HEAD and no `refs/heads` of its own. Looking
    // for refs in the wrong place made every worktree look like a fresh repo
    // with no branches, which is exactly when the checked-out branch gets used.
    const commonDir = await resolveCommonDir(gitDir);

    const fromRemote = await readRemoteDefaultBranch(commonDir);
    if (fromRemote !== undefined) {
      return fromRemote;
    }

    for (const conventional of ['main', 'master']) {
      if (await branchExists(commonDir, conventional)) {
        return conventional;
      }
    }

    // HEAD is per-worktree, so it is read from the gitdir, not the common dir.
    const checkedOut = await readHeadBranch(gitDir);
    if (checkedOut !== undefined && !(await branchExists(commonDir, checkedOut))) {
      // No ref for it yet: `git init` before the first commit. Nothing else
      // exists to prefer, and this is the branch the user chose.
      return checkedOut;
    }

    return FALLBACK_BASE_BRANCH;
  } catch {
    return FALLBACK_BASE_BRANCH;
  }
}

/**
 * Where a repository's refs actually live.
 *
 * A linked worktree's gitdir holds a `commondir` file pointing at the main
 * repository's `.git`; `refs/heads`, `refs/remotes` and `packed-refs` are all
 * there, not in the worktree gitdir.
 */
async function resolveCommonDir(gitDir: string): Promise<string> {
  const pointer = await readFile(join(gitDir, 'commondir'), 'utf8').catch(() => undefined);
  const target = pointer?.trim();
  if (target === undefined || target === '') {
    return gitDir;
  }
  return isAbsolute(target) ? target : resolve(gitDir, target);
}

/** The branch `HEAD` names, or undefined when detached or unreadable. */
async function readHeadBranch(gitDir: string): Promise<string | undefined> {
  const head = await readFile(join(gitDir, 'HEAD'), 'utf8').catch(() => undefined);
  if (head === undefined) {
    return undefined;
  }
  // A detached HEAD holds a raw sha and matches nothing here.
  const match = /^ref:\s*refs\/heads\/(.+)$/m.exec(head.trim());
  return match?.[1]?.trim() || undefined;
}

/**
 * What `origin` calls its default branch, from the symbolic ref git writes on
 * clone.
 *
 * ONLY the loose file. `packed-refs` holds ordinary remote-tracking branches —
 * git leaves symbolic refs loose and never packs them — so scanning it would
 * pick whichever `origin/*` happened to come first, and a repository with
 * packed `origin/develop` and `origin/main` would get `develop` as its base
 * branch. Absent the symbolic ref, the local `main`/`master` check is the
 * honest next signal.
 */
async function readRemoteDefaultBranch(gitDir: string): Promise<string | undefined> {
  const loose = await readFile(join(gitDir, 'refs', 'remotes', 'origin', 'HEAD'), 'utf8').catch(
    () => undefined,
  );
  if (loose === undefined) {
    return undefined;
  }
  const match = /^ref:\s*refs\/remotes\/origin\/(.+)$/m.exec(loose.trim());
  return match?.[1]?.trim() || undefined;
}

/** True when a local branch ref exists, loose or packed. */
async function branchExists(gitDir: string, branch: string): Promise<boolean> {
  const loose = await stat(join(gitDir, 'refs', 'heads', ...branch.split('/'))).catch(
    () => undefined,
  );
  if (loose !== undefined) {
    return true;
  }

  const packed = await readFile(join(gitDir, 'packed-refs'), 'utf8').catch(() => undefined);
  return packed === undefined
    ? false
    : new RegExp(`^\\S+\\s+refs/heads/${escapeForRegExp(branch)}$`, 'm').test(packed);
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolves the directory holding `HEAD`, following the one indirection a
 * linked worktree or submodule introduces.
 */
async function resolveGitDir(projectRoot: string): Promise<string | undefined> {
  const dotGit = join(projectRoot, '.git');

  const info = await stat(dotGit).catch(() => undefined);
  if (info === undefined) {
    return undefined;
  }
  if (info.isDirectory()) {
    return dotGit;
  }

  const pointer = await readFile(dotGit, 'utf8').catch(() => undefined);
  const target = pointer === undefined ? undefined : /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
  if (target === undefined || target === '') {
    return undefined;
  }

  // A relative gitdir is relative to the working tree that named it.
  const gitDir = isAbsolute(target) ? target : resolve(projectRoot, target);
  // Must be a DIRECTORY: `gitdir: notes.txt` pointing at a regular file (or a
  // FIFO, or a socket) is a stale pointer, not a worktree, and accepting it
  // would let `init` scaffold where AC3 says it must refuse.
  const targetEntry = await stat(gitDir).catch(() => undefined);
  return targetEntry?.isDirectory() === true ? gitDir : undefined;
}

/**
 * Creates the `.specwitness/` layout, returning what was created and what was
 * left alone.
 *
 * Idempotent by construction: a re-run completes whatever is missing and
 * touches nothing that already exists. Only `force` may replace an existing
 * `config.yaml`, and nothing else is ever overwritten.
 *
 * @throws {InfraError} when the filesystem refuses a write, or the shipped
 *   template is missing (a broken install, not a user error).
 */
export async function scaffold(
  projectRoot: string,
  options: ScaffoldOptions = {},
): Promise<ScaffoldResult> {
  const created: string[] = [];
  const skipped: string[] = [];
  const replaced: string[] = [];

  const projectDir = join(projectRoot, PROJECT_DIR);
  const configRelative = `${PROJECT_DIR}/config.yaml`;
  const configAbsolute = join(projectDir, 'config.yaml');

  // PHASE 1 — inspect everything, change nothing.
  //
  // Every reason this call can fail is discovered here, before a single byte is
  // written. Validating lazily as we went meant `--force` could replace the
  // user's config and only THEN discover that `contracts/` was a regular file:
  // the command would fail having already destroyed the one thing it was told
  // to be careful with.
  const present = await inspectLayout(projectDir);
  const configPresent = present.get(configRelative) !== undefined;
  const configWritten = !configPresent || options.force === true;

  // Rendered here too, so a broken install (missing or malformed template)
  // fails while the repository is still untouched.
  const configContents = configWritten ? await renderConfig(projectRoot) : undefined;

  // PHASE 2 — write, in the order that risks the user's data least.
  //
  // Replacing an existing config is the ONLY irreversible thing this command
  // does, so it goes LAST: everything else that can fail has already succeeded
  // by then. Phase 1 cannot catch every failure — an existing writable
  // config.yaml inside a read-only `.specwitness/` is overwritable while
  // creating a new file beside it is not — so ordering, not inspection, is what
  // guarantees `--force` never destroys the config and then fails.
  await ensureDirectory(projectDir, PROJECT_DIR, present, created, skipped);

  await ensureFile(
    join(projectDir, '.gitignore'),
    `${PROJECT_DIR}/.gitignore`,
    GITIGNORE_CONTENTS,
    present,
    created,
    skipped,
  );

  for (const name of SUBDIRECTORIES) {
    await ensureDirectory(
      join(projectDir, name),
      `${PROJECT_DIR}/${name}`,
      present,
      created,
      skipped,
    );
  }

  if (configContents === undefined) {
    skipped.push(configRelative);
  } else {
    await write(configAbsolute, configContents, !configPresent);
    // Replaced, not created: the user had a file there and now does not.
    (configPresent ? replaced : created).push(configRelative);
  }

  // Reported in layout order rather than write order: which write happens first
  // is an internal safety detail and should not reshuffle what the user reads.
  return {
    created: inLayoutOrder(created),
    skipped: inLayoutOrder(skipped),
    replaced: inLayoutOrder(replaced),
    configWritten,
  };
}

/** Keeps reported paths in a stable, human-sensible order. */
function inLayoutOrder(paths: readonly string[]): string[] {
  const order = LAYOUT.map((entry) => entry.relative);
  return [...paths].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** What the scaffold expects at each path. */
const LAYOUT: ReadonlyArray<{ relative: string; kind: 'directory' | 'file' }> = [
  { relative: PROJECT_DIR, kind: 'directory' },
  { relative: `${PROJECT_DIR}/config.yaml`, kind: 'file' },
  { relative: `${PROJECT_DIR}/.gitignore`, kind: 'file' },
  ...SUBDIRECTORIES.map((name) => ({ relative: `${PROJECT_DIR}/${name}`, kind: 'directory' as const })),
];

/**
 * Checks every layout entry that already exists, and returns the ones that do.
 *
 * Uses `lstat`, never `stat`: `stat` follows symlinks, so a symlinked
 * `config.yaml` would let `--force` overwrite whatever it points at — any file
 * the user can write, anywhere on the filesystem. Every write this module makes
 * must land inside `.specwitness/`.
 *
 * @throws {InfraError} for a symlink, or an entry of the wrong type.
 */
async function inspectLayout(projectDir: string): Promise<Map<string, true>> {
  const present = new Map<string, true>();

  for (const { relative, kind } of LAYOUT) {
    // `relative` always starts with PROJECT_DIR, so this reconstructs the
    // absolute path without re-deriving the project root.
    const absolute = join(projectDir, '..', relative);
    const entry = await lstat(absolute).catch(() => undefined);
    if (entry === undefined) {
      continue;
    }

    rejectSymlink(entry, relative, absolute);

    // Naming what IS there beats "not a directory": the user has to find the
    // offending entry, and a socket looks identical to a file in `ls`.
    if (kind === 'directory' && !entry.isDirectory()) {
      throw new InfraError(
        `${relative} exists but is ${describeEntry(entry)}, not a directory`,
        `remove or rename ${absolute}, then run 'specwitness init' again`,
      );
    }
    if (kind === 'file' && !entry.isFile()) {
      // Not just directories: a FIFO would make `--force` block forever, and
      // `init` must never hang — it is called by agents with no TTY.
      throw new InfraError(
        `${relative} exists but is ${describeEntry(entry)}, not a regular file`,
        `remove or rename ${absolute}, then run 'specwitness init' again`,
      );
    }

    present.set(relative, true);
  }

  return present;
}

/** The shipped template with the base-branch placeholder resolved (D4/D12). */
async function renderConfig(projectRoot: string): Promise<string> {
  const template = await readTemplate();
  const branch = await readBaseBranch(projectRoot);

  const pattern = new RegExp(`^(\\s*baseBranch:\\s*)${TEMPLATE_BASE_BRANCH}\\s*$`, 'gm');
  const matches = template.match(pattern) ?? [];
  if (matches.length !== 1) {
    // A reformatted template must fail loudly rather than silently shipping a
    // branch name that does not describe this repository.
    throw new InfraError(
      `the SpecWitness config template is malformed: expected exactly one 'baseBranch: ${TEMPLATE_BASE_BRANCH}' line, found ${matches.length}`,
      'reinstall SpecWitness — this indicates a corrupted or modified installation',
    );
  }

  // Serialized as a YAML scalar rather than interpolated raw. Git permits
  // branch names like `true`, `null` and `123`, which YAML would otherwise
  // read as a boolean, a null and a number — producing a config that fails
  // validation on the very first `doctor` run. `yaml` quotes only when it must,
  // so the ordinary `main` / `master` case stays unquoted.
  const scalar = stringify(branch).trim();

  // A replacement FUNCTION, not a string: `$&`, `` $` `` and `$'` are special in
  // a string replacement, and a branch name may legitimately contain `$`.
  return template.replace(pattern, (_match, indent: string) => `${indent}${scalar}`);
}

/**
 * Reads `templates/config.yaml` from the installed package.
 *
 * Walks up from this module rather than using a fixed relative path, because
 * the distance to the package root differs between contexts: the bundle lives
 * at `dist/cli.js` (one level down) while the sources run from
 * `src/infra/scaffold.ts` (two). One hardcoded path cannot serve both, and
 * this survives a change to the build layout.
 */
async function readTemplate(): Promise<string> {
  const templatePath = await findTemplate();
  if (templatePath === undefined) {
    throw new InfraError(
      'the SpecWitness config template (templates/config.yaml) is missing from the installation',
      "reinstall SpecWitness, e.g. 'npm install -g specwitness'",
    );
  }

  try {
    return await readFile(templatePath, 'utf8');
  } catch (err) {
    throw new InfraError(
      `cannot read the SpecWitness config template at ${templatePath}: ${describe(err)}`,
      "reinstall SpecWitness, e.g. 'npm install -g specwitness'",
    );
  }
}

async function findTemplate(): Promise<string | undefined> {
  let directory = dirname(fileURLToPath(import.meta.url));

  // Bounded by the filesystem root: `dirname('/')` is `/`, so the loop ends.
  for (;;) {
    const candidate = join(directory, 'templates', 'config.yaml');
    if (await pathExists(candidate)) {
      return candidate;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

/** Phase 2. Type validity was already established by `inspectLayout`. */
async function ensureDirectory(
  absolute: string,
  relative: string,
  present: ReadonlyMap<string, true>,
  created: string[],
  skipped: string[],
): Promise<void> {
  if (present.has(relative)) {
    skipped.push(relative);
    return;
  }

  try {
    await mkdir(absolute, { recursive: true });
  } catch (err) {
    throw new InfraError(
      `cannot create ${relative} in this repository: ${describe(err)}`,
      `check that ${absolute} is writable and is not an existing file`,
    );
  }
  created.push(relative);
}

/** Phase 2. Never overwrites: an existing file may carry the user's own edits. */
async function ensureFile(
  absolute: string,
  relative: string,
  contents: string,
  present: ReadonlyMap<string, true>,
  created: string[],
  skipped: string[],
): Promise<void> {
  if (present.has(relative)) {
    skipped.push(relative);
    return;
  }

  await write(absolute, contents, true);
  created.push(relative);
}

/**
 * Writes a scaffold file.
 *
 * `exclusive` uses `wx`, which fails if the path exists at open time — a
 * symlink included. That closes the check-then-write gap for files we believe
 * are absent: `inspectLayout` saw nothing there, so if something has appeared
 * by now the write must not proceed, and certainly must not follow it out of
 * `.specwitness/`.
 *
 * The replacing write (`--force` over an existing config) cannot use `wx`, and
 * a narrow race remains there: an entry validated as a regular file could be
 * swapped for a symlink before the write lands. That is accepted rather than
 * fixed. Closing it needs `O_NOFOLLOW` plus directory-handle-relative writes,
 * which Node does not expose portably, and it buys little: the attacker must
 * already have write access to `.specwitness/` inside the user's own working
 * tree, at which point they can corrupt the config directly without a race.
 */
async function write(absolute: string, contents: string, exclusive = false): Promise<void> {
  if (exclusive) {
    try {
      await writeFile(absolute, contents, { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      throw new InfraError(
        `cannot write ${absolute}: ${describe(err)}`,
        'check the directory permissions and that the filesystem is not read-only',
      );
    }
    return;
  }

  // Replacing an existing file: write a sibling and rename over it. Opening
  // with `w` truncates FIRST, so a disk-full, an I/O error or a kill between
  // truncate and write would leave the user's config empty — losing exactly the
  // data the surrounding write ordering exists to protect. `rename` within a
  // directory is atomic, so the file is either the old one or the new one.
  const temporary = `${absolute}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, absolute);
  } catch (err) {
    await unlink(temporary).catch(() => undefined);
    throw new InfraError(
      `cannot write ${absolute}: ${describe(err)}`,
      'check the directory permissions and that the filesystem is not read-only',
    );
  }
}

/** Names what is actually at a path, so the error tells the user what to look for. */
function describeEntry(entry: {
  isDirectory(): boolean;
  isFile(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
}): string {
  if (entry.isDirectory()) return 'a directory';
  if (entry.isFile()) return 'a regular file';
  if (entry.isFIFO()) return 'a named pipe';
  if (entry.isSocket()) return 'a socket';
  if (entry.isBlockDevice() || entry.isCharacterDevice()) return 'a device node';
  return 'not a regular file or directory';
}

/**
 * Refuses to treat a symlink as part of the scaffold layout.
 *
 * This module promises that every write lands inside `<projectRoot>/.specwitness/`.
 * A symlink breaks that promise silently: `--force` on a symlinked `config.yaml`
 * would overwrite the link's target, which may be any file the user can write,
 * and a symlinked directory would put run evidence and contracts somewhere the
 * user never named. Fail closed and say why, rather than following it.
 */
function rejectSymlink(
  entry: { isSymbolicLink(): boolean } | undefined,
  relative: string,
  absolute: string,
): void {
  if (entry?.isSymbolicLink() === true) {
    throw new InfraError(
      `${relative} is a symbolic link; SpecWitness will not write through it`,
      `replace ${absolute} with a real file or directory, then run 'specwitness init' again`,
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === undefined ? err.message : `${code}`;
  }
  return String(err);
}
