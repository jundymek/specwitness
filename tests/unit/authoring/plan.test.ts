import { describe, expect, it } from 'vitest';

import { compilePlan } from '../../../src/authoring/plan.js';
import { buildPlanPrompt } from '../../../src/authoring/plan-prompt.js';
import type { LoadedContract } from '../../../src/authoring/verifiable.js';
import type { AgentPrompt, AgentProvider } from '../../../src/domain/agent-provider.js';
import type { Contract } from '../../../src/domain/contract.js';
import { IntegrityError, ProviderError } from '../../../src/domain/errors.js';
import { PlanSchema, type DeclaredIds } from '../../../src/schemas/plan.js';
import { ConstantIds, FixedClock } from '../../fakes/ports.js';
import { COMPILED_AT, criterion, draftContract, frozenContract } from '../../helpers/plan.js';

/**
 * Every case here runs through a scripted `AgentProvider` double — zero subprocesses, no
 * `claude`, no `codex`, no filesystem. `compilePlan` does no I/O at all, which is what
 * makes that possible (AD-12) and what proves a gate exhaustion cannot leave a partial
 * artifact: there is nothing in the unit under test that could write one.
 */

const DECLARED: DeclaredIds = {
  serviceIds: ['backend', 'frontend'],
  commandIds: ['company-count', 'typecheck'],
};

const SEED = 'k3n8v2qz7m4d1p6b';

const CONTRACT = frozenContract([
  criterion('E7-01', {
    statement: 'GET /health responds 200 with a JSON body whose "status" field is "ok".',
  }),
  criterion('E7-02', {
    statement: 'The dashboard reads as a coherent page to a first-time visitor.',
    kind: 'human',
    verifiability: 'human',
  }),
  criterion('E7-03', { statement: 'Submitting the form twice creates exactly one company.' }),
]);

function loaded(contract: Contract): LoadedContract {
  return { present: true, epic: contract.spec.epic, path: '.specwitness/contracts/epic-7.yaml', contract };
}

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

const HTTP_PROBE_DRAFT = {
  id: 'health',
  surface: 'http',
  mechanics: { serviceId: 'backend', method: 'GET', path: '/health' },
  assertions: [
    {
      description: 'the health endpoint answers 200',
      target: { source: 'status' },
      comparison: 'equals',
      expected: '200',
    },
  ],
};

/**
 * The action whose effect the observation below measures.
 *
 * A `delta` phase compares two snapshots taken AROUND another probe, so the pair has to be
 * drafted together — an observation asking for a delta while wrapping nothing is refused by
 * the schema, which is exactly the point of the rule.
 */
const SUBMIT_PROBE_DRAFT = {
  id: 'submit',
  surface: 'http',
  mechanics: {
    serviceId: 'backend',
    method: 'POST',
    path: '/companies',
    body: '{"name":"Acme Test Ltd"}',
  },
  assertions: [
    {
      description: 'the company is created',
      target: { source: 'status' },
      comparison: 'equals',
      expected: '201',
    },
  ],
};

const OBSERVATION_PROBE_DRAFT = {
  id: 'companies',
  surface: 'observation',
  mechanics: { commandId: 'company-count', args: [], around: 'submit' },
  assertions: [
    {
      description: 'exactly one company was created',
      target: { source: 'jsonPath', path: '$.count', phase: 'delta' },
      comparison: 'equals',
      expected: '1',
    },
  ],
};

/** A complete, valid draft for `CONTRACT`. Individual tests override one piece at a time. */
function validDraft(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    data: {
      bindings: [
        { kind: 'fixed', name: 'companyName', value: 'Acme Test Ltd' },
        { kind: 'volatile', name: 'signupEmail', reason: 'must be unique per run' },
      ],
    },
    criteria: [
      { criterionId: 'E7-01', disposition: 'automated', probes: [HTTP_PROBE_DRAFT] },
      {
        criterionId: 'E7-02',
        disposition: 'needs-human',
        reason: 'human-verifiability',
        guidance: 'Open the dashboard and judge whether it reads coherently.',
      },
      {
        criterionId: 'E7-03',
        disposition: 'automated',
        probes: [SUBMIT_PROBE_DRAFT, OBSERVATION_PROBE_DRAFT],
      },
    ],
    ...overrides,
  });
}

async function compile(provider: AgentProvider, contract: Contract = CONTRACT) {
  return await compilePlan({
    loadedContract: loaded(contract),
    declared: DECLARED,
    provider,
    clock: new FixedClock(COMPILED_AT),
    ids: new ConstantIds(SEED),
    providerName: 'hermetic',
    model: null,
    providerCliVersion: null,
  });
}

describe('AC1: a valid draft compiles into a plan', () => {
  it('produces a plan that validates against the persisted schema', async () => {
    const { plan } = await compile(scripted(validDraft()));

    expect(PlanSchema.safeParse(JSON.parse(JSON.stringify(plan))).success).toBe(true);
  });

  it('records the contract version and fingerprint, never recomputing either', async () => {
    const { plan } = await compile(scripted(validDraft()));

    expect(plan.plan.contract).toEqual({
      version: CONTRACT.spec.version,
      fingerprint: CONTRACT.meta.fingerprint,
    });
  });

  it('carries every contract criterion exactly once, in contract order', async () => {
    const { plan } = await compile(scripted(validDraft()));

    expect(plan.plan.criteria.map((entry) => entry.criterionId)).toEqual([
      'E7-01',
      'E7-02',
      'E7-03',
    ]);
  });

  it('carries the human criterion as needs-human with guidance and no probes', async () => {
    const { plan } = await compile(scripted(validDraft()));
    const entry = plan.plan.criteria[1];

    expect(entry?.disposition).toBe('needs-human');
    expect(entry).not.toHaveProperty('probes');
    if (entry?.disposition === 'needs-human') {
      expect(entry.reason).toBe('human-verifiability');
      expect(entry.guidance.length).toBeGreaterThan(0);
    }
  });

  it('mints the seed through the injected Ids port', async () => {
    const { plan } = await compile(scripted(validDraft()));

    expect(plan.plan.data.seed).toBe(SEED);
  });

  it('refuses a draft that tries to choose the seed', async () => {
    // A provider choosing the seed would be a provider choosing how reproducible the plan
    // is, so the draft schema has nowhere to put one and the gate rejects it outright.
    await expect(compile(scripted(validDraft({ seed: 'provider-chose-this' })))).rejects.toThrow(
      ProviderError,
    );
  });

  it('records provenance with honest nulls and the injected instant', async () => {
    const { plan } = await compile(scripted(validDraft()));

    expect(plan.meta).toEqual({
      schemaVersion: 1,
      compiledAt: COMPILED_AT,
      provenance: {
        provider: 'hermetic',
        model: null,
        providerCliVersion: null,
        generatedAt: COMPILED_AT,
      },
    });
  });

  it('keeps the deterministic-data bindings the provider drafted', async () => {
    const { plan } = await compile(scripted(validDraft()));

    expect(plan.plan.data.bindings).toEqual([
      { kind: 'fixed', name: 'companyName', value: 'Acme Test Ltd' },
      { kind: 'volatile', name: 'signupEmail', reason: 'must be unique per run' },
    ]);
  });
});

describe('AC4: the lowest adequate surface rule', () => {
  it('states the rule to the provider in words', () => {
    const prompt = buildPlanPrompt(CONTRACT, DECLARED);

    expect(prompt).toContain('LOWEST ADEQUATE SURFACE');
    expect(prompt).toMatch(/http probe — NOT a browser probe/);
  });

  it('spot-check: an obviously HTTP-checkable criterion compiles to an http probe', async () => {
    // The judgement is the provider's (Q37) — there is deliberately no classifier in this
    // story. What is asserted is that the compiled ARTIFACT for such a criterion is `http`
    // and not `browser`, against a fixture written for this story. NOT Golden Corpus
    // coverage: the corpus proper is Epic 6.
    const { plan } = await compile(scripted(validDraft()));
    const entry = plan.plan.criteria[0];

    expect(entry?.disposition).toBe('automated');
    if (entry?.disposition === 'automated') {
      expect(entry.probes.map((probe) => probe.surface)).toEqual(['http']);
    }
  });

  it('lists only the ids this project actually declares', () => {
    const prompt = buildPlanPrompt(CONTRACT, DECLARED);

    expect(prompt).toContain('- backend');
    expect(prompt).toContain('- company-count');
    expect(prompt).not.toContain('- database');
  });

  it('says "none declared" rather than omitting an empty category', () => {
    const prompt = buildPlanPrompt(CONTRACT, { serviceIds: [], commandIds: ['typecheck'] });

    expect(prompt).toContain('(none declared)');
  });

  it('sends criterion statements verbatim, while the plan itself carries none', async () => {
    const provider = scripted(validDraft());
    const { plan } = await compile(provider);

    expect(provider.prompts[0]?.prompt).toContain(
      'GET /health responds 200 with a JSON body whose "status" field is "ok".',
    );
    expect(JSON.stringify(plan)).not.toContain('GET /health responds 200');
  });

  it('tells the provider that a human criterion may not receive a probe', () => {
    const prompt = buildPlanPrompt(CONTRACT, DECLARED);

    expect(prompt).toContain('E7-02 is verifiability: human');
    expect(prompt).toMatch(/Do NOT give it a probe/);
  });

  it('tells the provider that an unmappable criterion is recorded, not omitted', () => {
    const prompt = buildPlanPrompt(CONTRACT, DECLARED);

    expect(prompt).toContain('not-safely-automatable');
    expect(prompt).toMatch(/DO NOT omit a criterion/);
  });
});

describe('FR-14: the ONE gate, its retry loop and its budget', () => {
  it('recovers on attempt 2 after a malformed first response, recording both', async () => {
    const { plan, attempts } = await compile(scripted('not json at all', validDraft()));

    expect(attempts).toBe(2);
    expect(plan.plan.criteria).toHaveLength(3);
  });

  it('feeds the rejection back into the retry prompt', async () => {
    const provider = scripted('not json at all', validDraft());
    await compile(provider);

    expect(provider.prompts).toHaveLength(2);
    expect(provider.prompts[1]?.prompt).toContain('PREVIOUS RESPONSE REJECTED');
  });

  it('throws ProviderError — never a product FAIL — when the budget is exhausted', async () => {
    // A provider that cannot draft a valid plan has not proved the epic wrong.
    await expect(compile(scripted('not json at all'))).rejects.toThrow(ProviderError);
  });

  it('names every attempt in the exhaustion message, so the cost is visible', async () => {
    let thrown: unknown;
    try {
      await compile(scripted('not json at all'));
    } catch (error) {
      thrown = error;
    }

    expect((thrown as ProviderError).message).toMatch(/after 3 attempts/);
    expect((thrown as ProviderError).hint).toMatch(/no artifact was written/);
  });
});

describe('compilation refuses a contract that cannot gate verification', () => {
  it('refuses a never-frozen contract with the merged wording', async () => {
    const provider = scripted(validDraft());

    await expect(compile(provider, draftContract([criterion('E7-01')]))).rejects.toThrow(
      /has never been frozen/,
    );
    // And it refuses BEFORE spending a provider attempt — a project in this state must not
    // pay subscription quota to be told to run `--freeze`.
    expect(provider.prompts).toHaveLength(0);
  });

  it('refuses an absent contract', async () => {
    await expect(
      compilePlan({
        loadedContract: { present: false, epic: 'epic-7', path: '.specwitness/contracts/epic-7.yaml' },
        declared: DECLARED,
        provider: scripted(validDraft()),
        clock: new FixedClock(COMPILED_AT),
        ids: new ConstantIds(SEED),
        providerName: 'hermetic',
        model: null,
        providerCliVersion: null,
      }),
    ).rejects.toThrow(IntegrityError);
  });

  it('refuses a tampered contract without pointing at --freeze', async () => {
    const tampered: Contract = {
      spec: { ...CONTRACT.spec, criteria: [criterion('E7-99', { statement: 'Anything at all.' })] },
      meta: CONTRACT.meta,
    };

    let thrown: unknown;
    try {
      await compile(scripted(validDraft()), tampered);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(IntegrityError);
    // ADR-005: freezing over a tamper launders it. The remedy is --amend.
    expect((thrown as IntegrityError).hint).toMatch(/--amend/);
    expect((thrown as IntegrityError).hint).not.toMatch(/--freeze/);
  });
});
