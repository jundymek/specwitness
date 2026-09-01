/**
 * The `persist` stage — story 3.5 (AC1).
 *
 * Takes the run so far and hands it to the writer. That is the whole stage: no rendering,
 * no printing, no exit codes, and no opinion about the outcome — `aggregate` is the only
 * stage that decides one (AD-6), and persistence must never become a second place where
 * the meaning of a run can change.
 *
 * **POSITION 10 OF 11, AND THAT IS ON PURPOSE.** What this writes is the crash-durable
 * snapshot: if the process is killed during teardown, or teardown hangs, a
 * complete-through-aggregate `result.json` still exists on disk. What it CANNOT contain is
 * teardown's own timeline entry or the real `finishedAt`, because neither exists yet —
 * `context.snapshot()` reports `teardown` as `skipped`, honestly, and this stage does not
 * dress that up. A snapshot that predicted a teardown which had not happened would be a
 * crash-durable falsehood, which is worse than no snapshot at all.
 *
 * That gap is closed by `RunPipelineInput.onComplete`, which the runner awaits after
 * teardown with the finished `RunResult`; the CLI edge binds it to the same
 * `RunStore.writeResult` this stage calls. One writer, one serializer, two moments — and
 * because the finalize is atomic stage-and-rename, a reader always sees one complete
 * document, never a mix.
 *
 * **A DURABILITY FAILURE HERE MUST NOT REWRITE A DECIDED VERDICT.** A run that FAILed on a
 * gate and then could not write `result.json` is still a FAIL, and still exits 1. Exit 3
 * would tell a harness "the environment is broken, retry" — and the retry merges a branch
 * that does not build. So this stage lets the error propagate as the AD-7 error it is, and
 * the runner records it on this stage's timeline entry without touching the outcome. The
 * failure ends up visible without being fatal to the product answer.
 *
 * AD-8: `RunStore` is the sole writer under `.specwitness/runs/`. This stage takes a
 * NARROW FUNCTION PORT rather than the store itself, so no path under that directory is
 * constructible from `src/pipeline/**` — the sole-writer rule then holds by construction
 * rather than by review, and this stage cannot address a run other than the one it was
 * given.
 */

import type { RunResult } from '../../domain/run-result.js';
import type { Stage } from '../stage.js';
import { stageOk } from '../stage.js';

/**
 * Durably stores one run's result.
 *
 * Bound by the CLI edge to `RunStore.writeResult`. A function rather than the store,
 * because this stage needs exactly one capability and handing it the whole store would let
 * a later edit reach the manifest, the evidence files, or another run's directory.
 */
export type RunResultWriter = (runId: string, result: RunResult) => Promise<FinalizeWrite>;

/**
 * What the writer reports back.
 *
 * `durable: false` means the document WAS published and only the durability barrier after
 * the rename did not complete. That is a distinct, non-fatal condition: the stage stays
 * `ok` and records the barrier in its detail, because reporting a committed write as a
 * failure would tell an operator nothing changed when the file has in fact been replaced.
 * A write that genuinely did not happen throws instead, and never reaches here.
 */
export interface FinalizeWrite {
  readonly durable: boolean;
  readonly barrier?: string;
}

export interface PersistDeps {
  readonly writeResult?: RunResultWriter;
}

/**
 * @param deps the writer, injected. Absent only in tests and in a pipeline assembled
 * before the CLI edge binds one — in which case the stage records plainly that nothing
 * was stored rather than reporting a clean `ok`. A run that persisted nothing must never
 * look like a run that persisted something: the detail is itself persisted and rendered,
 * so the gap shows up exactly where a reader would look for it.
 */
export function createPersistStage(deps: PersistDeps = {}): Stage {
  return {
    name: 'persist',
    run: async (context) => {
      const { writeResult } = deps;
      if (writeResult === undefined) {
        return stageOk('no run-result writer configured — nothing was persisted');
      }

      // `snapshot()` throws if the outcome has not been decided. From position 10 that
      // cannot happen, and letting it throw rather than defending against it is the point:
      // a "result" carrying neither a verdict nor an infra error is not a result, and
      // fabricating one would put an outcome nobody decided into a run directory.
      const written = await writeResult(context.runId, context.snapshot());

      if (!written.durable) {
        // Published, but the durability barrier did not complete. `ok`, not `error`: the
        // document is on disk and readable, and calling this a failure is precisely the
        // lie the Epic 2 retrospective recorded. The detail is persisted and rendered, so
        // the operator learns the barrier failed without the run's conclusion changing.
        return stageOk(
          `result.json written, but not confirmed durable: ${written.barrier ?? 'unknown'}`,
        );
      }

      return stageOk('result.json written');
    },
  };
}
