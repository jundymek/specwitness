/**
 * The `integrity` stage — FR-9 at run time.
 *
 * **It precedes `worktree`, and that ordering is the point.** A contract whose content no
 * longer matches its fingerprint costs nothing to reject: no worktree is created, no
 * process is spawned, nothing is written. `tests/unit/pipeline/stages/integrity.test.ts`
 * proves that mechanically by injecting a `ProcessRunner` that throws on any call and
 * asserting it was never reached — not in prose, where it would rot.
 *
 * **It CALLS the merged guard; it does not re-implement it.** `assertVerifiableContract`
 * (story 2.6) already refuses absent, never-frozen and tampered contracts with three
 * distinct hints, and `contractState` is the single integrity comparison. Two
 * implementations of "does this content match its fingerprint" would eventually disagree,
 * and the disagreement would surface as a contract that verifies in one code path and
 * reports tampering in another.
 *
 * **How the guard gets here, and why it is not imported.** `assertVerifiableContract`
 * lives in `src/authoring/`, and `src/pipeline/**` may not import another application
 * layer (AD-1; the `pipeline-layer` rule enforces it). The spine's own answer is the one
 * taken here: the CLI edge loads and verifies, exactly as config is "loaded once,
 * validated, passed down", and hands the result in. So this stage takes a GUARD FUNCTION,
 * and story 3.7 binds it:
 *
 *     createIntegrityStage(() => assertVerifiableContract(loaded))
 *
 * The three refusals travel unchanged through `runPipeline`'s AD-7 classification to
 * `{infraError: 'integrity'}` and exit 3, with their hints intact — including the one
 * that must never be reported as "not frozen yet", because that wording invites an
 * operator to freeze over a tamper and destroy the only evidence it happened.
 */

import type { Contract } from '../../domain/contract.js';
import { IntegrityError } from '../../domain/errors.js';
import type { Stage } from '../stage.js';
import { stageOk } from '../stage.js';

/**
 * Returns the verified contract, or throws.
 *
 * Bound by the caller to `assertVerifiableContract(loaded)`. Its contract is the guard's:
 * `IntegrityError` when the contract is absent or tampered, `ContractNotFrozenError` (a
 * refinement of the same) when it was never frozen.
 */
export type VerifiableContractGuard = () => Contract;

export function createIntegrityStage(guard: VerifiableContractGuard): Stage {
  return {
    name: 'integrity',
    run: async (context) => {
      const contract = guard();

      if (contract.spec.epic !== context.run.epic) {
        // Verifying one epic against another epic's contract would produce a fully
        // plausible report about the wrong expectations — the most expensive kind of
        // wrong answer this product can give, because nothing about it looks broken.
        throw new IntegrityError(
          `the contract at hand is for ${contract.spec.epic}, but this run is verifying ${context.run.epic}`,
          `run 'specwitness verify ${context.run.epic}' against that epic's own contract`,
        );
      }

      const { fingerprint, frozenAt } = contract.meta;
      if (fingerprint === null || frozenAt === null) {
        // Unreachable through the merged guard, which only returns frozen contracts.
        // Checked anyway, and loudly: the alternative is a `!` assertion that turns a
        // future change in the guard into a `null` in a persisted report.
        throw new IntegrityError(
          `the contract for ${contract.spec.epic} passed the verifiability guard without a fingerprint`,
          'this is a defect in the contract guard, not in your project — please report it',
        );
      }

      // Recorded so that nothing downstream — no stage, and above all no renderer —
      // re-reads the contract file (AD-11). The PRESENCE of `contract` on the result is
      // what tells a reader the fingerprint was valid.
      context.run.contract = {
        epic: contract.spec.epic,
        version: contract.spec.version,
        fingerprint,
        frozenAt,
        amendments: contract.meta.history.length,
        criterionCount: contract.spec.criteria.length,
      };

      context.run.contractCriteria = contract.spec.criteria.map((criterion) => ({
        criterionId: criterion.id,
        statement: criterion.statement,
        severity: criterion.severity,
      }));

      return stageOk(
        `${contract.spec.epic} v${contract.spec.version} verified against its fingerprint ` +
          `(${contract.spec.criteria.length} criteria)`,
      );
    },
  };
}
