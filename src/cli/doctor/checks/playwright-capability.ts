/**
 * Browser-probe capability (FR-3, optional; extended by story 5.1 for AC2).
 *
 * OPTIONAL BY DESIGN. Only browser probes need Playwright, and most
 * verification runs never open a browser at all. Making this required would
 * fail doctor on projects that will never need it — the same reasoning that
 * keeps a missing agent CLI non-fatal in story 2.7 (UJ-4's edge case:
 * generation unavailable, execution still fine) — and would train people to
 * ignore the tool. `required: false` here means a `warn` never touches the exit
 * code (`render.ts#hasRequiredFailure`).
 *
 * Resolution is PROJECT-local: a `@playwright/test` hoisted into SpecWitness's
 * own dependencies must not make a target project look provisioned. Story 5.1
 * added that dependency to this repository, which is exactly the change that
 * could have broken this rule — Node's resolution walks upward through
 * `node_modules`, so a boolean "does it resolve?" would report a directory
 * nested under SpecWitness's own tree as provisioned. The rule is now enforced
 * rather than intended: `src/infra/playwright-env.ts` requires the resolved
 * package to live inside the project tree before it will call it the project's,
 * and `tests/unit/infra/playwright-env.test.ts` exercises the hazard against
 * this repository itself.
 *
 * Nothing is downloaded. Provisioning is `provisionPlaywright`'s job, this
 * command never calls it, and a diagnostic command that silently pulled
 * hundreds of megabytes would be a bad citizen.
 *
 * THREE DISTINCT FACTS, all reported (AC2):
 *
 *   SOURCE   — project · SpecWitness cache · absent
 *   VERSION  — what the resolved package declares, or `unknown`
 *   BROWSERS — whether the bundle is ACTUALLY DOWNLOADED
 *
 * The third is the one that matters most and the one a shorter check would
 * drop. A resolvable `@playwright/test` with no chromium is a real and common
 * state; calling it "present" would make doctor green immediately before a run
 * fails, which is the same green-for-nothing shape as a criterion nobody
 * adjudicated (Epic 4 retro §2 observation 2).
 *
 * `HINT:` travels ON THE DETAIL rather than through a second output channel, so
 * it reaches stderr wherever the detail does — in `--json` mode the command
 * writes the human rendering to stderr, and `ERROR:` stays reserved for errors.
 */

import type { PlaywrightEnvironment } from '../effects.js';
import type { CheckResult, DoctorCheck } from '../registry.js';

const PACKAGE = '@playwright/test';

/**
 * The command that would actually populate THIS installation's registry.
 *
 * BRANCHED BY SOURCE, because one command does not fit both. For a project's
 * own Playwright, `npx playwright install chromium` is exactly right — it is
 * their binary and their default registry. For SpecWitness's cache it is
 * ACTIVELY WRONG ADVICE: `npx` in the target project resolves some other
 * Playwright (or none), and it would download into the default `ms-playwright`
 * registry rather than the cache's `browsersPath` — leaving this check warning
 * with the operator convinced they had just fixed it. A hint that does not work
 * is worse than no hint, because it costs a round trip before it is disbelieved.
 * Reported by the codex review of this branch.
 */
function manualInstallCommand(environment: {
  readonly source: 'project' | 'specwitness-cache';
  readonly cliPath: string;
  readonly browsersPath: string;
}): string {
  if (environment.source === 'project') {
    return 'run `npx playwright install chromium`';
  }
  // The cached CLI, driven at the cache's own registry — the same invocation
  // SpecWitness makes when it provisions, so the two cannot disagree.
  //
  // SHELL-QUOTED because this is a command a human will PASTE. A macOS home
  // directory containing a space (`/Users/me/My Projects/...`) would otherwise
  // produce a line that breaks at the first word boundary — the same class of
  // defect as the hint that named the wrong binary: advice that does not work
  // costs a round trip before it is disbelieved.
  return (
    'run `PLAYWRIGHT_BROWSERS_PATH=' +
    `${shellQuote(environment.browsersPath)} node ` +
    `${shellQuote(environment.cliPath)} install chromium\``
  );
}

/**
 * POSIX single-quoting for a path that goes into DISPLAYED text.
 *
 * NOT A SECURITY CONTROL, and worth saying so plainly because it looks like
 * one: nothing built here reaches a shell. This check spawns nothing at all,
 * and AD-3 lives in `ProcessRunner`, which takes `binary` + `args[]` and never
 * a command line. The quoting exists so the operator can copy the hint and
 * have it run.
 */
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export const playwrightCapabilityCheck: DoctorCheck = {
  id: 'playwright-capability',
  required: false,
  async run(ctx): Promise<CheckResult> {
    let environment: PlaywrightEnvironment;
    try {
      environment = await ctx.effects.playwrightEnvironment(ctx.projectRoot);
    } catch (error) {
      // A probe that cannot answer is a WARN, not a fail: doctor's job is to
      // describe the environment, and an unreadable cache directory is a
      // description, not a required capability that went missing.
      return {
        status: 'warn',
        detail: `could not determine ${PACKAGE} capability: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    if (environment.source === 'absent') {
      // ALL THREE FACTS, INCLUDING HERE. AC2 asks for source, version and
      // browsers-present, and omitting two of them on an unprovisioned machine
      // makes the output incomplete at exactly the moment an operator is
      // reading it to find out what is missing. Reported by the fourth codex
      // review of this branch.
      return {
        status: 'warn',
        detail:
          `source: absent, version: unknown, browsers: absent — ${environment.reason}. ` +
          `HINT: install ${PACKAGE} in the project to use your own pinned version, or let ` +
          `SpecWitness provision one into ${environment.cacheDir} on the first browser probe ` +
          '(not required for gate, HTTP, observation or shell verification)',
      };
    }

    const where = environment.source === 'project' ? 'the project' : 'the SpecWitness cache';
    const version = environment.version ?? 'unknown';
    const preamble = `${PACKAGE} ${version} from ${where} (${environment.packageDir})`;

    if (!environment.browsersPresent) {
      return {
        status: 'warn',
        detail:
          `${preamble}; no browser bundle downloaded in ${environment.browsersPath}. ` +
          `HINT: ${manualInstallCommand(environment)}, or let SpecWitness download it on the ` +
          'first browser probe',
      };
    }

    return {
      status: 'pass',
      detail: `${preamble}; browsers present in ${environment.browsersPath}`,
    };
  },
};
