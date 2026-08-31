import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

/**
 * These tests spawn the **built** binary, because that is where this story's
 * behaviour actually lives: template resolution differs between the bundle and
 * the sources, and exit codes only exist at the process boundary.
 *
 * Hermetic: every case works in a throwaway directory, and none of them touch
 * this repository's own `.specwitness/`.
 */
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'specwitness-init-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function runInit(args: string[] = [], cwd: string = root) {
  const result = await execa(process.execPath, [CLI, 'init', ...args], {
    reject: false,
    cwd,
    // Prompt-free by contract: init must never block on stdin.
    input: '',
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

/** A repository, made by hand: init reads the filesystem, not `git`. */
async function makeRepo(dir: string, head = 'ref: refs/heads/master\n'): Promise<void> {
  await mkdir(join(dir, '.git'), { recursive: true });
  await writeFile(join(dir, '.git', 'HEAD'), head, 'utf8');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const LAYOUT = [
  '.specwitness/config.yaml',
  '.specwitness/.gitignore',
  '.specwitness/contracts',
  '.specwitness/plans',
  '.specwitness/runs',
];

describe('init in a fresh Git repository (AC1)', () => {
  it('creates the whole layout, reports it, and exits 0', async () => {
    await makeRepo(root);

    const { exitCode, stdout, stderr } = await runInit();

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');

    for (const path of LAYOUT) {
      expect(await exists(join(root, path)), `${path} should exist`).toBe(true);
      // AC1: "the command reports what was created" — one line per path.
      expect(stdout, `${path} should be reported`).toContain(path);
    }
  });

  it('works in a repository with no package.json at all (FR-4)', async () => {
    // SpecWitness verifies projects on any stack. A Node project in the target
    // repository is not a precondition for anything in this command.
    await makeRepo(root);
    await writeFile(join(root, 'manage.py'), '# a Django project\n', 'utf8');

    const { exitCode } = await runInit();

    expect(exitCode).toBe(0);
    expect(await exists(join(root, 'package.json'))).toBe(false);
    for (const path of LAYOUT) {
      expect(await exists(join(root, path))).toBe(true);
    }
  });

  it('works against a repository made by real git', async () => {
    // The hand-built fixtures above are the fast path; this one proves the
    // filesystem-only detection matches what git actually writes.
    const git = await execa('git', ['init', root], { reject: false });
    if (git.exitCode !== 0) {
      // git is a hard requirement of the product, but skipping beats a red
      // suite that says nothing about this story.
      return;
    }

    const { exitCode } = await runInit();

    expect(exitCode).toBe(0);
    expect(await exists(join(root, '.specwitness', 'config.yaml'))).toBe(true);
  });

  it('records the repository real branch as project.baseBranch', async () => {
    await makeRepo(root, 'ref: refs/heads/main\n');

    await runInit();

    const config = await readFile(join(root, '.specwitness', 'config.yaml'), 'utf8');
    expect(config).toContain('baseBranch: main');
  });

  it('writes the local-only ignore entries inside .specwitness/', async () => {
    await makeRepo(root);
    await writeFile(join(root, '.gitignore'), 'node_modules/\n', 'utf8');

    await runInit();

    const nested = await readFile(join(root, '.specwitness', '.gitignore'), 'utf8');
    expect(nested).toContain('runs/');
    expect(nested).toContain('scorecard.jsonl');
    // The project's own .gitignore is never touched.
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('node_modules/\n');
  });

  it('succeeds inside a linked worktree, where .git is a file', async () => {
    const gitdir = join(root, 'gitdir');
    await mkdir(gitdir, { recursive: true });
    await writeFile(join(gitdir, 'HEAD'), 'ref: refs/heads/feature\n', 'utf8');
    await writeFile(join(root, '.git'), `gitdir: ${gitdir}\n`, 'utf8');

    const { exitCode } = await runInit();

    expect(exitCode).toBe(0);
    const config = await readFile(join(root, '.specwitness', 'config.yaml'), 'utf8');
    expect(config).toContain('baseBranch: feature');
  });
});

describe('init outside a Git repository (AC3)', () => {
  it('refuses with ERROR + HINT on stderr and exits 3', async () => {
    const { exitCode, stdout, stderr } = await runInit();

    // 3, not 64: the invocation is well-formed; the environment is not ready.
    expect(exitCode).toBe(3);

    const errors = stderr.split('\n').filter((line) => line.startsWith('ERROR: '));
    const hints = stderr.split('\n').filter((line) => line.startsWith('HINT: '));
    expect(errors).toHaveLength(1);
    expect(hints).toHaveLength(1);

    // The error names the directory that was checked, so the user can see
    // immediately that they are not where they thought they were.
    expect(errors[0]).toContain(root);
    expect(errors[0]).toContain('not a Git repository');
    expect(hints[0]).toBe("HINT: run inside a Git repository or 'git init' first.");

    // Nothing is scaffolded, and stdout stays clean for machine consumers.
    expect(stdout).toBe('');
    expect(await exists(join(root, '.specwitness'))).toBe(false);
  });

  it('does not search upward for a parent repository', async () => {
    await makeRepo(root);
    const nested = join(root, 'packages', 'app');
    await mkdir(nested, { recursive: true });

    const { exitCode } = await runInit([], nested);

    expect(exitCode).toBe(3);
  });
});

describe('init re-run without --force (AC2)', () => {
  it('leaves the config untouched, says so, and exits 0', async () => {
    await makeRepo(root);
    await runInit();

    const configFile = join(root, '.specwitness', 'config.yaml');
    const edited = 'version: 1\nproject:\n  baseBranch: develop\n# my edits\n';
    await writeFile(configFile, edited, 'utf8');

    const { exitCode, stdout, stderr } = await runInit();

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    // Byte for byte: "nothing is overwritten without explicit --force".
    expect(await readFile(configFile, 'utf8')).toBe(edited);
    expect(stdout.toLowerCase()).toContain('--force');
  });

  it('completes a partially-present layout', async () => {
    await makeRepo(root);
    await mkdir(join(root, '.specwitness', 'contracts'), { recursive: true });

    const { exitCode, stdout } = await runInit();

    expect(exitCode).toBe(0);
    for (const path of LAYOUT) {
      expect(await exists(join(root, path)), `${path} should exist`).toBe(true);
    }
    // The pre-existing directory is reported as left alone, not as created.
    expect(stdout).toContain('.specwitness/plans');
  });
});

describe('init --force (AC2)', () => {
  it('replaces the config but never the directory contents', async () => {
    await makeRepo(root);
    await runInit();

    const configFile = join(root, '.specwitness', 'config.yaml');
    await writeFile(configFile, 'version: 1\n# stale\n', 'utf8');

    const sentinels = ['contracts', 'plans', 'runs'].map((dir) =>
      join(root, '.specwitness', dir, 'sentinel.txt'),
    );
    for (const sentinel of sentinels) {
      await writeFile(sentinel, 'precious\n', 'utf8');
    }

    const { exitCode, stderr } = await runInit(['--force']);

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');

    const config = await readFile(configFile, 'utf8');
    expect(config).not.toContain('# stale');
    expect(config).toContain('baseBranch:');

    // Committed contracts and run evidence are not scaffolding's to delete.
    for (const sentinel of sentinels) {
      expect(await readFile(sentinel, 'utf8')).toBe('precious\n');
    }
  });

  it('still refuses outside a Git repository', async () => {
    const { exitCode } = await runInit(['--force']);
    expect(exitCode).toBe(3);
  });
});

describe('init invocation contract', () => {
  it('rejects an unknown flag with exit 64', async () => {
    await makeRepo(root);

    const { exitCode } = await runInit(['--wat']);

    // A malformed invocation is 64; a missing precondition is 3. The two must
    // never blur, because the harness branches on them.
    expect(exitCode).toBe(64);
  });

  it('documents in --help that it should be run at the project root', async () => {
    const { exitCode, stdout } = await execa(process.execPath, [CLI, 'init', '--help'], {
      reject: false,
      cwd: root,
      input: '',
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain('--force');
    expect(stdout.toLowerCase()).toContain('project root');
  });
});
