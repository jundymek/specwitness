/**
 * Project Config validity (FR-2, FR-3, required).
 *
 * The `ConfigError` message is rendered VERBATIM: story 1.3 builds it to carry
 * the dotted YAML path and the reason (`services.backend.ready.timeoutSec:
 * expected number, received string`), and re-wording it here would lose exactly
 * the information the epic's exit criteria promise. This check's job is to place
 * that message, not to improve it.
 *
 * A missing file is a required failure too, distinguished by the predicate
 * rather than by `instanceof`: the class identity is not guaranteed to survive
 * every bundling boundary, and the predicate is the form story 1.3 exports for
 * exactly this caller.
 */

import { CONFIG_RELATIVE_PATH, isMissingConfigFileError } from '../../../config/index.js';
import type { DoctorCheck } from '../registry.js';

export const configValidCheck: DoctorCheck = {
  id: 'config-valid',
  required: true,
  async run(ctx) {
    if (ctx.config.ok) {
      return { status: 'pass', detail: `${CONFIG_RELATIVE_PATH} is valid` };
    }

    const { error } = ctx.config;
    if (isMissingConfigFileError(error)) {
      return {
        status: 'fail',
        detail: `${error.message} — run 'specwitness init' to scaffold config`,
      };
    }

    return { status: 'fail', detail: error.message };
  },
};
