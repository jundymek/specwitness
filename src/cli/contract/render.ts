/**
 * The two renderings of `specwitness contract <epic> --status` (AC3).
 *
 * Pure functions over a view model: no I/O, no exit codes, no clock, and — by
 * design — no dependency on the `Contract` model itself. The command reads the
 * file, asks story 2.2's `contractState`, and projects the answer into
 * `ContractStatus`; this module only formats it. That split is what makes the
 * published JSON shape testable without a provider, a filesystem or a contract,
 * and it mirrors `src/cli/doctor/render.ts`, which the merged `doctor --json`
 * pins the same way.
 *
 * STREAM DISCIPLINE lives in the command, not here: in `--json` mode stdout
 * carries the JSON document and nothing else, and the human rendering goes to
 * stderr. Returning strings rather than printing them is what lets the command
 * decide, and what lets these assertions run without capturing stdout.
 *
 * THIS SHAPE IS A PUBLIC CONTRACT from merge. The harness parses it and story
 * 2.7 adds an amend-related field to it, so evolution is ADDITIVE: add fields,
 * never rename or remove one without bumping `CONTRACT_STATUS_SCHEMA_VERSION`
 * and saying so.
 *
 * NO TIMESTAMP, deliberately, and this is the one place the shape diverges from
 * doctor's. Doctor reports a moment of measurement; this reports the state of a
 * file. Stamping the current time would make two identical `--status` calls
 * produce different bytes, so an operator could not diff them and a cache could
 * not compare them — while adding nothing a reader could act on. `frozenAt`
 * already carries the only instant that means anything here.
 */

/**
 * Pinned at 1. See the header: additive evolution only.
 */
export const CONTRACT_STATUS_SCHEMA_VERSION = 1;

/**
 * What the contract file IS.
 *
 * Mirrors story 2.2's `contractState()` (`draft | frozen | tampered`) plus
 * `absent`, which is a filesystem fact rather than a contract fact and so has
 * no counterpart there.
 */
export type ContractStatusState = 'absent' | 'draft' | 'frozen' | 'tampered';

/**
 * Whether the contract can be TRUSTED — the separate question story 2.7 asserts
 * on.
 *
 * Deliberately a second field rather than folded into `state`: `state` answers
 * "what is this", `integrity` answers "can I trust it". Collapsing them would
 * force every consumer to re-derive one from the other, which is how two
 * consumers end up deriving it differently.
 */
export type ContractIntegrity = 'ok' | 'mismatch' | 'not-frozen' | 'not-applicable';

/** The view model. Every field is always present; unknown values are `null`. */
export interface ContractStatus {
  /** Canonical epic id, e.g. `epic-7`. */
  readonly epic: string;
  /** Repo-relative path, so the operator can open the file being described. */
  readonly path: string;
  readonly state: ContractStatusState;
  readonly integrity: ContractIntegrity;
  /** `null` when there is no contract to have a version. */
  readonly version: number | null;
  /** Full lowercase hex; `null` on a draft. Never truncated. */
  readonly fingerprint: string | null;
  readonly criteriaCount: number | null;
  /** ISO-8601 UTC; `null` unless frozen. */
  readonly frozenAt: string | null;
}

/**
 * The single mapping from state to integrity.
 *
 * Exported so the command never re-derives it and story 2.7 never writes a
 * second version. Note that `not-applicable` and `not-frozen` are different
 * answers: an absent contract has no integrity state at all, while a draft has
 * one that is simply not established yet. Conflating them would put a false
 * statement in a field automation asserts on.
 */
export function integrityFor(state: ContractStatusState): ContractIntegrity {
  switch (state) {
    case 'absent':
      return 'not-applicable';
    case 'draft':
      return 'not-frozen';
    case 'frozen':
      return 'ok';
    case 'tampered':
      return 'mismatch';
    default: {
      // Compile-time exhaustiveness: adding a state without giving it an
      // integrity answer is a type error, not a silent fallthrough.
      const unreachable: never = state;
      return unreachable;
    }
  }
}

/**
 * The machine-readable document. stdout carries this and nothing else.
 *
 * Field order is fixed here rather than spread from the view model, so the
 * serialized shape does not drift with an internal refactor.
 */
export function renderStatusJson(status: ContractStatus): string {
  const payload = {
    schemaVersion: CONTRACT_STATUS_SCHEMA_VERSION,
    epic: status.epic,
    path: status.path,
    state: status.state,
    integrity: status.integrity,
    version: status.version,
    fingerprint: status.fingerprint,
    criteriaCount: status.criteriaCount,
    frozenAt: status.frozenAt,
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** The human rendering. */
export function renderStatusHuman(status: ContractStatus): string {
  if (status.state === 'absent') {
    return (
      `No contract for ${status.epic}.\n` +
      `Expected at ${status.path}.\n` +
      `\nGenerate one with 'specwitness contract ${status.epic}'.\n`
    );
  }

  const lines = [
    `Epic:      ${status.epic}`,
    `File:      ${status.path}`,
    `State:     ${status.state}`,
    `Version:   ${status.version ?? '(none)'}`,
    `Criteria:  ${status.criteriaCount ?? '(none)'}`,
    // Printed in full: UJ-1's climax is the operator seeing this value, and an
    // abbreviated fingerprint cannot be compared against a file by eye.
    `Fingerprint: ${status.fingerprint ?? '(not frozen)'}`,
    `Frozen at: ${status.frozenAt ?? '(not frozen)'}`,
  ];

  if (status.state === 'tampered') {
    lines.push(
      '',
      'WARNING: this contract is frozen, but its content does not match the',
      'stored fingerprint. It has been edited since it was frozen. Amend it',
      `explicitly with 'specwitness contract ${status.epic} --amend', or restore`,
      'the reviewed version from Git.',
    );
  } else if (status.state === 'draft') {
    lines.push('', `Not frozen yet. Freeze it with 'specwitness contract ${status.epic} --freeze'.`);
  }

  return `${lines.join('\n')}\n`;
}
