/**
 * AD-9 fakes for the `Clock` and `Ids` ports.
 *
 * AC2 of story 1.6 is explicit: no real time and no real randomness in unit
 * tests, ever. These make run-id construction fully deterministic, so tests
 * assert on exact id strings rather than on a regex that would also accept a
 * wrong id.
 *
 * They live under `tests/` rather than `src/` deliberately — a fake shipped in
 * the published package is a fake somebody eventually injects in production.
 */

import type { Clock, Ids } from '../../src/domain/ports.js';

/** A `Clock` frozen at one instant, or stepping through a fixed sequence. */
export class FixedClock implements Clock {
  readonly #instants: readonly Date[];
  #index = 0;

  /**
   * @param instants One or more instants. With a single instant the clock is
   * frozen; with several, each `now()` advances to the next and the last one
   * repeats forever (so a test never fails merely by calling `now()` again).
   */
  constructor(...instants: readonly (Date | string)[]) {
    if (instants.length === 0) {
      throw new Error('FixedClock needs at least one instant');
    }
    this.#instants = instants.map((i) => (typeof i === 'string' ? new Date(i) : i));
  }

  now(): Date {
    const instant = this.#instants.at(Math.min(this.#index, this.#instants.length - 1));
    if (instant === undefined) {
      throw new Error('FixedClock exhausted');
    }
    this.#index += 1;
    // A fresh Date each call: handing out the same mutable instance would let
    // one test mutate another's expectations.
    return new Date(instant.getTime());
  }
}

/**
 * An `Ids` port yielding a scripted sequence of suffixes.
 *
 * Cycles once exhausted, so a test that creates more runs than it scripted
 * gets repeats — which is also how the run-id collision path gets exercised.
 */
export class SequenceIds implements Ids {
  readonly #values: readonly string[];
  #index = 0;

  constructor(...values: readonly string[]) {
    if (values.length === 0) {
      throw new Error('SequenceIds needs at least one value');
    }
    this.#values = values;
  }

  randomBase36(length: number): string {
    const value = this.#values.at(this.#index % this.#values.length);
    if (value === undefined) {
      throw new Error('SequenceIds exhausted');
    }
    this.#index += 1;
    if (value.length !== length) {
      // Catches a test scripting a suffix of the wrong width, which would
      // otherwise surface as a confusing "malformed run id" much later.
      throw new Error(`SequenceIds was asked for ${length} chars but scripted '${value}'`);
    }
    return value;
  }
}

/** An `Ids` port that always returns the same suffix — for collision tests. */
export class ConstantIds implements Ids {
  constructor(private readonly value: string) {}

  randomBase36(length: number): string {
    if (this.value.length !== length) {
      throw new Error(`ConstantIds holds ${this.value.length} chars, asked for ${length}`);
    }
    return this.value;
  }
}
