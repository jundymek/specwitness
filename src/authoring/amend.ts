/**
 * Contract amendment — the only legitimate way a frozen contract changes
 * (FR-10, UJ-5, ADR-005, AD-5).
 *
 * This module is PURE. It takes a contract, an instant and an operator's
 * reason, and returns the next contract. It reads no file, writes no file,
 * calls no clock, and prompts nobody — the CLI edge does all four. That is what
 * makes every rule below testable without a terminal, a temp directory or a
 * fake filesystem.
 *
 * WHY THIS EXISTS AT ALL. UJ-5 is the product's reason for being: an agent that
 * cannot pass a criterion tries to weaken it, the fingerprint catches the edit,
 * and the only way forward is an explicit, versioned, human-confirmed amendment
 * with an audit trail. ADR-005 is honest that V0 is tamper-EVIDENT, not
 * tamper-PROOF: nothing here stops a determined local agent from re-running the
 * freeze itself. What it does is convert silent redefinition into an explicit,
 * reviewable, git-visible act.
 *
 * THE ORDER OF OPERATIONS IS THE SECURITY PROPERTY.
 *
 *   1. INTEGRITY FIRST, ALWAYS. A tampered contract is not amendable. Amending
 *      one would launder the tampering into the audit trail as legitimate: the
 *      history entry would record a fingerprint that no longer describes any
 *      content anyone approved, and the next reader would see a clean chain of
 *      custody over an edit nobody made deliberately. Refusing is the whole
 *      point — restore the file from git, then amend.
 *   2. A NEVER-FROZEN DRAFT IS NOT AMENDABLE EITHER. There is nothing to
 *      supersede and nothing to record; the operator wants `--freeze`, and
 *      saying so is more use than inventing a version-0 history entry.
 *   3. The version increments by exactly one (AD-5: integer, monotonic).
 *   4. The history entry records the SUPERSEDED version and ITS fingerprint —
 *      not the new one, which does not exist yet and would be circular.
 *
 * WHAT COMES BACK IS A VALID DRAFT, AND THAT IS DELIBERATE.
 *
 * `amend` returns the successor with `frozen: false` and `fingerprint: null`.
 * Re-freezing is a SEPARATE, second invocation (`--freeze`), because AC1 asks
 * for a version that is "re-reviewed and re-frozen" and the story's own
 * clarification says to "clear the frozen state SO THE HUMAN CAN EDIT". Freezing
 * inside this call would close that window before anyone could use it, and the
 * amendment would produce version N+1 whose criteria are identical to version
 * N — an audit trail recording a change that never happened.
 *
 * The failure mode the spec warns about — "version bumped, history written, but
 * not re-frozen, and the fingerprint NOW STALE" — is about a *stale* fingerprint,
 * not an absent one. A frozen flag left over a changed spec is indistinguishable
 * from tampering. Nulling both together is what makes the intermediate file a
 * legitimate draft rather than a half state, and the spec recommends exactly
 * that: "decide explicitly whether the post-amend file is a valid draft
 * (recommended: yes, with `frozen: false` and the history intact) — never
 * something `parseContract` rejects". `frozen` and `fingerprint` therefore always
 * travel together here; carrying one without the other is what 2.2's parser
 * rejects as self-contradictory. See DECISIONS.md D1.
 *
 * WHY `meta.history` CAN BE APPENDED SAFELY. `fingerprint()` takes a
 * `ContractSpec`, not a `Contract`, so `meta` is out of scope by construction
 * (AD-5, confirmed by 2.2). Recording an amendment cannot perturb the hash of
 * the version it records — the property is unrepresentable in the wrong form,
 * not merely remembered.
 *
 * WHO CHANGED IT. There is deliberately no author field. V0 has no identity
 * system, and one populated from `$USER` or `git config user.name` would be
 * worse than none: ADR-005 already concedes the file is editable by the agent,
 * so a self-reported identity is an attestation with no attester behind it.
 * Authorship is attested by GIT HISTORY, reviewed at the PR boundary. Raised
 * with 2.2 (the shape owner) before writing this and confirmed. See
 * DECISIONS.md D2.
 *
 * AD-9: no `new Date()` here or anywhere in `src/authoring/**` — the instant is
 * an argument, so the history timestamp is deterministic in tests.
 */

import type { Contract } from '../domain/contract.js';
import { IntegrityError, UsageError } from '../domain/errors.js';
import { contractState } from '../schemas/contract.js';

export interface AmendInput {
  /** The contract as read from disk and parsed. Must be `frozen` and intact. */
  readonly contract: Contract;
  /** The operator's stated reason. Recorded verbatim in the history entry. */
  readonly reason: string;
  /** Injected instant (AD-9). Becomes the history entry's timestamp. */
  readonly at: Date;
}

/**
 * The longest reason recorded. Long enough for a paragraph of rationale, short
 * enough that a pasted diff or stack trace does not end up living inside the
 * contract file forever.
 */
export const MAX_REASON_LENGTH = 2_000;

/**
 * Refuse anything that is not an intact, frozen contract.
 *
 * Exported so the CLI can ask BEFORE prompting the operator: making someone
 * type a reason for an operation that cannot proceed is a small cruelty, and a
 * tampered contract should be reported the moment it is recognised. `amend`
 * calls it too, so the rule holds for every caller and the refusal wording has
 * exactly one source.
 *
 * Returns the superseded fingerprint, which is the value only a valid frozen
 * contract has — so a caller cannot proceed without having passed the check.
 */
export function assertAmendable(contract: Contract): string {
  const state = contractState(contract);

  if (state === 'tampered') {
    throw new IntegrityError(
      `contract for ${contract.spec.epic} does not match its recorded fingerprint, so it cannot be amended`,
      'restore the contract from git first — amending a tampered file would record the tampering as a legitimate change',
    );
  }

  if (state === 'draft') {
    throw new IntegrityError(
      `contract for ${contract.spec.epic} has never been frozen, so there is no version to supersede`,
      "edit the draft directly, then freeze it with 'specwitness contract <epic> --freeze'",
    );
  }

  // `frozen` implies a non-null fingerprint — 2.2's parser rejects the
  // contradictory document — but the field's type is `string | null` and the
  // history entry must never carry a fabricated value. Fail closed instead.
  const supersededFingerprint = contract.meta.fingerprint;
  if (supersededFingerprint === null) {
    throw new IntegrityError(
      `contract for ${contract.spec.epic} claims to be frozen but records no fingerprint`,
      'restore the contract from git — a frozen contract without a fingerprint can be neither verified nor amended',
    );
  }

  return supersededFingerprint;
}

/**
 * Validate an operator-supplied reason, returning it trimmed.
 *
 * Exported for the same reason as `assertAmendable`: the CLI checks it as soon
 * as the reason is known, rather than after the confirmation.
 */
export function normalizeReason(raw: string): string {
  const reason = raw.trim();

  if (reason === '') {
    throw new UsageError(
      'an amendment reason is required',
      'describe why the contract is changing — the reason IS the audit trail, and a blank one records nothing',
    );
  }
  if (reason.length > MAX_REASON_LENGTH) {
    throw new UsageError(
      `the amendment reason is ${reason.length} characters; the limit is ${MAX_REASON_LENGTH}`,
      'summarise the change here and leave the detail in the commit message, where git already keeps it',
    );
  }

  return reason;
}

/**
 * Produce the amended successor of a frozen contract, as an unfrozen draft.
 *
 * Throws `IntegrityError` when the input is tampered or was never frozen, and
 * `UsageError` when the reason is missing or unusable. Both classify at the edge
 * through `cli/exit.ts`; this module sets no exit code (ADR-002).
 *
 * Re-checks both preconditions even when the caller already did: this is the
 * function that writes the audit trail, and it does not take another module's
 * word for whether it is allowed to.
 */
export function amend(input: AmendInput): Contract {
  const { contract, at } = input;

  const reason = normalizeReason(input.reason);
  const supersededFingerprint = assertAmendable(contract);

  const supersededEntry = {
    version: contract.spec.version,
    fingerprint: supersededFingerprint,
    timestamp: at.toISOString(),
    reason,
  };

  return {
    spec: {
      ...contract.spec,
      version: contract.spec.version + 1,
    },
    meta: {
      ...contract.meta,
      // These three move together, always. A `frozen: true` left standing over a
      // spec the operator is about to edit is indistinguishable from tampering,
      // which is the actual half state the story warns about.
      frozen: false,
      fingerprint: null,
      frozenAt: null,
      history: [...contract.meta.history, supersededEntry],
    },
  };
}
