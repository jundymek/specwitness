import { describe, expect, it } from 'vitest';

import { DRAFT_RESPONSE_SCHEMA, generateDraft } from '../../../src/authoring/contract.js';
import type { AgentPrompt, AgentProvider } from '../../../src/domain/agent-provider.js';
import { KINDS, SEVERITIES, VERIFIABILITIES } from '../../../src/domain/contract.js';
import type { EpicSpec } from '../../../src/domain/epic-spec.js';
import { ProviderError } from '../../../src/domain/errors.js';
import { fingerprint } from '../../../src/schemas/canonical.js';
import { CriterionSchema } from '../../../src/schemas/contract.js';
import { FixedClock } from '../../fakes/ports.js';
import { SEEDED_SECRET } from '../../fixtures/run-result.js';

/**
 * Every case here runs through a scripted `AgentProvider` double — zero
 * subprocesses, no `claude`, no `codex`, no filesystem. `generateDraft` does no
 * I/O at all, which is what makes that possible (AD-12).
 */

const SOURCE = { path: 'docs/planning-artifacts/epics.md', line: 3, layout: 'epics-file' } as const;

const EPIC: EpicSpec = {
  schemaVersion: 1,
  id: 'epic-7',
  epicNumber: 7,
  title: 'Verification Contracts',
  goal: 'Capture the definition of done before the cohort starts.',
  stories: [
    {
      id: '7.1',
      title: 'Freeze a contract',
      narrative: 'As an epic owner,\nI want to freeze a contract,\nSo that it is authoritative.',
      acceptanceCriteria: [{ ordinal: 1, text: 'Freezing prints the fingerprint.', source: SOURCE }],
      source: SOURCE,
    },
  ],
  source: SOURCE,
};

const INSTANT = '2026-08-31T06:12:41.000Z';

/** A provider replaying scripted raw responses and recording the prompts it saw. */
function scripted(...responses: readonly string[]): AgentProvider & { prompts: AgentPrompt[] } {
  const prompts: AgentPrompt[] = [];
  let index = 0;

  return {
    id: 'scripted',
    adapter: 'fake',
    prompts,
    generate(prompt: AgentPrompt): Promise<string> {
      prompts.push(prompt);
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return Promise.resolve(response ?? '');
    },
  };
}

function draft(...criteria: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ criteria });
}

const ONE_CRITERION = draft({
  statement: 'The command prints the fingerprint on stdout.',
  kind: 'behavioral',
  severity: 'critical',
  verifiability: 'automated',
});

async function generate(provider: AgentProvider, epic: EpicSpec = EPIC) {
  return await generateDraft({
    epicSpec: epic,
    provider,
    clock: new FixedClock(INSTANT),
    providerName: 'hermetic',
    model: null,
    providerCliVersion: '0.144.4',
  });
}

describe('generateDraft — happy path', () => {
  it('produces an unfrozen contract for the epic', async () => {
    const { contract } = await generate(scripted(ONE_CRITERION));

    expect(contract.spec.epic).toBe('epic-7');
    expect(contract.spec.version).toBe(1);
    expect(contract.meta.frozen).toBe(false);
    expect(contract.meta.fingerprint).toBeNull();
    expect(contract.meta.frozenAt).toBeNull();
  });

  it('carries the statement through unchanged', async () => {
    const { contract } = await generate(scripted(ONE_CRITERION));

    expect(contract.spec.criteria[0]?.statement).toBe(
      'The command prints the fingerprint on stdout.',
    );
  });

  it('starts a fresh draft with an empty history', async () => {
    const { contract } = await generate(scripted(ONE_CRITERION));

    expect(contract.meta.history).toEqual([]);
  });

  it('records the schema version from the registry', async () => {
    const { contract } = await generate(scripted(ONE_CRITERION));

    expect(contract.meta.schemaVersion).toBe(1);
  });
});

describe('generateDraft — criterion ids are assigned by SpecWitness', () => {
  it('numbers criteria sequentially in draft order', async () => {
    const three = draft(
      { statement: 'First.', kind: 'behavioral', severity: 'critical', verifiability: 'automated' },
      { statement: 'Second.', kind: 'invariant', severity: 'normal', verifiability: 'automated' },
      { statement: 'Third.', kind: 'security', severity: 'critical', verifiability: 'human' },
    );

    const { contract } = await generate(scripted(three));

    expect(contract.spec.criteria.map((c) => c.id)).toEqual(['E7-01', 'E7-02', 'E7-03']);
  });

  it('uses the epic number rather than a hardcoded 7', async () => {
    const { contract } = await generate(scripted(ONE_CRITERION), {
      ...EPIC,
      id: 'epic-12',
      epicNumber: 12,
    });

    expect(contract.spec.criteria[0]?.id).toBe('E12-01');
  });

  it('produces unique ids — true by construction, asserted anyway', async () => {
    const many = draft(
      ...Array.from({ length: 12 }, (_, i) => ({
        statement: `Criterion number ${i}.`,
        kind: 'behavioral',
        severity: 'normal',
        verifiability: 'automated',
      })),
    );

    const { contract } = await generate(scripted(many));
    const ids = contract.spec.criteria.map((c) => c.id);

    // parseContract rejects duplicates at the file boundary; this keeps the
    // guarantee true on my side after a refactor rather than only at parse time.
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.at(-1)).toBe('E7-12');
  });

  /**
   * AD-2: a provider that chooses an id is deciding what survives an amendment,
   * and FR-7 requires ids to be stable across amendments. Anything the model
   * puts in that field is discarded.
   */
  it('discards an id the provider tried to supply', async () => {
    const withId = draft({
      id: 'E99-42',
      statement: 'The provider tried to name this criterion.',
      kind: 'behavioral',
      severity: 'normal',
      verifiability: 'automated',
    });

    const { contract } = await generate(scripted(withId));

    expect(contract.spec.criteria[0]?.id).toBe('E7-01');
  });
});

describe('generateDraft — the schema gate is the only door', () => {
  it('accepts every value of every closed vocabulary', async () => {
    const all = draft(
      ...KINDS.map((kind) => ({
        statement: `A ${kind} expectation.`,
        kind,
        severity: 'normal',
        verifiability: 'automated',
      })),
      ...SEVERITIES.map((severity) => ({
        statement: `A ${severity} expectation.`,
        kind: 'behavioral',
        severity,
        verifiability: 'automated',
      })),
      ...VERIFIABILITIES.map((verifiability) => ({
        statement: `A ${verifiability} expectation.`,
        kind: 'behavioral',
        severity: 'normal',
        verifiability,
      })),
    );

    const { contract } = await generate(scripted(all));

    expect(contract.spec.criteria).toHaveLength(
      KINDS.length + SEVERITIES.length + VERIFIABILITIES.length,
    );
  });

  it('recovers when a malformed answer is followed by a valid one', async () => {
    // Proves the GATE's retry is in play without this story owning a retry.
    const provider = scripted('not json at all', ONE_CRITERION);

    const { contract } = await generate(provider);

    expect(contract.spec.criteria).toHaveLength(1);
    expect(provider.prompts).toHaveLength(2);
  });

  it('throws ProviderError when the retry budget is exhausted', async () => {
    await expect(generate(scripted('nope', 'still nope', 'nope again', 'nope'))).rejects.toThrow(
      ProviderError,
    );
  });

  it('rejects a kind outside the closed vocabulary', async () => {
    const bad = draft({
      statement: 'An expectation of an invented kind.',
      kind: 'vibes',
      severity: 'normal',
      verifiability: 'automated',
    });

    await expect(generate(scripted(bad))).rejects.toThrow(ProviderError);
  });

  it('rejects an empty statement', async () => {
    const bad = draft({
      statement: '',
      kind: 'behavioral',
      severity: 'normal',
      verifiability: 'automated',
    });

    await expect(generate(scripted(bad))).rejects.toThrow(ProviderError);
  });
});

describe('generateDraft — a contract with no criteria is refused', () => {
  /**
   * The highest-severity silent-wrong-answer bug this story could produce: an
   * empty contract PASSes every future verify run while asserting nothing. It
   * is rejected at the schema, so it can never be written, let alone frozen.
   */
  it('refuses an empty criteria array', async () => {
    await expect(generate(scripted(JSON.stringify({ criteria: [] })))).rejects.toThrow(
      ProviderError,
    );
  });

  it('refuses a response carrying no criteria field at all', async () => {
    await expect(generate(scripted(JSON.stringify({})))).rejects.toThrow(ProviderError);
  });
});

describe('generateDraft — provenance (AD-5)', () => {
  it('records what the provider reported', async () => {
    const { contract } = await generate(scripted(ONE_CRITERION));

    expect(contract.meta.provenance).toEqual({
      provider: 'hermetic',
      model: null,
      providerCliVersion: '0.144.4',
      generatedAt: INSTANT,
    });
  });

  it('writes an unavailable value as explicit null, never omitting the key', async () => {
    const { contract } = await generateDraft({
      epicSpec: EPIC,
      provider: scripted(ONE_CRITERION),
      clock: new FixedClock(INSTANT),
      providerName: 'hermetic',
      model: null,
      providerCliVersion: null,
    });

    expect(Object.keys(contract.meta.provenance).sort()).toEqual([
      'generatedAt',
      'model',
      'provider',
      'providerCliVersion',
    ]);
    expect(contract.meta.provenance.providerCliVersion).toBeNull();
  });

  it('takes its timestamp from the injected clock, never the wall clock', async () => {
    const { contract } = await generate(scripted(ONE_CRITERION));

    expect(contract.meta.createdAt).toBe(INSTANT);
  });
});

describe('generateDraft — coupling hints', () => {
  it('reports coupled statements without altering them', async () => {
    const coupled = draft({
      statement: 'The freeze() function stores the fingerprint.',
      kind: 'behavioral',
      severity: 'normal',
      verifiability: 'automated',
    });

    const { contract, hints } = await generate(scripted(coupled));

    expect(hints.map((entry) => entry.id)).toEqual(['E7-01']);
    // Flagged, never edited.
    expect(contract.spec.criteria[0]?.statement).toBe(
      'The freeze() function stores the fingerprint.',
    );
  });

  it('reports no hints for plainly behavioral statements', async () => {
    const { hints } = await generate(scripted(ONE_CRITERION));

    expect(hints).toEqual([]);
  });
});

describe('generateDraft — the request it builds', () => {
  it('invokes the contract-author role', async () => {
    const provider = scripted(ONE_CRITERION);

    await generate(provider);

    expect(provider.prompts[0]?.role).toBe('contract-author');
  });

  /**
   * D14: the gate derives `jsonSchema` from `responseSchema` in exactly one
   * place. Supplying it here would create a second derivation site that could
   * silently disagree with the gate's — so the adapter must still SEE one,
   * without this module having produced it.
   */
  it('leaves jsonSchema derivation to the gate', async () => {
    const provider = scripted(ONE_CRITERION);

    await generate(provider);

    expect(provider.prompts[0]?.jsonSchema).toBeDefined();
  });

  it('sends the epic content in the prompt', async () => {
    const provider = scripted(ONE_CRITERION);

    await generate(provider);

    expect(provider.prompts[0]?.prompt).toContain('Freezing prints the fingerprint.');
  });
});

describe('generateDraft — round-tripping', () => {
  it('survives a very long statement and unusual unicode', async () => {
    const exotic = `${'x'.repeat(4000)} — ✓ № 7 🇵🇱 café`;
    const { contract } = await generate(
      scripted(
        draft({
          statement: exotic,
          kind: 'behavioral',
          severity: 'normal',
          verifiability: 'automated',
        }),
      ),
    );

    expect(contract.spec.criteria[0]?.statement).toBe(exotic);
    // It must also hash without throwing — the fingerprint covers this text.
    expect(fingerprint(contract.spec)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('preserves criterion order, which is fingerprinted', async () => {
    const ordered = draft(
      { statement: 'Alpha.', kind: 'behavioral', severity: 'normal', verifiability: 'automated' },
      { statement: 'Beta.', kind: 'behavioral', severity: 'normal', verifiability: 'automated' },
    );

    const { contract } = await generate(scripted(ordered));

    expect(contract.spec.criteria.map((c) => c.statement)).toEqual(['Alpha.', 'Beta.']);
  });

  it('produces a spec.epic in canonical form, never the raw argument', async () => {
    const { contract } = await generate(scripted(ONE_CRITERION));

    // parseContract now requires canonicality; assert it at the source too.
    expect(contract.spec.epic).toBe('epic-7');
  });
});

describe('DRAFT_RESPONSE_SCHEMA', () => {
  it('does not ask the model for an id', () => {
    const parsed = DRAFT_RESPONSE_SCHEMA.safeParse({
      criteria: [
        {
          statement: 'A statement.',
          kind: 'behavioral',
          severity: 'normal',
          verifiability: 'automated',
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects an empty criteria array at the schema, not downstream', () => {
    expect(DRAFT_RESPONSE_SCHEMA.safeParse({ criteria: [] }).success).toBe(false);
  });
});

describe('DRAFT_RESPONSE_SCHEMA agrees with the persisted contract schema', () => {
  /**
   * The draft schema and `CriterionSchema` must accept exactly the same
   * statements. If the draft schema is the more permissive of the two, a
   * provider response passes the gate, the contract is WRITTEN, and every
   * later `--status` or `--freeze` fails to parse the file this command just
   * produced — an unreadable artifact with no explanation available to the
   * operator, which also defeats the "a failed generation writes nothing"
   * guarantee by writing something worse than nothing.
   *
   * Found by Codex review: the draft schema used `.min(1)` where the persisted
   * schema uses a trimmed-non-empty refinement, so `"   "` was accepted here
   * and rejected there.
   */
  const STATEMENTS = [
    'A perfectly ordinary statement.',
    '',
    '   ',
    '\t\n ',
    ' leading and trailing ',
    'x',
    '—',
  ];

  it.each(STATEMENTS)('agrees on %j', (statement) => {
    const draftAccepts = DRAFT_RESPONSE_SCHEMA.safeParse({
      criteria: [{ statement, kind: 'behavioral', severity: 'normal', verifiability: 'automated' }],
    }).success;

    const persistedAccepts = CriterionSchema.safeParse({
      id: 'E7-01',
      statement,
      kind: 'behavioral',
      severity: 'normal',
      verifiability: 'automated',
    }).success;

    expect(draftAccepts).toBe(persistedAccepts);
  });
});

describe('generateDraft — a whitespace-only statement never reaches the file', () => {
  it('exhausts the gate rather than writing an unreadable contract', async () => {
    const blank = draft({
      statement: '   ',
      kind: 'behavioral',
      severity: 'normal',
      verifiability: 'automated',
    });

    await expect(generate(scripted(blank))).rejects.toThrow(ProviderError);
  });

  it('retries and accepts a valid statement after a whitespace-only one', async () => {
    const blank = draft({
      statement: '  ',
      kind: 'behavioral',
      severity: 'normal',
      verifiability: 'automated',
    });

    const { contract } = await generate(scripted(blank, ONE_CRITERION));

    expect(contract.spec.criteria[0]?.statement).toBe(
      'The command prints the fingerprint on stdout.',
    );
  });
});

/**
 * The run's `RedactionOptions` reach the prompt through `generateDraft` — story 6.8.
 *
 * ⚠️ RAISED AS A P1 BY THE CODEX REVIEW, and correct: story 6.8's first version gave the
 * prompt BUILDER a `redaction` parameter and left this entry point without one, so a
 * project's config-declared `extraPatterns` could not reach it from production at all. The
 * built-in patterns always applied; what was unreachable is exactly the shapes a project
 * adds because the built-ins do not recognise its own secrets.
 *
 * These assert on the bytes the PROVIDER actually received, not on the builder called
 * directly — which is the distinction the P1 was about.
 */
describe('the run redaction options reach the prompt (story 6.8, AD-10)', () => {
  it('applies a config-declared extra pattern to the epic content', async () => {
    const provider = scripted(ONE_CRITERION);
    const epic: EpicSpec = { ...EPIC, goal: 'ship the release codenamed ORCHID' };

    await generateDraft({
      epicSpec: epic,
      provider,
      clock: new FixedClock(INSTANT),
      providerName: 'hermetic',
      model: null,
      providerCliVersion: '0.144.4',
      redaction: { extraPatterns: [/ORCHID/g] },
    });

    expect(provider.prompts).toHaveLength(1);
    expect(provider.prompts[0]?.prompt).not.toContain('ORCHID');
  });

  it('still redacts built-in shapes when no options are supplied', async () => {
    const provider = scripted(ONE_CRITERION);
    const epic: EpicSpec = { ...EPIC, goal: `deploy with API_KEY=${SEEDED_SECRET}` };

    await generateDraft({
      epicSpec: epic,
      provider,
      clock: new FixedClock(INSTANT),
      providerName: 'hermetic',
      model: null,
      providerCliVersion: '0.144.4',
    });

    expect(provider.prompts[0]?.prompt).not.toContain(SEEDED_SECRET);
  });
});
