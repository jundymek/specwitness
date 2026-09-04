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

import { execFileSync } from 'node:child_process';
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

    // ⚠️ THREE, NOT ONE — and the distinction is load-bearing rather than cosmetic. "I looked
    // and found survivors" is a FINDING (1); "I could not look" is INFRA (3), which is the
    // product's own taxonomy (ADR-002 / AD-6). A caller that cannot tell them apart reads a
    // broken `ps` as a positive detection — which is exactly the defect the launch predicate
    // in `browser-cancelled-run-check.sh` had.
    expect(exitCode).toBe(3);
    expect(stderr).toContain('ERROR:');
    expect(stderr).not.toContain('no surviving browser process');
  });

  it('fails on a listing that contains no process rows at all', async () => {
    const psFile = await listing();

    const { exitCode, stderr } = await run(['--ps-file', psFile, '--browsers-path', BROWSERS_PATH]);

    expect(exitCode).toBe(3);
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

    expect(exitCode).toBe(3);
    expect(stderr).toContain('ERROR:');
  });

  /* ── the launch predicate ─────────────────────────────────────────────────────────── */

  /**
   * ⚠️ **THE PLAYWRIGHT RUNNER IS NOT A BROWSER, AND TREATING IT AS ONE MADE THE VACUITY GUARD
   * VACUOUS.** Raised as a P1 by the Codex review of this branch.
   *
   * `browser-cancelled-run-check.sh` waits for a browser before killing the run, precisely so it
   * cannot report "nothing survived a cancelled run" about a run that had not started a browser.
   * It detected launch by asking this scanner for a non-zero exit — but the scanner deliberately
   * matches `@playwright/test/cli.js` too (it is the root of the browser tree, and leaking it is
   * a leak), and that process starts BEFORE chromium. On a slow runner the kill could therefore
   * land after the CLI started and before any browser existed, and the check would pass having
   * exercised nothing.
   *
   * `--browsers-only` is the narrower predicate: real browser processes, never the runner.
   */
  it('--browsers-only does not treat a lone Playwright runner as a browser', async () => {
    const psFile = await listing(
      '   6001    6000    6001       00:02 /usr/bin/node /repo/node_modules/@playwright/test/cli.js test --config /tmp/x/playwright.config.mjs',
    );

    const { exitCode, stdout } = await run([
      '--ps-file',
      psFile,
      '--browsers-path',
      BROWSERS_PATH,
      '--browsers-only',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('no surviving browser process');
  });

  it('--browsers-only still matches a real browser', async () => {
    const psFile = await listing(
      '   6001    6000    6001       00:02 /usr/bin/node /repo/node_modules/@playwright/test/cli.js test --config /tmp/x/playwright.config.mjs',
      `   6100    6001    6001       00:01 ${BROWSERS_PATH}/chromium_headless_shell-1234/chrome-linux/headless_shell --headless`,
    );

    const { exitCode, stdout } = await run([
      '--ps-file',
      psFile,
      '--browsers-path',
      BROWSERS_PATH,
      '--browsers-only',
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toContain('6100');
    // Asserted on the runner's ARGV, not on its pid: the browser's row carries `6001` in its
    // PPID column, so a bare pid check here passes or fails for the wrong reason.
    expect(stdout).not.toContain('cli.js test');
    expect(stdout.match(/^\s+\d+\s+\d+\s+\d+\s/gm)).toHaveLength(1);
  });

  /** Without the flag the runner still counts — a leaked runner is still a leak. */
  it('counts the Playwright runner when --browsers-only is NOT given', async () => {
    const psFile = await listing(
      '   6001    6000    6001       00:02 /usr/bin/node /repo/node_modules/@playwright/test/cli.js test --config /tmp/x/playwright.config.mjs',
    );

    const { exitCode } = await run(['--ps-file', psFile, '--browsers-path', BROWSERS_PATH]);

    expect(exitCode).toBe(1);
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

  /**
   * ⚠️ **A BASELINE KEYED ON PID ALONE CAN EXCLUDE A REAL SURVIVOR.** Raised as a P2 by the
   * Codex review of this branch. If a baseline browser exits and the OS hands its pid to a
   * browser this job then launches, matching on pid would subtract the new process and the scan
   * would report clean while a real leak ran on — a false clean in the check's principal
   * guarantee, which is the same family of defect as everything else this story is about.
   *
   * Identity is therefore pid **plus start time**, derived from the `etime` column that is
   * already parsed: a process seen at time T with elapsed E started at T − E, and that instant
   * is stable across scans while `etime` itself grows.
   *
   * The two cases below are the two directions, and the second is the bug.
   */
  it('still excludes a baseline process whose elapsed time keeps growing', async () => {
    const dir = await scratch();
    const baselinePath = join(dir, 'baseline.txt');

    const before = await listing(
      `   9001    9000    9001       10:00 ${BROWSERS_PATH}/chromium-1234/chrome-linux/chrome`,
    );
    await run(['--ps-file', before, '--browsers-path', BROWSERS_PATH, '--write-baseline', baselinePath]);

    // The same process on a later scan. `elapsed` grows by exactly the wall-clock that passed
    // between the two samples — which is what keeps the computed START instant fixed — so the
    // fixture cannot grow it faster than the test itself takes to run. On a real job the two
    // scans are minutes apart and elapsed grows by those minutes; the start stays put either way.
    const after = await listing(
      `   9001    9000    9001       10:01 ${BROWSERS_PATH}/chromium-1234/chrome-linux/chrome`,
    );
    const { exitCode, stdout } = await run([
      '--ps-file',
      after,
      '--browsers-path',
      BROWSERS_PATH,
      '--baseline',
      baselinePath,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('no surviving browser process');
  });

  it('reports a process that REUSED a baseline pid, instead of subtracting it', async () => {
    const dir = await scratch();
    const baselinePath = join(dir, 'baseline.txt');

    const before = await listing(
      `   9001    9000    9001    01:00:00 ${BROWSERS_PATH}/chromium-1234/chrome-linux/chrome`,
    );
    await run(['--ps-file', before, '--browsers-path', BROWSERS_PATH, '--write-baseline', baselinePath]);

    // The same PID, but only seconds old: the original exited and the pid was reused. This is a
    // NEW browser and a real survivor, however familiar its pid looks.
    const after = await listing(
      `   9001    9000    9001       00:03 ${BROWSERS_PATH}/chromium-1234/chrome-linux/chrome`,
    );
    const { exitCode, stdout } = await run([
      '--ps-file',
      after,
      '--browsers-path',
      BROWSERS_PATH,
      '--baseline',
      baselinePath,
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toContain('9001');
    expect(stdout).not.toContain('no surviving browser process');
  });

  /* ── reaping ──────────────────────────────────────────────────────────────────────── */

  /**
   * ⚠️ **A DRY RUN WHENEVER THE LISTING IS A FIXTURE, AND THAT IS A SAFETY PROPERTY, NOT A
   * TEST CONVENIENCE.** `--ps-file` rows carry INVENTED pids. On a real machine `4210` may
   * well be a live process group belonging to somebody else, and `kill(-4210)` would signal
   * it. So `--reap` signals only when the listing came from a real `ps`; with `--ps-file` it
   * reports what it would have signalled and touches nothing.
   *
   * That is also what makes the security-critical half testable: the refusals below are
   * exercised, while the signalling itself is exercised for real by the cancelled-run check
   * in CI.
   */
  it('reaps by process GROUP, and never signals when the listing is a fixture', async () => {
    const psFile = await listing(
      `   4210    4200    4198       00:42 ${BROWSERS_PATH}/chromium-1234/chrome-linux/chrome`,
      `   4211    4210    4198       00:42 ${BROWSERS_PATH}/chromium-1234/chrome-linux/chrome --type=zygote`,
    );

    const { exitCode, stdout } = await run([
      '--ps-file',
      psFile,
      '--browsers-path',
      BROWSERS_PATH,
      '--reap',
    ]);

    // The exit code still reports the leak: a leak that had to be reaped is still a leak.
    expect(exitCode).toBe(1);
    expect(stdout).toContain('would signal process group 4198');
    // One group, not two processes — a browser is a tree and the group is the unit.
    expect(stdout.match(/would signal process group/g)).toHaveLength(1);
    expect(stdout).toContain('dry run');
  });

  /**
   * ⚠️ THE REFUSALS `assertSignallableProcessGroup` MAKES, in the one place that signals
   * groups from a shell-facing script. `src/infra/process-runner.ts:364-376`: a pgid must be
   * an integer greater than 1, because `-1` signals every process on the machine and `0` the
   * caller's own group.
   */
  it('refuses to signal process group 0, 1, or a non-integer', async () => {
    const psFile = await listing(
      `   4210    4200       1       00:42 ${BROWSERS_PATH}/chromium-1234/chrome-linux/chrome`,
      `   4310    4300       0       00:42 ${BROWSERS_PATH}/chromium-1234/chrome-linux/chrome`,
    );

    const { exitCode, stdout } = await run([
      '--ps-file',
      psFile,
      '--browsers-path',
      BROWSERS_PATH,
      '--reap',
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toContain('refusing to signal process group 1');
    expect(stdout).toContain('refusing to signal process group 0');
    expect(stdout).not.toContain('would signal process group 1');
    expect(stdout).not.toContain('would signal process group 0');
  });

  it('refuses to signal its own process group', async () => {
    const ownPgid = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], {
      encoding: 'utf8',
    }).trim();
    const psFile = await listing(
      `   9410    9400 ${ownPgid.padStart(7)}       00:42 ${BROWSERS_PATH}/chromium-1234/chrome-linux/chrome`,
    );

    const { exitCode, stdout } = await run([
      '--ps-file',
      psFile,
      '--browsers-path',
      BROWSERS_PATH,
      '--reap',
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toContain(`refusing to signal process group ${ownPgid}`);
    expect(stdout).toContain('own');
  });

  /**
   * ⚠️ **A SAFETY GUARD THAT SWITCHES ITSELF OFF WHEN IT CANNOT ANSWER IS NOT A GUARD.**
   * Raised as a P1 by the Codex review of this branch. `ownProcessGroup()` returns `null` when
   * `ps` fails, and the own-group refusal was written as `own !== null && pgid === own` — so a
   * failed `ps` disabled precisely the check that stops `kill(-pgid)` killing the checker and
   * everything else in its group. Unknown must mean REFUSE, not proceed.
   *
   * Driven with a `PATH` that contains no `ps`, so the failure is real rather than simulated —
   * no test seam in the script, and the listing still arrives through `--ps-file`.
   */
  it('refuses to reap at all when it cannot determine its own process group', async () => {
    const psFile = await listing(
      `   4210    4200    4198       00:42 ${BROWSERS_PATH}/chromium-1234/chrome-linux/chrome`,
    );

    const { exitCode, stdout, stderr } = await run(
      ['--ps-file', psFile, '--browsers-path', BROWSERS_PATH, '--reap'],
      { PATH: '/nonexistent-so-ps-cannot-be-found', HOME: process.env['HOME'] ?? '/tmp' } as Record<
        string,
        string
      >,
    );

    expect(exitCode).toBe(1);
    expect(`${stdout}${stderr}`).toContain('cannot determine its own process group');
    expect(stdout).not.toContain('would signal process group');
  });

  /**
   * ⚠️ **DETECTION IS BROAD; REAPING IS NARROW. THEY ARE NOT THE SAME QUESTION, AND CONFLATING
   * THEM MADE THIS SCRIPT DESTRUCTIVE.** Raised as a P1 by the Codex review of this branch.
   *
   * The patterns match any Chrome or Electron process on purpose, because a browser helper that
   * outlives its parent is the thing being hunted. But "suspicious enough to REPORT" is a much
   * weaker claim than "mine, so safe to SIGKILL its whole process group". Run locally, a browser
   * window the operator opened during the wait matches the patterns, is absent from the
   * baseline, and would have had its entire group signalled.
   *
   * That is not hypothetical: an early local run of the cancelled-run check reported a Vivaldi
   * renderer that appeared during its 120-second wait. With `--reap` armed, this script would
   * have killed the author's browser.
   *
   * Ownership is the REGISTRY: a process running a binary out of the browsers path this job was
   * given is this job's. Everything else is reported and left alone.
   */
  it('reports a browser it does not own, and refuses to reap it', async () => {
    const psFile = await listing(
      '   8100    8000    8100       00:05 /Applications/Vivaldi.app/Contents/MacOS/Vivaldi Helper --type=renderer',
    );

    const { exitCode, stdout } = await run([
      '--ps-file',
      psFile,
      '--browsers-path',
      BROWSERS_PATH,
      '--reap',
    ]);

    // Still a finding: the report is unchanged and the exit code still says survivors exist.
    expect(exitCode).toBe(1);
    expect(stdout).toContain('8100');
    // But never signalled.
    expect(stdout).not.toContain('would signal process group 8100');
    expect(stdout).toContain('not owned by this run');
  });

  it('reaps a browser that came out of the registry it was given', async () => {
    const psFile = await listing(
      `   8200    8000    8200       00:05 ${BROWSERS_PATH}/chromium-1234/chrome-linux/chrome --type=renderer`,
    );

    const { exitCode, stdout } = await run([
      '--ps-file',
      psFile,
      '--browsers-path',
      BROWSERS_PATH,
      '--reap',
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toContain('would signal process group 8200');
  });

  /**
   * A group containing at least one registry-owned process is this run's tree, so the whole
   * group goes — helpers whose own argv does not name the registry included. That is why the
   * unit is the group and not the pid.
   */
  it('reaps the whole group when any member came from the registry', async () => {
    const psFile = await listing(
      `   8300    8000    8300       00:05 ${BROWSERS_PATH}/chromium-1234/chrome-linux/chrome`,
      '   8301    8300    8300       00:05 /opt/hostedtoolcache/chrome_crashpad_handler --monitor-self',
    );

    const { exitCode, stdout } = await run([
      '--ps-file',
      psFile,
      '--browsers-path',
      BROWSERS_PATH,
      '--reap',
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toContain('would signal process group 8300');
    expect(stdout.match(/would signal process group/g)).toHaveLength(1);
  });

  /**
   * `--owned-pgid` is the tighter bound the cancelled-run check can give, because it KNOWS which
   * groups it spared. Registry ownership alone would still be safe; this makes it exact.
   */
  it('honours an explicit owned-group list when the caller knows one', async () => {
    const psFile = await listing(
      `   8400    8000    8400       00:05 ${BROWSERS_PATH}/chromium-1234/chrome-linux/chrome`,
      `   8500    8000    8500       00:05 ${BROWSERS_PATH}/chromium-1234/chrome-linux/chrome`,
    );

    const { exitCode, stdout } = await run([
      '--ps-file',
      psFile,
      '--browsers-path',
      BROWSERS_PATH,
      '--reap',
      '--owned-pgid',
      '8400',
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toContain('would signal process group 8400');
    expect(stdout).not.toContain('would signal process group 8500');
    expect(stdout).toContain('not owned by this run');
  });

  it('reaps nothing, and says so, when nothing survived', async () => {
    const psFile = await listing('   1234    1000    1234       01:02 /usr/bin/node server.js');

    const { exitCode, stdout } = await run([
      '--ps-file',
      psFile,
      '--browsers-path',
      BROWSERS_PATH,
      '--reap',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('no surviving browser process');
    expect(stdout).not.toContain('would signal');
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
