import { describe, expect, it } from 'vitest';

import {
  CONTRACT_PROMPT_CAP_BYTES,
  buildContractPrompt,
} from '../../../src/authoring/prompt.js';
import type { EpicSpec } from '../../../src/domain/epic-spec.js';
import { InfraError } from '../../../src/domain/errors.js';
import { SEEDED_SECRET } from '../../fixtures/run-result.js';

/**
 * The prompt is the only place a provider learns what to draft, so these tests
 * pin the two properties that keep AD-2 true: the epic's real content reaches
 * the model verbatim, and the model is told plainly that ids, versions and
 * fingerprints are not its to choose.
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
      acceptanceCriteria: [
        { ordinal: 1, text: 'Given a draft, when I freeze it, then a fingerprint is printed.', source: SOURCE },
        { ordinal: 2, text: 'Re-freezing an unchanged contract is idempotent.', source: SOURCE },
      ],
      source: SOURCE,
    },
  ],
  source: SOURCE,
};

describe('buildContractPrompt', () => {
  it('carries the epic id, title and goal', () => {
    const prompt = buildContractPrompt(EPIC);

    expect(prompt).toContain('epic-7');
    expect(prompt).toContain('Verification Contracts');
    expect(prompt).toContain('Capture the definition of done before the cohort starts.');
  });

  it('carries every acceptance criterion verbatim', () => {
    const prompt = buildContractPrompt(EPIC);

    expect(prompt).toContain('Given a draft, when I freeze it, then a fingerprint is printed.');
    expect(prompt).toContain('Re-freezing an unchanged contract is idempotent.');
  });

  it('carries each story id, title and narrative', () => {
    const prompt = buildContractPrompt(EPIC);

    expect(prompt).toContain('7.1');
    expect(prompt).toContain('Freeze a contract');
    expect(prompt).toContain('As an epic owner,');
  });

  it('tells the model that ids are not its to choose', () => {
    const prompt = buildContractPrompt(EPIC).toLowerCase();

    // AD-2 / FR-7: ids must survive amendment, so SpecWitness assigns them.
    // A provider that invents one is deciding what survives an amendment.
    expect(prompt).toContain('do not');
    expect(prompt).toContain('id');
  });

  it('asks for externally observable behavior', () => {
    expect(buildContractPrompt(EPIC).toLowerCase()).toContain('observable');
  });

  /**
   * alice (2.1) reports an empty title/goal for the story-file-only layout
   * rather than fabricating one from a directory slug. A labelled empty field
   * invites the model to fill it, and a fabricated epic title inside a frozen,
   * fingerprinted contract is exactly the kind of small fiction this artifact
   * must not contain. So the label is omitted entirely.
   */
  it('omits the title label entirely when the epic has no title', () => {
    const prompt = buildContractPrompt({ ...EPIC, title: '' });

    expect(prompt).not.toContain('Epic title:');
  });

  it('omits the goal label entirely when the epic has no goal', () => {
    const prompt = buildContractPrompt({ ...EPIC, goal: '' });

    expect(prompt).not.toContain('Epic goal:');
  });

  it('still names the epic when title and goal are both absent', () => {
    const prompt = buildContractPrompt({ ...EPIC, title: '', goal: '' });

    expect(prompt).toContain('epic-7');
  });

  it('omits an absent story narrative rather than labelling emptiness', () => {
    const prompt = buildContractPrompt({
      ...EPIC,
      stories: [{ ...(EPIC.stories[0] as EpicStoryType), narrative: '' }],
    });

    expect(prompt).not.toContain('Narrative:');
  });

  it('is deterministic — the same epic yields the same prompt', () => {
    expect(buildContractPrompt(EPIC)).toBe(buildContractPrompt(EPIC));
  });
});

type EpicStoryType = EpicSpec['stories'][number];

/**
 * SECURITY and BOUNDING — added by story 6.8.
 *
 * Before story 6.8 this builder sent the entire epic — titles, goals, narratives and
 * acceptance criteria, all of it parsed out of the project's own planning artifacts — to a
 * provider with **no redaction and no bound whatsoever**. Neither of the two defects Epic 5
 * retro §2 observation 3 records had ever been looked for here, because this builder was
 * not one of the two modules in which they were found.
 *
 * Every assertion below fails against the pre-6.8 builder; each was run that way.
 *
 * Secrets are asserted ABSENT, never `[REDACTED]`-present (Epic 3 retro §7).
 */
describe('SECURITY — a seeded credential never reaches the prompt (story 6.8, AC2)', () => {
  const withAcceptanceCriterion = (text: string): EpicSpec => ({
    ...EPIC,
    stories: [
      {
        ...(EPIC.stories[0] as EpicStoryType),
        acceptanceCriteria: [{ ordinal: 1, text, source: SOURCE }],
      },
    ],
  });

  it('is absent when it is seeded into an acceptance criterion', () => {
    const epic = withAcceptanceCriterion(`the API accepts AUTH_TOKEN=${SEEDED_SECRET}`);

    expect(buildContractPrompt(epic)).not.toContain(SEEDED_SECRET);
  });

  it('is absent when it is seeded into a story narrative', () => {
    const epic: EpicSpec = {
      ...EPIC,
      stories: [
        {
          ...(EPIC.stories[0] as EpicStoryType),
          narrative: `As an operator with API_KEY=${SEEDED_SECRET},\nI want to log in.`,
        },
      ],
    };

    expect(buildContractPrompt(epic)).not.toContain(SEEDED_SECRET);
  });

  it('is absent when it is seeded into the epic goal', () => {
    const epic: EpicSpec = { ...EPIC, goal: `ship it with SECRET=${SEEDED_SECRET}` };

    expect(buildContractPrompt(epic)).not.toContain(SEEDED_SECRET);
  });

  it('is absent when it arrives as a sensitive header line', () => {
    const epic = withAcceptanceCriterion(`requests carry Authorization: Bearer ${SEEDED_SECRET}`);

    expect(buildContractPrompt(epic)).not.toContain(SEEDED_SECRET);
  });

  it('applies config-declared extra patterns when a caller supplies them', () => {
    const epic = withAcceptanceCriterion('the release is codenamed ORCHID');

    expect(buildContractPrompt(epic, { extraPatterns: [/ORCHID/g] })).not.toContain('ORCHID');
  });
});

describe('bounding (story 6.8, AC1)', () => {
  const huge = (): EpicSpec => ({
    ...EPIC,
    stories: Array.from({ length: 40 }, (_unused, index) => ({
      ...(EPIC.stories[0] as EpicStoryType),
      id: `7.${index}`,
      narrative: 'x'.repeat(20_000),
    })),
  });

  it('REFUSES an oversized epic rather than truncating it', () => {
    // ⚠️ RAISED AS A P2 BY THE CODEX REVIEW OF STORY 6.8, and correct — in the sharpest
    // instance of it. The codex report: *"the resulting provider response can still satisfy
    // DRAFT_RESPONSE_SCHEMA and become a frozen contract. This silently narrows the
    // definition of done."*
    //
    // That is exactly right, and it was right against this story's own reasoning: the cap's
    // doc comment already said nothing downstream detects a truncated epic, and then
    // mitigated that only by choosing a large number. Unlike the plan-author path there is
    // no gate that would catch it later, so an epic that does not fit must not be sent at
    // all. Exit 3, never a product FAIL, and before any provider is invoked.
    expect(() => buildContractPrompt(huge())).toThrow(InfraError);
  });

  it('says how large the epic was and what the cap is', () => {
    try {
      buildContractPrompt(huge());
      expect.unreachable('buildContractPrompt should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(InfraError);
      expect((error as InfraError).message).toContain(String(CONTRACT_PROMPT_CAP_BYTES));
      expect((error as InfraError).hint).toBeDefined();
    }
  });

  it('builds normally for an epic that fits, which is every real one', () => {
    // The refusal must not be reachable by an ordinary epic. Forty stories with real
    // narratives is already larger than anything this project has planned.
    const ordinary: EpicSpec = {
      ...EPIC,
      stories: Array.from({ length: 40 }, (_unused, index) => ({
        ...(EPIC.stories[0] as EpicStoryType),
        id: `7.${index}`,
      })),
    };

    const prompt = buildContractPrompt(ordinary);

    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(
      CONTRACT_PROMPT_CAP_BYTES + 1,
    );
    expect(prompt).toContain('--- Story 7.39');
    expect(prompt).not.toContain('truncated:');
  });

  it('leaves an ordinary epic completely untouched', () => {
    // The widening must cost nothing on the overwhelmingly common input: ordinary planning
    // prose matches neither redaction shape, so it arrives verbatim.
    const prompt = buildContractPrompt(EPIC);

    expect(prompt).toContain('Given a draft, when I freeze it, then a fingerprint is printed.');
    expect(prompt).not.toContain('truncated:');
    expect(prompt).not.toContain('[REDACTED]');
  });
});
