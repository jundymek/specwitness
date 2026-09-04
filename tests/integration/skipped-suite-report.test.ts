/**
 * `scripts/report-skipped-suites.mjs` (story 6.1, the skipped-suite rider).
 *
 * An INTEGRATION suite: it spawns the script as a real process, because the thing under
 * test is a CLI step in a CI job and its exit code is half of what it contributes.
 *
 * The property that matters is not the formatting. It is that **a skipped suite nobody
 * enumerated fails the step.** A report that prints skips and always exits 0 makes them
 * visible only to a reader who was already looking; the exit code is what makes a NEW skip
 * arrive as an event rather than as a line in a scrollback.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../scripts/report-skipped-suites.mjs', import.meta.url));

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })),
  );
});

/** Writes a vitest-shaped JSON report and returns its path plus a summary-file path. */
async function report(
  assertions: readonly { suite: string; title: string; status: string }[],
  file = '/repo/tests/integration/surfaces/browser.test.ts',
): Promise<{ reportPath: string; summaryPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'specwitness-skip-report-'));
  directories.push(dir);
  const reportPath = join(dir, 'report.json');
  await writeFile(
    reportPath,
    JSON.stringify({
      testResults: [
        {
          name: file,
          assertionResults: assertions.map((assertion) => ({
            ancestorTitles: [assertion.suite],
            title: assertion.title,
            status: assertion.status,
          })),
        },
      ],
    }),
    'utf8',
  );
  return { reportPath, summaryPath: join(dir, 'summary.md') };
}

async function run(
  reportPath: string,
  summaryPath?: string,
): Promise<{ exitCode: number | undefined; stdout: string; stderr: string }> {
  const result = await execa(process.execPath, [SCRIPT, reportPath], {
    reject: false,
    ...(summaryPath === undefined ? {} : { env: { GITHUB_STEP_SUMMARY: summaryPath } }),
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

describe('the skipped-suite report', () => {
  it('names every skipped suite and counts its tests', async () => {
    const { reportPath } = await report([
      {
        suite: 'the browser surface reads what the page actually shows [SKIPPED: no usable Playwright environment on this machine]',
        title: 'reads text',
        status: 'skipped',
      },
      {
        suite: 'the browser surface reads what the page actually shows [SKIPPED: no usable Playwright environment on this machine]',
        title: 'reads the title',
        status: 'skipped',
      },
      { suite: 'something that ran', title: 'passes', status: 'passed' },
    ]);

    const { exitCode, stdout } = await run(reportPath);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('1 file(s), 1 suite(s), 2 of 3 tests did not run');
    expect(stdout).toContain('[browser-gated]');
    expect(stdout).toContain('Story 6.9 owns making these run in CI');
  });

  it('reports "none" when everything ran, rather than printing nothing at all', async () => {
    // A reporting step that produces no output when there is nothing to report is
    // indistinguishable from a reporting step that broke.
    const { reportPath } = await report([
      { suite: 'a suite', title: 'runs', status: 'passed' },
    ]);

    const { exitCode, stdout } = await run(reportPath);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('none — every suite in this run executed');
  });

  it('FAILS on a skip nobody enumerated', async () => {
    // The guard. A wave-2 story that adds a skip must name it in KNOWN_SKIP_SOURCES, in a
    // diff a reviewer reads — that is the whole mechanism by which "the skip count changed
    // unexpectedly" becomes visible instead of being absorbed into a green check.
    const { reportPath } = await report([
      { suite: 'a brand new quietly skipped suite', title: 'does not run', status: 'skipped' },
    ]);

    const { exitCode, stderr } = await run(reportPath);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('a reason this repository does not recognise');
    expect(stderr).toContain('a brand new quietly skipped suite');
  });

  it('writes the same information into the GitHub job summary', async () => {
    const { reportPath, summaryPath } = await report([
      {
        suite: 'AD-3: the page may not leave the declared service origin [SKIPPED: no usable Playwright environment on this machine]',
        title: 'refuses a cross-origin navigation',
        status: 'skipped',
      },
    ]);

    await run(reportPath, summaryPath);

    const { readFile } = await import('node:fs/promises');
    const summary = await readFile(summaryPath, 'utf8');
    expect(summary).toContain('## Skipped suites: 1 in 1 file(s)');
    expect(summary).toContain('AD-3: the page may not leave the declared service origin');
    expect(summary).toContain('1 of 1 tests did not run');
  });

  it('FAILS when the report is missing, rather than reporting no skips', async () => {
    const { exitCode, stderr } = await run('/definitely/not/a/report.json');

    expect(exitCode).toBe(1);
    expect(stderr).toContain('ERROR:');
    expect(stderr).toContain('HINT:');
  });
});
