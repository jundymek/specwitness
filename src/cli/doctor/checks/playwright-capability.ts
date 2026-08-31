/**
 * Browser-probe capability (FR-3, optional).
 *
 * OPTIONAL BY DESIGN. Only browser probes need Playwright, those arrive in Epic
 * 5, and most verification runs never open a browser at all. Making this
 * required would fail doctor on projects that will never need it — the same
 * reasoning that keeps a missing agent CLI non-fatal in story 2.7 (UJ-4's edge
 * case: generation unavailable, execution still fine).
 *
 * Resolution is PROJECT-local: a `@playwright/test` hoisted into SpecWitness's
 * own dependencies must not make a target project look provisioned. Nothing is
 * downloaded — provisioning browsers is story 5.1's job, and a diagnostic
 * command that silently pulls hundreds of megabytes would be a bad citizen.
 */

import type { DoctorCheck } from '../registry.js';

const PACKAGE = '@playwright/test';

export const playwrightCapabilityCheck: DoctorCheck = {
  id: 'playwright-capability',
  required: false,
  async run(ctx) {
    if (ctx.effects.resolvesFrom(PACKAGE, ctx.projectRoot)) {
      return { status: 'pass', detail: `${PACKAGE} resolves from the project` };
    }

    return {
      status: 'warn',
      detail: `${PACKAGE} does not resolve from this project; browser probes will need it provisioned (not required for gate or HTTP verification)`,
    };
  },
};
