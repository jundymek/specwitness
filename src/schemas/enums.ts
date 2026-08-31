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

import { CRITERION_STATUSES, GATE_STATUSES } from '../domain/result.js';
import { INFRA_ERROR_CLASSIFICATIONS, VERDICTS } from '../domain/run-outcome.js';

/** `pass | fail | needs_human | skipped | error` */
export const CriterionStatusSchema = z.enum(CRITERION_STATUSES);

/** `pass | fail | skipped` */
export const GateStatusSchema = z.enum(GATE_STATUSES);

/** `PASS | FAIL | NEEDS_HUMAN` */
export const VerdictSchema = z.enum(VERDICTS);

/** `config | ingest | integrity | provider | infra` (never `usage` — see run-outcome.ts). */
export const InfraErrorClassificationSchema = z.enum(INFRA_ERROR_CLASSIFICATIONS);
