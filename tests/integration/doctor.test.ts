import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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

interface HeldPort {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Occupies an ephemeral localhost port, or resolves `undefined` where the
 * sandbox forbids listening. Both the success and the failure path settle:
 * a `listen` that rejects with no error handler surfaces as an unhandled
 * exception and a 30s test timeout, which is how this was found.
 */
async function tryListen(): Promise<HeldPort | undefined> {
  const server = createServer();

  return await new Promise<HeldPort | undefined>((resolve) => {
    server.once('error', () => {
      server.close();
      resolve(undefined);
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address !== 'object' || address === null) {
        server.close();
        resolve(undefined);
        return;
      }
      resolve({
        port: address.port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * Runs the built CLI. `input: ''` means the child gets no TTY, which is how the
 * harness invokes it.
 *
 * Story 2.7 note on `env`: the billing-risk variables are UNSET by default, so a
 * developer who happens to export `OPENAI_API_KEY` gets the same results as CI.
 * Without this the `billing-risk-env` check would report differently on
 * different machines and the failure would look like a flake rather than an
 * inherited environment.
 */
/**
 * A PATH containing git and nothing else.
 *
 * Emptying PATH outright would also hide `git`, which is a REQUIRED check — the
 * run would exit 3 for a reason that has nothing to do with providers. Linking
 * the real git into an otherwise-empty directory makes "codex is absent" true
 * regardless of what the developer running this has installed, without breaking
 * everything else doctor needs.
 */
async function gitOnlyPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'specwitness-git-only-'));
  created.push(dir);
  const { stdout } = await execa('sh', ['-c', 'command -v git']);
  await symlink(stdout.trim(), join(dir, 'git'));
  return dir;
}

async function doctor(
  cwd: string,
  args: string[] = [],
  env: Record<string, string | undefined> = {},
) {
  const result = await execa(process.execPath, [CLI, 'doctor', ...args], {
    cwd,
    reject: false,
    input: '',
    env: { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, ...env },
    extendEnv: true,
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

  it('stays at 0 when an optional check warns', async () => {
    // The fixture has no @playwright/test, so playwright-capability warns.
    // An optional check must never move the exit code — that rule is what keeps
    // a missing agent CLI (story 2.7) or an unprovisioned browser non-fatal.
    const root = await project(HEALTHY);

    const { exitCode, stdout } = await doctor(root);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/⚠ playwright-capability/);
  });

  it('warns, and still exits 0, when a declared port is occupied', async (context) => {
    // Binding a listener is not permitted in every sandbox (a Codex review run
    // returned EPERM on 127.0.0.1). Skip rather than fail there: the product
    // path is covered regardless, because `probePort` reports any bind failure
    // — EPERM included — as an occupied port, which is a warn.
    const held = await tryListen();
    if (held === undefined) {
      context.skip();
      return;
    }

    try {
      const root = await project(
        [
          'version: 1',
          'project:',
          '  baseBranch: master',
          'services:',
          '  web:',
          '    run: /bin/sh',
          `    port: ${held.port}`,
          '    ready:',
          `      url: http://127.0.0.1:${held.port}/health`,
          '',
        ].join('\n'),
      );

      const { exitCode, stdout } = await doctor(root);

      expect(exitCode).toBe(0);
      expect(stdout).toContain(String(held.port));
      expect(stdout).toMatch(/⚠ ports-free/);
    } finally {
      await held.close();
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
      // ── appended by story 2.7 ──
      // Extended in registration order, and deliberately still an EXACT list:
      // loosening this to `toContain` would delete the only guarantee that the
      // `--json` check order is stable for the consumers that parse it.
      'billing-risk-env',
      'ai-providers',
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

/**
 * FR-15 / UJ-4 through the built binary (story 2.7).
 *
 * The variable is set in the CHILD's environment only. `process.env` in this
 * test process is never mutated: AD-4 forbids the product from touching the
 * parent environment, and a suite that did it would leak into every file that
 * ran after it.
 */
describe('doctor and billing-risk environment variables', () => {
  const WITH_PROVIDER = [
    'version: 1',
    'project:',
    '  baseBranch: master',
    'ai:',
    '  providers:',
    '    codex:',
    '      adapter: codex-cli',
    '      mode: chatgpt',
    '  roles:',
    '    contract-author: codex',
    '',
  ].join('\n');

  it('names the variable and still exits 0', async () => {
    const root = await project(WITH_PROVIDER);

    const { exitCode, stdout } = await doctor(root, [], {
      OPENAI_API_KEY: 'sk-not-a-real-key-000',
    });

    // The warning is a thing to know, not a broken environment. Exiting
    // non-zero here would train an operator to stop reading doctor's output.
    expect(exitCode).toBe(0);
    expect(stdout).toContain('OPENAI_API_KEY present in environment');
    expect(stdout).toContain('could bill your API account');
  });

  it('prints the name and never the value', async () => {
    const root = await project(WITH_PROVIDER);
    const secret = 'sk-not-a-real-key-000';

    const { stdout, stderr } = await doctor(root, [], { OPENAI_API_KEY: secret });

    // The whole point of the check: a warning that echoed the key would leak a
    // credential into terminal scrollback, CI logs and PR bodies.
    expect(stdout).not.toContain(secret);
    expect(stderr).not.toContain(secret);
  });

  it('keeps the value out of --json too', async () => {
    const root = await project(WITH_PROVIDER);
    const secret = 'sk-not-a-real-key-000';

    const { exitCode, stdout } = await doctor(root, ['--json'], { OPENAI_API_KEY: secret });

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain(secret);

    // stdout still carries the JSON document and nothing else.
    const parsed = JSON.parse(stdout) as {
      checks: { id: string; status: string; required: boolean; detail: string }[];
    };
    const billing = parsed.checks.find((check) => check.id === 'billing-risk-env');
    expect(billing?.status).toBe('warn');
    expect(billing?.required).toBe(false);
    expect(billing?.detail).toContain('OPENAI_API_KEY');
  });

  it('reports a configured provider whose binary is absent, and still exits 0', async () => {
    // UJ-4's edge case, end to end: with no agent CLI installed, contract
    // GENERATION is unavailable but execution of existing plans still works.
    // PATH is emptied for the CHILD only, so the result does not depend on
    // whether the developer running this happens to have codex installed.
    const root = await project(WITH_PROVIDER);
    const binDir = await gitOnlyPath();

    const { exitCode, stdout } = await doctor(root, [], { PATH: binDir });

    expect(exitCode).toBe(0);
    expect(stdout).toContain('ai-providers');
    expect(stdout).toMatch(/⚠ ai-providers/);
    expect(stdout).toContain('codex');
  });

  it('says nothing when no provider is configured, even with a key exported', async () => {
    // A normal project state, not a diagnosis: SpecWitness will spawn no
    // provider here, so no provider call can bill anything (UJ-4 edge case).
    const root = await project(HEALTHY);

    const { exitCode, stdout } = await doctor(root, [], { OPENAI_API_KEY: 'sk-not-a-real-key-000' });

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('could bill your API account');
  });
});
