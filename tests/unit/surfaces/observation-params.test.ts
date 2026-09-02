/**
 * Story 4.5 follow-up — the params contract, hardened.
 *
 * FOUR DEFECTS, ONE ROOT. All four come from hand-validating a
 * `Readonly<Record<string, unknown>>`, which is what every surface must do because 4.2's
 * probe schemas are module-private. The type system stops helping at that boundary.
 *
 *   1. A SILENT FALLBACK. `probeId ?? mechanics.commandId` meant a caller who spread a
 *      compiled probe verbatim — the natural move, since the domain model names the field
 *      `id` — got evidence named after the COMMAND. Two probes in one criterion sharing a
 *      commandId (the ordinary before/after case) then collapsed to one evidence stem and
 *      overwrote each other: the misattribution defect the first PR fixed, reintroduced
 *      one line away by a convenience.
 *   2. A 32-BIT DISCRIMINATOR, collidable by chosen input — the plan's ids are authored by
 *      a provider, so this is chosen-input, not chance.
 *   3. PROTOTYPE-BACKED READS. Bracket access walks the prototype chain.
 *   4. NO POSITIVE CONTROL BUILT FROM THE DOMAIN MODEL. The first PR had many positive
 *      tests and they all used the suite's own helper, so they proved the validator agreed
 *      with the helper's assumption rather than with the compiled plan.
 *
 * THE FOURTH IS WHY THE FIRST SURVIVED 66 GREEN TESTS, and it is the lesson worth keeping:
 * a positive control constructed from the same assumption as the code under test proves
 * the code is self-consistent, not that it is right. Every fixture below that stands for a
 * real probe is typed `ObservationProbe`, so the COMPILER supplies the shape.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { InfraError } from '../../../src/domain/errors.js';
import type { ObservationProbe } from '../../../src/domain/plan.js';
import { ObservationSurfaceExecutor } from '../../../src/surfaces/observation.js';
import { FixedClock } from '../../fakes/ports.js';

import {
  processResult,
  RecordingEvidence,
  resolvedCommand,
  ScriptedRunner,
} from './observation.helpers.js';

/** A real compiled probe. Typed by the merged model so the compiler decides the shape. */
const REAL_PROBE: ObservationProbe = {
  id: 'count-companies',
  surface: 'observation',
  mechanics: { commandId: 'company-count', args: ['--json'] },
  assertions: [
    {
      description: 'exactly one company row exists',
      target: { source: 'jsonPath', path: '$.count', phase: 'snapshot' },
      comparison: 'equals',
      expected: '1',
    },
  ],
};

function build(stdout = '{"count":1}') {
  const evidence = new RecordingEvidence();
  const runner = new ScriptedRunner(processResult({ stdout }));
  return {
    evidence,
    runner,
    executor: new ObservationSurfaceExecutor({
      runner,
      clock: new FixedClock('2026-09-02T00:00:00.000Z'),
      cwd: '/tmp/worktree',
      writeEvidence: evidence.write,
      recordEvidence: evidence.record,
      resolveCommand: () => resolvedCommand(),
    }),
  };
}

const execute = async (params: Record<string, unknown>, stdout?: string) => {
  const harness = build(stdout);
  const attempt = await harness.executor.execute({
    criterionId: 'E4-01',
    surface: 'observation',
    params,
  });
  return { attempt, ...harness };
};

describe('THE POSITIVE CONTROL — otherwise every rejection below is vacuous', () => {
  it('accepts a real compiled ObservationProbe spread verbatim, and runs it', async () => {
    // arnold's lesson, in his own words: "a suite that only ever proves rejection cannot
    // notice that it rejects everything." This is the guard that makes the rest mean something.
    const { attempt, runner } = await execute({ ...REAL_PROBE });

    expect(attempt.execError).toBeUndefined();
    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(true);
    expect(runner.calls).toHaveLength(1);
  });
});

describe('`id` is canonical; `probeId` is an explicit alias', () => {
  it('gives the SAME evidence path whether the caller spreads id or maps probeId', async () => {
    // THE DEFECT THIS FILE EXISTS FOR. Both spellings must name the PROBE — never the
    // command — so the two cannot diverge into two different audit records.
    const spread = await execute({ ...REAL_PROBE });
    const mapped = await execute({
      probeId: REAL_PROBE.id,
      mechanics: REAL_PROBE.mechanics,
      assertions: REAL_PROBE.assertions,
    });

    const names = (r: { evidence: RecordingEvidence }) => r.evidence.files.map((f) => f.name);
    expect(names(spread)).toEqual(names(mapped));
    expect(names(spread).join(' ')).toContain('count-companies');
    // The command id must NOT be what the evidence is named after.
    expect(names(spread).join(' ')).not.toContain('company-count-');
  });

  it('refuses an id/probeId pair that disagrees', async () => {
    // 4.6's rule, adopted verbatim: "an alias that can resolve to a semantically different
    // value is not an alias." Refusing beats picking a winner silently.
    await expect(
      execute({ ...REAL_PROBE, probeId: 'a-different-probe' }),
    ).rejects.toThrow(InfraError);
  });

  it('accepts an id/probeId pair that agrees', async () => {
    const { attempt } = await execute({ ...REAL_PROBE, probeId: REAL_PROBE.id });
    expect(attempt.execError).toBeUndefined();
  });

  it('REFUSES a probe carrying neither, instead of falling back to the command id', async () => {
    // The old behaviour defaulted to `mechanics.commandId`, which named evidence after the
    // command and let two probes sharing one command overwrite each other.
    await expect(
      execute({ mechanics: REAL_PROBE.mechanics, assertions: REAL_PROBE.assertions }),
    ).rejects.toThrow(InfraError);
  });
});

describe('the discriminator resists a CHOSEN collision, not merely a chance one', () => {
  it('carries a 12-character hex digest, not the old 7-character base36 hash', async () => {
    // ASSERTS THE PROPERTY, NOT THE FORMULA. Recomputing sha256(criterion + probe) here
    // would MIRROR the implementation rather than check it — the two would agree even if
    // both were wrong, which is the same self-consistency trap that let the probeId
    // fallback survive 66 green tests. What matters is the WIDTH and the ALPHABET: 48 bits
    // of hex puts a birthday collision at ~2^24 instead of the old ~2^16, and the old
    // digest was 7 base36 characters, so a regression to it is detectable by shape alone.
    const { evidence } = await execute({ ...REAL_PROBE });
    const name = evidence.files[0]?.name ?? '';

    expect(name).toMatch(/-[0-9a-f]{12}-snapshot-1\./);
    // Nothing as narrow as the old digest may appear again.
    expect(name).not.toMatch(/-[0-9a-z]{7}-snapshot-1\./);
  });

  it('separates two ids that share a prefix past the slug budget', async () => {
    const stem = 'p'.repeat(80);
    const names = async (id: string) =>
      (await execute({ ...REAL_PROBE, id })).evidence.files.map((f) => f.name);

    expect(await names(`${stem}alpha`)).not.toEqual(await names(`${stem}omega`));
  });

  it('is deterministic across runs of the same identity', async () => {
    const a = (await execute({ ...REAL_PROBE })).evidence.files.map((f) => f.name);
    const b = (await execute({ ...REAL_PROBE })).evidence.files.map((f) => f.name);
    expect(a).toEqual(b);
  });
});

describe('own-property reads — the SILENT direction', () => {
  it('refuses params whose fields live only on a prototype', async () => {
    const params = Object.create({ ...REAL_PROBE }) as Record<string, unknown>;
    await expect(execute(params)).rejects.toThrow(InfraError);
  });

  it('refuses an assertion whose fields live only on a prototype', async () => {
    const assertion = Object.create(REAL_PROBE.assertions[0] as unknown as object) as Record<string, unknown>;
    await expect(
      execute({ ...REAL_PROBE, assertions: [assertion] }),
    ).rejects.toThrow(InfraError);
  });

  it('still refuses a __proto__-supplied value in the OBSERVED JSON', async () => {
    // Already correct before this PR — pinned so it stays correct. A prototype-supplied
    // count satisfying "exactly one row was created" would be a PASS minted from something
    // the command never printed.
    const { attempt } = await execute({ ...REAL_PROBE }, '{"__proto__":{"count":1}}');
    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(false);
  });
});

describe('structurally wrong inputs, not merely semantically wrong ones', () => {
  // 4.6's framing: "a target with a bad source is semantically wrong; a target that is null
  // is structurally wrong. Only the second kind tests the guard." Every malformed-params
  // test in the original suite was the first kind, so the asRecord guards were unpinned.
  const withAssertions = (assertions: unknown) => ({ ...REAL_PROBE, assertions });

  it('refuses an assertion that is not an object', async () => {
    for (const bad of [null, 'a string', 42, []]) {
      await expect(execute(withAssertions([bad]))).rejects.toThrow(InfraError);
    }
  });

  it('refuses a target that is not an object', async () => {
    for (const target of [null, 'jsonPath', 7, undefined]) {
      await expect(
        execute(withAssertions([{ ...REAL_PROBE.assertions[0], target }])),
      ).rejects.toThrow(InfraError);
    }
  });

  it('refuses non-string leaves', async () => {
    const base = REAL_PROBE.assertions[0] as unknown as Record<string, unknown>;
    for (const over of [{ description: 7 }, { expected: {} }, { comparison: null }]) {
      await expect(execute(withAssertions([{ ...base, ...over }]))).rejects.toThrow(InfraError);
    }
    await expect(
      execute(
        withAssertions([{ ...base, target: { source: 'jsonPath', path: 99, phase: 'snapshot' } }]),
      ),
    ).rejects.toThrow(InfraError);
  });

  it('refuses mechanics that is not an object', async () => {
    for (const mechanics of [null, 'company-count', 7]) {
      await expect(execute({ ...REAL_PROBE, mechanics })).rejects.toThrow(InfraError);
    }
  });
});
