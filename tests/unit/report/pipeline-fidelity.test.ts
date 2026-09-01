import { describe, expect, it } from 'vitest';

import { STAGE_NAMES } from '../../../src/domain/stage.js';
import type { Stage } from '../../../src/pipeline/stage.js';
import { stageOk } from '../../../src/pipeline/stage.js';
import { createAggregateStage } from '../../../src/pipeline/stages/aggregate.js';
import { runPipeline } from '../../../src/pipeline/run-pipeline.js';
import { renderTerminal } from '../../../src/report/terminal.js';
import { FixedClock } from '../../fakes/ports.js';
import { ENVIRONMENT } from './helpers.js';

/**
 * Fidelity: the renderer is exercised against a `RunResult` the real pipeline
 * produced, not one this suite hand-built.
 *
 * Every other test in `tests/unit/report/**` builds its input from
 * `helpers.ts`, which is the right way to get table-driven coverage of statuses
 * this epic cannot yet produce. But it shares a blind spot with every fixture
 * suite: the fixtures encode what I BELIEVE `runPipeline` returns. If that
 * belief is wrong — a field I never set because I forgot it exists, a stage
 * array shaped differently from the eleven I assume — thirty-seven green tests
 * say nothing about it, and the first person to find out is whoever runs
 * `verify` for real.
 *
 * So this suite builds no `RunResult` at all. It runs the merged pipeline and
 * renders whatever comes back. The assertions are deliberately about shape
 * rather than content: content is covered exhaustively elsewhere, and the
 * question here is only "does the report survive contact with the real thing".
 *
 * It shares zero `expect()` with `tests/unit/pipeline/**` — story 3.3 asserts
 * what the pipeline produces, this asserts that the report renders it.
 */

/**
 * The eleven, in order: inert except for the REAL aggregate stage.
 *
 * Aggregate has to be the real one, and finding that out is the first thing
 * this suite paid for. An all-inert run leaves `ctx.run.outcome` unset, and the
 * runner then reports `{infraError: 'infra'}` — correctly, since no outcome was
 * ever decided. My fixtures all carry an outcome because I wrote them that way,
 * so no fixture-based test could have told me that a run only has a verdict
 * because one stage put it there.
 */
function stagesWithRealAggregate(): readonly Stage[] {
  return STAGE_NAMES.map((name) =>
    name === 'aggregate' ? createAggregateStage() : { name, run: async () => stageOk() },
  );
}

/** The eleven, all inert — so nothing decides an outcome. */
function inertStages(): readonly Stage[] {
  return STAGE_NAMES.map((name) => ({ name, run: async () => stageOk() }));
}

describe('the report renders a RunResult the real pipeline produced', () => {
  it('renders every section from a real run, with nothing missing', async () => {
    const result = await runPipeline({
      runId: 'run-20260901T070000Z-a3f9',
      epic: 'epic-3',
      baseSha: 'b'.repeat(40),
      headSha: 'c'.repeat(40),
      environment: ENVIRONMENT,
      clock: new FixedClock('2026-09-01T07:00:00.000Z'),
      stages: stagesWithRealAggregate(),
    });

    const report = renderTerminal(result);

    // The failure this test exists to catch: a field the pipeline populates
    // differently from my fixtures surfaces as `undefined` or `[object Object]`
    // in the middle of a supervisor's report, and no fixture-based assertion
    // would ever see it.
    expect(report).not.toContain('undefined');
    expect(report).not.toContain('[object Object]');
    expect(report).not.toContain('NaN');

    // Every stage the pipeline ran has a row: the report never silently drops
    // one, and never invents one either.
    for (const stage of STAGE_NAMES) {
      expect(report).toContain(stage);
    }
    expect(result.stages).toHaveLength(STAGE_NAMES.length);

    // An all-inert run is a gates-only PASS, and the verdict comes from the
    // pipeline rather than from anything this renderer decided.
    expect(report).toContain('VERDICT: PASS');
    expect(report.endsWith('\n')).toBe(true);
  });

  it('renders a real run that reached no conclusion as an infra outcome', async () => {
    // The other half, and a real `RunResult` the pipeline builds rather than one
    // I asserted into existence: with nothing to decide an outcome, `runPipeline`
    // returns `{infraError: 'infra'}`. The report must say so and must not
    // borrow a verdict — exit 3 is "SpecWitness could not reach a conclusion",
    // and printing PASS or FAIL here would contradict the exit code the same run
    // produces.
    const result = await runPipeline({
      runId: 'run-20260901T070000Z-c5d9',
      epic: 'epic-3',
      baseSha: 'b'.repeat(40),
      headSha: 'c'.repeat(40),
      environment: ENVIRONMENT,
      clock: new FixedClock('2026-09-01T07:00:00.000Z'),
      stages: inertStages(),
    });

    const report = renderTerminal(result);

    expect(report).toContain('VERDICT: (none) — infra error: infra');
    expect(report).not.toContain('VERDICT: PASS');
    expect(report).not.toContain('VERDICT: FAIL');
    expect(report).not.toContain('undefined');
  });

  it('renders a real run identically twice', async () => {
    // Determinism against a real result rather than a frozen fixture: a fixture
    // cannot drift between two calls, so proving determinism over one proves
    // less than it appears to.
    const input = {
      runId: 'run-20260901T070000Z-b4c8',
      epic: 'epic-3',
      baseSha: 'b'.repeat(40),
      headSha: 'c'.repeat(40),
      environment: ENVIRONMENT,
      clock: new FixedClock('2026-09-01T07:00:00.000Z'),
      stages: stagesWithRealAggregate(),
    };

    const result = await runPipeline(input);

    expect(renderTerminal(result)).toBe(renderTerminal(result));
  });
});
