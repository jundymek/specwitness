/**
 * Story 4.6 — ADVERSARIAL params validation.
 *
 * WHY THIS FILE EXISTS, and it is not defensive box-ticking. 4.2's per-surface
 * probe schemas (`ShellProbeSchema` and its siblings) are module-private, so no
 * surface executor can re-validate with zod and all three hand-validate
 * instead. `ProbeRequest.params` is `Readonly<Record<string, unknown>>`, which
 * means **the type system stops helping exactly where the hand-validation
 * starts**: TypeScript will happily let you write `assertion.target.source`
 * against a value it knows nothing about.
 *
 * Story 4.4 hit precisely that — `{assertions: [{}]}` threw a raw `TypeError`
 * rather than the `InfraError` their contract promises, escaping the
 * classification by the one route the classification exists to close, and no
 * test caught it because every test passed a well-formed probe. They reported
 * it as a SHARED defect class rather than a bug in their branch alone, and
 * pointed out that this surface has a sharper version: `args` and
 * `argumentAllowlist` hold elements that reach an **equality test**, so a
 * non-string slipping through is an allowlist BYPASS rather than merely a
 * crash.
 *
 * So every case below is malformed in a way a hand-edited plan can be, and each
 * one asserts the same two things:
 *
 *   1. it throws `InfraError` — the classified "SpecWitness was wired wrong"
 *      answer (exit 3), never a raw `TypeError` and never a product FAIL;
 *   2. **nothing was spawned** — proven by a runner that fails the test if it is
 *      called at all, because a validator that throws only after spawning has
 *      already lost the property it exists for.
 */

import { describe, expect, it } from 'vitest';

import { InfraError } from '../../../src/domain/errors.js';
import { ShellSurfaceExecutor } from '../../../src/surfaces/shell.js';
import { FixedClock } from '../../fakes/ports.js';

import {
  recordingSink,
  recordingWriter,
  resolvedCommand,
  throwingRunner,
  WORKTREE,
} from './shell.helpers.js';

const CAPTURED_AT = '2026-09-02T00:00:00.000Z';

const WELL_FORMED = {
  probeId: 'migrations-check',
  commandId: 'migrations-applied',
  args: [] as unknown[],
  argumentAllowlist: [] as unknown[],
  assertions: [
    {
      description: 'exits cleanly',
      target: { source: 'exitCode' },
      comparison: 'equals',
      expected: '0',
    },
  ] as unknown[],
};

/** Runs the executor and returns what it threw, with a runner that must never be called. */
async function attempt(params: unknown): Promise<{ error: unknown; spawns: number }> {
  const runner = throwingRunner();
  const executor = new ShellSurfaceExecutor({
    runner,
    clock: new FixedClock(CAPTURED_AT),
    cwd: WORKTREE,
    command: resolvedCommand(),
    writeEvidence: recordingWriter(),
    recordEvidence: recordingSink(),
  });

  let error: unknown;
  try {
    await executor.execute({
      criterionId: 'E4-01',
      surface: 'shell',
      params: params as Readonly<Record<string, unknown>>,
    });
  } catch (caught) {
    error = caught;
  }
  return { error, spawns: runner.calls.length };
}

/** Every case must be classified, and must be classified BEFORE any spawn. */
async function expectRefused(params: unknown): Promise<void> {
  const { error, spawns } = await attempt(params);

  // A raw TypeError here would mean the value escaped classification entirely —
  // `cli/exit.ts` escalates an unclassified throw to exit 3, so the run would
  // still fail closed, but the operator would be told "SpecWitness crashed"
  // instead of "your plan is malformed at this field".
  expect(error).toBeInstanceOf(InfraError);
  expect((error as Error).message).not.toMatch(/undefined is not an object|Cannot read propert/);
  expect(spawns).toBe(0);
}

describe('the params object itself', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'migrations-applied'],
    ['a number', 7],
    ['an array', []],
  ])('refuses params that are %s', async (_label, value) => {
    await expectRefused(value);
  });
});

describe('the identifiers', () => {
  it.each([
    ['probeId missing', { ...WELL_FORMED, probeId: undefined }],
    ['probeId empty', { ...WELL_FORMED, probeId: '' }],
    ['probeId a number', { ...WELL_FORMED, probeId: 7 }],
    ['probeId an object', { ...WELL_FORMED, probeId: {} }],
    ['commandId missing', { ...WELL_FORMED, commandId: undefined }],
    ['commandId a number', { ...WELL_FORMED, commandId: 7 }],
  ])('refuses when %s', async (_label, params) => {
    await expectRefused(params);
  });
});

describe('args and argumentAllowlist — the allowlist-bypass shapes', () => {
  // 4.4's point: these elements reach an EQUALITY TEST. A non-string that
  // survived validation would be compared against a Set of strings, and the
  // interesting failure is not a crash — it is an argument that is neither
  // rejected nor equal to anything, reaching the child unexamined.
  it.each([
    ['args is null', { ...WELL_FORMED, args: null }],
    ['args is a string', { ...WELL_FORMED, args: '--dry-run' }],
    ['args is an object', { ...WELL_FORMED, args: { 0: '--dry-run' } }],
    ['an arg is a number', { ...WELL_FORMED, args: [7], argumentAllowlist: [7] }],
    ['an arg is null', { ...WELL_FORMED, args: [null], argumentAllowlist: [null] }],
    ['an arg is an object', { ...WELL_FORMED, args: [{}], argumentAllowlist: [{}] }],
    ['an arg is an array', { ...WELL_FORMED, args: [['x']], argumentAllowlist: [['x']] }],
    ['argumentAllowlist is null', { ...WELL_FORMED, argumentAllowlist: null }],
    ['argumentAllowlist is missing', { ...WELL_FORMED, argumentAllowlist: undefined }],
    ['an allowlist entry is a number', { ...WELL_FORMED, args: ['7'], argumentAllowlist: [7] }],
  ])('refuses when %s', async (_label, params) => {
    await expectRefused(params);
  });

  it('does not let a non-string argument reach the allowlist comparison', async () => {
    // The bypass shape stated directly: `7` and `'7'` are different values, and
    // an unvalidated `7` compared against a Set containing `'7'` is neither
    // rejected nor matched. It must never get as far as that comparison.
    await expectRefused({ ...WELL_FORMED, args: [7], argumentAllowlist: ['7'] });
  });
});

describe('assertions — the two-level dereference 4.4 was bitten by', () => {
  it.each([
    ['assertions is missing', { ...WELL_FORMED, assertions: undefined }],
    ['assertions is empty', { ...WELL_FORMED, assertions: [] }],
    ['assertions is null', { ...WELL_FORMED, assertions: null }],
    ['assertions is an object', { ...WELL_FORMED, assertions: { 0: {} } }],
    // THE EXACT SHAPE THAT BIT 4.4.
    ['an assertion is {}', { ...WELL_FORMED, assertions: [{}] }],
    ['an assertion is null', { ...WELL_FORMED, assertions: [null] }],
    ['an assertion is a string', { ...WELL_FORMED, assertions: ['exitCode == 0'] }],
    [
      'target is missing',
      {
        ...WELL_FORMED,
        assertions: [{ description: 'd', comparison: 'equals', expected: '0' }],
      },
    ],
    [
      'target is null',
      {
        ...WELL_FORMED,
        assertions: [{ description: 'd', target: null, comparison: 'equals', expected: '0' }],
      },
    ],
    [
      'target is a string',
      {
        ...WELL_FORMED,
        assertions: [
          { description: 'd', target: 'exitCode', comparison: 'equals', expected: '0' },
        ],
      },
    ],
    [
      'target.source is missing',
      {
        ...WELL_FORMED,
        assertions: [{ description: 'd', target: {}, comparison: 'equals', expected: '0' }],
      },
    ],
    [
      'target.source is unknown',
      {
        ...WELL_FORMED,
        assertions: [
          { description: 'd', target: { source: 'file' }, comparison: 'equals', expected: '0' },
        ],
      },
    ],
    [
      'comparison is unknown',
      {
        ...WELL_FORMED,
        assertions: [
          { description: 'd', target: { source: 'stdout' }, comparison: 'regex', expected: '.*' },
        ],
      },
    ],
    [
      'comparison is missing',
      {
        ...WELL_FORMED,
        assertions: [{ description: 'd', target: { source: 'stdout' }, expected: '0' }],
      },
    ],
    [
      'description is not a string',
      {
        ...WELL_FORMED,
        assertions: [
          { description: 7, target: { source: 'stdout' }, comparison: 'equals', expected: '0' },
        ],
      },
    ],
    [
      'expected is not a string',
      {
        ...WELL_FORMED,
        assertions: [
          { description: 'd', target: { source: 'stdout' }, comparison: 'equals', expected: 0 },
        ],
      },
    ],
  ])('refuses when %s', async (_label, params) => {
    await expectRefused(params);
  });
});

describe('the attempt number', () => {
  it.each([
    ['a string', { ...WELL_FORMED, attempt: '2' }],
    ['zero', { ...WELL_FORMED, attempt: 0 }],
    ['negative', { ...WELL_FORMED, attempt: -1 }],
    ['fractional', { ...WELL_FORMED, attempt: 1.5 }],
    ['NaN', { ...WELL_FORMED, attempt: Number.NaN }],
  ])('refuses an attempt that is %s', async (_label, params) => {
    await expectRefused(params);
  });
});

describe('prototype-pollution shapes reach the same refusal', () => {
  // `params` is parsed from YAML a human may have edited. A key like
  // `__proto__` must not resolve through the prototype chain into something
  // that looks valid — an own-property read is what makes that impossible.
  it('refuses a params object whose fields live only on the prototype', async () => {
    const hostile = Object.create({ ...WELL_FORMED }) as Record<string, unknown>;
    await expectRefused(hostile);
  });
});
