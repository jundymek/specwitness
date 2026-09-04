/**
 * The `contract-author` prompt (FR-7).
 *
 * This is the ONLY place a provider learns what to draft, which makes it the
 * only place AD-2's authority boundary can be stated to the model in words.
 * Two properties matter and both are tested:
 *
 *  1. THE EPIC'S REAL CONTENT REACHES THE MODEL VERBATIM, SUBJECT TO REDACTION
 *     — and story 6.8 added the second half of that sentence rather than
 *     quietly weakening the first. Acceptance criteria are copied exactly as
 *     the artifact wrote them: not paraphrased, not summarised, not reordered,
 *     because drafting a contract from a summary of the requirement rather than
 *     the requirement is the failure this property exists to prevent, and
 *     nobody downstream could tell. What they now pass through is `redactText`,
 *     which alters an epic only where it carries something shaped like a
 *     credential. See the `head`/`body` split below for why a prompt is the
 *     last place that boundary can be applied.
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
import type { RedactionOptions } from '../domain/evidence.js';

import { assemblePrompt } from './prompt-assembly.js';

/**
 * The whole-prompt cap, in BYTES. Story 6.8.
 *
 * ⚠️ **BEFORE STORY 6.8 THIS PROMPT WAS NOT BOUNDED AT ALL**, and this number is
 * deliberately two orders of magnitude above the verify edge's 24 000.
 *
 * **The cap is a runaway guard, not a content budget**, and here that distinction has the
 * sharpest teeth in the layer. The epic below IS the requirement, and property 1 of this
 * module requires it to reach the model in full — a contract drafted from half an epic is a
 * SILENTLY narrowed definition of done, and unlike the plan-author path there is **no gate
 * downstream that would notice**: `DRAFT_RESPONSE_SCHEMA` validates the shape of whatever
 * criteria come back, not whether they cover an epic nobody fully described. So the number
 * is set where a real epic can never reach it.
 *
 * Scale check, so the figure is not arbitrary: this repository's entire `epics.md` — seven
 * epics and forty-three stories — is 57 kB, and this prompt carries ONE epic.
 */
export const CONTRACT_PROMPT_CAP_BYTES = 200_000;

/**
 * Builds the drafting prompt for one epic.
 *
 * Returns plain text. The response SHAPE is enforced by the schema the gate
 * validates against, not by asking the model nicely — this text explains the
 * job; `src/providers/invoke.ts` is what makes a malformed answer impossible to
 * turn into state.
 */
export function buildContractPrompt(epic: EpicSpec, redaction?: RedactionOptions): string {
  const head: string[] = [
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
  ];

  // ⚠️ EVERYTHING BELOW THIS LINE IS UNTRUSTED, AND THE SPLIT IS THE SECURITY DECISION.
  //
  // `head` above is fixed literals authored in this repository. The epic is not: it is
  // whatever `src/ingest/**` parsed out of the project's own planning artifacts — titles,
  // goals, narratives and acceptance criteria a person wrote in a markdown file. Before
  // story 6.8 all of it reached the provider with no redaction and no bound whatsoever.
  //
  // An acceptance criterion that reads "the API accepts AUTH_TOKEN=hunter2" is careless
  // rather than exotic, and a prompt is data leaving the process — this is the last
  // boundary before it does. `explain.ts` made exactly this argument for the criterion
  // statement in story 5.5; AD-10 says unification widens rather than narrows, so the same
  // boundary now applies to the field this prompt carries.
  //
  // There is no instruction TAIL here: this prompt states all of its rules BEFORE the epic,
  // so bounding the body cannot reach an instruction. An empty tail is the honest answer for
  // this builder rather than a reason to invent one.
  const body: string[] = [`Epic id: ${epic.id}`];

  // Absent fields are omitted rather than labelled — see the module header.
  if (epic.title !== '') {
    body.push(`Epic title: ${epic.title}`);
  }
  if (epic.goal !== '') {
    body.push('', 'Epic goal:', epic.goal);
  }

  body.push('', `The epic has ${epic.stories.length} ${epic.stories.length === 1 ? 'story' : 'stories'}.`);

  for (const story of epic.stories) {
    body.push('', ...renderStory(story));
  }

  return `${assemblePrompt({
    head,
    body,
    capBytes: CONTRACT_PROMPT_CAP_BYTES,
    // ⚠️ REFUSE, DO NOT TRUNCATE. Raised as a P2 by the codex review of story 6.8, and
    // correct against that story's own reasoning: the cap's doc comment already said
    // nothing downstream detects a truncated document, then mitigated it only by choosing a
    // large number. A silently narrowed definition of done is the failure this whole product
    // exists to prevent, so an oversized input is an `InfraError` (exit 3) raised before any
    // provider is invoked — costing no quota — rather than a quietly shortened prompt.
    onOverflow: 'refuse',
    ...(redaction === undefined ? {} : { redaction }),
  })}\n`;
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
