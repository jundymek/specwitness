/**
 * The dogfooding summary — FR-34, PRD SM-1, brief §54, ADR-008 §5 (story 6.6).
 *
 * ============================================================================
 * THIS MODULE IS THE ARITHMETIC THAT DECIDES WHETHER THIS PRODUCT WAS WORTH BUILDING
 * ============================================================================
 *
 * Every epic so far built machinery. The claim the machinery exists to justify is that
 * independent epic-level verification finds real defects that already passed
 * coding-agent tests, Codex review and supervisor review. Epic 7 tests that claim against
 * a real epic, and **the way it tests it is by reading this summary.**
 *
 * Which gives this file an unusual property: **there is no downstream gate on its
 * correctness.** A wrong verdict gets caught by a corpus fixture. A wrong metric gets
 * BELIEVED — because by then the number is the evidence. So the discipline here is to be
 * conservative with the arithmetic and loud about its limits:
 *
 *  - **show denominators**, never a bare percentage. At n=30 every rate is computed over
 *    few records, and "false-positive rate: 100%" from one record is technically true and
 *    practically a lie;
 *  - **count what was skipped** (ADR-008 §5 requires it by name), so a silently shrinking
 *    denominator is impossible;
 *  - **count what nobody attributed**, so an unjudged finding can never be mistaken for a
 *    confirmed defect;
 *  - **a rate with no denominator is `null`**, never `NaN` and never `0`. Zero reads as
 *    "we measured, and the answer was none"; null reads as "there was nothing to measure".
 *
 * ============================================================================
 * ⚠️ AN UNATTRIBUTED FINDING IS NEVER `unique`
 * ============================================================================
 *
 * FR-34's classification is human judgment and this module never supplies it. A finding
 * with no attribution is counted in `findings.unattributed` and in NO metric numerator.
 * A north-star metric computed as if unattributed findings were `unique` would be the
 * most flattering possible lie about this product, so the resolution below starts from
 * the ATTRIBUTIONS and never from the findings.
 *
 * ============================================================================
 * WHY THE ARITHMETIC LIVES IN `src/report/**` — a real placement decision
 * ============================================================================
 *
 * Arithmetic over records is domain-shaped, and `src/domain/**` would be the instinctive
 * home. It cannot be: `domain-is-dependency-free` in `.dependency-cruiser.cjs` lets
 * `src/domain/**` import `src/domain/**` and NOTHING else, and `ScorecardRecord` lives in
 * `src/schemas/`. With `tsPreCompilationDeps: true` even a type-only import is a
 * dependency, so a domain summariser could not name the type it summarises.
 *
 * `src/report/**` is the layer that may read `src/domain/**` AND `src/schemas/**` while
 * being structurally forbidden from importing `src/infra/**` or any side-effectful Node
 * built-in (`report-layer`). That is exactly the shape this computation wants:
 *
 *  - it **cannot open a file**, so reading the two logs stays at the CLI edge where it
 *    belongs, and this function is pure and trivially testable;
 *  - it **cannot reach the network**, which is how AC2's "computed from local records
 *    only" becomes a property of the layer graph rather than a promise in a comment;
 *  - it **cannot look up a fact the model does not carry**, which is AD-11's guarantee
 *    that the terminal view and the `--json` document cannot drift apart.
 *
 * AD-11 in one line: **one model, two renderers.** `summarizeScorecard` computes every
 * fact; `renderScorecardSummaryJson` and `renderScorecardSummaryTerminal` only format it.
 * A number in one view and not the other is a renderer inventing a fact.
 *
 * AD-6: this changes no verdict and no exit code. The scorecard is instrumentation about
 * verification, never part of it.
 */

import type {
  AttributionRecord,
  AttributionSkipReason,
  AttributionValue,
} from '../schemas/scorecard-attribution.js';
import { ATTRIBUTION_VALUES } from '../schemas/scorecard-attribution.js';
import type { ScorecardRecord } from '../schemas/scorecard.js';
import { schemaVersionFor } from '../schemas/versions.js';

/** The `--json` document's version. See `SCHEMA_VERSIONS.scorecardSummary`. */
export const SCORECARD_SUMMARY_VERSION = schemaVersionFor('scorecardSummary');

/* ── the input ────────────────────────────────────────────────────────────────────── */

/**
 * One skipped line, from either log.
 *
 * Structurally identical to `SkippedScorecardRecord` and `SkippedAttributionRecord`, and
 * declared here as a shared STRUCTURAL shape rather than imported from either store,
 * because `report-layer` forbids `src/report/**` from importing `src/infra/**` at all —
 * type-only imports included, since `tsPreCompilationDeps` is on. Both stores' results
 * are assignable to it structurally, so the CLI edge hands them over with no adapter.
 *
 * The `reason` union comes from `src/schemas/**`, which this layer MAY read, so the two
 * logs and this summary cannot drift apart about what a skip reason is.
 */
export interface SkippedLine {
  readonly line: number;
  readonly reason: AttributionSkipReason;
  readonly message: string;
}

export interface ScorecardSummaryInput {
  readonly scorecard: {
    readonly records: readonly ScorecardRecord[];
    readonly skipped: readonly SkippedLine[];
  };
  readonly attributions: {
    /** **In FILE ORDER.** The re-attribution rule depends on it — see `resolveAttributions`. */
    readonly records: readonly AttributionRecord[];
    readonly skipped: readonly SkippedLine[];
  };
  /**
   * The UNCAPPED finding ids for runs whose scorecard record truncated its own list,
   * keyed by run id. Supplied by the CLI edge from `.specwitness/runs/<runId>/result.json`.
   *
   * ⚠️ THIS EXISTS SO THAT `add` AND `summary` SHARE ONE SOURCE OF TRUTH, and four rounds
   * of codex review on this branch are the reason it does. Story 6.5 caps a record's
   * finding-id list at 200 ids, and every attempt to treat that CAPPED list as the set
   * broke something:
   *
   *  - counting an unlisted criterion anyway let any id inflate the north star past the
   *    findings that exist;
   *  - refusing it outright meant a run with more than 200 findings could never have
   *    findings 201+ attributed at all;
   *  - validating it at the WRITE end only (against the run's stored result) made `add`
   *    accept a judgement this summary then reported as an orphan and never counted —
   *    the same accept-then-discard contradiction, one layer along.
   *
   * So the authoritative list is read ONCE, at the edge, and handed to both. This module
   * stays pure and file-free (`report-layer`); it is told the facts rather than fetching
   * them, which is the same discipline AD-11 applies to everything else here.
   *
   * OPTIONAL, and absence is not an error: an untruncated record needs nothing, and a run
   * whose result cannot be read falls back to its capped list — narrower, never wider.
   */
  readonly authoritativeFindingIds?: ReadonlyMap<string, ReadonlySet<string>>;
}

/* ── the model ────────────────────────────────────────────────────────────────────── */

/**
 * A rate, always carrying the two numbers it was computed from.
 *
 * **The denominator is not decoration.** During the ~30–50-task dogfooding window every
 * rate is computed over few records, and a percentage without its denominator is how a
 * sample of one becomes a headline. SM-2 turns on whether the author keeps the gate
 * mandatory, and that is a judgement nobody can make from "100%".
 *
 * `value` is `null` — never `NaN`, never `0` — when `denominator` is zero.
 */
export interface Rate {
  readonly numerator: number;
  readonly denominator: number;
  readonly value: number | null;
}

/** The north star (SM-1), with both denominators it should ever be read against. */
export interface UniqueDefects {
  /** Findings a human judged `unique`. **The number this product exists to produce.** */
  readonly count: number;
  /** How many findings were judged at all. */
  readonly ofAttributed: number;
  /** How many findings exist, judged or not. */
  readonly ofAllFindings: number;
}

export interface DurationSummary {
  /** MEDIAN, not mean — durations are skewed by infra retries. `null` over no records. */
  readonly medianMs: number | null;
  readonly count: number;
}

export interface FindingCounts {
  /**
   * Every finding, from the EXACT per-status counts (`criteria.fail + needs_human +
   * error`) — never from the id arrays, which story 6.5 caps at 200 across a record.
   * Deriving this from ids would silently shrink the denominator for exactly the runs
   * with the most findings.
   */
  readonly total: number;
  /** How many findings are NAMED by an id, and so can be attributed at all. */
  readonly enumerated: number;
  readonly attributed: number;
  /** `total - attributed`. **Never folded into any metric numerator.** */
  readonly unattributed: number;
  /** Runs whose id list was cut. A cut list must never be read as a complete one. */
  readonly runsWithTruncatedFindingIds: number;
  /**
   * Truncated runs whose UNCAPPED list could not be supplied — no stored result, or one
   * that could not be read.
   *
   * ⚠️ REPORTED BECAUSE THE FALLBACK IS SILENT OTHERWISE, and that was a finding of the
   * auto-review over this branch's final head. When an authoritative list is missing the
   * summary falls back to the capped one, and attributions beyond the cap — which
   * `scorecard add` may legitimately have accepted earlier, when the result WAS readable —
   * become orphans. That undercounts `uniqueDefects` with nothing on screen to say so,
   * which is the silently-shrinking-denominator failure ADR-008 §5 exists to prevent,
   * arriving by a different route.
   *
   * Zero on every ordinary project: it can only be non-zero for a run with more than 200
   * findings whose `result.json` is missing or unreadable.
   */
  readonly runsWithUnreadableStoredResult: number;
  /**
   * Attributions naming a `(runId, criterionId)` that no record enumerates.
   *
   * Reported, never counted. Including one would add to a numerator whose denominator it
   * is not part of — the shape of a quietly wrong rate.
   */
  readonly orphanedAttributions: number;
}

export interface SkippedRecords {
  readonly total: number;
  readonly scorecard: number;
  readonly attributions: number;
  readonly detail: readonly (SkippedLine & { readonly source: 'scorecard' | 'attributions' })[];
}

export interface ScorecardSummary {
  readonly schemaVersion: number;
  readonly records: { readonly read: number };
  readonly attributionsRead: number;
  /** ADR-008 §5 requires this by name, *"so a silently shrinking denominator is impossible."* */
  readonly skippedRecords: SkippedRecords;
  readonly findings: FindingCounts;
  /** The winning judgements, by value. Sums to `findings.attributed`. */
  readonly attributionCounts: Readonly<Record<AttributionValue, number>>;
  readonly metrics: {
    readonly uniqueDefects: UniqueDefects;
    readonly falsePositiveRate: Rate;
    readonly needsHumanRate: Rate;
    readonly infraErrorRate: Rate;
    readonly aiFreeRunShare: Rate;
    readonly flakyRate: Rate;
    readonly duration: DurationSummary;
  };
}

/* ── the arithmetic ───────────────────────────────────────────────────────────────── */

/** Builds a rate, refusing to divide by zero. */
function rate(numerator: number, denominator: number): Rate {
  return {
    numerator,
    denominator,
    value: denominator === 0 ? null : numerator / denominator,
  };
}

/**
 * The MEDIAN of a list of durations.
 *
 * The AC says median and the reason is in the data: durations are skewed by infra
 * retries, and a mean would be dominated by them.
 *
 * The three cases that make a summary throw in front of a person deciding whether to keep
 * the gate, all answered here rather than at a call site:
 *
 *  - **empty** → `null`. Not `0`, which would read as "these runs were instant";
 *  - **one record** → that value;
 *  - **an even count** → the mean of the two middle values, the ordinary convention.
 *
 * A COPY is sorted, never the caller's array — this function is pure and the input is a
 * readonly view of a store's result.
 */
function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** The join key. ` ` cannot occur in either id, so no pair can collide with another. */
function key(runId: string, criterionId: string): string {
  return `${runId} ${criterionId}`;
}

/**
 * Resolves the attribution log to at most one judgement per finding.
 *
 * **THE LAST RECORD IN FILE ORDER WINS**, and that is the whole re-attribution rule.
 * People change their minds — a finding called `unique` on Monday can be shown to be a
 * duplicate on Friday — and an append-only log expresses a correction as a later record
 * rather than by rewriting history. The alternative, refusing a second attribution, would
 * force an operator to hand-edit the log to correct a mistake, which is strictly worse:
 * it destroys the audit trail and invites exactly the corruption ADR-008 §5 exists to
 * survive.
 *
 * **File order, not `recordedAt`.** The timestamps come from the machine that wrote each
 * line, and two clocks that disagree — or two records written in the same millisecond —
 * would make the winner ambiguous. Append order is the one total ordering the file
 * actually has, and `AttributionStore.read` is documented never to sort.
 */
function resolveAttributions(
  records: readonly AttributionRecord[],
): readonly AttributionRecord[] {
  // Keyed by `(runId, criterionId)` for de-duplication; the winning RECORD is kept rather
  // than just its value, so the caller can join it back to a run without re-parsing a
  // composite string key.
  const winning = new Map<string, AttributionRecord>();
  for (const entry of records) {
    winning.set(key(entry.runId, entry.criterionId), entry);
  }
  return [...winning.values()];
}

/**
 * Computes every fact the two views can show. Pure, total, and free of I/O.
 *
 * Total in the strict sense: there is no input for which this throws. An empty scorecard,
 * a scorecard whose every line was skipped, one record, an even count, a finding nobody
 * judged, an attribution naming a run that is not there — each has an answer, because
 * this function runs at the moment someone is deciding whether this gate is worth
 * keeping, and a stack trace is not an answer.
 */
export function summarizeScorecard(input: ScorecardSummaryInput): ScorecardSummary {
  const records = input.scorecard.records;
  const runCount = records.length;

  // ── the record-denominated rates ──────────────────────────────────────────────────
  //
  // `outcome` is a discriminated union: a verdict OR an infra error, never both (AD-6).
  // The scorecard RECORDS infra-errored runs deliberately (story 6.5's PR §2) — excluding
  // them would make the infra-error rate structurally zero, which looks like good news.
  let needsHuman = 0;
  let infraErrors = 0;
  let aiFree = 0;
  let flakyCriteria = 0;
  let retriedCriteria = 0;
  let findingsTotal = 0;
  let findingsEnumerated = 0;
  let truncatedRuns = 0;
  let unreadableStoredResults = 0;
  const durations: number[] = [];

  /**
   * Every `(runId, criterionId)` a finding could be about, across every record.
   *
   * ⚠️ MEMBERSHIP IS DECIDED BY THIS SET AND NOTHING ELSE, and two rounds of codex review
   * on this branch are the reason. An intermediate version granted an amnesty for runs
   * whose finding list was TRUNCATED, so that a judgement `scorecard add` had accepted
   * would still be counted. That amnesty let *any* syntactically valid criterion id count
   * for such a run — so `attributed` and `uniqueDefects.count` could exceed
   * `findings.total`: a north-star count larger than the number of findings that exist.
   *
   * The resolution was to close it at the WRITE end instead: `scorecard add` now refuses
   * an unlisted criterion even on a truncated record (`assertCriterionIsAFinding`). With
   * that refusal in place this set is the whole membership test, and
   * `attributed <= enumerated <= total` holds structurally rather than by clamping.
   *
   * An attribution outside it — hand-written, or predating that refusal — is an ORPHAN:
   * reported, never counted.
   */
  const enumeratedFindings = new Set<string>();

  for (const record of records) {
    durations.push(record.durationMs);

    if ('infraError' in record.outcome) {
      infraErrors += 1;
    } else if (record.outcome.verdict === 'NEEDS_HUMAN') {
      needsHuman += 1;
    }

    if (record.providerInvocations === 0) {
      aiFree += 1;
    }

    flakyCriteria += record.flakiness.flakyCriteria;
    retriedCriteria += record.flakiness.retriedCriteria;

    // ⚠️ FROM THE EXACT COUNTS, NOT FROM THE ID ARRAYS. Story 6.5 caps the arrays at 200
    // ids ACROSS the record and flags it; the per-status counts stay exact regardless. A
    // denominator built from ids would silently shrink for the runs with the most
    // findings — the ones that matter most.
    findingsTotal +=
      record.criteria.fail + record.criteria.needs_human + record.criteria.error;

    if (record.findingCriterionIdsTruncated) {
      truncatedRuns += 1;
      // A truncated run with no authoritative list is one whose full finding set this
      // summary cannot see. Counted rather than silently narrowed.
      if (input.authoritativeFindingIds?.has(record.runId) !== true) {
        unreadableStoredResults += 1;
      }
    }

    // The record's own ids, WIDENED by the authoritative list when the record truncated
    // its own. A run with no authoritative list contributes exactly what it names, so the
    // widening can only ever add ids that a stored result actually recorded as findings.
    const named = new Set<string>([
      ...record.findingCriterionIds.fail,
      ...record.findingCriterionIds.needs_human,
      ...record.findingCriterionIds.error,
      ...(input.authoritativeFindingIds?.get(record.runId) ?? []),
    ]);

    for (const criterionId of named) {
      enumeratedFindings.add(key(record.runId, criterionId));
    }
    findingsEnumerated += named.size;
  }

  // ── the human judgements ──────────────────────────────────────────────────────────
  const winning = resolveAttributions(input.attributions.records);

  const attributionCounts: Record<AttributionValue, number> = {
    unique: 0,
    duplicate: 0,
    'false-positive': 0,
  };
  let orphanedAttributions = 0;

  for (const { runId, criterionId, attribution: value } of winning) {
    // An attribution counts only when some record names that exact `(run, criterion)` as a
    // finding. Anything else is an orphan: reported, never counted, because adding it to a
    // numerator whose denominator it is not part of is the shape of a quietly wrong rate.
    if (enumeratedFindings.has(key(runId, criterionId))) {
      attributionCounts[value] += 1;
    } else {
      orphanedAttributions += 1;
    }
  }

  const attributed = ATTRIBUTION_VALUES.reduce(
    (total, value) => total + attributionCounts[value],
    0,
  );

  // `total`, not `enumerated`: a finding whose id was truncated away still EXISTS and
  // still has nobody's judgement on it. Counting only enumerated findings here would hide
  // the unjudged ones that are hardest to see.
  const unattributed = Math.max(0, findingsTotal - attributed);

  const skippedDetail = [
    ...input.scorecard.skipped.map((entry) => ({ ...entry, source: 'scorecard' as const })),
    ...input.attributions.skipped.map((entry) => ({ ...entry, source: 'attributions' as const })),
  ];

  return {
    schemaVersion: SCORECARD_SUMMARY_VERSION,
    records: { read: runCount },
    attributionsRead: input.attributions.records.length,
    skippedRecords: {
      total: skippedDetail.length,
      scorecard: input.scorecard.skipped.length,
      attributions: input.attributions.skipped.length,
      detail: skippedDetail,
    },
    findings: {
      total: findingsTotal,
      enumerated: findingsEnumerated,
      attributed,
      unattributed,
      runsWithTruncatedFindingIds: truncatedRuns,
      runsWithUnreadableStoredResult: unreadableStoredResults,
      orphanedAttributions,
    },
    attributionCounts,
    metrics: {
      uniqueDefects: {
        count: attributionCounts.unique,
        ofAttributed: attributed,
        ofAllFindings: findingsTotal,
      },
      // Denominated by ATTRIBUTED findings: a finding nobody judged is not evidence
      // either way, and folding it into this denominator would flatter the rate.
      // `findings.unattributed` sits beside it so the base is never mistaken.
      falsePositiveRate: rate(attributionCounts['false-positive'], attributed),
      needsHumanRate: rate(needsHuman, runCount),
      infraErrorRate: rate(infraErrors, runCount),
      aiFreeRunShare: rate(aiFree, runCount),
      // Retry-to-green (SM-C3), exactly as story 6.5 documents the field pair:
      // `flakyCriteria` over `retriedCriteria`. A run that retried nothing contributes
      // nothing to either, so a project with no retries reports `null` rather than a
      // perfect score.
      flakyRate: rate(flakyCriteria, retriedCriteria),
      duration: { medianMs: medianOf(durations), count: runCount },
    },
  };
}

/* ── the renderers — AD-11: two views, one model, no invented facts ───────────────── */

/**
 * The machine-readable summary: the model, serialized.
 *
 * Deliberately a straight `JSON.stringify` of the model and nothing more — the same
 * discipline `src/report/json.ts` keeps, and for the same reason. Any transformation here
 * would be a second shape, and the terminal view and the document would begin to disagree
 * about the same numbers.
 *
 * Indented because, unlike `result.json`, this document is not byte-compared against a
 * stored file: it is computed on demand, a human reads it over a harness's shoulder, and
 * there is no persisted counterpart for it to match.
 */
export function renderScorecardSummaryJson(summary: ScorecardSummary): string {
  return `${JSON.stringify(summary, null, 2)}\n`;
}

/**
 * Escapes every control character so a log's contents cannot forge terminal output.
 *
 * ⚠️ A P2 FROM ROUND 4 OF THE CODEX REVIEW, AND I INTRODUCED IT IN ROUND 3. Making the
 * terminal print the parser's full skip message (as ADR-008 §5 requires, naming the
 * unknown fields) also put UNTRUSTED TEXT on the terminal for the first time: an unknown
 * key's NAME comes out of the file, and a JSON key may legally contain an ESC or a
 * newline. Reproduced against the built binary — a key named
 * `<ESC>[31mINJECTED<ESC>[0m\nFAKE LINE: pwned` coloured the output and **forged a line
 * of its own** inside a metrics report.
 *
 * Redaction and byte-bounding do not help: neither removes control characters. `field()`
 * in the schema modules bounds and redacts the key name, which is the right treatment for
 * a SECRET, and this is the separate treatment for a CONTROL SEQUENCE.
 *
 * **Scope, stated precisely.** This is a local file the operator owns, so it is not a
 * remote-attacker path; the reason it matters anyway is that a scorecard summary is the
 * output most likely to be pasted into an issue or a report, and a forged line in a
 * metrics report is the same class of harm this whole story exists to prevent. It also
 * closes a hole in the no-TTY guarantee, which promises this command emits no escape
 * sequence.
 *
 * **`--json` is unaffected and deliberately keeps the original**: `JSON.stringify`
 * escapes control characters itself, so the machine document stays faithful while the
 * human view stays safe. That asymmetry is not an AD-11 parity break — it is the same
 * fact, rendered for two media with different hazards.
 *
 * The two scorecard log parsers both produce these messages, and this renderer is the
 * only place either reaches a terminal, so one guard here covers both. Story 6.5's parser
 * is merged code and is deliberately not modified.
 *
 * EXPORTED because `scorecard add` echoes the operator's own `--note` back to stdout and
 * needs exactly the same treatment - round 5 of the same review found that second site
 * after round 4 fixed this one. One implementation rather than two: a sanitiser that
 * exists twice is a sanitiser that gets fixed once.
 */
export function printable(text: string): string {
  // C0 (00–1F), DEL (7F) and C1 (80–9F). Rendered as `\xNN` so the operator can still see
  // exactly what was in the file without the terminal acting on it.
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) =>
    `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
}

/** `1 of 5 (20.0%)`, or `— (no data)`. The denominator is always shown. */
function formatRate(value: Rate): string {
  if (value.value === null) {
    return `— (0 of 0 — nothing to measure yet)`;
  }
  return `${value.numerator} of ${value.denominator} (${(value.value * 100).toFixed(1)}%)`;
}

function formatDuration(duration: DurationSummary): string {
  if (duration.medianMs === null) {
    return '— (no runs recorded)';
  }
  return `${duration.medianMs} ms (median of ${duration.count})`;
}

/**
 * The human view.
 *
 * Carries **exactly** the facts of the model, with denominators beside every rate. Plain
 * text, no colour and no cursor control: this is written to a pipe as often as to a
 * terminal, and an escape sequence in a log is noise a reader has to decode.
 *
 * The order is deliberate. The north star first, because it is the question. The
 * unattributed count immediately under it, because it is the number that says how much of
 * the question is still unanswered — a reader who sees "1 unique defect" and stops has
 * been misled unless "12 unattributed" is on the next line.
 */
export function renderScorecardSummaryTerminal(summary: ScorecardSummary): string {
  const { findings, metrics, skippedRecords } = summary;
  const lines: string[] = [];

  lines.push('SpecWitness dogfooding scorecard');
  lines.push('');

  // ⚠️ NO EARLY RETURN ON AN EMPTY SCORECARD, and that was a P2 from the codex review of
  // this branch. An earlier version printed a short "no runs recorded" block and returned
  // — so the terminal view omitted all seven metrics, the skip detail and the orphan
  // count while `--json` still carried them. That is precisely the AD-11 drift this module
  // is built to prevent: a fact in one view and not the other. The two edge cases it hit
  // are the two most likely to be seen by a person deciding whether to keep the gate — a
  // freshly initialised project, and a scorecard whose every line was skipped.
  //
  // The note is now a HEADER above the full structure rather than a substitute for it.
  if (summary.records.read === 0) {
    lines.push(
      skippedRecords.scorecard > 0
        ? `  ⚠ No READABLE runs — ${skippedRecords.scorecard} scorecard record(s) were skipped ` +
            `(see COVERAGE below). Every rate is therefore over zero records.`
        : "  No runs recorded yet — this project has no completed verifications. Run 'specwitness verify <epic>' to record one.",
    );
    lines.push('');
  }

  lines.push('  THE NORTH STAR (SM-1) — real defects SpecWitness found that earlier gates missed');
  lines.push(
    `    Unique real defects:   ${metrics.uniqueDefects.count} ` +
      `of ${metrics.uniqueDefects.ofAttributed} judged, ` +
      `of ${metrics.uniqueDefects.ofAllFindings} findings`,
  );
  lines.push(
    `    Unattributed:          ${findings.unattributed} finding(s) nobody has judged yet`,
  );
  lines.push('');

  lines.push('  RATES (numerator of denominator — a rate at n=1 is not a trend)');
  lines.push(`    False-positive rate:   ${formatRate(metrics.falsePositiveRate)}`);
  lines.push(`    NEEDS_HUMAN rate:      ${formatRate(metrics.needsHumanRate)}`);
  lines.push(`    Infra-error rate:      ${formatRate(metrics.infraErrorRate)}`);
  lines.push(`    AI-free run share:     ${formatRate(metrics.aiFreeRunShare)}`);
  lines.push(`    Flaky (retry-to-green): ${formatRate(metrics.flakyRate)}`);
  lines.push(`    Median duration:       ${formatDuration(metrics.duration)}`);
  lines.push('');

  lines.push('  JUDGEMENTS');
  lines.push(`    unique:                ${summary.attributionCounts.unique}`);
  lines.push(`    duplicate:             ${summary.attributionCounts.duplicate}`);
  lines.push(`    false-positive:        ${summary.attributionCounts['false-positive']}`);
  lines.push('');

  // ⚠️ EVERY FACT IN THE MODEL APPEARS HERE, UNCONDITIONALLY — a P2 from round 3 of the
  // codex review of this branch. `findings.enumerated` was missing from this view while
  // `--json` carried it, and `runsWithTruncatedFindingIds` / `orphanedAttributions` were
  // printed only when non-zero. Both are AD-11 parity breaks: a terminal reader could not
  // tell a complete finding list from a truncated one, and could not distinguish "zero
  // orphans" from "orphans not reported". A conditional fact is a fact the reader has to
  // already know about in order to miss it.
  //
  // The ⚠ lines below are kept for the non-zero cases, because EMPHASIS is a rendering
  // decision and is not a fact — the numbers themselves are always present above them.
  lines.push('  COVERAGE');
  lines.push(`    Records read:          ${summary.records.read}`);
  lines.push(`    Attributions read:     ${summary.attributionsRead}`);
  lines.push(`    Findings total:        ${findings.total}`);
  lines.push(`    Findings named by id:  ${findings.enumerated}`);
  lines.push(`    Findings attributed:   ${findings.attributed}`);
  lines.push(`    Runs with a cut list:  ${findings.runsWithTruncatedFindingIds}`);
  lines.push(`    ...list unrecoverable:  ${findings.runsWithUnreadableStoredResult}`);
  lines.push(`    Orphaned attributions: ${findings.orphanedAttributions}`);

  // ⚠️ THE WORDING IS CONDITIONAL BECAUSE THE BEHAVIOUR IS. An earlier version said flatly
  // that truncated findings "cannot be attributed by id" — which became FALSE the moment
  // the authoritative-list path recovered them, giving operators false guidance in exactly
  // the case where the feature had just worked. Flagged by the auto-review over this
  // branch's final head.
  if (findings.runsWithTruncatedFindingIds > 0) {
    const recovered =
      findings.runsWithTruncatedFindingIds - findings.runsWithUnreadableStoredResult;
    if (recovered > 0) {
      lines.push(
        `    ⚠ ${recovered} run(s) had more findings than the record names individually; ` +
          `their full list was recovered from the run's stored result.`,
      );
    }
    if (findings.runsWithUnreadableStoredResult > 0) {
      lines.push(
        `    ⚠ ${findings.runsWithUnreadableStoredResult} run(s) had more findings than the ` +
          `record names individually AND no readable stored result — findings beyond the ` +
          `named ones cannot be attributed by id, and any existing attribution of one is ` +
          `counted as orphaned above.`,
      );
    }
  }

  if (findings.orphanedAttributions > 0) {
    lines.push(
      `    ⚠ ${findings.orphanedAttributions} attribution(s) name a finding no record lists — ` +
        `excluded from every metric above.`,
    );
  }

  // ADR-008 §5, by name: "so a silently shrinking denominator is impossible".
  lines.push(`    Records skipped:       ${skippedRecords.total}`);
  if (skippedRecords.total > 0) {
    lines.push(
      `      (${skippedRecords.scorecard} from the scorecard, ` +
        `${skippedRecords.attributions} from the attribution log — ` +
        `every number above is computed WITHOUT them)`,
    );
    // ⚠️ THE FULL MESSAGE, not just the reason — a P2 from the codex review of this
    // branch. ADR-008 §5 requires a skipped record to be reported with *"the line number
    // and the unknown fields"*; printing only `version-skew` discarded the field names the
    // parser had carefully preserved, so an operator could not tell WHICH unsupported
    // field caused the record to be dropped. The message is already bounded and redacted
    // and carries no value from the file (see `parseAttributionLine`).
    for (const entry of skippedRecords.detail) {
      lines.push(`      - [${entry.source}/${entry.reason}] ${printable(entry.message)}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
