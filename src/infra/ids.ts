/**
 * The real `Ids` port (AD-9) — cryptographic randomness rendered as base36.
 *
 * Uses `node:crypto` rather than `Math.random()`. Run ids are not a security
 * boundary, but they are a collision boundary: `Math.random()` is seeded per
 * process and two `specwitness verify` runs starting in the same second (a
 * normal thing for a harness verifying several epics) are exactly the case
 * where a weak generator produces a duplicate.
 *
 * The entropy source is injectable so the interesting behaviour — rejection
 * sampling — can be tested deterministically instead of statistically.
 */

import { randomBytes as nodeRandomBytes } from 'node:crypto';

import type { Ids } from '../domain/ports.js';

/** Digits then lowercase letters: index === the base36 value. */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * The largest byte value that can be reduced modulo 36 without bias.
 *
 * 256 = 36 * 7 + 4, so bytes 252-255 would map onto '0'-'3' a seventh time
 * while every other character gets six chances. Dropping them costs ~1.6% of
 * draws and makes the distribution exactly uniform.
 */
const UNBIASED_CEILING = Math.floor(256 / ALPHABET.length) * ALPHABET.length; // 252

type RandomBytes = (size: number) => Uint8Array;

export class RandomIds implements Ids {
  readonly #randomBytes: RandomBytes;

  constructor(randomBytes: RandomBytes = nodeRandomBytes) {
    this.#randomBytes = randomBytes;
  }

  randomBase36(length: number): string {
    if (!Number.isInteger(length) || length < 1) {
      throw new RangeError(`random id length must be a positive integer, got ${length}`);
    }

    let out = '';
    while (out.length < length) {
      // Over-draw slightly so the common case is a single call: on average
      // ~1.6% of bytes are discarded, so asking for the shortfall plus a
      // little slack almost always finishes in one round.
      const wanted = length - out.length;
      const bytes = this.#randomBytes(wanted + 8);

      for (const byte of bytes) {
        if (byte >= UNBIASED_CEILING) {
          continue; // biased tail — draw again rather than skew the alphabet
        }
        out += ALPHABET[byte % ALPHABET.length];
        if (out.length === length) {
          break;
        }
      }
    }

    return out;
  }
}
