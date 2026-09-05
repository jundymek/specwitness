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

/**
 * A default absolute start time for fixture rows.
 *
 * `ps` reports `lstart` as an ABSOLUTE instant, identical on every scan of the same process —
 * which is what lets identity be exact equality rather than a tolerance. See IDENTITY in the
 * script.
 */
const STARTED = 'Fri Sep  5 08:00:00 2026';

/**
 * Writes a `ps -eo pid,ppid,pgid,etime,lstart,args` shaped listing.
 *
 * Rows are given as `<pid> <ppid> <pgid> <etime>|<args>` and the lstart column is inserted, so
 * the existing cases stay readable. Pass `started` to give a row a different start instant.
 */
async function listing(...rows: readonly string[]): Promise<string> {
  return await listingStarted(STARTED, ...rows);
}

async function listingStarted(started: string, ...rows: readonly string[]): Promise<string> {
  const dir = await scratch();
  const path = join(dir, 'ps.txt');
  const withStart = rows.map((row) => {
    // Insert the lstart column between etime and args: the fifth whitespace-separated field.
    const m = /^(\s*\d+\s+\d+\s+\d+\s+\S+)\s+(.*)$/.exec(row);
    return m === null ? row : `${m[1]} ${started} ${m[2]}`;
  });
  await writeFile(
    path,
    ['    PID    PPID    PGID     ELAPSED STARTED                      COMMAND', ...withStart].join(
      '\n',
    ) + '\n',
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
    // The baseline is WRITTEN BY THE SCRIPT rather than hand-rolled, so the fixture cannot drift
    // from the identity format. It drifted once already: these cases used to hand-write a bare
    // pid, which the fail-closed identity rule now correctly refuses to match.
    const before = await listing(
      '   9001    9000    9001       10:00 /opt/google/chrome/chrome --type=zygote',
    );
    await run(['--ps-file', before, '--browsers-path', BROWSERS_PATH, '--write-baseline', baselinePath]);

    const psFile = await listing(
      '   9001    9000    9001       10:30 /opt/google/chrome/chrome --type=zygote',
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
    const before = await listing(
      '   9001    9000    9001       10:00 /opt/google/chrome/chrome --type=zygote',
    );
    await run(['--ps-file', before, '--browsers-path', BROWSERS_PATH, '--write-baseline', baselinePath]);

    const psFile = await listing(
      '   9001    9000    9001       10:30 /opt/google/chrome/chrome --type=zygote',
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

    // The same process on a later scan: `elapsed` has grown, but `lstart` is an ABSOLUTE instant
    // and has not moved. That is the whole reason identity is keyed on it.
    const after = await listing(
      `   9001    9000    9001       10:47 ${BROWSERS_PATH}/chromium-1234/chrome-linux/chrome`,
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

    const before = await listingStarted(
      'Fri Sep  5 07:00:00 2026',
      `   9001    9000    9001    01:00:00 ${BROWSERS_PATH}/chromium-1234/chrome-linux/chrome`,
    );
    await run(['--ps-file', before, '--browsers-path', BROWSERS_PATH, '--write-baseline', baselinePath]);

    const after = await listingStarted(
      'Fri Sep  5 08:00:00 2026',
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

  /**
   * ⚠️ **THE THREE-SECOND WINDOW, CLOSED.** Raised as a P2 by the Codex review of this branch,
   * against the very fix that was supposed to close pid reuse.
   *
   * Identity was pid plus a start time DERIVED from `etime` (`sampledAt - elapsed`). Both inputs
   * have one-second resolution and the two scans are taken at different moments, so the derived
   * value needed a ±3s tolerance — and a pid reused **within those three seconds** fell inside
   * it. The false clean came back, narrowed but alive: the check would subtract a genuine
   * survivor and report no leak.
   *
   * `lstart` is an ABSOLUTE instant reported by `ps`, identical on every scan of the same
   * process, so identity is now EXACT EQUALITY with no tolerance at all. A derived value needed a
   * band; an absolute one does not. **Twice this instrument was able to report in its own
   * favour, and both times the fault was in how it infers identity** — which is why this is keyed
   * on something measured rather than something computed.
   */
  it('reports a pid reused within the old three-second tolerance', async () => {
    const dir = await scratch();
    const baselinePath = join(dir, 'baseline.txt');

    const before = await listingStarted(
      'Fri Sep  5 08:00:00 2026',
      `   9100    9000    9100       00:05 ${BROWSERS_PATH}/chromium-1234/chrome-linux/chrome`,
    );
    await run(['--ps-file', before, '--browsers-path', BROWSERS_PATH, '--write-baseline', baselinePath]);

    // Two seconds later a DIFFERENT browser takes the same pid — inside the old tolerance.
    const after = await listingStarted(
      'Fri Sep  5 08:00:02 2026',
      `   9100    9000    9100       00:01 ${BROWSERS_PATH}/chromium-1234/chrome-linux/chrome`,
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
    expect(stdout).toContain('9100');
    expect(stdout).not.toContain('no surviving browser process');
  });

  /**
   * ⚠️ FAIL CLOSED WHEN IDENTITY CANNOT BE ESTABLISHED. A row whose start instant cannot be read
   * is a row we cannot prove is the baseline's, so it is NOT subtracted — over-reporting, which
   * is the safe direction for a leak check and the one every other guard here takes.
   */
  it('does not subtract a row whose start time cannot be read', async () => {
    const dir = await scratch();
    const baselinePath = join(dir, 'baseline.txt');
    await writeFile(baselinePath, '9200 unknown\n', 'utf8');

    const after = await listing(
      `   9200    9000    9200       00:05 ${BROWSERS_PATH}/chromium-1234/chrome-linux/chrome`,
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
    expect(stdout).toContain('9200');
  });

  /* ── reaping ──────────────────────────────────────────────────────────────────────── */

  /**
   * ⚠️ **OWNERSHIP FOR DESTRUCTION IS THE CALLER'S PGID LIST, AND NOTHING ELSE.**
   *
   * Raised as a P1 by the Codex review of this branch, and it went deeper than the three prefix
   * fixes before it. The ownership model rested on SHARED PATHS: `~/.cache/ms-playwright` is the
   * registry every Playwright on the machine uses, and any Chrome may reference a file under the
   * workspace. So a concurrently running Playwright — or the operator's browser holding a
   * download from this directory — satisfied "owned" and had its whole group signalled. Adding
   * separator boundaries fixed the SPELLING of those paths; it never made them run-specific,
   * because they are not.
   *
   * Only a caller that SPAWNED a group can vouch for it. The path heuristics still decide what is
   * REPORTED; only `--owned-pgid` decides what may be SIGNALLED.
   */
  it('reports a registry browser but refuses to reap it when nobody claimed it', async () => {
    const psFile = await listing(
      `   8200    8000    8200       00:05 ${BROWSERS_PATH}/chromium-1234/chrome-linux/chrome`,
    );

    const { exitCode, stdout } = await run([
      '--ps-file',
      psFile,
      '--browsers-path',
      BROWSERS_PATH,
      '--reap',
    ]);

    // Detected and reported — the registry match is still how it is FOUND.
    expect(exitCode).toBe(1);
    expect(stdout).toContain('8200');
    // But never signalled: a shared registry path is not proof of ownership.
    expect(stdout).toContain('not claimed by the caller');
    expect(stdout).not.toContain('would signal process group 8200');
  });

  it('reaps only the groups the caller claimed', async () => {
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
    expect(stdout).toContain('not claimed by the caller');
  });

  /**
   * A claimed group goes whole, helpers included — a browser is a tree, and
   * `src/infra/process-runner.ts` reaps one with `kill(-pgid, ...)` for that reason.
   */
  it('reaps a claimed group whole, including members that match nothing', async () => {
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
      '--owned-pgid',
      '8300',
    ]);

    expect(exitCode).toBe(1);
    expect(stdout.match(/would signal process group/g)).toHaveLength(1);
    expect(stdout).toContain('would signal process group 8300');
  });

  /**
   * ⚠️ **A DRY RUN WHENEVER THE LISTING IS A FIXTURE, AND THAT IS A SAFETY PROPERTY.**
   * `--ps-file` rows carry INVENTED pids; on a real machine `8400` may be somebody's live process
   * group. A test fixture must not be able to signal anything, so it cannot.
   */
  it('never signals when the listing is a fixture', async () => {
    const psFile = await listing(
      `   8400    8000    8400       00:05 ${BROWSERS_PATH}/chromium-1234/chrome-linux/chrome`,
    );

    const { stdout } = await run([
      '--ps-file',
      psFile,
      '--browsers-path',
      BROWSERS_PATH,
      '--reap',
      '--owned-pgid',
      '8400',
    ]);

    expect(stdout).toContain('dry run');
  });

  /**
   * ⚠️ THE REFUSALS `assertSignallableProcessGroup` MAKES
   * (`src/infra/process-runner.ts:364-376`): a pgid must be an integer greater than 1, because
   * `-1` signals every process on the machine and `0` the caller's own group.
   */
  /**
   * TWO LAYERS, and the outer one is now strictly stronger — which is worth pinning rather than
   * assuming. `--owned-pgid 1` never reaches the reap loop at all: the parser rejects it with a
   * usage error, so the loop's own `pgid <= 1` refusal has become unreachable defence in depth.
   * Both are kept: the parser guards the caller's input, the loop guards a pgid that arrived from
   * `ps`.
   */
  it('rejects a claim on process group 1 at parse time, before any reaping', async () => {
    const psFile = await listing(
      `   4210    4200       1       00:42 ${BROWSERS_PATH}/chromium-1234/chrome-linux/chrome`,
    );

    const { exitCode, stderr } = await run([
      '--ps-file',
      psFile,
      '--browsers-path',
      BROWSERS_PATH,
      '--reap',
      '--owned-pgid',
      '1',
    ]);

    expect(exitCode).toBe(64);
    expect(stderr).toContain('--owned-pgid');
  });

  /** And an unclaimed group in pgid 0 or 1 is simply never signalled, being unclaimed. */
  it('never signals an unclaimed group, whatever its pgid', async () => {
    const psFile = await listing(
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
    expect(stdout).not.toContain('would signal');
  });

  it('refuses to signal its own process group even when claimed', async () => {
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
      '--owned-pgid',
      ownPgid,
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toContain(`refusing to signal process group ${ownPgid}`);
    expect(stdout).toContain('own');
  });

  /**
   * ⚠️ A safety guard that switches itself off when it cannot answer is not a guard. If `ps`
   * cannot be run, the own-group refusal cannot be evaluated, so nothing is signalled at all.
   */
  it('refuses to reap at all when it cannot determine its own process group', async () => {
    const psFile = await listing(
      `   4210    4200    4198       00:42 ${BROWSERS_PATH}/chromium-1234/chrome-linux/chrome`,
    );

    const { exitCode, stdout, stderr } = await run(
      ['--ps-file', psFile, '--browsers-path', BROWSERS_PATH, '--reap', '--owned-pgid', '4198'],
      { PATH: '/nonexistent-so-ps-cannot-be-found', HOME: process.env['HOME'] ?? '/tmp' } as Record<
        string,
        string
      >,
    );

    expect(exitCode).toBe(1);
    expect(`${stdout}${stderr}`).toContain('cannot determine its own process group');
    expect(stdout).not.toContain('would signal process group');
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
