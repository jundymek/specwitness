/**
 * `specwitness report <run-id>` — story 1.6 (AC3).
 *
 * Scope is deliberately narrow. This locates a stored run through `RunStore`
 * and renders its manifest metadata, proving that runs persisted by story 1.6
 * are findable and readable. Full rendering arrives in Epic 3, from the single
 * `RunResult` domain object (AD-11).
 *
 * Explicitly NOT here, and each for a reason:
 *
 *  - **`--json`.** Epic 3 derives JSON from `RunResult`, and every renderer
 *    reads from that one model (AD-11). Inventing a partial JSON shape now
 *    would publish a schema the harness could start parsing, which Epic 3
 *    would then have to break.
 *  - **`report <epic>`** (rendering the latest run of an epic) — story 3.5.
 *  - **Any writing.** `report` is a pure read: it creates no directory, not
 *    even the runs root, and not even when the project has never been
 *    initialised.
 *
 * AD-1: this is the edge, so it may reach into `infra`. Nothing beneath the
 * CLI may import back the other way.
 */

import type { Command } from 'commander';

import { InfraError } from '../../domain/errors.js';
import { parseRunId } from '../../domain/run-id.js';
import { SystemClock } from '../../infra/clock.js';
import { RandomIds } from '../../infra/ids.js';
import { RunStore } from '../../infra/run-store.js';

export function register(program: Command): void {
  program
    .command('report')
    .description('render a stored run')
    .argument('<run-id>', 'id of a stored run, e.g. run-20260830T142501Z-a3f9')
    .action(async (runId: string) => {
      process.stdout.write(await renderRun(process.cwd(), runId));
    });
}

/**
 * Builds the report text for one stored run.
 *
 * Returns a string rather than printing, so the rendering is testable without
 * capturing stdout and so Epic 3 can reuse the shape.
 */
async function renderRun(projectRoot: string, runId: string): Promise<string> {
  // Validate the id FIRST, before touching the filesystem. A typo is a usage
  // error (exit 64); reporting it as exit 3 would tell a harness the
  // environment is broken and that retrying might help.
  parseRunId(runId);

  const store = new RunStore(projectRoot, new SystemClock(), new RandomIds());

  if (!store.isInitialized()) {
    throw new InfraError(
      `this project is not initialised for SpecWitness (no .specwitness directory in ${projectRoot})`,
      "run 'specwitness init' first, or change to the project root",
    );
  }

  const manifest = await store.readManifest(runId);
  const hasResult = await store.hasResult(runId);

  const lines = [
    `Run:      ${manifest.runId}`,
    `Created:  ${manifest.createdAt}`,
    `Epic:     ${manifest.epic ?? '(none)'}`,
    `Reaped:   ${manifest.reaped ? 'yes' : 'no'}`,
    `Result:   ${
      hasResult
        ? 'result.json is present (full rendering arrives in Epic 3)'
        : 'no result yet — run verification arrives in Epic 3'
    }`,
  ];

  return `${lines.join('\n')}\n`;
}
