/**
 * zod mirrors of the closed domain enums (AD-6).
 *
 * Every schema here is DERIVED from the domain's `as const` array rather than
 * re-listing the literals. Divergence between the zod schemas and the domain
 * unions is a named failure mode for this taxonomy — deriving one from the
 * other makes it impossible rather than merely unlikely, and
 * `tests/unit/schemas-enums.test.ts` asserts the derivation still holds.
 *
 * Later artifact schemas (Epic 2+: contract, plan, run manifest, JSON report)
 * compose these instead of writing their own enums.
 *
 * AD-1: zod lives here and never in `src/domain` — the domain core stays plain,
 * dependency-free TypeScript.
 */

import { z } from 'zod';

import { KINDS, SEVERITIES, VERIFIABILITIES } from '../domain/contract.js';
import { CRITERION_STATUSES, GATE_STATUSES, NEEDS_HUMAN_REASONS } from '../domain/result.js';
import { INFRA_ERROR_CLASSIFICATIONS, VERDICTS } from '../domain/run-outcome.js';

/** `pass | fail | needs_human | skipped | error` */
export const CriterionStatusSchema = z.enum(CRITERION_STATUSES);

/** `pass | fail | skipped` */
export const GateStatusSchema = z.enum(GATE_STATUSES);

/** `PASS | FAIL | NEEDS_HUMAN` */
export const VerdictSchema = z.enum(VERDICTS);

/** `config | ingest | integrity | provider | infra` (never `usage` — see run-outcome.ts). */
export const InfraErrorClassificationSchema = z.enum(INFRA_ERROR_CLASSIFICATIONS);

/**
 * The contract vocabularies (AD-5), added by story 2.2 — the same derivation
 * discipline as everything above. Story 2.6 composes its provider-response
 * schema from these rather than re-listing the literals: a draft whose `kind`
 * the model invented must be rejected by the gate, not written into a
 * fingerprinted file.
 */

/** `behavioral | integration | invariant | security | structural | performance | human` */
export const KindSchema = z.enum(KINDS);

/** `critical | normal` */
export const SeveritySchema = z.enum(SEVERITIES);

/** `automated | human` */
export const VerifiabilitySchema = z.enum(VERIFIABILITIES);

/**
 * `human-verifiability | not-safely-automatable` — Q39's two, and only two, NEEDS_HUMAN
 * triggers, both compile-time (`domain/plan.ts:102-127`).
 *
 * Added by story 5.3, which carries the reason into the persisted result so a reviewer is
 * told WHY a criterion is theirs to answer. Closed for the reason the taxonomy is closed:
 * a third value arriving through a stored document would be a third trigger entering by
 * the back door, and execution-time uncertainty is `error`, never `needs_human`.
 */
export const NeedsHumanReasonSchema = z.enum(NEEDS_HUMAN_REASONS);
