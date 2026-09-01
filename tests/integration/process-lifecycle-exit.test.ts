import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installCodexShim, type InstalledShim } from '../fixtures/bin/install-shim.js';

/**
 * A spawn that is still in flight must keep the process ALIVE — story 3.2.
 *
 * This file exists because of one specific regression, caught by a flake and
 * worth a permanent test.
 *
 * `src/cli/main.ts` ends in a top-level `await`. When Node's event loop empties
 * while a top-level await is still pending, the process exits with code 13
 * (`ERR_UNFINISHED_TOP_LEVEL_AWAIT`) — silently, with no output and no
 * ERROR/HINT pair. Exit 13 is not in the frozen exit table at all, so a harness
 * reading it learns nothing: not PASS, not FAIL, not "rerun the environment".
 *
 * Story 2.3's runner was protected from that by accident: it delegated timing to
 * execa's `timeout`, whose timer is ref'd. Story 3.2 had to take the timeout
 * over (execa reports `timedOut: false` after our own group kill, so its
 * classification could not be trusted), and the first version unref'd every
 * replacement timer — copying the existing watchdog's `unref` without noticing
 * that the watchdog was the OUTER net, not the thing keeping the loop alive.
 * `specwitness doctor` then exited 13 instead of 0, intermittently, under load.
 *
 * The rule that came out of it, stated in `src/infra/process-runner.ts`: any
 * timer whose expiry a run's settlement depends on is REF'D and CLEARED, never
 * unref'd. Clearing gives back what unref'ing was for — a fast run is not held
 * open by the losing side of a race — without the failure mode.
 *
 * The test drives it through the built binary with a provider CLI that never
 * answers, which is the shape that actually broke: a hanging child, a runner
 * waiting on its own timer, and nothing else holding the loop.
 *
 * HONEST LIMIT, since a test that has never been red deserves one: the original
 * failure was INTERMITTENT and load-dependent, and re-introducing the `unref`
 * did not reproduce it on demand here — with the watchdog still ref'd, the loop
 * stayed alive anyway. So this is a GUARD against exit 13 escaping the frozen
 * table, not a proven reproducer of the race. The actual fix is the rule in
 * `src/infra/process-runner.ts` (ref'd and cleared, never unref'd); this test is
 * what notices if a future change puts an off-table code back on the wire.
 */

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

/** Codes the product is allowed to exit with (ADR-002). 13 is not one of them. */
const FROZEN_EXIT_CODES = [0, 1, 2, 3, 64];

const WITH_CODEX = [
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

let projectRoot: string;
let shim: InstalledShim | undefined;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'specwitness-lifecycle-'));
  await mkdir(join(projectRoot, '.specwitness'), { recursive: true });
  await writeFile(join(projectRoot, '.specwitness', 'config.yaml'), WITH_CODEX);
});

afterEach(async () => {
  await shim?.cleanup();
  shim = undefined;
  await rm(projectRoot, { recursive: true, force: true });
});

describe('a hanging child never turns into an off-table exit code', () => {
  it('exits with a frozen exit code, never 13, when the provider CLI never answers', async () => {
    // `hanging` never responds to `--version`, so doctor's probe runs to its
    // timeout and this process must stay alive long enough to notice, reap the
    // process group, and classify. Unref every timer on that path and Node
    // exits 13 with no output instead.
    shim = await installCodexShim({ mode: 'hanging' });

    const result = await execa(process.execPath, [CLI, 'doctor'], {
      cwd: projectRoot,
      reject: false,
      input: '',
      env: {
        PATH: shim.pathPrefixedWith(process.env.PATH),
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
      },
      extendEnv: true,
    });

    expect(result.exitCode).not.toBe(13);
    expect(FROZEN_EXIT_CODES).toContain(result.exitCode);
    // And it actually said something: an exit code with no output is the shape
    // of the bug, not evidence against it.
    expect(`${result.stdout}${result.stderr}`.length).toBeGreaterThan(0);
  });

  it('reports the hang rather than pretending the CLI answered', async () => {
    // The other half: settling is only useful if it settles TRUTHFULLY. A
    // timeout classified as a clean `completed` run would be worse than exit 13,
    // because it would be believed.
    shim = await installCodexShim({ mode: 'hanging' });

    const result = await execa(process.execPath, [CLI, 'doctor'], {
      cwd: projectRoot,
      reject: false,
      input: '',
      env: {
        PATH: shim.pathPrefixedWith(process.env.PATH),
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
      },
      extendEnv: true,
    });

    expect(result.stdout).toMatch(/did not respond|state unknown|timed out/i);
  });
});
