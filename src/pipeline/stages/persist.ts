/**
 * The `persist` stage — PLACEHOLDER.
 *
 * **Filled by story 3.5 (rambo), wave B.** Persisting needs `RunStore.writeResult`, which
 * does not exist until his story; his `createPersistStage(deps)` replaces the body of this
 * file. Deliberately NOT stubbed with a partial write here — a second implementation of
 * "write result.json" is exactly the kind of thing that ends up disagreeing with the real
 * one about atomicity.
 *
 * **This stage sits at position 10 of 11, and that is on purpose.** The document it writes
 * is the crash-durable snapshot: if the process is killed during teardown, or teardown
 * hangs, a complete-through-aggregate `result.json` still exists on disk. What it CANNOT
 * contain is teardown's own timeline entry or `finishedAt`, because neither exists yet.
 *
 * That gap is closed by `RunPipelineInput.onComplete`, which `runPipeline` awaits after
 * teardown with the finished `RunResult`; the CLI edge binds it to the same
 * `RunStore.writeResult` this stage calls. One writer, one serializer, two moments — and
 * because the finalize is atomic stage-and-rename, a reader always sees one complete
 * document, never a mix. Without the second write, a run that PASSed and then leaked a
 * worktree would be stored as a clean PASS, and the stored run is the only place anyone
 * would ever learn about the leak.
 */

import type { Stage } from '../stage.js';
import { createPlaceholderStage } from './placeholder.js';

export function createPersistStage(): Stage {
  return createPlaceholderStage('persist', 'story 3.5 writes result.json through RunStore');
}
