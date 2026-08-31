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

import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
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
  try {
    await stat(join(projectRoot, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * The branch `HEAD` points at, or `master` when that cannot be determined.
 *
 * The written `project.baseBranch` is an observation rather than a guess: a
 * repository whose default branch is `main` gets `main`, so `doctor`'s
 * base-branch check resolves instead of reporting a phantom `master`.
 *
 * Never throws. A repository we cannot read HEAD from still gets a config
 * file — only the placeholder's accuracy is affected, and `doctor` will say so.
 */
export async function readHeadBranch(projectRoot: string): Promise<string> {
  try {
    const gitDir = await resolveGitDir(projectRoot);
    if (gitDir === undefined) {
      return FALLBACK_BASE_BRANCH;
    }

    const head = await readFile(join(gitDir, 'HEAD'), 'utf8');
    // A detached HEAD holds a raw sha and matches nothing here.
    const match = /^ref:\s*refs\/heads\/(.+)$/m.exec(head.trim());
    return match?.[1]?.trim() || FALLBACK_BASE_BRANCH;
  } catch {
    return FALLBACK_BASE_BRANCH;
  }
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
  const exists = await stat(gitDir).catch(() => undefined);
  return exists === undefined ? undefined : gitDir;
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

  // PHASE 2 — write. Nothing below throws for a reason phase 1 could have seen.
  await ensureDirectory(projectDir, PROJECT_DIR, present, created, skipped);

  if (configContents === undefined) {
    skipped.push(configRelative);
  } else {
    await write(configAbsolute, configContents);
    // Replaced, not created: the user had a file there and now does not.
    (configPresent ? replaced : created).push(configRelative);
  }

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

  return { created, skipped, replaced, configWritten };
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
  const branch = await readHeadBranch(projectRoot);

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

  await write(absolute, contents);
  created.push(relative);
}

async function write(absolute: string, contents: string): Promise<void> {
  try {
    await writeFile(absolute, contents, 'utf8');
  } catch (err) {
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
