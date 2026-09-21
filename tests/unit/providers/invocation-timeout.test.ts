import { describe, expect, it } from 'vitest';

import { invocationTimeoutMs } from '../../../src/providers/claude-code-cli.js';

/**
 * The numbers here are the two real calibrations and the run that outgrew the
 * second one, so a future edit can see what the function is answering to:
 *
 *   - 5 minutes was right until a 40-criterion contract (2026-09-05).
 *   - 15 minutes was right until tenstandard's epic 6, whose contract carries
 *     **91** criteria: plan compilation failed three times, each attempt
 *     spending ~20 minutes before dying on the same wall.
 *
 * A third constant would have met the same end, which is why the bound now
 * follows the declared size of the work.
 */

const BASE = 900_000; // the configured base: 15 minutes

describe('invocationTimeoutMs', () => {
  it('returns the base unchanged when a request declares no size', () => {
    expect(invocationTimeoutMs(BASE, undefined)).toBe(BASE);
  });

  it('gives a 91-criterion contract materially more than the base', () => {
    const scaled = invocationTimeoutMs(BASE, 91);

    expect(scaled).toBeGreaterThan(BASE);
    // 15 min + 91 × 12 s ≈ 33 minutes — comfortably past the ~20 minutes each
    // failed attempt was taking.
    expect(scaled).toBe(BASE + 91 * 12_000);
  });

  it('grows with the work, so a bigger contract gets more time', () => {
    expect(invocationTimeoutMs(BASE, 91)).toBeGreaterThan(invocationTimeoutMs(BASE, 40));
    expect(invocationTimeoutMs(BASE, 40)).toBeGreaterThan(invocationTimeoutMs(BASE, 5));
  });

  it('stays bounded, because an unbounded bound is not one', () => {
    // A wedged CLI must still surface as a timeout rather than as a process
    // nobody is watching.
    expect(invocationTimeoutMs(BASE, 100_000)).toBe(3_600_000);
  });

  it('ignores sizes that cannot be work', () => {
    for (const nonsense of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(invocationTimeoutMs(BASE, nonsense)).toBe(BASE);
    }
  });

  it('rounds a fractional size up rather than truncating toward zero', () => {
    expect(invocationTimeoutMs(BASE, 1.2)).toBe(BASE + 2 * 12_000);
  });
});
