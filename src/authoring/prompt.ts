/**
 * The `contract-author` prompt (FR-7).
 *
 * This is the ONLY place a provider learns what to draft, which makes it the
 * only place AD-2's authority boundary can be stated to the model in words.
 * Two properties matter and both are tested:
 *
 *  1. THE EPIC'S REAL CONTENT REACHES THE MODEL VERBATIM. Acceptance criteria
 *     are copied exactly as the artifact wrote them. Paraphrasing them here
 *     would mean the contract was drafted from a summary of the requirement
 *     rather than the requirement, and nobody downstream could tell.
 *
 *  2. IDS, VERSIONS AND FINGERPRINTS ARE NOT THE MODEL'S TO CHOOSE, and the
 *     prompt says so plainly. FR-7 requires criterion ids that "survive
 *     amendment", so SpecWitness assigns them from `buildCriterionId`; a
 *     provider that invents one is a provider deciding what survives an
 *     amendment. The response schema also omits the field, so this instruction
 *     is belt and braces rather than the only defence — anything the model
 *     returns anyway is discarded by the caller.
 *
 * EMPTY FIELDS ARE OMITTED, NOT LABELLED. Story 2.1 reports an absent epic
 * title or goal as `''` rather than fabricating one from a directory slug
 * (the story-file-only layout carries neither). Sending `Epic title:` with
 * nothing after it invites the model to supply something plausible, and a
 * fabricated epic title inside a frozen, fingerprinted contract is exactly the
 * kind of small fiction this artifact exists to not contain. So an absent
 * field leaves no trace in the prompt at all.
 *
 * Pure and deterministic: same epic, same prompt. AD-1 — application layer,
 * imports domain only.
 */

import type { EpicSpec, EpicStory } from '../domain/epic-spec.js';

/**
 * Builds the drafting prompt for one epic.
 *
 * Returns plain text. The response SHAPE is enforced by the schema the gate
 * validates against, not by asking the model nicely — this text explains the
 * job; `src/providers/invoke.ts` is what makes a malformed answer impossible to
 * turn into state.
 */
export function buildContractPrompt(epic: EpicSpec): string {
  const sections: string[] = [
    'You are drafting a verification contract for a software epic.',
    '',
    'A verification contract is the definition of done: the set of criteria that',
    'must be true of the finished epic. It is frozen before implementation starts',
    'and is then the sole authority on what must be true, so it has to describe',
    'the requirement rather than any particular implementation of it.',
    '',
    'WHAT TO WRITE',
    '',
    '- One criterion per distinct, checkable expectation. Prefer several precise',
    '  criteria over one broad one.',
    '- Each statement must describe EXTERNALLY OBSERVABLE behavior or a system',
    '  invariant: what a user, an API client, or an inspection of the running',
    '  system could confirm. Avoid naming internal functions, classes, methods or',
    '  source files unless the criterion is genuinely structural.',
    '- Cover the acceptance criteria below. Where they imply an expectation they',
    '  do not state outright, write that criterion too.',
    '',
    'WHAT NOT TO WRITE',
    '',
    '- DO NOT invent, assign or return criterion ids. SpecWitness assigns them,',
    '  because ids must survive an amendment and that is not a drafting decision.',
    '- DO NOT return a version, a fingerprint, a frozen flag, or any metadata.',
    '- DO NOT restate an acceptance criterion verbatim if it describes an',
    '  implementation step rather than an outcome; describe the outcome instead.',
    '',
    'THE EPIC',
    '',
    `Epic id: ${epic.id}`,
  ];

  // Absent fields are omitted rather than labelled — see the module header.
  if (epic.title !== '') {
    sections.push(`Epic title: ${epic.title}`);
  }
  if (epic.goal !== '') {
    sections.push('', 'Epic goal:', epic.goal);
  }

  sections.push('', `The epic has ${epic.stories.length} ${epic.stories.length === 1 ? 'story' : 'stories'}.`);

  for (const story of epic.stories) {
    sections.push('', ...renderStory(story));
  }

  return `${sections.join('\n')}\n`;
}

function renderStory(story: EpicStory): string[] {
  const lines = [`--- Story ${story.id}: ${story.title} ---`];

  if (story.narrative !== '') {
    lines.push('', 'Narrative:', story.narrative);
  }

  lines.push('', 'Acceptance criteria, verbatim from the planning artifact:');
  for (const criterion of story.acceptanceCriteria) {
    lines.push(`  ${criterion.ordinal}. ${criterion.text}`);
  }

  return lines;
}
