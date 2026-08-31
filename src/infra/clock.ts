/**
 * The real `Clock` (AD-9).
 *
 * Trivial by design. Its whole job is to be the ONE place `new Date()` is
 * called on the run path, so every other module can be tested with a fake and
 * no test ever depends on what time it is.
 *
 * Precision note: this returns full millisecond precision. Run ids truncate to
 * whole seconds themselves (`makeRunId`), while manifests keep everything —
 * two different needs, one clock, the truncation living with the format that
 * requires it rather than being baked in here.
 */

import type { Clock } from '../domain/ports.js';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
