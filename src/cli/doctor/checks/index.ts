/**
 * The built-in checks, in report order.
 *
 * ORDER IS PART OF THE CONTRACT. It runs cheapest-and-most-fundamental first so
 * that a reader scanning the output top to bottom meets the cause before the
 * consequences: if `config-valid` failed, the base-branch and command failures
 * below it are downstream of that one problem, not four separate ones.
 *
 * REQUIRED vs OPTIONAL is the exit-code rule (AC1): a failing required check
 * makes doctor exit 3; optional checks warn and leave the code alone. The split
 * is deliberate — `playwright-capability` and `ports-free` describe conditions
 * that block *some* verification runs, and failing a diagnostic command over a
 * dev server the developer is about to stop would train people to ignore it.
 *
 * Story 2.7 appends provider checks (claude/codex discovery, non-interactive
 * mode, auth readiness, billing-risk env vars) by registering them alongside
 * these — no file in this directory changes. Deliberately, none of them is
 * stubbed here: a placeholder would be a contract nobody agreed to.
 */

import type { DoctorCheck } from '../registry.js';
import { baseBranchCheck } from './base-branch.js';
import { commandsResolvableCheck } from './commands-resolvable.js';
import { configValidCheck } from './config-valid.js';
import { gitPresentCheck } from './git-present.js';
import { nodeVersionCheck } from './node-version.js';
import { playwrightCapabilityCheck } from './playwright-capability.js';
import { portsFreeCheck } from './ports-free.js';

export const BUILTIN_CHECKS: readonly DoctorCheck[] = Object.freeze([
  nodeVersionCheck,
  gitPresentCheck,
  configValidCheck,
  baseBranchCheck,
  commandsResolvableCheck,
  playwrightCapabilityCheck,
  portsFreeCheck,
]);
