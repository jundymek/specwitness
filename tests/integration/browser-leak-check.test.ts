/**
 * `scripts/browser-leak-check.mjs` (story 6.9, AC4).
 *
 * An INTEGRATION suite: the thing under test is a step in a CI job, so it is spawned as a
 * real process and its EXIT CODE is half of what it contributes. The pattern is story 6.1's
 * (`tests/integration/skipped-suite-report.test.ts`), for the same reason.
 *
 * ⚠️ **WHAT THIS SCRIPT IS FOR.** `browser-fixture.ts`'s header states the hazard it exists
 * to answer: *"A leaked browser tree is the worst leak this product can produce, and it lives
 * until reboot."* Every fixture is self-limiting because **a killed run executes no
 * `afterEach` at all** (Epic 4 retro §2 observation 8). This story puts that claim on a
 * shared Linux runner for the first time, and "the tests passed" says nothing about what
 * survived them — so the survival check is a separate, testable artefact.
 *
 * ⚠️ **THE SCAN MUST NOT BE ABLE TO REPORT CLEAN WITHOUT LOOKING.** A checker that cannot
 * read a process listing and exits 0 is this story's own green-for-nothing (Epic 4 retro §2
 * observation 2), and case 6 below is the guard against it. That failure mode is why the
 * listing is an INPUT here: with `--ps-file` the parser can be driven over process trees a
 * test can never produce on demand, including ones that do not exist on the host platform.
 *
 * ⚠️ **AND WHY IT IS A DIFF, NOT AN ABSOLUTE COUNT.** The first version of this script
 * matched browser processes absolutely, and on the author's laptop it reported 77 survivors
 * on a clean run — every Electron application on the machine answers to `--type=renderer` and
 * `chrome_crashpad_handler`. A check that fires on a clean run is a check that gets ignored,
 * and narrowing the patterns until the laptop went quiet would have narrowed away exactly the
 * helper processes most likely to outlive their parent. So the patterns stay broad and a
 * BASELINE taken before the run is subtracted: what this reports is what THIS RUN left
 * behind, which is the only question AC4 asks.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../scripts/browser-leak-check.mjs', import.meta.url));

/** A plausible Linux registry root, used only as text — nothing is read from it. */
const BROWSERS_PATH = '/home/runner/.cache/ms-playwright';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'specwitness-leak-check-'));
  directories.push(dir);
  return dir;
}

/** Writes a `ps -eo pid,ppid,pgid,etime,args` shaped listing and returns its path. */
async function listing(...rows: readonly string[]): Promise<string> {
  const dir = await scratch();
  const path = join(dir, 'ps.txt');
  await writeFile(
    path,
    ['    PID    PPID    PGID     ELAPSED COMMAND', ...rows].join('\n') + '\n',
    'utf8',
  );
  return path;
}

async function run(
  args: readonly string[],
  env?: Record<string, string>,
): Promise<{ exitCode: number | undefined; stdout: string; stderr: string }> {
  const result = await execa(process.execPath, [SCRIPT, ...args], {
    reject: false,
    ...(env === undefined ? {} : { env }),
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

describe('the browser leak check', () => {
  it('reports clean when no browser process is present', async () => {
    const psFile = await listing(
      '   1234    1000    1234       01:02 /usr/bin/node /home/runner/work/specwitness/dist/cli.js verify',
      '   1235    1234    1234       00:01 /bin/sh -c echo hello',
    );

    const { exitCode, stdout } = await run(['--ps-file', psFile, '--browsers-path', BROWSERS_PATH]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('no surviving browser process');
  });

  /**
   * The load-bearing case. A survivor must be named with its FULL argv, because the evidence
   * a reader needs is which browser, launched from which registry, in which process group —
   * not a count.
   */
  it('fails, and names the survivor, when a browser from the registry is still running', async () => {
    const psFile = await listing(
      `   4210    4200    4210       00:42 ${BROWSERS_PATH}/chromium_headless_shell-1234/chrome-linux/headless_shell --headless --remote-debugging-pipe`,
    );

    const { exitCode, stdout, stderr } = await run([
      '--ps-file',
      psFile,
      '--browsers-path',
      BROWSERS_PATH,
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toContain('4210');
    expect(stdout).toContain('headless_shell');
    expect(stdout).toContain('--remote-debugging-pipe');
    expect(stderr).toContain('ERROR:');
    expect(stderr).toContain('HINT:');
  });

  /**
   * A browser whose argv does not name the registry — a crashpad handler, a zygote, a
   * chromium the runner image ships — is still a survivor. Matching only the registry path
   * would make the scan blind to exactly the processes that outlive their parent.
   */
  it('matches a browser process that does not name the registry', async () => {
    const psFile = await listing(
      '   5120    5100    5120       00:09 /opt/hostedtoolcache/chrome_crashpad_handler --monitor-self',
    );

    const { exitCode, stdout } = await run(['--ps-file', psFile, '--browsers-path', BROWSERS_PATH]);

    expect(exitCode).toBe(1);
    expect(stdout).toContain('chrome_crashpad_handler');
  });

  /**
   * The root of the browser tree, not only the browser. `src/surfaces/browser.ts:1250-1251`
   * spawns `process.execPath` with `[cliPath, 'test', '--config', configPath]` and
   * `src/infra/process-runner.ts` detaches it, so a leaked Playwright runner is the process
   * that would open the next browser — a leak in its own right even between launches.
   */
  it("matches a leaked Playwright runner, not only the browser it launches", async () => {
    const psFile = await listing(
      '   6001    6000    6001       00:20 /usr/bin/node /repo/node_modules/@playwright/test/cli.js test --config /tmp/x/playwright.config.mjs',
    );

    const { exitCode, stdout } = await run(['--ps-file', psFile, '--browsers-path', BROWSERS_PATH]);

    expect(exitCode).toBe(1);
    expect(stdout).toContain('6001');
    expect(stdout).toContain('cli.js test');
  });

  /**
   * ⚠️ The scanner's OWN command line names the registry. Without a self-exclusion the check
   * would report itself as a leak on every clean run — a guard that always fires is a guard
   * nobody keeps.
   */
  it('never counts itself', async () => {
    const psFile = await listing(
      `   7777    7000    7777       00:00 /usr/bin/node scripts/browser-leak-check.mjs --browsers-path ${BROWSERS_PATH}`,
    );

    const { exitCode, stdout } = await run(['--ps-file', psFile, '--browsers-path', BROWSERS_PATH]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('no surviving browser process');
  });

  it('puts the evidence in the GitHub job summary', async () => {
    const dir = await scratch();
    const summaryPath = join(dir, 'summary.md');
    const psFile = await listing(
      `   4210    4200    4210       00:42 ${BROWSERS_PATH}/chromium-1234/chrome-linux/chrome --type=zygote`,
    );

    await run(['--ps-file', psFile, '--browsers-path', BROWSERS_PATH, '--label', 'after a killed run'], {
      ...process.env,
      GITHUB_STEP_SUMMARY: summaryPath,
    } as Record<string, string>);

    const summary = await readFile(summaryPath, 'utf8');
    expect(summary).toContain('after a killed run');
    expect(summary).toContain('4210');
    expect(summary).toContain('--type=zygote');
  });

  /**
   * ⚠️ **A SCAN THAT COULD NOT LOOK IS NOT A CLEAN SCAN.** An unreadable listing, or one with
   * no process rows at all, must be an error — reporting "no survivors" from a listing that
   * was never read is the same defect this whole epic is about, committed by the guard.
   */
  it('fails rather than reporting clean when it could not read a process listing', async () => {
    const dir = await scratch();

    const { exitCode, stderr } = await run([
      '--ps-file',
      join(dir, 'does-not-exist.txt'),
      '--browsers-path',
      BROWSERS_PATH,
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('ERROR:');
    expect(stderr).not.toContain('no surviving browser process');
  });

  it('fails on a listing that contains no process rows at all', async () => {
    const psFile = await listing();

    const { exitCode, stderr } = await run(['--ps-file', psFile, '--browsers-path', BROWSERS_PATH]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('ERROR:');
  });

  /* ── the baseline ─────────────────────────────────────────────────────────────────── */

  /**
   * The "before" snapshot. It records what was already running and **always exits 0**: a
   * runner that arrives with a browser already up is a fact to record, not this job's
   * failure. It is also the evidence that the scan could see browser processes at all.
   */
  it('writes a baseline of what is already running, and never fails', async () => {
    const dir = await scratch();
    const baselinePath = join(dir, 'baseline.txt');
    const psFile = await listing(
      '   9001    9000    9001       10:00 /opt/google/chrome/chrome --type=zygote',
    );

    const { exitCode, stdout } = await run([
      '--ps-file',
      psFile,
      '--browsers-path',
      BROWSERS_PATH,
      '--write-baseline',
      baselinePath,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('baseline');
    expect(await readFile(baselinePath, 'utf8')).toContain('9001');
  });

  it('subtracts the baseline, so a process that was already running is not a leak', async () => {
    const dir = await scratch();
    const baselinePath = join(dir, 'baseline.txt');
    await writeFile(baselinePath, '9001\n', 'utf8');
    const psFile = await listing(
      '   9001    9000    9001       10:00 /opt/google/chrome/chrome --type=zygote',
    );

    const { exitCode, stdout } = await run([
      '--ps-file',
      psFile,
      '--browsers-path',
      BROWSERS_PATH,
      '--baseline',
      baselinePath,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('no surviving browser process');
  });

  it('still reports a process that appeared after the baseline was taken', async () => {
    const dir = await scratch();
    const baselinePath = join(dir, 'baseline.txt');
    await writeFile(baselinePath, '9001\n', 'utf8');
    const psFile = await listing(
      '   9001    9000    9001       10:00 /opt/google/chrome/chrome --type=zygote',
      `   4210    4200    4210       00:42 ${BROWSERS_PATH}/chromium_headless_shell-1234/chrome-linux/headless_shell`,
    );

    const { exitCode, stdout } = await run([
      '--ps-file',
      psFile,
      '--browsers-path',
      BROWSERS_PATH,
      '--baseline',
      baselinePath,
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toContain('4210');
    expect(stdout).not.toContain('9001');
  });

  /**
   * ⚠️ Same fail-closed rule as the listing itself. A `--baseline` that is not there means
   * the "before" step did not run, and silently treating that as "nothing was running before"
   * would make every survivor invisible in exactly the run where the job was already broken.
   */
  it('fails when the baseline it was told to subtract does not exist', async () => {
    const dir = await scratch();
    const psFile = await listing(
      `   4210    4200    4210       00:42 ${BROWSERS_PATH}/chromium-1234/chrome-linux/chrome`,
    );

    const { exitCode, stderr } = await run([
      '--ps-file',
      psFile,
      '--browsers-path',
      BROWSERS_PATH,
      '--baseline',
      join(dir, 'never-written.txt'),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('ERROR:');
  });

  /**
   * ⚠️ **DETECTING A LEAK AND LEAVING IT RUNNING IS NOT A CHECK, IT IS A LEAK.** Raised as a P1
   * by the Codex review of this branch, and correct: `browser-cancelled-run-check.sh`
   * deliberately CREATES an orphan, so a survivor it merely printed would be a browser tree this
   * job put on a shared runner and walked away from — the exact condition AC4 exists to
   * prevent, caused by the thing checking for it.
   *
   * The script records survivors so the caller can reap them AFTER the evidence is captured.
   * The pgid is what gets written, not just the pid, because a browser is a TREE and
   * `src/infra/process-runner.ts` reaps it with `kill(-pgid, ...)` for exactly that reason.
   */
  it('records surviving processes with their process group, so the caller can reap them', async () => {
    const dir = await scratch();
    const survivorsPath = join(dir, 'survivors.txt');
    const psFile = await listing(
      `   4210    4200    4198       00:42 ${BROWSERS_PATH}/chromium-1234/chrome-linux/chrome`,
    );

    const { exitCode } = await run([
      '--ps-file',
      psFile,
      '--browsers-path',
      BROWSERS_PATH,
      '--write-survivors',
      survivorsPath,
    ]);

    expect(exitCode).toBe(1);
    expect((await readFile(survivorsPath, 'utf8')).trim()).toBe('4210 4198');
  });

  it('writes an empty survivor list when nothing survived, rather than no file at all', async () => {
    const dir = await scratch();
    const survivorsPath = join(dir, 'survivors.txt');
    const psFile = await listing('   1234    1000    1234       01:02 /usr/bin/node server.js');

    const { exitCode } = await run([
      '--ps-file',
      psFile,
      '--browsers-path',
      BROWSERS_PATH,
      '--write-survivors',
      survivorsPath,
    ]);

    // A missing file and an empty one mean different things to the reaper: "nothing survived"
    // versus "the scan never got that far".
    expect(exitCode).toBe(0);
    expect((await readFile(survivorsPath, 'utf8')).trim()).toBe('');
  });

  it('exits 64 on an unknown flag', async () => {
    const psFile = await listing('   1234    1000    1234       01:02 /usr/bin/node server.js');

    const { exitCode, stderr } = await run(['--ps-file', psFile, '--nonsense']);

    expect(exitCode).toBe(64);
    expect(stderr).toContain('usage:');
  });

  /**
   * `--wait-seconds` is how the cancelled-run check distinguishes "an orphan that is still
   * shutting down" from "an orphan that is never going away", and the elapsed time is part of
   * the evidence: it is the answer to *how long does a killed run leak for?*
   */
  it('reports how long it waited', async () => {
    const psFile = await listing(
      `   4210    4200    4210       00:42 ${BROWSERS_PATH}/chromium-1234/chrome-linux/chrome`,
    );

    const { exitCode, stdout } = await run([
      '--ps-file',
      psFile,
      '--browsers-path',
      BROWSERS_PATH,
      '--wait-seconds',
      '1',
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/still present after \d+(\.\d+)?s/);
  });
});
