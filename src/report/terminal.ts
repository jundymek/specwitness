/**
 * The sectioned terminal report (FR-29, AD-11). Story 3.6.
 *
 * One rule governs every line below: this module renders a `RunResult` and
 * computes nothing. Counts come from `src/domain/result-counts.ts`, durations
 * from `StageTimelineEntry.durationMs`, contract status from
 * `RunResult.contract`, and the run directory from `environment.runDirectory` —
 * never derived from the run id. The only arithmetic in the file is padding.
 *
 * Why that matters rather than merely being tidy: AD-11 exists because a human
 * report and a machine document written by different code at different times
 * slowly disagree, until a harness gates on a JSON field the human report
 * contradicts and nobody can tell which is right. A renderer that computes a
 * fact has created exactly that disagreement. If a fact is missing here it
 * belongs in the model — a message to story 3.3, never a computation.
 *
 * Two properties are structural rather than conventional. The signature takes a
 * `RunResult` and nothing else — no clock, no store, no config — so a fact this
 * function was not handed is a fact it cannot invent. And `src/report/**` may
 * not import `infra`, `config`, `pipeline` or any side-effectful Node built-in
 * (the `report-layer` rule), so it cannot reach out for one either.
 *
 * It returns a string and prints nothing: the caller owns stream discipline,
 * which under `--json` means every human line goes to stderr while the JSON
 * document has stdout to itself.
 */

import {
  type BoundedText,
  type Evidence,
  truncationMarker,
} from '../domain/evidence.js';
import {
  countCriterionStatuses,
  countGateStatuses,
  summarizeFlakiness,
  type FlakinessCounts,
} from '../domain/result-counts.js';
import type {
  CriterionAttemptRecord,
  DerivedCriterionResult,
} from '../domain/criterion-result.js';
import {
  CRITERION_STATUSES,
  GATE_STATUSES,
  type NeedsHumanReason,
} from '../domain/result.js';
import type { AppliedMechanicsChange, RunAdaptation } from '../domain/adaptation.js';
import type { CriterionExplanation, RunResult } from '../domain/run-result.js';
import type { StageTimelineEntry } from '../domain/stage.js';
import { MARK_WIDTH, criterionMark, gateMark, stageMark, verdictLine } from './format.js';

/** Width of the label column in the run header, so values line up. */
const LABEL_WIDTH = 12;

/** Width of the id column in the gate and stage tables. */
const ID_WIDTH = 12;

function label(name: string, value: string): string {
  return `  ${`${name}:`.padEnd(LABEL_WIDTH)} ${value}`;
}

function section(title: string, lines: readonly string[]): string[] {
  return ['', title, ...lines];
}

/** `1200 ms`, right-aligned. `durationMs` is an integer by convention. */
function duration(ms: number): string {
  return `${String(ms).padStart(6)} ms`;
}

/**
 * One stage row, plus its recorded remedy when the stage errored.
 *
 * `hint` is rendered as `recorded hint:` rather than printed bare, and those two
 * words are the whole point. The hint is written in the imperative — "inspect
 * the change with 'git diff'" — because it is composed for the person whose run
 * has just failed, and `verify` prints it to them live on stderr. But
 * `report <run-id>` re-renders a run that finished at some point in the past
 * (FR-31, Q52), and an imperative addressed to a reader about a run from three
 * weeks ago tells them to act on a situation that may no longer exist. The
 * label turns the instruction back into what it actually is here: a record of
 * what the run advised at the time — which is how every timestamp and SHA in
 * this report already reads.
 *
 * Rendering it at all, rather than leaving it to the CLI edge, is not the
 * duplication AD-11 forbids. Both surfaces print the SAME FIELD, so the wording
 * lives once in `domain/stage.ts` and neither surface composes remedy prose.
 * The alternative was worse: a remedy that is in the model, in `result.json`
 * and schema-versioned, but readable only by machines — while the diagnosis of
 * the very same failure prints two columns to its left.
 *
 * Errored stages only. A hint on an `ok` or `skipped` row is advice about a
 * problem that did not happen, and a report offering remedies for non-problems
 * teaches its reader to skim.
 */
function stageLines(entry: StageTimelineEntry): string[] {
  // Built as prefix + detail rather than as one template, so the hint below can
  // indent to `prefix.length` and stay aligned with the detail column whatever
  // MARK_WIDTH, ID_WIDTH or the duration format do later. Hard-coding that
  // indent is how a continuation line drifts two columns left of the row it
  // belongs to — which is exactly what the first version of this did.
  const prefix = `  ${stageMark(entry.status).padEnd(MARK_WIDTH)} ${entry.stage.padEnd(
    ID_WIDTH,
  )} ${duration(entry.durationMs)}  `;
  const row = `${prefix}${entry.detail ?? ''}`.trimEnd();

  if (entry.status !== 'error' || entry.hint === undefined) {
    return [row];
  }
  return [row, `${' '.repeat(prefix.length)}recorded hint: ${entry.hint}`];
}

/**
 * The contract line — FR-29's "contract status" and its fingerprint validity.
 *
 * Validity is the PRESENCE of `contract`: the integrity stage populates it only
 * after `assertVerifiableContract` returned, so a summary being here means
 * "frozen, and its content still matches its fingerprint". A renderer must
 * never re-read the contract file to find that out (AD-11), and this one
 * cannot — its layer rule forbids the filesystem.
 */
function contractLines(result: RunResult): string[] {
  const { contract } = result;
  if (contract === undefined) {
    return [
      label(
        'Contract',
        'not verified — the run ended at or before the integrity stage',
      ),
    ];
  }
  return [
    label(
      'Contract',
      `frozen and fingerprint verified — ${contract.epic} v${contract.version}, ` +
        `${plural(contract.criterionCount, 'criterion', 'criteria')}, ` +
        `${plural(contract.amendments, 'amendment', 'amendments')}, frozen ${contract.frozenAt}`,
    ),
    label('Fingerprint', contract.fingerprint),
  ];
}

function environmentLine(result: RunResult): string {
  const { environment } = result;
  return label(
    'Environment',
    `node ${environment.nodeVersion} · specwitness ${environment.specwitnessVersion} · ` +
      `${environment.platform}/${environment.arch}`,
  );
}

/**
 * Bounded inline output, plus pamela's marker when it was truncated.
 *
 * The marker is printed exactly as she returns it — it is the empty string for
 * untruncated content, so there is no branch here and no second place the two
 * views could describe truncation differently. This renderer never re-redacts,
 * never re-truncates and never reconstructs: redaction happened at capture
 * (AD-10) and re-processing text is how a "helpful" renderer un-redacts it.
 */
function boundedLines(caption: string, bounded: BoundedText, indent: string): string[] {
  if (bounded.text.length === 0 && !bounded.truncated) {
    return [];
  }
  const marker = truncationMarker(bounded);
  // Captured output almost always ends in a newline, and splitting on it would
  // otherwise yield a trailing empty element that renders as a blank line in
  // the middle of the report. Exactly one trailing newline is dropped: a blank
  // line the command actually printed is part of its output and is kept.
  const body = bounded.text.endsWith('\n') ? bounded.text.slice(0, -1) : bounded.text;
  return [
    `${indent}${caption}:`,
    ...body.split('\n').map((line) => `${indent}  ${line}`),
    ...(marker === '' ? [] : [`${indent}  ${marker}`]),
  ];
}

/**
 * `1 amendment` / `2 amendments`, and `1 criterion` / `3 criteria`. The plural
 * form is passed in rather than derived, because the most common noun here is
 * irregular and a rule that appends `s` would print "criterions".
 */
function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * One evidence entry: always its identity and its pointers, and its text only
 * where the text explains a non-pass.
 *
 * NFR-8 is why: the cap is 8192 bytes per bounded field and a run carries two
 * per gate, so inlining everything would put a couple of hundred kilobytes of
 * successful install chatter in front of a reader — often an agent with a
 * context window — whose question is "what failed". Nothing is hidden: every
 * entry is listed, and every pointer to a full file is printed.
 */
function evidenceLines(evidence: Evidence): string[] {
  switch (evidence.kind) {
    case 'gate': {
      // The declared command is named, not just the gate id: a reader of a
      // stored run six months from now has `gateId: 'lint'` and some output,
      // and learning what actually ran would otherwise mean reconstructing the
      // config as it was at that revision — which defeats the run directory
      // being a self-contained record. Redacted at capture like every other
      // string here; this renderer never re-redacts.
      const head = `  gate ${evidence.gateId} (${evidence.status}, exit ${
        evidence.exitCode ?? 'none'
      }): ${evidence.displayCommand}`;
      if (evidence.status === 'pass') {
        return [head, ...pointerLines([evidence.stdout, evidence.stderr], '    ')];
      }
      return [
        head,
        ...boundedLines('stdout', evidence.stdout, '    '),
        ...boundedLines('stderr', evidence.stderr, '    '),
      ];
    }
    case 'command': {
      const head = `  command ${evidence.commandId} (exit ${evidence.exitCode ?? 'none'}): ${
        evidence.displayCommand
      }`;
      if (evidence.exitCode === 0) {
        return [head, ...pointerLines([evidence.stdout, evidence.stderr], '    ')];
      }
      return [
        head,
        ...boundedLines('stdout', evidence.stdout, '    '),
        ...boundedLines('stderr', evidence.stderr, '    '),
      ];
    }
    case 'http':
      return [
        `  http ${evidence.request.method} ${evidence.request.url} -> ${evidence.response.status}`,
        ...boundedLines('body', evidence.response.body, '    '),
      ];
    case 'browser':
      return [
        `  browser ${evidence.url}`,
        ...[evidence.trace, evidence.screenshot]
          .filter((ref) => ref !== undefined)
          .map((ref) => `    ${ref.kind} at ${ref.path}`),
      ];
    case 'observation':
      return [
        `  observation ${evidence.observationId}`,
        ...boundedLines('snapshot', evidence.snapshot, '    '),
      ];
    case 'provider':
      return [
        `  provider ${evidence.provider} (${evidence.role}, ${evidence.attempts} attempts)`,
        ...pointerLines([evidence.rawResponse], '    '),
      ];
    default: {
      // Adding an evidence kind without deciding how it reads is a type error,
      // not an entry that silently disappears from the report.
      const unreachable: never = evidence;
      return unreachable;
    }
  }
}

/**
 * One criterion: its status, its id, and FR-29's "one-line summary" — which is
 * `statement`, the criterion's wording copied verbatim from the frozen
 * contract at derivation time. A renderer must not synthesise that sentence
 * from the status; a summary invented here would be a fact the JSON view does
 * not carry, which is the drift AD-11 forbids.
 *
 * `expected` / `actual` / `evidence` are present on every non-pass result
 * (FR-28) and are indented beneath it. `flaky` is surfaced always: FR-32's
 * whole point is that a retry-pass is never silently converted into a clean
 * one, and a renderer is the last place that visibility can be lost.
 */
function criterionLines(criterion: DerivedCriterionResult, runDirectory: string): string[] {
  const flaky = criterion.flaky === true ? ' (flaky)' : '';
  const head =
    `  ${criterionMark(criterion.status).padEnd(MARK_WIDTH)} ${criterion.criterionId} ` +
    `[${criterion.severity}]${flaky}  ${criterion.statement}`;

  const detail: string[] = [];
  if (criterion.expected !== undefined) {
    detail.push(`      expected: ${criterion.expected}`);
  }
  if (criterion.actual !== undefined) {
    detail.push(`      actual:   ${criterion.actual}`);
  }
  for (const ref of criterion.evidence ?? []) {
    detail.push(`      evidence: ${ref.kind} at ${ref.path}`);
  }
  detail.push(...attemptLines(criterion.attempts));

  return [head, ...detail, ...reviewerLines(criterion, runDirectory)];
}

/**
 * Why each NEEDS_HUMAN reason is a human's question, in the vocabulary the `plan` command
 * already uses (`src/cli/commands/plan.ts:357-364`).
 *
 * BORROWED, NOT INVENTED. `plan` already tells an operator that a `not-safely-automatable`
 * criterion "could not be mapped to a safe probe" and that "sharpening the criterion often
 * makes it automatable". A second vocabulary here would have the product saying two things
 * about one fact, to the same person, hours apart.
 *
 * The two lines differ because the FACTS differ and their remedies differ
 * (`domain/plan.ts:102-119`). `human-verifiability` is a property of the contract: its
 * author wrote that no machine may answer it, and no amount of sharpening will change that.
 * `not-safely-automatable` is a property of compilation, and it IS actionable. A report
 * that collapsed them would tell a reader either to attempt the impossible or to give up on
 * the tractable.
 */
const REVIEWER_REASON: Record<NeedsHumanReason, string> = {
  'human-verifiability':
    'the frozen contract declares this criterion verifiability: human — no machine may decide it',
  'not-safely-automatable':
    'the contract declares this criterion automated, but it could not be mapped to a safe probe; ' +
    'sharpening the criterion often makes it automatable',
};

/**
 * The reviewer's block: what to check, why it is theirs, and where to look (AC2, FR-16).
 *
 * Story 5.3 exists because this block did not. A NEEDS_HUMAN criterion reached a person
 * carrying the contract's statement and nothing else, even though the plan-author had been
 * instructed to write reviewer guidance and the plan schema required it. NEEDS_HUMAN is
 * exit 2, and exit 2 is a STOP; a stop that does not say what to look at is a stop people
 * learn to override.
 *
 * NOTHING HERE IS SYNTHESISED. The guidance is the plan-author's own text, already redacted
 * and bounded at derivation, printed as-is with the one merged truncation marker (Q49). The
 * reason is a lookup on a closed enum. Where a value is absent the line is absent — a
 * renderer that filled the gap with a placeholder would report a fact the JSON view does not
 * carry (AD-11), and a reader could not tell the invented sentence from the plan-author's.
 *
 * THE EVIDENCE POINTER IS THE RUN'S, NOT THE CRITERION'S, and it says so. A `needs-human`
 * plan arm is a strict object with no `probes` key at all (`schemas/plan.ts:474-478`), so
 * nothing probed this criterion and it has no evidence by construction. Naming that plainly
 * is the honest option; fabricating per-criterion refs to fill the block would be the mirror
 * of the defect this product exists to prevent.
 */
function reviewerLines(criterion: DerivedCriterionResult, runDirectory: string): string[] {
  if (criterion.status !== 'needs_human') {
    return [];
  }

  const lines: string[] = [];

  if (criterion.needsHumanReason !== undefined) {
    lines.push(`      why:      ${REVIEWER_REASON[criterion.needsHumanReason]}`);
  }

  const guidance = criterion.reviewerGuidance;
  if (guidance !== undefined) {
    const marker = truncationMarker(guidance);
    lines.push(`      check:    ${guidance.text}${marker === '' ? '' : ` ${marker}`}`);
    if (guidance.truncated) {
      // FR-29 wants the bound AND a route to the rest. `truncationMarker` supplies the
      // first half on its own — how much was withheld — but it can only print a `fullPath`
      // when there is a file in the RUN to point at, and guidance has none.
      //
      // IT IS NOT LOST, WHICH IS WHY THIS IS A POINTER AND NOT A REPAIR. The full text is
      // in the compiled plan on disk, where the plan-author wrote it; the derivation
      // dropped the tail from the RESULT, not from the artifact. The named remedy in
      // review was to persist the guidance as run evidence and pass its path here, and
      // that is deliberately not done: `BoundedText.fullPath` is validated run-relative so
      // it cannot address the plan, `src/report/**` may not import `src/authoring/**` where
      // `planRelativePath` lives, and `deriveCriterionResult` is pure and may not write a
      // file — so the only way to obtain such a path is for two pipeline stages to start
      // writing a second, redacted copy of a document that already exists. Two artifacts
      // holding one fact, differing by redaction, is a drift generator; one line naming the
      // artifact that already holds it is not.
      //
      // The epic is printed in this report's header, so the reader has both halves of the
      // location without this renderer composing a path it cannot legally import.
      lines.push('                the full guidance is in the compiled plan for this epic');
    }
  }

  // Printed for every needs_human criterion, including one carrying neither field: a person
  // who has been stopped must always be told where to look, and this is the one line here
  // that is a fact about the run rather than about the plan.
  lines.push(
    `      evidence: this criterion has no evidence of its own (nothing probed it); ` +
      `the run's evidence is under ${runDirectory}`,
  );
  // The one sentence in Epic 5 where 5.3 and 5.2 genuinely meet, agreed verbatim with 5.2
  // rather than invented here — and kept verbatim on purpose: 5.2 quotes it in its module
  // header and in the browser evidence member's own `explanation`, so rewording it here
  // would desynchronise the two places the product says this.
  //
  // Every TEXT channel a browser probe captures IS redacted at capture — URLs, page text,
  // titles, error messages. Overstating that would train a reviewer to distrust fields that
  // are in fact protected.
  lines.push(
    '      caution:  screenshots and traces are NOT redacted — ' +
      'image content cannot be scrubbed by a text redactor',
  );
  // THE SECOND LINE EXISTS BECAUSE THE FIRST ONE'S REASON ONLY COVERS THE SCREENSHOT, and
  // a reviewer acting on the first line alone would draw the wrong conclusion about the
  // bigger risk. A screenshot is pixels; a trace is a zip of DOM snapshots, network
  // payloads and console output — so a credential inside one is GREPPABLE, not merely
  // visible, and the trace is the larger exposure of the two. Told to a reviewer at the
  // moment they are pointed at the evidence, because that is when they decide what to open
  // and who to show it to.
  //
  // 5.2 raised the distinction after its own review sharpened it, and deliberately did NOT
  // close the exposure: AC1 requires the trace and 5.6 needs it for the probes it adapts.
  // That AC1-vs-AD-10 tension is reported to the owner in 5.2's PR body and is not settled
  // here — this line makes the reviewer aware of it, which is the part 5.3 owns.
  lines.push(
    '                a trace is the larger exposure: it carries DOM snapshots, ' +
      'network payloads and console output',
  );

  return lines;
}

/**
 * What each attempt did, beneath a criterion that took more than one (story 5.4).
 *
 * THIS IS THE HALF OF FR-32 THE `(flaky)` MARKER ABOVE CANNOT CARRY. A pass returns from
 * the derivation with no expected, no actual and no evidence — nothing to look at — so
 * without these lines the marker names a problem and points nowhere, and a flake a reader
 * cannot investigate is a flake they learn to skim past. That is the laundering defect
 * this story exists to prevent, arriving one step later than expected: the report is
 * technically correct and practically useless.
 *
 * PRINTED FOR AN EXHAUSTED RETRY TOO, not only for a flaky pass. AC2 says retries change
 * repetition and never classification, and someone debugging a criterion that failed three
 * times needs the first two attempts exactly as much as a flake reader needs the failed
 * one. Nothing is printed for the ordinary single-attempt criterion, which — retries being
 * opt-in and 0 by default — is every criterion of almost every run.
 *
 * BOUNDED BY CONSTRUCTION (FR-29): `retries` is capped at `MAX_PROBE_RETRIES` in the
 * config schema, so this is at most six attempts of at most four lines, and only for
 * criteria a project explicitly asked to repeat.
 */
function attemptLines(attempts: readonly CriterionAttemptRecord[] | undefined): string[] {
  if (attempts === undefined) {
    return [];
  }

  // A criterion may declare several probes and reports one result, so `select` can hand
  // this function records from more than one of them. `of N` must then count that probe's
  // attempts rather than the array's length, and the probe has to be named — otherwise two
  // probes' records read as one impossible sequence: attempt 1, attempt 1, attempt 2.
  // Named ONLY when it disambiguates, so the ordinary single-probe criterion — which is
  // almost every criterion — reads exactly as it did.
  const probes = new Set(attempts.map((record) => record.probeId));
  const totalFor = (probeId: string | undefined): number =>
    attempts.filter((record) => record.probeId === probeId).length;

  return attempts.flatMap((record) => {
    const which =
      probes.size > 1 && record.probeId !== undefined ? ` (probe ${record.probeId})` : '';
    const lines = [
      `      attempt ${record.attempt} of ${totalFor(record.probeId)}${which}:` +
        ` ${record.outcome} (${record.durationMs} ms)`,
    ];
    if (record.expected !== undefined) {
      lines.push(`        expected: ${record.expected}`);
    }
    if (record.actual !== undefined) {
      lines.push(`        actual:   ${record.actual}`);
    }
    for (const ref of record.evidence ?? []) {
      // The attempt number is in the file name (see `evidenceStem` in the http surface):
      // attempt 2 never overwrites attempt 1, so a flaky pass points at the artifact that
      // actually shows the failure rather than at one showing the pass.
      lines.push(`        evidence: ${ref.kind} at ${ref.path}`);
    }
    return lines;
  });
}

/**
 * The run's flake figures for the Counts section (story 5.4).
 *
 * THE FLAKY COUNT IS ALWAYS PRINTED, INCLUDING ZERO. Until this story it was suppressed
 * when nothing was flaky, which left "nothing was flaky" and "this build does not report
 * flake" looking identical on the page — the same ambiguity that made `flakiness` a key
 * the persisted document always writes rather than one it omits when empty. FR-32's
 * subject is that a reader can tell; a silence they have to interpret is not telling them.
 *
 * The repetition figures ARE suppressed when there was none, and the asymmetry is
 * deliberate: `0 flaky` answers a question every reader of a verification report has,
 * whereas `0 retried` answers one only a project that opted into retries is asking. When
 * they do appear, they are SM-C3's denominator — "retry-to-green rate must stay visible,
 * never optimized away by hidden retries" — and a rate needs both halves.
 */
function flakinessSummary(counts: FlakinessCounts): string {
  const parts = [`${counts.flakyCriteria} flaky`];
  if (counts.retriedCriteria > 0) {
    parts.push(
      `${counts.retriedCriteria} retried`,
      `${counts.extraAttempts} extra ${counts.extraAttempts === 1 ? 'attempt' : 'attempts'}`,
    );
  }
  return parts.join(' · ');
}

/**
 * The heading of the hypotheses block (story 5.5).
 *
 * "Clearly labeled non-authoritative" is in the acceptance criterion, not a nicety, and
 * the reason is a fact about readers rather than about formatting: **an unlabelled
 * hypothesis printed beside a verdict becomes a finding in the reader's mind.** So the
 * label is on the heading — where somebody skimming cannot miss it — and repeated on every
 * line, so a hypothesis quoted out of the report into a ticket carries its own status with
 * it.
 *
 * Exported so a test asserts the exact words rather than a paraphrase of them.
 */
export const EXPLANATION_HEADING =
  'Root-cause hypotheses  [NON-AUTHORITATIVE — AI-written guesses, not evidence]';

/** The second half of the label: what it is not. Printed once, under the heading. */
export const EXPLANATION_DISCLAIMER =
  '  These did not affect the verdict, the criterion statuses or the exit code.';

/**
 * One hypothesis, with the id it belongs to and its continuation lines aligned.
 *
 * Model prose has no line discipline, so it is re-indented here rather than printed raw:
 * an unindented second line reads as a new report row, and a report row is the one thing
 * a hypothesis must never look like. Nothing is re-redacted and nothing is re-truncated —
 * both happened at capture (AD-10), and `src/report/**` cannot reach a file to show more
 * even if it wanted to.
 */
function explanationLines(entry: CriterionExplanation): string[] {
  const [first = '', ...rest] = entry.explanation.split('\n');
  return [
    `  ${entry.criterionId.padEnd(ID_WIDTH)} (hypothesis) ${first}`,
    ...rest.map((line) => `  ${' '.repeat(ID_WIDTH)}              ${line}`),
  ];
}

/** The pointers alone, for entries whose text the report does not inline. */
function pointerLines(texts: readonly BoundedText[], indent: string): string[] {
  return texts
    .map((text) => text.fullPath)
    .filter((path) => path !== undefined)
    .map((path) => `${indent}full output at ${path}`);
}

/**
 * The mechanics-adaptation block (story 5.6, AC1).
 *
 * ⚠️ **AN ADAPTED PASS MUST NEVER READ AS AN ORDINARY PASS**, and this block is the only
 * thing standing between the two in the human report. A criterion that passed after its
 * probe was rewritten renders in the Criteria section exactly like one that passed as
 * compiled — there is no per-criterion marker, deliberately, because `DerivedCriterionResult`
 * is produced by one function this story does not touch. So the run-level block has to
 * carry the whole message, and it says what changed, at which probe, and from what to what.
 *
 * RENDERED FOR A REFUSAL TOO. "A provider proposed something illegal and was refused" is a
 * fact a reviewer should see; printing nothing would make a hostile provider look exactly
 * like an absent one. The heading says which case it is, so the two are never confused.
 *
 * BOUNDED (FR-29): every value is a `BoundedText` that was redacted and capped at capture,
 * and `boundedLines` prints it as-is with the one truncation marker. Nothing here
 * re-redacts, re-truncates or opens a file (AD-10, AD-11).
 *
 * VOCABULARY, agreed with 5.5 at wave-3 intent-sync so the report does not use one word for
 * two things: this block says "adapted", "proposed" and "applied", and never "retry" or
 * "flaky" (5.4's, meaning repetition of an UNCHANGED probe) and never "explanation" or
 * "hypothesis" (5.5's, meaning text that changed nothing).
 */
function changeLines(change: AppliedMechanicsChange): string[] {
  return [
    `  ${change.criterionId} · probe ${change.probeId} · ${change.field}`,
    ...boundedLines('was', change.from, '    '),
    ...boundedLines('now', change.to, '    '),
  ];
}

/**
 * What was EXECUTED and then thrown away because the criterion did not improve.
 *
 * ⚠️ Rendered in BOTH branches, and that is the point. Raised as a P2 by the codex
 * re-review: the JSON audit carried these and the terminal did not, so a human reading the
 * report could not see mechanics a browser had genuinely run. Worse, the unadapted branch
 * said the results were "exactly what the compiled plan produced" — true of the RESULTS and
 * false about what was executed.
 *
 * "Not kept" and "not executed" are different facts and the report now distinguishes them.
 */
function discardedLines(adaptation: RunAdaptation): string[] {
  const discarded = adaptation.discarded ?? [];
  if (discarded.length === 0) {
    return [];
  }

  return [
    '',
    `  ${plural(discarded.length, 'change was', 'changes were')} executed and then DISCARDED,`,
    '  because the re-executed probe did not pass. The criterion kept its original outcome',
    '  and its original evidence; these ran and changed nothing:',
    '',
    ...discarded.flatMap(changeLines),
  ];
}

function adaptationLines(adaptation: RunAdaptation): string[] {
  if (!adaptation.adapted) {
    return [
      '  No adaptation was applied, and every criterion kept its original outcome and its',
      '  original evidence.',
      ...(adaptation.refusal === undefined
        ? []
        : boundedLines('Reason', adaptation.refusal, '  ')),
      ...discardedLines(adaptation),
    ];
  }

  return [
    `  ${plural(adaptation.applied.length, 'probe mechanic was', 'probe mechanics were')} changed`,
    '  during this run. A criterion below may therefore have passed by looking in a',
    '  DIFFERENT place from the one the committed plan describes.',
    '',
    '  The plan file on disk was NOT modified.',
    '',
    ...adaptation.applied.flatMap(changeLines),
    ...discardedLines(adaptation),
  ];
}

/**
 * The whole report.
 *
 * Returns a string and prints nothing: the caller owns stream discipline
 * (`report` and `verify` put the human report on stderr under `--json`), and a
 * string-returning renderer is assertable without capturing stdout — the shape
 * story 1.6 left behind for exactly this story.
 */
export function renderTerminal(result: RunResult): string {
  const criterionCounts = countCriterionStatuses(result.criteria);
  const gateCounts = countGateStatuses(result.gates);
  // The SAME derivation `schemas/result.ts` writes into `result.json` (story 5.4). Two
  // views, one implementation: a flaky count that disagreed between the human report and
  // the machine document would be AD-11's drift in the one field whose entire purpose is
  // that somebody sees it.
  const flakiness = summarizeFlakiness(result.criteria);

  const lines: string[] = [
    `SpecWitness run ${result.runId}`,
    label('Epic', result.epic),
    ...contractLines(result),
    label('Base', result.baseSha),
    label('Head', result.headSha),
    environmentLine(result),
    label('Worktree', result.environment.worktreePath ?? '(none)'),
    label('Run dir', result.environment.runDirectory),
    label('Started', result.startedAt),
    label('Finished', result.finishedAt),

    ...section('Stages', result.stages.flatMap(stageLines)),

    ...section(
      'Gates',
      result.gates.length === 0
        ? ['  (none declared)']
        : result.gates.map(
            (gate) =>
              `  ${gateMark(gate.status).padEnd(MARK_WIDTH)} ${gate.gateId.padEnd(ID_WIDTH)} ${
                gate.durationMs === undefined ? '' : duration(gate.durationMs)
              }`.trimEnd(),
          ),
    ),

    ...section(
      'Criteria',
      result.criteria.length === 0
        ? ['  (none — this run verified deterministic gates only)']
        : // An explicit arrow, NOT point-free `flatMap(criterionLines)`. `flatMap` passes
          // the array INDEX as its second argument, so widening this function's signature
          // point-free would have silently bound a number to `runDirectory` — a defect that
          // typechecks and renders a criterion's position where its evidence path belongs.
          result.criteria.flatMap((entry) =>
            criterionLines(entry, result.environment.runDirectory),
          ),
    ),

    // Story 5.6. Immediately after the criteria it qualifies, because a reader who has just
    // seen a criterion pass is the reader who needs to know the probe was changed. Placement
    // agreed with 5.5 at intent-sync: this block here, the non-authoritative one last.
    ...(result.adaptation === undefined
      ? []
      : section('Adaptation', adaptationLines(result.adaptation))),

    ...section('Counts', [
      `  Criteria:  ${CRITERION_STATUSES.map((s) => `${criterionCounts[s]} ${s}`).join(' · ')}` +
        `  (${flakinessSummary(flakiness)})`,
      `  Gates:     ${GATE_STATUSES.map((s) => `${gateCounts[s]} ${s}`).join(' · ')}`,
    ]),

    ...section(
      'Evidence',
      result.evidence.length === 0
        ? ['  (none captured)']
        : result.evidence.flatMap(evidenceLines),
    ),

    // LAST OF THE SECTIONS, and the position is a decision (story 5.5). Everything above
    // is mechanically derived from what the run observed; this is the one block that is
    // not, so it sits furthest from all of it. A reader who stops before here has read
    // only facts. The whole block is ABSENT — not empty — on every run that was not
    // explained, which is every run by default.
    ...(result.explanations === undefined || result.explanations.length === 0
      ? []
      : section(EXPLANATION_HEADING, [
          EXPLANATION_DISCLAIMER,
          ...result.explanations.flatMap(explanationLines),
        ])),

    '',
    verdictLine(result.outcome),
  ];

  return `${lines.join('\n')}\n`;
}
