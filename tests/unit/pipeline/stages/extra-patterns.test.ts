import { describe, expect, it } from 'vitest';

import type { RedactionOptions } from '../../../../src/domain/evidence.js';
import type { StageName } from '../../../../src/domain/stage.js';
import type { Stage } from '../../../../src/pipeline/stage.js';
import { createDataStage } from '../../../../src/pipeline/stages/data.js';
import { createGatesStage } from '../../../../src/pipeline/stages/gates.js';
import { createStages } from '../../../../src/pipeline/stages/index.js';
import { createServicesStage, type ServicesStageDeps } from '../../../../src/pipeline/stages/services.js';
import { createSetupStage } from '../../../../src/pipeline/stages/setup.js';

import * as dataKit from './data.helpers.js';
import * as gatesKit from './gates.helpers.js';
import {
  EXTRA_PATTERN_SECRET as SECRET,
  EXTRA_REDACTION,
  PROJECT_SHAPED_OUTPUT,
} from './gates.secrets.js';
import * as servicesKit from './services.helpers.js';
import * as setupKit from './setup.helpers.js';

/**
 * Story 7.4 — config-declared extra patterns reach every NON-PROBE stage that captures text.
 *
 * The setup, gates, services and data stages execute project commands and persist what they
 * print. Until this story each called `redactText(raw)` with no options at all, so even once
 * the surfaces were wired, a gate printing a project's own secret shape would have persisted it
 * to a run-directory file and to `result.json`. That is AC2's "every sink that redacts".
 *
 * EVERY CASE HAS A CONTROL. The same capture without the pattern must CONTAIN the secret —
 * which proves both that the built-ins cannot match it and that the capture really reached the
 * sink being inspected. Without the control, an absence assertion over a sink that never saw
 * the text would pass and prove nothing.
 *
 * Absence, never marker presence (Epic 3 retro §7).
 */

/** Everything a stage could have persisted or printed, flattened into one string. */
function capturedText(parts: {
  readonly evidence: readonly unknown[];
  readonly written?: readonly { readonly contents: string }[];
  readonly error?: { readonly message: string; readonly hint?: string | undefined };
  readonly result?: unknown;
}): string {
  return [
    JSON.stringify(parts.evidence),
    ...(parts.written ?? []).map((entry) => entry.contents),
    parts.error?.message ?? '',
    parts.error?.hint ?? '',
    JSON.stringify(parts.result ?? null),
  ].join('\n');
}

async function gates(redaction?: RedactionOptions) {
  const writer = gatesKit.recordingWriter();
  const context = gatesKit.stageContext();
  await createGatesStage({
    // The DECLARED command carries the secret too: `displayCommand` is persisted in evidence.
    gates: gatesKit.declaredGates([{ id: 'lint', run: `node gates/${SECRET}.cjs` }]),
    runner: gatesKit.recordingRunner(
      gatesKit.processResult({ stdout: PROJECT_SHAPED_OUTPUT, stderr: PROJECT_SHAPED_OUTPUT }),
    ),
    writeEvidence: writer,
    ...(redaction === undefined ? {} : { redaction }),
  }).run(context);
  expect(writer.writes.length, 'the gate must have written its full output').toBeGreaterThan(0);
  return capturedText({ evidence: context.run.evidence, written: writer.writes });
}

async function gatesSpawnFailure(redaction?: RedactionOptions) {
  const error = await gatesKit.infraErrorFrom(
    createGatesStage({
      gates: gatesKit.declaredGates([{ id: 'lint', run: 'pnpm lint' }]),
      runner: gatesKit.recordingRunner(
        gatesKit.processResult({ outcome: 'spawn-failed', exitCode: null, stderr: PROJECT_SHAPED_OUTPUT }),
      ),
      writeEvidence: gatesKit.recordingWriter(),
      ...(redaction === undefined ? {} : { redaction }),
    }).run(gatesKit.stageContext()),
  );
  return capturedText({ evidence: [], error });
}

async function setup(redaction?: RedactionOptions) {
  const writer = setupKit.recordingWriter();
  const context = setupKit.stageContext();
  const result = await createSetupStage({
    install: setupKit.declaredInstall(`node scripts/${SECRET}.cjs`),
    runner: setupKit.recordingRunner(
      setupKit.processResult({ stdout: PROJECT_SHAPED_OUTPUT, stderr: PROJECT_SHAPED_OUTPUT }),
    ),
    writeEvidence: writer,
    ...(redaction === undefined ? {} : { redaction }),
  }).run(context);
  expect(writer.written.length, 'the install must have written its full output').toBeGreaterThan(0);
  // `result` too: the stage's ok detail quotes the declared command, and that detail is a
  // timeline entry persisted in `result.json`.
  return capturedText({ evidence: context.run.evidence, written: writer.written, result });
}

async function setupFailure(redaction?: RedactionOptions) {
  const error = await setupKit.infraErrorFrom(
    createSetupStage({
      install: setupKit.declaredInstall(`node scripts/${SECRET}.cjs`),
      runner: setupKit.recordingRunner(
        setupKit.processResult({ exitCode: 1, stderr: PROJECT_SHAPED_OUTPUT }),
      ),
      writeEvidence: setupKit.recordingWriter(),
      ...(redaction === undefined ? {} : { redaction }),
    }).run(setupKit.stageContext()),
  );
  return capturedText({ evidence: [], error });
}

async function data(redaction?: RedactionOptions) {
  const writer = dataKit.recordingWriter();
  const context = dataKit.stageContext();
  await createDataStage({
    data: dataKit.declaredData([{ id: 'reset', run: `node commands/${SECRET}.cjs` }]),
    runner: dataKit.recordingRunner(
      dataKit.processResult({ stdout: PROJECT_SHAPED_OUTPUT, stderr: PROJECT_SHAPED_OUTPUT }),
    ),
    writeEvidence: writer,
    ...(redaction === undefined ? {} : { redaction }),
  }).run(context);
  expect(writer.written.length, 'the data command must have written its output').toBeGreaterThan(0);
  return capturedText({ evidence: context.run.evidence, written: writer.written });
}

async function dataSpawnFailure(redaction?: RedactionOptions) {
  const error = await dataKit.infraErrorFrom(
    createDataStage({
      data: dataKit.declaredData([{ id: 'reset', run: 'pnpm reset' }]),
      runner: dataKit.recordingRunner(
        dataKit.processResult({ outcome: 'spawn-failed', exitCode: null, stderr: PROJECT_SHAPED_OUTPUT }),
      ),
      writeEvidence: dataKit.recordingWriter(),
      ...(redaction === undefined ? {} : { redaction }),
    }).run(dataKit.stageContext()),
  );
  return capturedText({ evidence: [], error });
}

function crashingServiceDeps(redaction?: RedactionOptions): ServicesStageDeps {
  return {
    services: servicesKit.declaredServices([
      {
        id: 'backend',
        run: `node ${SECRET}.js`,
        ready: { url: 'http://127.0.0.1:4501/health', timeoutSec: 1 },
      },
    ]),
    // A service that EXITS before becoming ready, printing the secret on both streams.
    runner: servicesKit.recordingRunner(
      servicesKit.processResult({
        outcome: 'completed',
        exitCode: 1,
        stdout: PROJECT_SHAPED_OUTPUT,
        stderr: PROJECT_SHAPED_OUTPUT,
      }),
    ),
    registry: servicesKit.recordingRegistry(),
    probePort: servicesKit.portProbe(),
    sleep: servicesKit.instantSleep(),
    httpProbe: async () => ({ status: 503 }),
    settleGraceMs: 5,
    ...(redaction === undefined ? {} : { redaction }),
  };
}

async function services(redaction?: RedactionOptions) {
  const context = servicesKit.stageContext({
    clock: new servicesKit.SteppingClock('2026-09-01T00:00:00.000Z', 400),
  });
  const error = await servicesKit.infraErrorFrom(
    createServicesStage(crashingServiceDeps(redaction)).run(context),
  );
  expect(context.run.evidence.length, 'the crashed service must have left evidence').toBeGreaterThan(0);
  return capturedText({ evidence: context.run.evidence, error });
}

const CASES = [
  ['gates: output, full-output file and displayCommand', gates],
  ['gates: a spawn failure quoting captured stderr', gatesSpawnFailure],
  ['setup: install output, full-output file and the ok detail', setup],
  ['setup: a failed install quoting captured stderr', setupFailure],
  ['data: output, full-output file and displayCommand', data],
  ['data: a spawn failure quoting captured stderr', dataSpawnFailure],
  ['services: a crashed service, its evidence and its InfraError', services],
] as const;

describe('story 7.4 — each capturing stage takes the run\'s extra patterns (AD-10, AC2, AC3)', () => {
  for (const [name, capture] of CASES) {
    it(`${name}: present on the built-ins alone, ABSENT with the declared pattern`, async () => {
      expect(await capture(), 'control: the built-ins must NOT match this secret').toContain(SECRET);
      expect(await capture(EXTRA_REDACTION)).not.toContain(SECRET);
    });
  }
});

describe('story 7.4 — ONE binding at the composition root reaches every capturing stage', () => {
  /**
   * `StageDependencies.redaction` is the single place the edge binds the run's options, and
   * `createStages` hands it to every stage that captures text. A per-stage binding at the edge
   * is the shape that let this defect survive four epics: each new stage was one more place to
   * remember, and none of them did.
   */
  const stageNamed = (stages: readonly Stage[], name: StageName): Stage => {
    const stage = stages.find((candidate) => candidate.name === name);
    if (stage === undefined) {
      throw new Error(`createStages returned no '${name}' stage`);
    }
    return stage;
  };

  async function throughCreateStages(redaction?: RedactionOptions): Promise<string> {
    const gatesWriter = gatesKit.recordingWriter();
    const setupWriter = setupKit.recordingWriter();
    const dataWriter = dataKit.recordingWriter();
    const { redaction: _omitted, ...serviceDeps } = crashingServiceDeps();

    const stages = createStages({
      assertVerifiableContract: () => {
        throw new Error('the integrity stage is not under test here');
      },
      ...(redaction === undefined ? {} : { redaction }),
      setup: {
        install: setupKit.declaredInstall('pnpm install'),
        runner: setupKit.recordingRunner(setupKit.processResult({ stdout: PROJECT_SHAPED_OUTPUT })),
        writeEvidence: setupWriter,
      },
      gates: {
        gates: gatesKit.declaredGates([{ id: 'lint', run: 'pnpm lint' }]),
        runner: gatesKit.recordingRunner(gatesKit.processResult({ stdout: PROJECT_SHAPED_OUTPUT })),
        writeEvidence: gatesWriter,
      },
      data: {
        data: dataKit.declaredData([{ id: 'reset', run: 'pnpm reset' }]),
        runner: dataKit.recordingRunner(dataKit.processResult({ stdout: PROJECT_SHAPED_OUTPUT })),
        writeEvidence: dataWriter,
      },
      services: serviceDeps,
    });

    const setupContext = setupKit.stageContext();
    await stageNamed(stages, 'setup').run(setupContext);
    const gatesContext = gatesKit.stageContext();
    await stageNamed(stages, 'gates').run(gatesContext);
    const dataContext = dataKit.stageContext();
    await stageNamed(stages, 'data').run(dataContext);
    const servicesContext = servicesKit.stageContext({
      clock: new servicesKit.SteppingClock('2026-09-01T00:00:00.000Z', 400),
    });
    const servicesError = await servicesKit.infraErrorFrom(
      stageNamed(stages, 'services').run(servicesContext),
    );

    return [
      capturedText({ evidence: setupContext.run.evidence, written: setupWriter.written }),
      capturedText({ evidence: gatesContext.run.evidence, written: gatesWriter.writes }),
      capturedText({ evidence: dataContext.run.evidence, written: dataWriter.written }),
      capturedText({ evidence: servicesContext.run.evidence, error: servicesError }),
    ].join('\n');
  }

  it('StageDependencies.redaction is fanned out to setup, gates, data and services', async () => {
    const control = await throughCreateStages();
    // Every one of the four stages must contribute the secret to the control, or the fan-out
    // assertion below would be satisfied by a stage that captured nothing.
    expect(control.split(SECRET).length - 1).toBeGreaterThanOrEqual(4);

    expect(await throughCreateStages(EXTRA_REDACTION)).not.toContain(SECRET);
  });
});
