/**
 * The terminal renderer suite (AC1, AC3).
 *
 * Table-driven over the outcome arms and over every status value, including
 * the ones Epic 3 cannot yet produce (`needs_human`, `error`, `flaky`). A
 * renderer that has never rendered a status will meet it first in Epic 4, in
 * production, in front of an operator deciding whether to merge.
 */

import { describe, expect, it } from 'vitest';

import { CRITERION_STATUSES } from '../../../src/domain/result.js';
import { INFRA_ERROR_CLASSIFICATIONS } from '../../../src/domain/run-outcome.js';
import { renderTerminal } from '../../../src/report/terminal.js';
import {
  CONTRACT,
  RUN_ID,
  criterion,
  gate,
  hugeGateEvidence,
  runResult,
  shortGateEvidence,
  stages,
  truncatedGateEvidence,
} from './helpers.js';

describe('the run header', () => {
  it('prints the identity, revisions, environment and run directory', () => {
    const report = renderTerminal(runResult());

    expect(report).toContain(`SpecWitness run ${RUN_ID}`);
    expect(report).toContain('Epic:        epic-3');
    expect(report).toContain('Base:        1111111111111111111111111111111111111111');
    expect(report).toContain('Head:        2222222222222222222222222222222222222222');
    expect(report).toContain('Environment: node v22.12.0 · specwitness 0.1.0 · darwin/arm64');
    expect(report).toContain(`Run dir:     .specwitness/runs/${RUN_ID}`);
    // ISO-8601 UTC, rendered exactly as stored: a caller doing a freshness
    // comparison parses this, and a localised timestamp would break it.
    expect(report).toContain('Started:     2026-08-31T14:25:01Z');
    expect(report).toContain('Finished:    2026-08-31T14:26:11Z');
  });

  it('reports contract status and fingerprint validity from the model', () => {
    // Validity IS the presence of `contract`: the integrity stage populates it
    // only after `assertVerifiableContract` returned. A renderer must never
    // re-read the contract file to find out, and this one cannot — its layer
    // rule forbids the filesystem.
    const report = renderTerminal(runResult());

    expect(report).toContain('frozen and fingerprint verified');
    expect(report).toContain(CONTRACT.fingerprint);
    expect(report).toContain('epic-3 v2');
    expect(report).toContain('3 criteria');
    // Singular reads as English, and `criterion` is irregular enough that a
    // rule appending `s` would print "criterions" at a supervisor.
    expect(report).toContain('1 amendment,');
    expect(report).not.toContain('1 amendments');
  });

  it('pluralises the contract counts correctly in both directions', () => {
    const one = renderTerminal(
      runResult({ contract: { ...CONTRACT, criterionCount: 1, amendments: 0 } }),
    );

    expect(one).toContain('1 criterion,');
    expect(one).toContain('0 amendments');
    expect(one).not.toContain('1 criterions');
  });

  it('says so plainly when the contract was never verified', () => {
    // The run died at or before integrity. Printing a fingerprint here — or
    // omitting the line entirely — would let an unverified run read like a
    // verified one, which is the whole point of the freeze.
    const report = renderTerminal(
      runResult({ contract: undefined, outcome: { infraError: 'integrity' } }),
    );

    expect(report).toContain('not verified — the run ended at or before the integrity stage');
    expect(report).not.toContain(CONTRACT.fingerprint);
  });

  it('names the absence of a worktree rather than printing nothing', () => {
    const report = renderTerminal(
      runResult({ environment: { ...runResult().environment, worktreePath: null } }),
    );

    expect(report).toContain('Worktree:    (none)');
  });
});

describe('the outcome arms', () => {
  it('renders a PASS', () => {
    expect(renderTerminal(runResult())).toContain('VERDICT: PASS');
  });

  it('renders a FAIL that a gate caused, and names the gate', () => {
    const report = renderTerminal(
      runResult({
        outcome: { verdict: 'FAIL', gateFailed: 'build' },
        gates: [gate('lint', 'pass'), gate('build', 'fail'), gate('test', 'skipped', 0)],
        stages: stages('gates', { stage: 'gates', status: 'failed', detail: "gate 'build' failed" }),
      }),
    );

    expect(report).toContain("VERDICT: FAIL — gate 'build' failed");
    // The failing gate is named in its own row, and the gates that never ran
    // are shown as skipped rather than omitted: a missing gate and a skipped
    // gate look identical in a report, and only one of them is true.
    expect(report).toContain('✗ fail        build');
    expect(report).toContain('– skipped     test');
  });

  it('renders a NEEDS_HUMAN', () => {
    const report = renderTerminal(
      runResult({
        outcome: { verdict: 'NEEDS_HUMAN' },
        criteria: [criterion('E3-01', 'needs_human')],
      }),
    );

    expect(report).toContain('VERDICT: NEEDS_HUMAN');
    expect(report).toContain('? needs_human');
  });

  it('never reports any infrastructure classification as a product verdict', () => {
    // The product's central promise at its last mile. Exit 3, never exit 1 —
    // and a report that said FAIL here would contradict the exit code the same
    // run produces.
    for (const classification of INFRA_ERROR_CLASSIFICATIONS) {
      const report = renderTerminal(runResult({ outcome: { infraError: classification } }));

      expect(report).toContain(`VERDICT: (none) — infra error: ${classification}`);
      expect(report).not.toContain('VERDICT: FAIL');
      expect(report).not.toContain('VERDICT: PASS');
    }
  });
});

describe('the boundary between a stage error and the run outcome', () => {
  it('renders a product verdict even when a later stage errored', () => {
    // pamela's SHAPE UPDATE 3: once an outcome exists, a failure after it never
    // replaces it. The defect that rule fixed was a run which FAILed on a gate
    // and then could not write result.json being reported as exit 3 — a harness
    // reads exit 3 as "environment broken, retry", and the retry merges a branch
    // that does not build.
    //
    // So `PASS`/`FAIL` alongside a `status: 'error'` stage entry is legal and
    // meaningful, and this renderer must not read the error entry as implying an
    // infra outcome. Asserting it here rather than trusting it: the property
    // lives in her module, the misreading would live in mine.
    const report = renderTerminal(
      runResult({
        outcome: { verdict: 'FAIL', gateFailed: 'test' },
        gates: [gate('test', 'fail')],
        stages: stages('teardown', {
          stage: 'persist',
          status: 'error',
          detail: 'could not write result.json: ENOSPC',
        }),
      }),
    );

    expect(report).toContain("VERDICT: FAIL — gate 'test' failed");
    expect(report).not.toContain('infra error');
    // The durability failure stays visible without being fatal to the answer.
    expect(report).toContain('! error');
    expect(report).toContain('could not write result.json');
  });
});

describe('redaction is never undone and never repeated', () => {
  it('prints already-redacted text exactly as the model carries it', () => {
    // AD-10 puts redaction at capture precisely so a renderer cannot get it
    // wrong. A renderer that "helpfully" re-processed this text could un-redact
    // it by reformatting, or double-redact and hide real evidence. pamela's
    // `deriveCriterionResult` redacts `expected`/`actual` at construction, and
    // her pipeline recorder redacts stage `detail` — so by the time either
    // reaches here the marker is part of the data.
    const report = renderTerminal(
      runResult({
        criteria: [
          criterion('E3-01', 'fail', {
            statement: 'the client sends no credential upstream',
            expected: 'Authorization: [REDACTED]',
            actual: 'Authorization: [REDACTED]',
          }),
        ],
      }),
    );

    expect(report).toContain('Authorization: [REDACTED]');
    // Neither a second pass over the marker itself...
    expect(report).not.toContain('[[REDACTED]]');
    // ...nor any attempt to reconstruct what was behind it.
    expect(report).not.toMatch(/Bearer\s/);
  });
});

describe('per-criterion rendering', () => {
  it('renders every status, including the ones this epic cannot yet produce', () => {
    const report = renderTerminal(
      runResult({
        criteria: CRITERION_STATUSES.map((status, index) =>
          criterion(`E3-0${index + 1}`, status),
        ),
      }),
    );

    for (const status of CRITERION_STATUSES) {
      expect(report).toContain(status);
    }
  });

  it('renders error visibly differently from fail, without any colour', () => {
    // The distinction the whole epic exists to preserve: `fail` says the branch
    // is wrong, `error` says we could not look. An operator who reads one as
    // the other goes hunting for a defect that may not exist.
    const report = renderTerminal(
      runResult({
        criteria: [criterion('E3-01', 'fail'), criterion('E3-02', 'error')],
      }),
    );

    const failLine = report.split('\n').find((line) => line.includes('E3-01')) ?? '';
    const errorLine = report.split('\n').find((line) => line.includes('E3-02')) ?? '';

    expect(failLine).toContain('✗ fail');
    expect(errorLine).toContain('! error');
    expect(errorLine).not.toContain('✗');
    // And the difference survives having every non-letter stripped, which is
    // what a pipe, a capture buffer or a screen reader effectively does.
    expect(failLine.replace(/[^a-z_]/g, '')).not.toBe(errorLine.replace(/[^a-z_]/g, ''));
  });

  it('surfaces a flaky pass, always', () => {
    // FR-32 / AD-9: a retry-pass is a pass, and its flakiness is never
    // optimised away. A renderer is the last place that visibility can be lost,
    // and a clean-looking flaky pass hides an entire defect class.
    const report = renderTerminal(
      runResult({ criteria: [criterion('E3-01', 'pass', { flaky: true })] }),
    );

    expect(report).toContain('flaky');
    expect(report).toContain('✓ pass');
  });

  it('prints the contract statement as the one-line summary, verbatim', () => {
    // FR-29's "one-line summary" is a human's words copied from the frozen
    // contract at derivation time — never a sentence a renderer synthesised
    // from a status, which would be a fact the JSON view does not carry.
    const report = renderTerminal(
      runResult({
        criteria: [
          criterion('E3-01', 'fail', {
            statement: 'the checkout page rejects an expired card',
            expected: 'HTTP 402',
            actual: 'HTTP 500',
          }),
        ],
      }),
    );

    expect(report).toContain('the checkout page rejects an expired card');
    expect(report).toContain('HTTP 402');
    expect(report).toContain('HTTP 500');
  });

  it('explains an empty criteria section rather than showing an empty heading', () => {
    // The gates-only run this epic ships. A bare `Criteria` heading with
    // nothing under it reads as a bug in the report.
    const report = renderTerminal(runResult({ criteria: [] }));

    expect(report).toContain('(none — this run verified deterministic gates only)');
  });
});

describe('bounded output', () => {
  it('truncates long output and points at the full file with a relative path', () => {
    // NFR-8: the caller is frequently an agent and the report lands in a
    // context window, so a megabyte of test output would flood it. The pointer
    // is relative to the run directory (Q48) so it still resolves after the
    // directory is copied between machines.
    const report = renderTerminal(
      runResult({
        outcome: { verdict: 'FAIL', gateFailed: 'test' },
        gates: [gate('test', 'fail')],
        evidence: [truncatedGateEvidence('test')],
      }),
    );

    expect(report).toContain('truncated:');
    expect(report).toContain('full output at evidence/gate-test.stdout.txt');
    // The marker's pointer must not be absolute — that is the failure that
    // only shows up after someone moves the run directory.
    expect(report).not.toMatch(/full output at \//);
    expect(report.length).toBeLessThan(20_000);
  });

  it('points the two streams at two different files', () => {
    // The same property pamela closed in her constructor, asserted from the
    // rendering side: two markers naming one file would send a reader to open
    // it and read stderr as stdout. Two of us testing one property from
    // different sides is how the first hole in this area was found.
    const report = renderTerminal(
      runResult({
        outcome: { verdict: 'FAIL', gateFailed: 'test' },
        gates: [gate('test', 'fail')],
        evidence: [truncatedGateEvidence('test')],
      }),
    );

    const pointers = [...report.matchAll(/full output at (\S+)/g)].map((match) => match[1]);
    expect(new Set(pointers).size).toBe(pointers.length);
  });

  it('does not grow with the size of the output it describes', () => {
    // NFR-8 stated as the property it actually is, rather than as a fixed
    // length: a failing `npm test` can emit megabytes, and the report has to
    // stay the same size whether it emitted 20 KB or 2 MB. Asserting only
    // `length < 20000` would pass for a renderer that happened to be under the
    // limit on one fixture and flood a supervisor's context window on the next.
    //
    // The bound comes from the cap applied at capture, not from anything this
    // renderer decides — which is why there is no second cap here to keep in
    // sync with the first.
    //
    // Both fixtures are realistic multi-line log text rather than one enormous
    // token: capture-time redaction is linear over ordinary output but
    // quadratic over a long unbroken identifier run, so a single-token fixture
    // this size would take minutes and this test would look hung.
    const small = renderTerminal(
      runResult({
        gates: [gate('test', 'fail')],
        evidence: [hugeGateEvidence('test', 64_000)],
      }),
    );
    const enormous = renderTerminal(
      runResult({
        gates: [gate('test', 'fail')],
        evidence: [hugeGateEvidence('test', 4_000_000)],
      }),
    );

    // Not byte-identical, and it should not be: the marker prints the ORIGINAL
    // size, so a bigger input costs exactly the extra digits of that number.
    // That is the report telling the truth about what it withheld. The property
    // is that this is the ONLY way the report grows — 62x the input for a
    // handful of characters, rather than 62x the report.
    expect(Math.abs(enormous.length - small.length)).toBeLessThan(50);
    expect(small).toContain('bytes shown');
    // The marker still tells the truth about how much was withheld, and the two
    // numbers differ by orders of magnitude even though the reports do not.
    const bytesOf = (report: string): number =>
      Number(/of (\d+) bytes shown/.exec(report)?.[1] ?? 0);
    expect(bytesOf(enormous)).toBeGreaterThan(bytesOf(small) * 50);
  });

  it('lists a passing gate without inlining its output', () => {
    const report = renderTerminal(
      runResult({ gates: [gate('lint', 'pass')], evidence: [shortGateEvidence('lint', 'pass')] }),
    );

    expect(report).toContain('gate lint');
    expect(report).not.toContain('running lint');
  });
});

describe('counts', () => {
  it('reports every status count and the flaky count from the shared helpers', () => {
    // Summing inside the renderer would be the AD-11 drift: the terminal would
    // show a number the JSON consumer has to recompute, and the two could
    // disagree the day a status is added. These come from
    // `src/domain/result-counts.ts`, which rambo's serializer can call too.
    const report = renderTerminal(
      runResult({
        criteria: [
          criterion('E3-01', 'pass', { flaky: true }),
          criterion('E3-02', 'fail'),
          criterion('E3-03', 'skipped'),
        ],
        gates: [gate('lint', 'pass'), gate('build', 'fail'), gate('test', 'skipped', 0)],
      }),
    );

    expect(report).toContain('1 pass');
    expect(report).toContain('1 fail');
    expect(report).toContain('1 skipped');
    expect(report).toContain('(1 flaky)');
  });
});

describe('purity', () => {
  it('renders the same RunResult byte-identically twice', () => {
    // No clock, no randomness, no filesystem — so the only thing that can
    // change the output is the input. This is what makes the report
    // snapshot-testable and diffable at all.
    const result = runResult({ criteria: [criterion('E3-01', 'pass')] });

    expect(renderTerminal(result)).toBe(renderTerminal(result));
  });

  it('ends with exactly one newline', () => {
    const report = renderTerminal(runResult());

    expect(report.endsWith('\n')).toBe(true);
    expect(report.endsWith('\n\n')).toBe(false);
  });
});
