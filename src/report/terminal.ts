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
import { CRITERION_STATUSES, GATE_STATUSES } from '../domain/result.js';
import type { RunResult } from '../domain/run-result.js';
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
function criterionLines(criterion: DerivedCriterionResult): string[] {
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

  return [head, ...detail];
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

  return attempts.flatMap((record) => {
    const lines = [
      `      attempt ${record.attempt} of ${attempts.length}: ${record.outcome}` +
        ` (${record.durationMs} ms)`,
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

/** The pointers alone, for entries whose text the report does not inline. */
function pointerLines(texts: readonly BoundedText[], indent: string): string[] {
  return texts
    .map((text) => text.fullPath)
    .filter((path) => path !== undefined)
    .map((path) => `${indent}full output at ${path}`);
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
        : result.criteria.flatMap(criterionLines),
    ),

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

    '',
    verdictLine(result.outcome),
  ];

  return `${lines.join('\n')}\n`;
}
