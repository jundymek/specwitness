/**
 * Story 1.6 AC2 — the real implementations behind the AD-9 ports.
 *
 * These are the two modules that are ALLOWED to touch real time and real
 * randomness, so they are the only place a test may. Everything downstream
 * injects the fakes in `tests/fakes/ports.ts` instead.
 *
 * `RandomIds` takes its entropy source as a constructor parameter, so the
 * interesting behaviour — rejection sampling — is tested deterministically
 * rather than statistically.
 */

import { describe, expect, it } from 'vitest';

import { SystemClock } from '../../src/infra/clock.js';
import { RandomIds } from '../../src/infra/ids.js';
import { isRunId, makeRunId } from '../../src/domain/run-id.js';

describe('SystemClock', () => {
  it('returns a valid instant', () => {
    const now = new SystemClock().now();

    expect(now).toBeInstanceOf(Date);
    expect(Number.isNaN(now.getTime())).toBe(false);
  });

  it('tracks real time', () => {
    // A generous window: this asserts the clock is wired to the system clock,
    // not that it is precise. Tightening it would buy nothing and add flake.
    const before = Date.now();
    const now = new SystemClock().now().getTime();
    const after = Date.now();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  it('does not hand out a shared mutable Date', () => {
    const clock = new SystemClock();
    const first = clock.now();
    first.setUTCFullYear(1999);

    expect(clock.now().getUTCFullYear()).not.toBe(1999);
  });
});

describe('RandomIds', () => {
  it('returns exactly the requested number of base36 characters', () => {
    const ids = new RandomIds();

    for (const length of [1, 4, 8, 32]) {
      const value = ids.randomBase36(length);
      expect(value).toHaveLength(length);
      expect(value).toMatch(/^[0-9a-z]*$/);
    }
  });

  it('rejects a non-positive or non-integer length rather than guessing', () => {
    const ids = new RandomIds();

    expect(() => ids.randomBase36(0)).toThrow(/length/i);
    expect(() => ids.randomBase36(-1)).toThrow(/length/i);
    expect(() => ids.randomBase36(1.5)).toThrow(/length/i);
  });

  it('maps byte values onto the base36 alphabet in order', () => {
    // Bytes 0, 1, 35 -> '0', '1', 'z'. Pinning the mapping means a future
    // refactor cannot silently re-order the alphabet, which would change every
    // id the tool has ever generated.
    const ids = new RandomIds(() => Uint8Array.from([0, 1, 35]));
    expect(ids.randomBase36(3)).toBe('01z');
  });

  it('discards biased bytes instead of taking a modulo (uniformity)', () => {
    // 256 is not a multiple of 36: bytes 252-255 would map onto '0'-'3' a
    // fourth time, making those four characters ~1.4% likelier than the rest.
    // Rejection sampling must drop them and draw again.
    const scripted = [252, 253, 254, 255, 7];
    let cursor = 0;
    const ids = new RandomIds((n) => {
      const out = Uint8Array.from(scripted.slice(cursor, cursor + n));
      cursor += n;
      return out;
    });

    // The four biased bytes are discarded; only 7 -> '7' survives.
    expect(ids.randomBase36(1)).toBe('7');
    expect(cursor).toBeGreaterThan(1);
  });

  it('accepts the last unbiased byte, so rejection is not off by one', () => {
    // 251 is the largest acceptable byte (251 = 36*6 + 35 -> 'z'). Rejecting
    // it too would be a silent uniformity bug in the opposite direction.
    const ids = new RandomIds(() => Uint8Array.from([251]));
    expect(ids.randomBase36(1)).toBe('z');
  });

  it('produces varied output across many draws', () => {
    // Not a statistical test — just proof the entropy source is actually
    // consulted rather than a constant being returned.
    const ids = new RandomIds();
    const seen = new Set(Array.from({ length: 200 }, () => ids.randomBase36(4)));

    expect(seen.size).toBeGreaterThan(150);
  });
});

describe('the real ports satisfy the run-id contract', () => {
  it('mints ids that validate', () => {
    // The seam that matters: domain + infra together, with nothing faked.
    const id = makeRunId(new SystemClock(), new RandomIds());
    expect(isRunId(id)).toBe(true);
  });
});
