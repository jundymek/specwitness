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
  processResult,
  recordingRunner,
  recordingSink,
  recordingWriter,
  resolvedCommand,
  throwingRunner,
  WORKTREE,
} from './shell.helpers.js';

const CAPTURED_AT = '2026-09-02T00:00:00.000Z';

/**
 * The MERGED `ShellProbe` shape, which is what `params` actually arrives in.
 *
 * This suite is only meaningful if its baseline is CORRECT: an adversarial case
 * built on a wrong baseline is refused for the baseline rather than for the
 * malformation, so every test passes vacuously and proves nothing. That is not
 * hypothetical — this file was first written against a flattened shape, and
 * when the executor was corrected to read the merged model, all 44 cases went
 * green for exactly that wrong reason. `wellFormedIsAccepted` below is the
 * guard against a repeat: if the baseline ever stops being executable, it fails
 * and takes the premise of the whole file with it.
 */
function wellFormed(): Record<string, unknown> {
  return {
    id: 'migrations-check',
    surface: 'shell',
    mechanics: {
      commandId: 'migrations-applied',
      args: [] as unknown[],
      argumentAllowlist: [] as unknown[],
    },
    assertions: [
      {
        description: 'exits cleanly',
        target: { source: 'exitCode' },
        comparison: 'equals',
        expected: '0',
      },
    ] as unknown[],
  };
}

/** `wellFormed()` with `mechanics` replaced wholesale. */
function withMechanics(mechanics: unknown): Record<string, unknown> {
  return { ...wellFormed(), mechanics };
}

/** `wellFormed()` with one `mechanics` field overridden. */
function mech(field: string, value: unknown): Record<string, unknown> {
  const base = wellFormed();
  return { ...base, mechanics: { ...(base['mechanics'] as object), [field]: value } };
}

/** `wellFormed()` with one top-level field overridden. */
function top(field: string, value: unknown): Record<string, unknown> {
  return { ...wellFormed(), [field]: value };
}

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

/**
 * Runs the executor with a runner that ALLOWS the spawn, for the positive
 * control only.
 *
 * `attempt()` above injects a runner that throws on any call — that is what
 * makes "nothing was spawned" provable. It therefore cannot also be used to
 * show that a well-formed probe DOES run, so the positive control needs its own
 * harness. Using the throwing runner for both would make the control assert the
 * opposite of what it means.
 */
async function accepts(params: unknown): Promise<{ error: unknown; spawns: number }> {
  const runner = recordingRunner(processResult());
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
    ['id missing', top('id', undefined)],
    ['id empty', top('id', '')],
    ['id a number', top('id', 7)],
    ['id an object', top('id', {})],
    ['mechanics.commandId missing', mech('commandId', undefined)],
    ['mechanics.commandId empty', mech('commandId', '')],
    ['mechanics.commandId a number', mech('commandId', 7)],
  ])('refuses when %s', async (_label, params) => {
    await expectRefused(params);
  });

  it('accepts probeId as an alias for id', async () => {
    // The merged observation executor reads a top-level `probeId`, so the alias
    // removes a class of 4.7 wiring failure. It must genuinely work rather than
    // merely be documented.
    const { id, ...withoutId } = wellFormed();
    void id;
    const { error, spawns } = await accepts({ ...withoutId, probeId: 'migrations-check' });

    expect(error).toBeUndefined();
    expect(spawns).toBe(1);
  });
});

describe('mechanics itself', () => {
  it.each([
    ['mechanics missing', withMechanics(undefined)],
    ['mechanics null', withMechanics(null)],
    ['mechanics a string', withMechanics('migrations-applied')],
    ['mechanics an array', withMechanics([])],
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
    ['args is null', mech('args', null)],
    ['args is a string', mech('args', '--dry-run')],
    ['args is an object', mech('args', { 0: '--dry-run' })],
    ['an arg is a number', withMechanics({ commandId: 'c', args: [7], argumentAllowlist: [7] })],
    ['an arg is null', withMechanics({ commandId: 'c', args: [null], argumentAllowlist: [null] })],
    ['an arg is an object', withMechanics({ commandId: 'c', args: [{}], argumentAllowlist: [{}] })],
    ['an arg is an array', withMechanics({ commandId: 'c', args: [['x']], argumentAllowlist: [['x']] })],
    ['argumentAllowlist is null', mech('argumentAllowlist', null)],
    ['argumentAllowlist is missing', mech('argumentAllowlist', undefined)],
    ['an allowlist entry is a number', withMechanics({ commandId: 'c', args: ['7'], argumentAllowlist: [7] })],
  ])('refuses when %s', async (_label, params) => {
    await expectRefused(params);
  });

  it('does not let a non-string argument reach the allowlist comparison', async () => {
    // The bypass shape stated directly: `7` and `'7'` are different values, and
    // an unvalidated `7` compared against a Set containing `'7'` is neither
    // rejected nor matched. It must never get as far as that comparison.
    await expectRefused(withMechanics({ commandId: 'c', args: [7], argumentAllowlist: ['7'] }));
  });
});

describe('assertions — the two-level dereference 4.4 was bitten by', () => {
  const assertion = (value: unknown): Record<string, unknown> => top('assertions', [value]);

  it.each([
    ['assertions is missing', top('assertions', undefined)],
    ['assertions is empty', top('assertions', [])],
    ['assertions is null', top('assertions', null)],
    ['assertions is an object', top('assertions', { 0: {} })],
    // THE EXACT SHAPE THAT BIT 4.4.
    ['an assertion is {}', assertion({})],
    ['an assertion is null', assertion(null)],
    ['an assertion is a string', assertion('exitCode == 0')],
    ['target is missing', assertion({ description: 'd', comparison: 'equals', expected: '0' })],
    [
      'target is null',
      assertion({ description: 'd', target: null, comparison: 'equals', expected: '0' }),
    ],
    [
      'target is a string',
      assertion({ description: 'd', target: 'exitCode', comparison: 'equals', expected: '0' }),
    ],
    [
      'target.source is missing',
      assertion({ description: 'd', target: {}, comparison: 'equals', expected: '0' }),
    ],
    [
      'target.source is unknown',
      assertion({
        description: 'd',
        target: { source: 'file' },
        comparison: 'equals',
        expected: '0',
      }),
    ],
    [
      'comparison is unknown',
      assertion({
        description: 'd',
        target: { source: 'stdout' },
        comparison: 'regex',
        expected: '.*',
      }),
    ],
    [
      'comparison is missing',
      assertion({ description: 'd', target: { source: 'stdout' }, expected: '0' }),
    ],
    [
      'description is not a string',
      assertion({
        description: 7,
        target: { source: 'stdout' },
        comparison: 'equals',
        expected: '0',
      }),
    ],
    [
      'expected is not a string',
      assertion({
        description: 'd',
        target: { source: 'stdout' },
        comparison: 'equals',
        expected: 0,
      }),
    ],
  ])('refuses when %s', async (_label, params) => {
    await expectRefused(params);
  });
});

describe('the attempt number', () => {
  it.each([
    ['a string', top('attempt', '2')],
    ['zero', top('attempt', 0)],
    ['negative', top('attempt', -1)],
    ['fractional', top('attempt', 1.5)],
    ['NaN', top('attempt', Number.NaN)],
  ])('refuses an attempt that is %s', async (_label, params) => {
    await expectRefused(params);
  });
});

describe('prototype-pollution shapes reach the same refusal', () => {
  // `params` is parsed from YAML a human may have edited. A key like
  // `__proto__` must not resolve through the prototype chain into something
  // that looks valid — an own-property read is what makes that impossible.
  it('refuses a params object whose fields live only on the prototype', async () => {
    const hostile = Object.create(wellFormed()) as Record<string, unknown>;
    await expectRefused(hostile);
  });
});

describe('the premise of this file', () => {
  it('wellFormed() is ACCEPTED and runs — otherwise every case above is vacuous', async () => {
    // THE POSITIVE CONTROL, and the guard that would have caught the real bug.
    //
    // This file was first written against a FLATTENED params shape that the
    // executor happened to require but a compiled plan never produces. When the
    // executor was corrected to read the merged `ShellProbe` model, every
    // adversarial case here went green — refused for the baseline rather than
    // for its malformation. A suite of negative tests is worth exactly what its
    // positive control is worth, and this file had none.
    const { error, spawns } = await accepts(wellFormed());

    expect(error).toBeUndefined();
    expect(spawns).toBe(1);
  });
});

describe('the shape contract itself', () => {
  it('REFUSES the flattened shape this executor used to require', async () => {
    // The defect, pinned from the other side. Story 4.6 originally required
    // `{probeId, commandId, args, argumentAllowlist, assertions}` all at the top
    // level — a shape no compiled plan produces. Every test constructed it, so
    // the suite was green while a real plan probe was refused before execution.
    //
    // Asserting the old shape is now refused is a stronger guard than asserting
    // the new one is accepted: it fails loudly if anyone "helpfully" restores
    // top-level fallbacks to make an old caller work, which is exactly how the
    // two shapes would start coexisting and the ambiguity would return.
    await expectRefused({
      probeId: 'migrations-check',
      commandId: 'migrations-applied',
      args: [],
      argumentAllowlist: [],
      assertions: [
        {
          description: 'exits cleanly',
          target: { source: 'exitCode' },
          comparison: 'equals',
          expected: '0',
        },
      ],
    });
  });

  it('accepts a probe carrying the extra keys a real ProbeSpec has', async () => {
    // 4.7 should be able to pass a `ShellProbe` straight through, so unknown
    // extra keys must not be fatal — `surface` is already one of them.
    const { error, spawns } = await accepts({ ...wellFormed(), attempt: 2 });

    expect(error).toBeUndefined();
    expect(spawns).toBe(1);
  });
});

describe('the id alias cannot become a silent substitution', () => {
  it('gives the SAME evidence path whether the caller spreads id or maps probeId', async () => {
    // Story 4.5 found this on their surface: their validator falls back from
    // `probeId` to `mechanics.commandId`, so one probe produced two different
    // evidence paths depending on whether the caller spread `{...probe}` or
    // mapped `{probeId: probe.id}` — both accepted, silently. That is
    // misattributed evidence arriving through a convenience rather than a hash
    // collision.
    //
    // Here `probeId` is an ALIAS, so both callers must name the same files.
    const spread = recordingWriter();
    const mapped = recordingWriter();

    for (const [params, writer] of [
      [wellFormed(), spread],
      [(() => {
        const { id, ...rest } = wellFormed();
        return { ...rest, probeId: id };
      })(), mapped],
    ] as const) {
      await new ShellSurfaceExecutor({
        runner: recordingRunner(processResult({ stdout: 'ok\n' })),
        clock: new FixedClock(CAPTURED_AT),
        cwd: WORKTREE,
        command: resolvedCommand(),
        writeEvidence: writer,
        recordEvidence: recordingSink(),
      }).execute({
        criterionId: 'E4-01',
        surface: 'shell',
        params: params as Readonly<Record<string, unknown>>,
      });
    }

    expect(spread.writes.map((w) => w.name)).toEqual(mapped.writes.map((w) => w.name));
    expect(spread.writes.length).toBeGreaterThan(0);
  });

  it('REFUSES a params object where id and probeId disagree', async () => {
    // An alias that can resolve to a different value is not an alias.
    await expectRefused({ ...wellFormed(), probeId: 'a-different-probe' });
  });
});
