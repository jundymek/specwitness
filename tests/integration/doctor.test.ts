import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `specwitness doctor` end to end, against the BUILT binary.
 *
 * Every fixture is a fresh temp directory — never the repository root. Doctor
 * reads `.specwitness/config.yaml`, so a test run at REPO_ROOT would find (or
 * not find) whatever another test happened to leave behind, and its result would
 * depend on suite ordering. Temp dirs make these assertions order-independent.
 */

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function project(config?: string, options: { git?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'specwitness-doctor-it-'));
  created.push(root);

  if (options.git !== false) {
    await execa('git', ['init', '-b', 'master'], { cwd: root });
    await execa(
      'git',
      [
        '-c',
        'user.email=doctor@example.test',
        '-c',
        'user.name=Doctor Fixture',
        'commit',
        '--allow-empty',
        '-m',
        'root commit',
      ],
      { cwd: root },
    );
  }

  if (config !== undefined) {
    await mkdir(join(root, '.specwitness'), { recursive: true });
    await writeFile(join(root, '.specwitness', 'config.yaml'), config, 'utf8');
  }

  return root;
}

async function doctor(cwd: string, args: string[] = []) {
  const result = await execa(process.execPath, [CLI, 'doctor', ...args], {
    cwd,
    reject: false,
    input: '',
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

const HEALTHY = ['version: 1', 'project:', '  baseBranch: master', ''].join('\n');

describe('doctor on a healthy project', () => {
  it('exits 0 and reports every check', async () => {
    const root = await project(HEALTHY);

    const { exitCode, stdout } = await doctor(root);

    expect(exitCode).toBe(0);
    for (const id of [
      'node-version',
      'git-present',
      'config-valid',
      'base-branch-exists',
      'commands-resolvable',
      'playwright-capability',
      'ports-free',
    ]) {
      expect(stdout).toContain(id);
    }
  });

  it('stays at 0 when only optional checks warn', async () => {
    // Playwright is absent from the fixture and the declared port is held by
    // this test: two warnings, and doctor must still report success.
    const held = createServer();
    await new Promise<void>((resolve) => held.listen(0, '127.0.0.1', resolve));
    const address = held.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    try {
      const root = await project(
        [
          'version: 1',
          'project:',
          '  baseBranch: master',
          'services:',
          '  web:',
          '    run: /bin/sh',
          `    port: ${port}`,
          '    ready:',
          `      url: http://127.0.0.1:${port}/health`,
          '',
        ].join('\n'),
      );

      const { exitCode, stdout } = await doctor(root);

      expect(exitCode).toBe(0);
      expect(stdout).toContain(String(port));
      expect(stdout).toMatch(/⚠/);
    } finally {
      await new Promise<void>((resolve) => held.close(() => resolve()));
    }
  });
});

describe('doctor on a broken project', () => {
  it('exits 3 — never 1 or 2 — and names the offending YAML path', async () => {
    const root = await project(
      ['version: 1', 'project:', '  baseBranch: master', 'setupp:', '  install: pnpm i', ''].join(
        '\n',
      ),
    );

    const { exitCode, stdout, stderr } = await doctor(root);

    expect(exitCode).toBe(3);
    expect(stdout).toContain('setupp');
    expect(stderr).toContain('ERROR:');
    expect(stderr).toContain('HINT:');
  });

  it('exits 3 when the declared base branch does not exist', async () => {
    const root = await project(
      ['version: 1', 'project:', '  baseBranch: no-such-branch', ''].join('\n'),
    );

    const { exitCode, stdout } = await doctor(root);

    expect(exitCode).toBe(3);
    expect(stdout).toContain('no-such-branch');
  });

  it('exits 3 and names the gate when a declared command does not resolve', async () => {
    const root = await project(
      [
        'version: 1',
        'project:',
        '  baseBranch: master',
        'gates:',
        '  - id: lint',
        '    run: definitely-not-installed-binary --check',
        '',
      ].join('\n'),
    );

    const { exitCode, stdout } = await doctor(root);

    expect(exitCode).toBe(3);
    expect(stdout).toContain('gates[lint]');
    expect(stdout).toContain('definitely-not-installed-binary');
  });

  it('exits 3 with the init hint when there is no config file', async () => {
    const root = await project();

    const { exitCode, stdout } = await doctor(root);

    expect(exitCode).toBe(3);
    expect(stdout).toContain('specwitness init');
  });

  it('reports "not a git repository" rather than a git failure', async () => {
    const root = await project(HEALTHY, { git: false });

    const { exitCode, stdout } = await doctor(root);

    expect(exitCode).toBe(3);
    expect(stdout).toMatch(/not a git repository/i);
  });

  it('runs every check even when an early one fails', async () => {
    const root = await project(undefined, { git: true });

    const { stdout } = await doctor(root);

    // config-valid failed, yet the downstream checks still report rather than
    // the command stopping at the first problem.
    expect(stdout).toContain('base-branch-exists');
    expect(stdout).toContain('ports-free');
  });
});

describe('doctor --json', () => {
  it('puts JSON and nothing else on stdout, with an ISO-8601 UTC timestamp', async () => {
    const root = await project(HEALTHY);

    const { exitCode, stdout, stderr } = await doctor(root, ['--json']);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as {
      schemaVersion: number;
      timestamp: string;
      status: string;
      checks: { id: string; status: string; required: boolean; detail: string }[];
    };

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
    expect(parsed.checks.map((check) => check.id)).toEqual([
      'node-version',
      'git-present',
      'config-valid',
      'base-branch-exists',
      'commands-resolvable',
      'playwright-capability',
      'ports-free',
    ]);
    // The human rendering is still available, on the other stream.
    expect(stderr).toContain('node-version');
  });

  it('still parses as JSON on the failure path, and still exits 3', async () => {
    const root = await project();

    const { exitCode, stdout } = await doctor(root, ['--json']);

    expect(exitCode).toBe(3);
    const parsed = JSON.parse(stdout) as { status: string };
    expect(parsed.status).toBe('fail');
  });
});
