/**
 * The verifiability guard (AC4, FR-8, ADR-005).
 *
 * FR-8: "Only frozen Contracts gate verification", and "verify against a
 * never-frozen Contract is refused with guidance to freeze first". This module
 * is that refusal, expressed once so that every caller asks the question the
 * same way.
 *
 * **`specwitness verify` does not exist yet — it is Epic 3, and story 3.7 wires
 * this guard into the verify pipeline.** Shipping the guard now, with its
 * tests, means the discipline is defined and proven by the story that owns the
 * contract lifecycle rather than improvised later by the story that owns the
 * pipeline. Nothing here registers a command, and no `verify` stub exists.
 *
 * THREE REFUSALS, THREE DISTINCT HINTS, and the distinctions are load-bearing:
 *
 *  - **absent** — there is no contract. The operator must generate one.
 *  - **never frozen** — a draft exists but nobody committed to it. `--freeze`.
 *  - **tampered** — a frozen contract's content changed after freezing. This
 *    must NOT be reported as "not frozen yet": that wording invites the
 *    operator to freeze over the edit, which launders a tamper into a
 *    legitimate contract and destroys the only evidence that it happened.
 *    ADR-005 makes amendment the one legitimate change path, so the hint names
 *    it.
 *
 * The integrity comparison itself lives in story 2.2's `contractState`; this
 * module wraps it and never re-implements it. Two implementations of "does
 * this content match its fingerprint" would eventually disagree, and the
 * disagreement would surface as a contract that verifies in one code path and
 * reports tampering in another.
 *
 * AD-1: application layer — `domain/` and `schemas/` only, never `cli/`.
 */

import type { Contract } from '../domain/contract.js';
import { IntegrityError } from '../domain/errors.js';
import { ContractNotFrozenError, contractState } from '../schemas/contract.js';

/**
 * A contract file as the caller found it.
 *
 * `present: false` is a filesystem fact with no counterpart in story 2.2's
 * `ContractState`, which is why this type exists rather than passing a bare
 * `Contract | undefined`: the epic id and path are needed for messages in
 * exactly the case where there is no contract to read them from.
 */
export type LoadedContract =
  | { readonly present: false; readonly epic: string; readonly path: string }
  | {
      readonly present: true;
      readonly epic: string;
      readonly path: string;
      readonly contract: Contract;
    };

/** What `--status` reports: story 2.2's three states, plus `absent`. */
export type ContractStatusState = 'absent' | 'draft' | 'frozen' | 'tampered';

/**
 * The NON-THROWING query.
 *
 * `--status` must report a tampered contract as a field rather than crash, and
 * story 2.7's amend flow asks the same question before refusing. Both call
 * this; the throwing form below is for the refusal paths.
 */
export function contractStatusState(loaded: LoadedContract): ContractStatusState {
  return loaded.present ? contractState(loaded.contract) : 'absent';
}

/**
 * Refuses unless the contract is frozen AND its content still matches its
 * fingerprint.
 *
 * Returns the verified contract so a caller can use it without asking twice.
 *
 * @throws {IntegrityError} when absent or tampered.
 * @throws {ContractNotFrozenError} (a refinement of `IntegrityError`) when the
 *   contract exists but was never frozen.
 */
export function assertVerifiableContract(loaded: LoadedContract): Contract {
  if (!loaded.present) {
    throw new IntegrityError(
      `no verification contract for ${loaded.epic} (expected ${loaded.path})`,
      `generate one with 'specwitness contract ${loaded.epic}', review it, then freeze it with 'specwitness contract ${loaded.epic} --freeze'`,
    );
  }

  const state = contractState(loaded.contract);

  switch (state) {
    case 'frozen':
      return loaded.contract;

    case 'draft':
      throw new ContractNotFrozenError(
        `the contract for ${loaded.epic} has never been frozen, so it cannot gate verification`,
        `review ${loaded.path}, then freeze it with 'specwitness contract ${loaded.epic} --freeze'`,
      );

    case 'tampered':
      // Deliberately NOT ContractNotFrozenError, and deliberately not pointing
      // at --freeze: see the module header. Freezing over a tamper is what this
      // wording exists to prevent.
      throw new IntegrityError(
        `the contract for ${loaded.epic} was edited after it was frozen: its content no longer matches its stored fingerprint`,
        `inspect the change with 'git diff ${loaded.path}'; if it is legitimate, record it with 'specwitness contract ${loaded.epic} --amend', otherwise restore the reviewed version from Git`,
      );

    default: {
      // Compile-time exhaustiveness: a new ContractState must be given a
      // refusal here rather than silently falling through to "verifiable".
      const unreachable: never = state;
      return unreachable;
    }
  }
}
