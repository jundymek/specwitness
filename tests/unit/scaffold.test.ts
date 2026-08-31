import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { InfraError } from '../../src/domain/errors.js';
import { isGitRepository, readHeadBranch, scaffold } from '../../src/infra/scaffold.js';

/**
 * Every test works in a throwaway directory: the scaffold's whole job is to
 * write files, so asserting against fixtures in the repo would either be a lie
 * (mocked fs) or destructive (real fs). Nothing here touches `src/`.
 */
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'specwitness-scaffold-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Makes `root` look like a plain (non-worktree) repository. */
async function makeGitDir(head = 'ref: refs/heads/master\n'): Promise<void> {
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, '.git', 'HEAD'), head, 'utf8');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function configPath(): string {
  return join(root, '.specwitness', 'config.yaml');
}

describe('isGitRepository (AC3, filesystem-only)', () => {
  it('accepts a .git directory', async () => {
    await makeGitDir();
    await expect(isGitRepository(root)).resolves.toBe(true);
  });

  it('accepts a .git FILE — linked worktrees and submodules use one', async () => {
    // This is not a hypothetical: every agent in this cohort works inside a
    // linked worktree, so rejecting it would make init unusable here.
    await writeFile(join(root, '.git'), 'gitdir: /somewhere/.git/worktrees/wt\n', 'utf8');
    await expect(isGitRepository(root)).resolves.toBe(true);
  });

  it('rejects a directory with no .git entry at all', async () => {
    await expect(isGitRepository(root)).resolves.toBe(false);
  });

  it('does not search upward for a parent repository', async () => {
    // Refuse-to-guess: init scaffolds where it is pointed, or refuses. An
    // upward search would silently write into a directory the user did not name.
    await makeGitDir();
    const nested = join(root, 'packages', 'app');
    await mkdir(nested, { recursive: true });

    await expect(isGitRepository(nested)).resolves.toBe(false);
  });
});

describe('readHeadBranch (D4 — placeholder comes from the repo, not a guess)', () => {
  it('reads the branch name out of .git/HEAD', async () => {
    await makeGitDir('ref: refs/heads/main\n');
    await expect(readHeadBranch(root)).resolves.toBe('main');
  });

  it('handles branch names containing slashes', async () => {
    await makeGitDir('ref: refs/heads/release/2026-q3\n');
    await expect(readHeadBranch(root)).resolves.toBe('release/2026-q3');
  });

  it('falls back to master on a detached HEAD', async () => {
    await makeGitDir('9fceb02d0ae598e95dc970b74767f19372d61af8\n');
    await expect(readHeadBranch(root)).resolves.toBe('master');
  });

  it('falls back to master when HEAD is missing or unreadable', async () => {
    await mkdir(join(root, '.git'), { recursive: true });
    await expect(readHeadBranch(root)).resolves.toBe('master');
  });

  it('follows a .git FILE to the real gitdir', async () => {
    const gitdir = join(root, 'elsewhere');
    await mkdir(gitdir, { recursive: true });
    await writeFile(join(gitdir, 'HEAD'), 'ref: refs/heads/develop\n', 'utf8');
    await writeFile(join(root, '.git'), `gitdir: ${gitdir}\n`, 'utf8');

    await expect(readHeadBranch(root)).resolves.toBe('develop');
  });

  it('falls back to master when the .git file points nowhere useful', async () => {
    await writeFile(join(root, '.git'), 'gitdir: /nonexistent/path/.git\n', 'utf8');
    await expect(readHeadBranch(root)).resolves.toBe('master');
  });
});

describe('scaffold on a fresh repository (AC1)', () => {
  it('creates every path and reports each one as created', async () => {
    await makeGitDir();

    const result = await scaffold(root);

    // Directory names are contract: Epic 2 commits into contracts/ and plans/,
    // Epic 3 writes runs/. Renaming one breaks stories that are not written yet.
    expect(result.created).toEqual([
      '.specwitness',
      '.specwitness/config.yaml',
      '.specwitness/.gitignore',
      '.specwitness/contracts',
      '.specwitness/plans',
      '.specwitness/runs',
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.replaced).toEqual([]);
    expect(result.configWritten).toBe(true);

    for (const path of result.created) {
      expect(await exists(join(root, path))).toBe(true);
    }
  });

  it('writes the git-ignore entries into .specwitness/.gitignore, not the project root', async () => {
    // Q11 outcome via the spec's chosen mechanism (D1): runs/ and scorecard
    // are local-only, and SpecWitness never edits a file the user owns.
    await makeGitDir();
    await writeFile(join(root, '.gitignore'), 'node_modules/\n', 'utf8');

    await scaffold(root);

    const nested = await readFile(join(root, '.specwitness', '.gitignore'), 'utf8');
    expect(nested).toContain('runs/');
    expect(nested).toContain('scorecard.jsonl');

    // The project's own .gitignore is untouched, byte for byte.
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('node_modules/\n');
  });

  it('writes the branch read from HEAD into project.baseBranch', async () => {
    await makeGitDir('ref: refs/heads/main\n');

    await scaffold(root);

    const config = await readFile(configPath(), 'utf8');
    expect(config).toContain('baseBranch: main');
    expect(config).not.toContain('baseBranch: master');
  });

  it('leaves the commented examples commented (D5)', async () => {
    await makeGitDir();

    await scaffold(root);

    const config = await readFile(configPath(), 'utf8');
    // Every command-bearing section must stay inert, or a fresh init would
    // declare commands that do not resolve on the user's machine.
    for (const key of ['gates:', 'services:', 'observations:', 'data:', 'setup:', 'ai:']) {
      const active = config
        .split('\n')
        .filter((line) => line.startsWith(key))
        .length;
      expect(active, `${key} must not be active in the skeleton`).toBe(0);
    }
  });

  it('writes only inside .specwitness/', async () => {
    await makeGitDir();
    await writeFile(join(root, 'README.md'), 'untouched\n', 'utf8');

    await scaffold(root);

    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('untouched\n');
  });
});

describe('scaffold re-run without --force (AC2)', () => {
  it('skips everything and reports the config as left alone', async () => {
    await makeGitDir();
    await scaffold(root);
    await writeFile(configPath(), 'version: 1\n# user edits\n', 'utf8');

    const result = await scaffold(root);

    expect(result.created).toEqual([]);
    expect(result.skipped).toContain('.specwitness/config.yaml');
    expect(result.configWritten).toBe(false);
    // The whole point of AC2: an existing config survives byte for byte.
    expect(await readFile(configPath(), 'utf8')).toBe('version: 1\n# user edits\n');
  });

  it('completes a partial layout without touching what already exists', async () => {
    await makeGitDir();
    await mkdir(join(root, '.specwitness', 'contracts'), { recursive: true });
    await writeFile(configPath(), 'version: 1\n', 'utf8');

    const result = await scaffold(root);

    expect(result.created).toEqual([
      '.specwitness/.gitignore',
      '.specwitness/plans',
      '.specwitness/runs',
    ]);
    expect(result.skipped).toEqual(['.specwitness', '.specwitness/config.yaml', '.specwitness/contracts']);
    expect(await readFile(configPath(), 'utf8')).toBe('version: 1\n');
  });

  it('leaves an existing .gitignore alone — the user may have added entries', async () => {
    await makeGitDir();
    await scaffold(root);
    const ignorePath = join(root, '.specwitness', '.gitignore');
    await writeFile(ignorePath, 'runs/\nscorecard.jsonl\nmy-scratch/\n', 'utf8');

    await scaffold(root);

    expect(await readFile(ignorePath, 'utf8')).toBe('runs/\nscorecard.jsonl\nmy-scratch/\n');
  });
});

describe('scaffold with --force (AC2)', () => {
  it('replaces config.yaml', async () => {
    await makeGitDir();
    await scaffold(root);
    await writeFile(configPath(), 'version: 1\n# stale\n', 'utf8');

    const result = await scaffold(root, { force: true });

    expect(result.configWritten).toBe(true);
    // Replaced, not created: the user had a file there and now does not.
    expect(result.replaced).toEqual(['.specwitness/config.yaml']);
    expect(result.created).toEqual([]);

    const config = await readFile(configPath(), 'utf8');
    expect(config).not.toContain('# stale');
    expect(config).toContain('version: 1');
  });

  it('never touches the contents of contracts/, plans/ or runs/', async () => {
    // These hold committed product artifacts (Epic 2) and run evidence
    // (Epic 3+). A scaffolding command has no business deleting either.
    await makeGitDir();
    await scaffold(root);

    const sentinels = ['contracts', 'plans', 'runs'].map((dir) =>
      join(root, '.specwitness', dir, 'sentinel.txt'),
    );
    for (const sentinel of sentinels) {
      await writeFile(sentinel, 'precious\n', 'utf8');
    }

    await scaffold(root, { force: true });

    for (const sentinel of sentinels) {
      expect(await readFile(sentinel, 'utf8')).toBe('precious\n');
    }
  });

  it('does not rewrite an existing .gitignore — only config.yaml is in scope', async () => {
    await makeGitDir();
    await scaffold(root);
    const ignorePath = join(root, '.specwitness', '.gitignore');
    await writeFile(ignorePath, 'runs/\nscorecard.jsonl\nmine/\n', 'utf8');

    await scaffold(root, { force: true });

    expect(await readFile(ignorePath, 'utf8')).toBe('runs/\nscorecard.jsonl\nmine/\n');
  });
});

describe('branch names that are not plain YAML strings', () => {
  // Git permits these; YAML would read them as a boolean, a null and a number,
  // so a raw interpolation produces a config that fails validation on the very
  // first `doctor` run — in a repository whose only sin is its branch name.
  it.each([['true'], ['false'], ['null'], ['123'], ['1.0'], ['no'], ['y']])(
    'quotes a branch named %s so it round-trips as a string',
    async (branch) => {
      await makeGitDir(`ref: refs/heads/${branch}\n`);

      await scaffold(root);

      const parsed = parse(await readFile(configPath(), 'utf8'), { uniqueKeys: true }) as {
        project: { baseBranch: unknown };
      };
      expect(parsed.project.baseBranch).toBe(branch);
      expect(typeof parsed.project.baseBranch).toBe('string');
    },
  );

  it('handles a branch name containing $ replacement patterns', async () => {
    // `$&` reinserts the whole match in a string replacement, so a raw
    // `String.replace` would corrupt the line.
    await makeGitDir('ref: refs/heads/fix/$&-and-$`\n');

    await scaffold(root);

    const parsed = parse(await readFile(configPath(), 'utf8'), { uniqueKeys: true }) as {
      project: { baseBranch: unknown };
    };
    expect(parsed.project.baseBranch).toBe('fix/$&-and-$`');
  });

  it('leaves the ordinary case unquoted', async () => {
    await makeGitDir('ref: refs/heads/main\n');

    await scaffold(root);

    expect(await readFile(configPath(), 'utf8')).toContain('baseBranch: main');
  });
});

describe('a hostile .git/HEAD cannot inject YAML', () => {
  // HEAD is attacker-controlled in a repository you did not write, and its
  // content is copied into the generated config.yaml. A crafted value must not
  // be able to add keys, change the document's shape, or escape the scalar —
  // otherwise cloning a repository and running `init` would let that repository
  // decide part of your SpecWitness configuration.
  it.each([
    ['quote injection', 'ref: refs/heads/a"\nevil: injected\n'],
    ['structure break-out', 'ref: refs/heads/x\nproject:\n  evil: yes\n'],
    ['colon and comment', 'ref: refs/heads/a: b #c'],
    ['leading dash', 'ref: refs/heads/-x'],
    ['tab', 'ref: refs/heads/a\tb'],
    ['indent injection', 'ref: refs/heads/x\n  nested: 1'],
    ['very long name', `ref: refs/heads/${'a'.repeat(500)}`],
  ])('%s produces a plain string and no extra keys', async (_label, head) => {
    await makeGitDir(head);

    await scaffold(root);

    const doc = parse(await readFile(configPath(), 'utf8'), { uniqueKeys: true }) as {
      project: { baseBranch: unknown };
    };

    expect(Object.keys(doc).sort()).toEqual(['project', 'version']);
    expect(typeof doc.project.baseBranch).toBe('string');
  });
});

describe('symlinks never carry a write outside .specwitness/', () => {
  it('refuses to overwrite through a symlinked config.yaml under --force', async () => {
    // The destructive case: stat() follows symlinks, so without an lstat check
    // `init --force` would overwrite whatever the link points at — any file the
    // user can write. This module promises every write stays inside
    // .specwitness/, and a symlink breaks that promise silently.
    await makeGitDir();
    await mkdir(join(root, '.specwitness'), { recursive: true });

    const outsider = join(root, 'precious.txt');
    await writeFile(outsider, 'do not touch\n', 'utf8');
    await symlink(outsider, configPath());

    const err = await scaffold(root, { force: true }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InfraError);
    expect((err as InfraError).message).toContain('symbolic link');
    // The point of the test: the target survived.
    expect(await readFile(outsider, 'utf8')).toBe('do not touch\n');
  });

  it.each([['contracts'], ['plans'], ['runs']])(
    'refuses when %s is a symlink to a directory elsewhere',
    async (name) => {
      await makeGitDir();
      await mkdir(join(root, '.specwitness'), { recursive: true });

      const outsideDir = join(root, 'elsewhere');
      await mkdir(outsideDir, { recursive: true });
      await symlink(outsideDir, join(root, '.specwitness', name));

      const err = await scaffold(root).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(InfraError);
      expect((err as InfraError).message).toContain('symbolic link');
    },
  );

  it('refuses when .specwitness itself is a symlink', async () => {
    await makeGitDir();
    const outsideDir = join(root, 'elsewhere');
    await mkdir(outsideDir, { recursive: true });
    await symlink(outsideDir, join(root, '.specwitness'));

    const err = await scaffold(root).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InfraError);
    expect((err as InfraError).message).toContain('symbolic link');
  });
});

describe('nothing is written until the whole layout is known to be valid', () => {
  it('does not replace the config under --force when a later entry is invalid', async () => {
    // The nasty ordering bug: validating lazily meant --force overwrote the
    // config and only THEN discovered contracts/ was a regular file. The
    // command failed having already destroyed the one thing the user asked it
    // to be careful with.
    await makeGitDir();
    await scaffold(root);

    const precious = 'version: 1\nproject:\n  baseBranch: develop\n# hand-tuned\n';
    await writeFile(configPath(), precious, 'utf8');
    await rm(join(root, '.specwitness', 'contracts'), { recursive: true });
    await writeFile(join(root, '.specwitness', 'contracts'), 'not a directory\n', 'utf8');

    const err = await scaffold(root, { force: true }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InfraError);
    // The point: the config the user cared about is byte-for-byte intact.
    expect(await readFile(configPath(), 'utf8')).toBe(precious);
  });

  it('does not replace the config when a later write fails on permissions', async () => {
    // Phase 1 cannot see this one: an existing writable config.yaml inside a
    // read-only .specwitness/ IS overwritable (writing an existing file needs
    // permission on the file, not the directory), while creating .gitignore
    // beside it is not. Ordering the config write last is what saves the user's
    // data here — inspection alone cannot.
    await makeGitDir();
    await mkdir(join(root, '.specwitness'), { recursive: true });

    const precious = 'version: 1\nproject:\n  baseBranch: develop\n# hand-tuned\n';
    await writeFile(configPath(), precious, 'utf8');
    await chmod(join(root, '.specwitness'), 0o500);

    try {
      const err = await scaffold(root, { force: true }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(InfraError);
      expect(await readFile(configPath(), 'utf8')).toBe(precious);
    } finally {
      // Restore write permission so afterEach can clean up.
      await chmod(join(root, '.specwitness'), 0o700);
    }
  });

  it('does not create directories when the config entry is invalid', async () => {
    await makeGitDir();
    await mkdir(join(root, '.specwitness'), { recursive: true });
    await mkdir(join(root, '.specwitness', 'config.yaml'), { recursive: true });

    const err = await scaffold(root).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InfraError);
    for (const name of ['contracts', 'plans', 'runs', '.gitignore']) {
      expect(await exists(join(root, '.specwitness', name)), `${name} must not exist`).toBe(false);
    }
  });
});

describe('scaffold failure modes', () => {
  it('refuses a FIFO where a scaffold file belongs', async () => {
    // `--force` writing to a FIFO with no reader blocks forever, and `init` is
    // agent-callable: a command with no TTY that hangs is worse than one that
    // fails. Rejecting anything that is not a regular file also stops a
    // non-forced run reporting a scaffold that config loading cannot read.
    const mkfifo = await execa('mkfifo', [join(root, 'probe-fifo')], { reject: false });
    if (mkfifo.exitCode !== 0) {
      return; // no mkfifo on this platform; the isFile() guard is still in place
    }
    await rm(join(root, 'probe-fifo'));

    await makeGitDir();
    await mkdir(join(root, '.specwitness'), { recursive: true });
    await execa('mkfifo', [configPath()]);

    const err = await scaffold(root, { force: true }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InfraError);
    expect((err as InfraError).message).toContain('is a named pipe');
  });

  it.each([['contracts'], ['plans'], ['runs']])(
    'refuses when %s exists as a file rather than a directory',
    async (name) => {
      // Skipping it would exit 0 on a layout later commands cannot write into:
      // an infra failure disguised as success.
      await makeGitDir();
      await mkdir(join(root, '.specwitness'), { recursive: true });
      await writeFile(join(root, '.specwitness', name), 'not a directory\n', 'utf8');

      const err = await scaffold(root).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(InfraError);
      expect((err as InfraError).message).toContain(name);
      expect((err as InfraError).message).toContain('not a directory');
    },
  );

  it('refuses when config.yaml exists as a directory', async () => {
    await makeGitDir();
    await mkdir(join(root, '.specwitness', 'config.yaml'), { recursive: true });

    const err = await scaffold(root).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InfraError);
    expect((err as InfraError).message).toContain('is a directory, not a regular file');
  });

  it('creates no partial layout when the project directory cannot be made', async () => {
    // Half a .specwitness/ is worse than none: the user would have to work out
    // which parts are real before re-running. Whatever fails, nothing that
    // failure did not reach should exist.
    await makeGitDir();
    await writeFile(join(root, '.specwitness'), 'not a directory\n', 'utf8');

    await expect(scaffold(root)).rejects.toBeInstanceOf(InfraError);

    for (const name of ['contracts', 'plans', 'runs', 'config.yaml', '.gitignore']) {
      expect(await exists(join(root, '.specwitness', name)), `${name} must not exist`).toBe(false);
    }
  });

  it('raises InfraError naming the path when the target is not writable', async () => {
    await makeGitDir();
    // A file where the directory must go: the mkdir fails with EEXIST/ENOTDIR,
    // and the user needs the path, not a raw errno stack.
    await writeFile(join(root, '.specwitness'), 'not a directory\n', 'utf8');

    const err = await scaffold(root).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InfraError);
    expect((err as InfraError).message).toContain('.specwitness');
    expect((err as InfraError).hint).toBeDefined();
  });
});
