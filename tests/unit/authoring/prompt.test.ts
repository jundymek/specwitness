import { describe, expect, it } from 'vitest';

import { buildContractPrompt } from '../../../src/authoring/prompt.js';
import type { EpicSpec } from '../../../src/domain/epic-spec.js';

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
