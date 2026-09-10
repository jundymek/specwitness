/**
 * Story 7.4 — config-declared extra patterns, END TO END through the built binary (AC2-AC4).
 *
 * `verify-secrets.test.ts` proves the BUILT-IN rules reach every byte a run leaves behind. This
 * proves the same of a project's OWN secret shape, which only a pattern declared under
 * `redaction.extraPatterns` in `.specwitness/config.yaml` can recognise: one raw, unshaped secret
 * is planted in a gate's output, a data command's output, an HTTP response header and body, an
 * observation command's stderr and a shell probe's stderr.
 *
 * ⚠️ THE CONTROL RUN IS HALF THE PROOF. The same project without the pattern declared must leave
 * the secret in `result.json` and in every evidence family. Without that, an absence assertion
 * could pass because the secret never reached a sink, or because a built-in happened to match it,
 * and neither would say anything about the key. Until story 7.4 wired it, every path below
 * received `undefined` in production — which is exactly what the control run shows.
 *
 * Absence, never marker presence (Epic 3 retro §7), and every file read whole: 4.6's review found
 * a hole where the inline evidence was clean and the full copy beside it was not.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildProbeFixture,
  PROJECT_SECRET,
  runCli,
  type ProbeFixture,
} from './helpers/probe-fixture.js';

interface RunDocument {
  readonly outcome: { readonly verdict?: string };
  readonly environment: { readonly runDirectory: string };
}

/** The families of evidence file a full run writes, each of which must be checked. */
const EVIDENCE_FAMILIES = ['gate-', 'data-', 'http-', 'observation-', 'shell-'] as const;

const fixtures: ProbeFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.cleanup()));
});

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

/** Verifies a project carrying the planted secret and returns everything the run left. */
async function verify(declareProjectPattern: boolean) {
  const project = await buildProbeFixture({
    seedProjectSecret: true,
    declareProjectPattern,
    gates: [{ id: 'lint', passes: true }],
  });
  fixtures.push(project);

  const { exitCode, stdout, stderr } = await runCli(['verify', project.epic, '--json'], {
    cwd: project.root,
  });

  // The run must really have HAPPENED — a refusal would leave nothing to inspect, and the
  // absence assertions would pass by vacuity.
  expect(exitCode, `stderr:\n${stderr}`).toBe(0);
  const document = JSON.parse(stdout) as RunDocument;
  expect(document.outcome).toEqual({ verdict: 'PASS' });

  const runDirectory = join(project.root, document.environment.runDirectory);
  const files = await Promise.all(
    (await filesUnder(runDirectory)).map(async (file) => ({
      name: file.replace(`${runDirectory}/`, ''),
      contents: await readFile(file, 'utf8'),
    })),
  );

  // THE FILE LIST IS ITSELF AN ASSERTION: a directory holding only a manifest proves nothing.
  const names = files.map((file) => file.name);
  expect(names).toContain('result.json');
  for (const family of EVIDENCE_FAMILIES) {
    expect(names.some((name) => name.startsWith(`evidence/${family}`)), family).toBe(true);
  }

  const scorecard = await readFile(join(project.root, '.specwitness', 'scorecard.jsonl'), 'utf8');
  return { files, stdout, stderr, scorecard };
}

describe('a declared extra pattern reaches every sink of a real run (story 7.4, AD-10)', () => {
  it('control: with NO pattern declared, the built-ins leave the secret in result.json and every evidence family', async () => {
    const run = await verify(false);
    const leaked = run.files.filter((file) => file.contents.includes(PROJECT_SECRET)).map((f) => f.name);

    expect(leaked).toContain('result.json');
    for (const family of EVIDENCE_FAMILIES) {
      expect(leaked.some((name) => name.startsWith(`evidence/${family}`)), family).toBe(true);
    }
    expect(run.stdout).toContain(PROJECT_SECRET);
  }, 90_000);

  it('with `redaction.extraPatterns` declared, the secret is ABSENT from every file, the scorecard, stdout and stderr', async () => {
    const run = await verify(true);

    for (const file of run.files) {
      expect(file.contents, `the secret survived into ${file.name}`).not.toContain(PROJECT_SECRET);
    }
    expect(run.scorecard).not.toContain(PROJECT_SECRET);
    expect(run.stdout).not.toContain(PROJECT_SECRET);
    expect(run.stderr).not.toContain(PROJECT_SECRET);
  }, 90_000);
});
