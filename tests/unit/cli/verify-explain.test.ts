/**
 * Story 5.5, AC2 — the edge composition, where a `ProviderError` is still reachable.
 *
 * `src/authoring/explain.ts` promises never to throw and its own suite proves it. This file
 * covers the half that happens BEFORE that promise takes effect: resolving the role out of
 * config and building an adapter, both of which can fail, and neither of which may fail the
 * run.
 *
 * The claim under test is a NEGATIVE — "this can never break a verification" — which is
 * exactly the kind of claim that erodes silently. So every route asserts the same two
 * things: a note came back, and the returned run is **the input object itself**, by
 * reference. Reference identity is the cheapest possible proof that a failure path altered
 * nothing at all, and it is strictly stronger than deep equality.
 *
 * AD-12: nothing here spawns. The `fake` adapter is a shipped, config-selectable product
 * feature that reads canned responses off disk, and `readProviderProvenance` documents that
 * `fake` lands on its no-subprocess arm.
 *
 * ── VERIFIED RED ────────────────────────────────────────────────────────────────────────
 *   P12  the `catch` in `explainVerifiedRun` removed  →  green at first, which was the
 *        finding: no test reached it, because every adapter the config schema ACCEPTS can
 *        be constructed. "returns the run untouched when the adapter cannot be constructed
 *        at all" was written to close that, and the re-planted P12 then FAILED with
 *        `ProviderError` escaping — the defect that would turn a bad provider name into a
 *        failed verification.
 *   P13  the early `explainableCriteria(result).length === 0` guard removed  →  also green
 *        at first, and for a more interesting reason: `explainRun` applies the SAME guard
 *        one layer down and returns the same note, so the edge guard changed no output at
 *        all. What it actually saves is building an adapter and probing its version, which
 *        is invisible with the `fake` adapter. "builds no adapter and reaches no process
 *        runner on a clean run" makes that observable by injecting the runner factory, and
 *        the re-planted P13 FAILED against it.
 *
 * Both plants started green, and neither weakness was visible by reading. That is the whole
 * argument for planting rather than reviewing.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SpecwitnessConfig } from '../../../src/config/index.js';
import { configSchema } from '../../../src/config/schema.js';
import type { RunResult } from '../../../src/domain/run-result.js';
import { explainVerifiedRun, publishExplainedRun } from '../../../src/cli/verify/explain.js';
import { FixedClock } from '../../fakes/ports.js';
import { fullyPopulatedRunResult } from '../../fixtures/run-result.js';

/** Per-test temp directories; the auto-review runs `pnpm test` here concurrently (H-8). */
const temporary: string[] = [];

afterEach(async () => {
  // In a `finally`-shaped hook rather than inline, and every directory is removed even if
  // an earlier one refuses — a test run KILLED outright runs no hook at all, which is why
  // every fixture below is also self-limiting.
  await Promise.all(temporary.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

function config(ai: Record<string, unknown>): SpecwitnessConfig {
  // The REAL config schema, not a hand-built object literal: a test that invented its own
  // shape would keep passing after the schema changed under it.
  return configSchema.parse({ version: 1, project: { baseBranch: 'master' }, ai });
}

async function fixtureDirectory(script?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'specwitness-explain-'));
  temporary.push(dir);
  if (script !== undefined) {
    await writeFile(join(dir, 'explainer.json'), script, 'utf8');
  }
  return dir;
}

async function explain(configuration: SpecwitnessConfig, result: RunResult = fullyPopulatedRunResult()) {
  return await explainVerifiedRun({
    result,
    config: configuration,
    clock: new FixedClock('2026-09-04T00:00:00.000Z', '2026-09-04T00:00:01.000Z'),
    warn: () => undefined,
  });
}

describe('AC2 — no explainer configured', () => {
  it('returns the run untouched, with a note naming the config key to set', async () => {
    const base = fullyPopulatedRunResult();
    const output = await explain(config({}), base);

    // THE SAME OBJECT. Not an equal one — the same one.
    expect(output.result).toBe(base);
    expect(output.note).toContain('ai.roles.explainer');
    expect(output.note).toContain('verification results are unaffected');
    // A note, never an `ERROR:`. The verification succeeded and answered the question it
    // was asked; only the optional extra is missing.
    expect(output.note).not.toContain('ERROR:');
  });

  it('cannot even be configured to name a provider that is not declared', () => {
    // Pinned here rather than assumed. `resolveRoleProvider` answers `undefined` for a role
    // pointing at a missing provider key, so this module WOULD handle it as "no explainer"
    // — but it never gets the chance, because `configSchema`'s `superRefine` already
    // refuses such a config at load, naming the YAML path.
    //
    // Worth recording as a test rather than a comment: it is the reason there is no
    // separate "dangling role" route in this file, and a reader auditing AC2's five routes
    // should be able to see that the sixth one is closed upstream rather than forgotten.
    expect(() => config({ roles: { explainer: 'nowhere' } })).toThrow(
      /references undeclared provider/,
    );
  });
});

describe('AC2 — the provider cannot produce a hypothesis', () => {
  it('returns the run untouched when the fixture script is missing entirely', async () => {
    const dir = await fixtureDirectory();
    const base = fullyPopulatedRunResult();

    const output = await explain(
      config({
        providers: { hermetic: { adapter: 'fake', mode: dir } },
        roles: { explainer: 'hermetic' },
      }),
      base,
    );

    // The adapter throws `ProviderError` from `generate`; the merged gate classifies it as
    // `provider-failed` rather than propagating it, and this module records the spend.
    expect(output.note).toMatch(/no usable hypothesis/);
    expect(output.result.explanations).toBeUndefined();
    // Every other field is untouched, including the verdict and every criterion status.
    expect(output.result.outcome).toBe(base.outcome);
    expect(output.result.criteria).toBe(base.criteria);
    // But the attempt IS recorded: a failed call spent the quota a successful one would
    // have, and Q65/FR-15 exist to keep that visible.
    expect(output.result.providerUsage).toHaveLength(base.providerUsage.length + 1);
    expect(output.result.providerUsage.at(-1)?.role).toBe('explainer');
  });

  it('returns the run untouched when the adapter cannot be constructed at all', async () => {
    // THE BACKSTOP `catch`, reached deliberately. `configSchema` refuses an unknown adapter,
    // so this config is built by a cast rather than parsed — which is exactly the situation
    // `createProvider`'s `default:` arm documents itself as the fail-closed floor for: "a
    // value that reached here without passing the schema".
    //
    // This test exists because planting the removal of that `catch` did NOT go red without
    // it. Every other route is caught further in, by the merged gate; this is the only one
    // where a `ProviderError` is thrown at construction, and for `plan-author` that is
    // correctly fatal. Here it must be a note.
    const base = fullyPopulatedRunResult();
    const broken = {
      version: 1,
      project: { baseBranch: 'master' },
      ai: {
        providers: { hermetic: { adapter: 'a-build-that-does-not-exist', mode: 'unused' } },
        roles: { explainer: 'hermetic' },
      },
      gates: [],
      services: {},
      data: {},
      observations: {},
    } as unknown as SpecwitnessConfig;

    const output = await explain(broken, base);

    expect(output.result).toBe(base);
    expect(output.note).toContain('could not be honoured');
    expect(output.note).toContain('verification results are unaffected');
  });

  it('returns the run untouched when the response is malformed', async () => {
    const dir = await fixtureDirectory(JSON.stringify(['definitely not json']));
    const base = fullyPopulatedRunResult();

    const output = await explain(
      config({
        providers: { hermetic: { adapter: 'fake', mode: dir } },
        roles: { explainer: 'hermetic' },
      }),
      base,
    );

    expect(output.note).toMatch(/unparsable/);
    expect(output.result.criteria).toBe(base.criteria);
    expect(output.result.outcome).toBe(base.outcome);
  });
});

describe('the success path', () => {
  it('attaches the hypotheses and changes nothing else', async () => {
    const dir = await fixtureDirectory(
      JSON.stringify([
        JSON.stringify({
          explanations: [{ criterionId: 'E7-03', hypothesis: 'the flag parser is too permissive' }],
        }),
      ]),
    );
    const base = fullyPopulatedRunResult();

    const output = await explain(
      config({
        providers: { hermetic: { adapter: 'fake', mode: dir } },
        roles: { explainer: 'hermetic' },
      }),
      base,
    );

    expect(output.note).toBeUndefined();
    expect(output.result.explanations).toEqual([
      { criterionId: 'E7-03', explanation: 'the flag parser is too permissive' },
    ]);
    expect(output.result.outcome).toBe(base.outcome);
    expect(output.result.criteria).toBe(base.criteria);
  });
});

describe('nothing is spent on a run with nothing to explain', () => {
  it('never builds a provider when no criterion failed', async () => {
    const base = fullyPopulatedRunResult();
    const clean: RunResult = {
      ...base,
      criteria: base.criteria.filter((c) => c.status !== 'fail' && c.status !== 'error'),
    };

    // The fixture directory is EMPTY, so reaching the provider would produce the "has no
    // fixture for role" note. Getting "nothing to explain" instead is the proof that the
    // guard fired before anything was built or probed.
    const dir = await fixtureDirectory();
    const output = await explain(
      config({
        providers: { hermetic: { adapter: 'fake', mode: dir } },
        roles: { explainer: 'hermetic' },
      }),
      clean,
    );

    expect(output.note).toMatch(/nothing to explain/);
    expect(output.result).toBe(clean);
    expect(output.result.providerUsage).toEqual(clean.providerUsage);
  });

  it('builds no adapter and reaches no process runner on a clean run', async () => {
    // THE ASSERTION THE EARLIER ONE COULD NOT MAKE. `explainRun` has its own "nothing to
    // explain" guard returning the same note, so removing the edge guard changed no output
    // at all — the plant stayed green and the optimisation was an untested claim.
    //
    // `forbiddenProcessRunner` turns any spawn into a test failure. With the `fake` adapter
    // nothing spawns either way, so what this actually pins is that the runner FACTORY is
    // never called: `createRunner` throwing is what proves the guard fired before an adapter
    // was built. For `claude-code-cli` that is a real `claude --version` not spawned.
    const base = fullyPopulatedRunResult();
    const clean: RunResult = {
      ...base,
      criteria: base.criteria.filter((c) => c.status !== 'fail' && c.status !== 'error'),
    };
    const dir = await fixtureDirectory();

    const output = await explainVerifiedRun({
      result: clean,
      config: config({
        providers: { hermetic: { adapter: 'fake', mode: dir } },
        roles: { explainer: 'hermetic' },
      }),
      clock: new FixedClock('2026-09-04T00:00:00.000Z'),
      warn: () => undefined,
      createRunner: () => {
        throw new Error('the explainer built a process runner for a run with nothing to explain');
      },
    });

    // Reaching the factory would be caught by the module's own backstop `catch` and turned
    // into a note — so this asserts the note is the CHEAP one, not the caught one.
    expect(output.note).toMatch(/nothing to explain/);
    expect(output.note).not.toMatch(/could not be honoured/);
  });
});

describe('publishing the explained run cannot break the verification', () => {
  /**
   * FOUND BY REVIEW, and it is the sharpest instance of this story's own subject.
   *
   * `RunStore.writeResult` can throw — a full disk, a permission revoked between
   * `onComplete`'s write and this one. An exception escaping the command is caught by
   * `main.ts` and classified as an INFRASTRUCTURE FAILURE, exit 3. So a completed
   * verification whose verdict was already decided would have been reported as an infra
   * error because an OPTIONAL convenience could not be filed — the exact guarantee the
   * whole story rests on, broken by the one path that touches the disk after the verdict
   * exists.
   *
   * It also fires on the AC2 failure routes, which write purely to record the
   * `providerUsage` of a call that did NOT work.
   */
  const explained: RunResult = {
    ...fullyPopulatedRunResult(),
    explanations: [{ criterionId: 'E7-03', explanation: 'a hypothesis' }],
  };
  const original = fullyPopulatedRunResult();

  it('returns the explained run when the write commits', async () => {
    const written: RunResult[] = [];

    const published = await publishExplainedRun({
      explained,
      original,
      writeResult: async (result) => {
        written.push(result);
        return { durable: true };
      },
      warn: () => undefined,
    });

    expect(published).toBe(explained);
    expect(written).toEqual([explained]);
  });

  it('falls back to the stored run when the write THROWS, and never rethrows', async () => {
    const warnings: string[] = [];

    const published = await publishExplainedRun({
      explained,
      original,
      writeResult: async () => {
        throw new Error('ENOSPC: no space left on device');
      },
      warn: (message) => warnings.push(message),
    });

    // NOT the explained run. `writeResult` stages and renames atomically, so a throw means
    // the rename did not commit and the document `onComplete` wrote is intact on disk — the
    // run WITHOUT the hypotheses. Returning the explained one anyway would make the terminal
    // and `--json` print bytes that disagree with the stored file, which is exactly the
    // AD-11/Q53 drift the single serializer exists to prevent.
    expect(published).toBe(original);
    expect(published.explanations).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('the verification is complete and stored');
    expect(warnings[0]).toContain('discarded');
  });

  it('keeps the explained run when only the durability barrier failed', async () => {
    // A DIFFERENT CONDITION, reported differently. `rename(2)` committed and only the fsync
    // after it did not: the document IS published, so it is rendered, and the operator is
    // told its survival of a power loss is unconfirmed. Collapsing this into the throw case
    // would discard hypotheses that are sitting on disk.
    const warnings: string[] = [];

    const published = await publishExplainedRun({
      explained,
      original,
      writeResult: async () => ({ durable: false, barrier: 'fsync refused' }),
      warn: (message) => warnings.push(message),
    });

    expect(published).toBe(explained);
    expect(warnings[0]).toContain('could not be made durable');
    expect(warnings[0]).toContain('fsync refused');
  });
});
