/**
 * Node runtime floor (FR-3, required).
 *
 * >=22.12 is a reviewed decision, not a preference: Node 20 is EOL, and
 * commander 15, execa 10 and dependency-cruiser 18 all require it. `engines`
 * makes npm complain at install time; this check makes it legible at diagnosis
 * time, which is the difference between a warning nobody read and an answer.
 */

import type { DoctorCheck } from '../registry.js';

const REQUIRED: readonly [number, number] = [22, 12];
const REQUIRED_TEXT = `${REQUIRED[0]}.${REQUIRED[1]}`;

/** `v22.20.0` / `22.20.0-nightly` -> `[22, 20, 0]`. */
function parseVersion(raw: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (match === null) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export const nodeVersionCheck: DoctorCheck = {
  id: 'node-version',
  required: true,
  async run(ctx) {
    const parsed = parseVersion(ctx.nodeVersion);
    if (parsed === undefined) {
      return {
        status: 'fail',
        detail: `cannot parse the running Node version "${ctx.nodeVersion}"; SpecWitness requires Node >=${REQUIRED_TEXT}`,
      };
    }

    const [major, minor, patch] = parsed;
    // Numeric comparison on purpose: lexicographically 'v22.9.0' sorts above
    // 'v22.12.0', so a string compare would pass a runtime that is too old.
    const satisfied = major > REQUIRED[0] || (major === REQUIRED[0] && minor >= REQUIRED[1]);

    if (!satisfied) {
      return {
        status: 'fail',
        detail: `Node ${major}.${minor}.${patch} is below the required >=${REQUIRED_TEXT}; upgrade Node (nvm install ${REQUIRED_TEXT})`,
      };
    }

    return { status: 'pass', detail: `Node ${major}.${minor}.${patch} (>=${REQUIRED_TEXT})` };
  },
};
