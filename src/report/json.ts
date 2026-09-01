/**
 * The machine-readable report (FR-30, AC2). Story 3.6.
 *
 * This module is one line long, and that is the design rather than an
 * accident.
 *
 * `--json` must put on stdout **the same document** that is persisted as
 * `.specwitness/runs/<run-id>/result.json` (Q53, Q55) — byte for byte, because
 * a harness may diff, hash or cache it. That property is reachable only if
 * exactly one function turns a `RunResult` into bytes. Story 3.5 owns that
 * function: `serializeRunResult` in `src/schemas/result.ts`, called by
 * `RunStore` when it persists and called here when `--json` renders. Any
 * transformation added in this file — a re-indent, a key reorder, a trailing
 * newline "for tidiness" — would make a second byte sequence, and the two
 * would drift the first time either side changed.
 *
 * Where the serializer lives is not a preference either. `src/report/**` may
 * not import `src/infra/**` (the `report-layer` rule), so a serializer inside
 * `run-store.ts` would be one this module could not legally call — and the
 * only way to satisfy `--json` would then be to write a second serializer,
 * which is exactly what guarantees the drift. `src/schemas/` is the layer both
 * callers can reach.
 *
 * `schemaVersion` is contributed by that serializer, not here: pamela's
 * `RunResult` is deliberately version-free because the version belongs to the
 * persisted document rather than to the in-memory model (AD-5).
 */

import type { RunResult } from '../domain/run-result.js';
import { serializeRunResult } from '../schemas/result.js';

/**
 * The JSON report: exactly the bytes of the persisted `result.json`.
 *
 * Returns a string and prints nothing, so the caller owns stream discipline —
 * under `--json` this is the whole of stdout, and every human line goes to
 * stderr (the merged `src/cli/commands/doctor.ts` is the precedent). A single
 * stray write would break `JSON.parse` for every consumer.
 */
export function renderJson(result: RunResult): string {
  return serializeRunResult(result);
}
