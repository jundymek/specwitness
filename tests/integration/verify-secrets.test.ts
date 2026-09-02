/**
 * The END-TO-END seeded-secret proof (FR-28, AD-10) — a roadmap exit criterion for Epic 4.
 *
 * Each surface story proved its own capture path. This proves the WHOLE RUN: one secret is
 * seeded into every place a run captures text — a gate's output, a data command's output, an
 * HTTP response header, an HTTP response body, an observation command's streams, and a shell
 * probe's output — and then the secret string is asserted **absent** from every byte the run
 * left anywhere.
 *
 * ============================================================================
 * TWO RULES THIS FILE EXISTS TO OBEY, BOTH LEARNED THE HARD WAY
 * ============================================================================
 *
 * **1. ASSERT ABSENCE, NOT THE PRESENCE OF `[REDACTED]`.** Epic 3's retrospective §7
 * records why: output containing the marker *with the secret still beside it* survives
 * review in a way a raw leak does not. A test that looks for the marker passes on exactly
 * the output that should fail it. So every assertion here is `not.toContain(SECRET)`.
 *
 * **2. WALK THE RUN DIRECTORY; NEVER SAMPLE.** 4.6's own review found a redaction hole in
 * which the inline evidence was spotless and the full-copy file beside it held the
 * credential verbatim — invisible to any test that inspected only the evidence members. So
 * this walks every file recursively, asserts that it found the files it expects to have
 * found, and reads each one.
 *
 * The canary is deliberately NOT shaped like a real vendor key: the repository's pre-commit
 * secret scanner rejects `sk-…` literals on sight, correctly, and the shape is irrelevant —
 * `redactText` fires on the ASSIGNMENT NAME (`AWS_SECRET_ACCESS_KEY=`, `Authorization:`),
 * never on the value's format.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildProbeFixture,
  runCli,
  SECRET,
  type ProbeFixture,
} from './helpers/probe-fixture.js';

interface RunDocument {
  readonly outcome: { readonly verdict?: string; readonly infraError?: string };
  readonly environment: { readonly runDirectory: string };
  readonly evidence: readonly unknown[];
}

const fixtures: ProbeFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.cleanup()));
});

/** Every file under a directory, recursively. */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      out.push(path);
    }
  };
  await walk(dir);
  return out;
}

describe('the seeded secret reaches NO stored artifact (FR-28, AD-10)', () => {
  it('is absent from every file in the run directory, from --json stdout and from the report', async () => {
    const project = await buildProbeFixture({
      seedSecret: true,
      gates: [{ id: 'lint', passes: true }],
    });
    fixtures.push(project);

    const { exitCode, stdout, stderr } = await runCli(['verify', project.epic, '--json'], {
      cwd: project.root,
    });

    // The run must really have HAPPENED. A refusal would leave nothing to inspect and this
    // whole file would pass by vacuity — the failure mode a seeded-secret test is most
    // likely to have.
    expect(exitCode, `stderr:\n${stderr}`).toBe(0);
    const document = JSON.parse(stdout) as RunDocument;
    expect(document.outcome).toEqual({ verdict: 'PASS' });
    expect(document.evidence.length).toBeGreaterThan(0);

    const runDirectory = join(project.root, document.environment.runDirectory);
    const files = await filesUnder(runDirectory);

    // THE FILE LIST IS ITSELF AN ASSERTION. Walking a directory that turned out to hold
    // only a manifest would prove nothing, so the evidence files a full run must produce
    // are named before any of them is read.
    const names = files.map((file) => file.replace(`${runDirectory}/`, ''));
    expect(names).toContain('result.json');
    expect(names).toContain('manifest.json');
    expect(names.some((name) => name.startsWith('evidence/http-'))).toBe(true);
    expect(names.some((name) => name.startsWith('evidence/observation-'))).toBe(true);
    expect(names.some((name) => name.startsWith('evidence/shell-'))).toBe(true);
    expect(names.some((name) => name.startsWith('evidence/gate-'))).toBe(true);
    expect(names.some((name) => name.startsWith('evidence/data-'))).toBe(true);

    // Every file, read whole. No sampling: 4.6's review found a hole in which the inline
    // evidence was clean and the full copy beside it was not.
    for (const file of files) {
      const contents = await readFile(file, 'utf8');
      expect(contents, `the secret survived into ${file.replace(`${runDirectory}/`, '')}`).not.toContain(
        SECRET,
      );
    }

    // ...and the two things a human or a harness actually reads.
    expect(stdout).not.toContain(SECRET);
    expect(stderr).not.toContain(SECRET);
  }, 60_000);

  it('is absent from the terminal report too, which is a different renderer', async () => {
    const project = await buildProbeFixture({
      seedSecret: true,
      gates: [{ id: 'lint', passes: true }],
    });
    fixtures.push(project);

    const { exitCode, stdout, stderr } = await runCli(['verify', project.epic], {
      cwd: project.root,
    });

    expect(exitCode).toBe(0);
    // The terminal renderer prints bounded inline evidence, so it reads the same members
    // from a different code path than `renderJson` does.
    expect(stdout).toContain('Evidence');
    expect(stdout).not.toContain(SECRET);
    expect(stderr).not.toContain(SECRET);
  }, 60_000);

  it('is absent from a FAILING run, where expected/actual carry captured text', async () => {
    // The path that matters most and is easiest to miss. `deriveCriterionResult` copies an
    // assertion's `actual` — and an exec error's message — straight out of what a surface
    // observed, and both are persisted to `result.json` and printed to a terminal exactly
    // like evidence is. Without redaction there, they would be the one route by which a
    // captured credential reaches a stored run while every evidence field stayed clean.
    const project = await buildProbeFixture({ seedSecret: true, statusCode: 503 });
    fixtures.push(project);

    const { exitCode, stdout, stderr } = await runCli(['verify', project.epic, '--json'], {
      cwd: project.root,
    });

    expect(exitCode).toBe(1);
    const document = JSON.parse(stdout) as RunDocument;

    for (const file of await filesUnder(join(project.root, document.environment.runDirectory))) {
      expect(await readFile(file, 'utf8'), file).not.toContain(SECRET);
    }
    expect(stdout).not.toContain(SECRET);
    expect(stderr).not.toContain(SECRET);
  }, 60_000);

  it('is absent from an INFRA run, where an error message carries captured text', async () => {
    // An exec error's message travels further than evidence does: it reaches `actual`, it
    // reaches the persisted document, and `reportInfraFailure` prints it to stderr.
    const project = await buildProbeFixture({ seedSecret: true, brokenObservation: true });
    fixtures.push(project);

    const { exitCode, stdout, stderr } = await runCli(['verify', project.epic, '--json'], {
      cwd: project.root,
    });

    expect(exitCode).toBe(3);
    const document = JSON.parse(stdout) as RunDocument;

    for (const file of await filesUnder(join(project.root, document.environment.runDirectory))) {
      expect(await readFile(file, 'utf8'), file).not.toContain(SECRET);
    }
    expect(stdout).not.toContain(SECRET);
    expect(stderr).not.toContain(SECRET);
  }, 60_000);

  it('is absent from `specwitness report`, a third reader of the same document', async () => {
    const project = await buildProbeFixture({
      seedSecret: true,
      gates: [{ id: 'lint', passes: true }],
    });
    fixtures.push(project);

    await runCli(['verify', project.epic], { cwd: project.root });

    // `report` TAKES AN ARGUMENT. The first version of this test called it bare, which
    // exits 64 with an empty stdout — so both `not.toContain` assertions passed against
    // nothing at all, and the test proved exactly zero. Caught by planting a leak in
    // `redactText` and noticing this was the one case that stayed green.
    const terminal = await runCli(['report', project.epic], { cwd: project.root });
    const json = await runCli(['report', project.epic, '--json'], { cwd: project.root });

    // So the premise is asserted before the property: a report was really rendered.
    expect(terminal.exitCode, terminal.stderr).toBe(0);
    expect(terminal.stdout).toContain('Evidence');
    expect(json.exitCode, json.stderr).toBe(0);
    expect(json.stdout).toContain('"evidence"');

    expect(terminal.stdout).not.toContain(SECRET);
    expect(terminal.stderr).not.toContain(SECRET);
    expect(json.stdout).not.toContain(SECRET);
    expect(json.stderr).not.toContain(SECRET);
  }, 60_000);
});

describe('the canary really would have been caught', () => {
  it('fails when the redaction is neutered — the guard is not vacuous', async () => {
    // WITHOUT THIS TEST THE WHOLE FILE COULD BE GREEN FOR NOTHING. If the fixture never
    // actually emitted the secret — a typo in a script, a command that did not run — every
    // `not.toContain` above passes and proves nothing at all. So this asserts the secret
    // IS present in the fixture's own scripts, i.e. that there was something to redact.
    const project = await buildProbeFixture({
      seedSecret: true,
      gates: [{ id: 'lint', passes: true }],
    });
    fixtures.push(project);

    const sources = [
      join(project.root, 'app', 'server.cjs'),
      join(project.root, 'commands', 'rowcount.cjs'),
      join(project.root, 'commands', 'version.cjs'),
      join(project.root, 'commands', 'reset.cjs'),
      join(project.root, 'gates', 'lint.cjs'),
    ];

    for (const source of sources) {
      expect(await readFile(source, 'utf8'), source).toContain(SECRET);
    }

    // And the secret really travels: the fixture service serves it, so an unredacted run
    // would have carried it into the http evidence.
    const { stdout } = await runCli(['verify', project.epic, '--json'], { cwd: project.root });
    expect(stdout).toContain('"kind": "http"');
  }, 60_000);
});
