/**
 * Story 1.6 AC1 + AC2 — the canonical run-id.
 *
 * Format (spine Consistency Conventions, Identifiers row — normative):
 *   run-<YYYYMMDDTHHmmssZ>-<4 random base36>
 *
 * Every assertion here uses injected fakes, so ids are exact strings rather
 * than regex-shaped guesses (AC2: no real time or randomness in unit tests).
 */

import { describe, expect, it } from 'vitest';

import { UsageError } from '../../src/domain/errors.js';
import { isRunId, makeRunId, parseRunId, RUN_ID_SUFFIX_LENGTH } from '../../src/domain/run-id.js';
import { ConstantIds, FixedClock, SequenceIds } from '../fakes/ports.js';

describe('makeRunId (AC1, AC2)', () => {
  it('builds the exact documented id from injected time and randomness', () => {
    const clock = new FixedClock('2026-08-30T14:25:01.000Z');
    const ids = new SequenceIds('a3f9');

    // The literal from the spine's own example — not a regex match.
    expect(makeRunId(clock, ids)).toBe('run-20260830T142501Z-a3f9');
  });

  it('truncates to whole seconds rather than rounding', () => {
    // 999ms must not carry into the next second: ids are a directory name, and
    // a rounded id would disagree with the manifest's own createdAt.
    const clock = new FixedClock('2026-08-30T14:25:01.999Z');
    expect(makeRunId(clock, new SequenceIds('0000'))).toBe('run-20260830T142501Z-0000');
  });

  it('asks the Ids port for exactly the suffix width the format defines', () => {
    let requested = -1;
    const spyIds = {
      randomBase36(length: number): string {
        requested = length;
        return 'wxyz';
      },
    };

    makeRunId(new FixedClock('2026-08-30T14:25:01Z'), spyIds);

    expect(requested).toBe(RUN_ID_SUFFIX_LENGTH);
    expect(requested).toBe(4);
  });

  it('is UTC regardless of the ambient timezone', () => {
    // Asia/Kolkata is +05:30 on purpose: a naive local-time implementation
    // would shift the HOUR at a whole-hour offset too, but the :30 offset also
    // corrupts the MINUTES, so this cannot coincidentally pass.
    const original = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Kolkata';
      const clock = new FixedClock('2026-08-30T14:25:01.000Z');
      expect(makeRunId(clock, new SequenceIds('a3f9'))).toBe('run-20260830T142501Z-a3f9');
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('pads single-digit components so every id is the same width', () => {
    const clock = new FixedClock('2026-01-02T03:04:05.000Z');
    expect(makeRunId(clock, new SequenceIds('0001'))).toBe('run-20260102T030405Z-0001');
  });

  it('sorts chronologically as plain strings, which is why the format is compact', () => {
    const clock = new FixedClock(
      '2026-01-02T03:04:05Z',
      '2026-01-02T03:04:06Z',
      '2026-02-02T03:04:05Z',
      '2027-01-02T03:04:05Z',
    );
    const ids = new SequenceIds('zzzz', 'aaaa', 'mmmm', 'bbbb');

    const made = [makeRunId(clock, ids), makeRunId(clock, ids), makeRunId(clock, ids), makeRunId(clock, ids)];

    // Shuffled, then sorted lexicographically, must equal creation order —
    // note the suffixes are deliberately NOT in order, so only the timestamp
    // can be doing the sorting.
    expect([...made].reverse().sort()).toStrictEqual(made);
  });

  it('produces ids that validate and round-trip', () => {
    const id = makeRunId(new FixedClock('2026-08-30T14:25:01Z'), new SequenceIds('a3f9'));

    expect(isRunId(id)).toBe(true);
    expect(parseRunId(id).createdAt.toISOString()).toBe('2026-08-30T14:25:01.000Z');
  });

  it('fails closed when the Ids port misbehaves', () => {
    // A port returning an out-of-charset suffix would otherwise mint an id
    // that isRunId rejects — a directory we could create but never find.
    const badIds = { randomBase36: () => 'AB!9' };
    expect(() => makeRunId(new FixedClock('2026-08-30T14:25:01Z'), badIds)).toThrow(
      /suffix/i,
    );
  });

  it('fails closed when the Clock port returns an invalid date', () => {
    const badClock = { now: () => new Date(Number.NaN) };
    expect(() => makeRunId(badClock, new SequenceIds('a3f9'))).toThrow(/invalid/i);
  });
});

describe('isRunId (AC1)', () => {
  it('accepts a well-formed id', () => {
    expect(isRunId('run-20260830T142501Z-a3f9')).toBe(true);
  });

  it('accepts digits and lowercase letters across the whole base36 range', () => {
    expect(isRunId('run-20260830T142501Z-0z9a')).toBe(true);
  });

  it.each([
    ['empty string', ''],
    ['prefix missing', '20260830T142501Z-a3f9'],
    ['wrong prefix', 'runs-20260830T142501Z-a3f9'],
    ['uppercase prefix', 'RUN-20260830T142501Z-a3f9'],
    ['missing trailing Z', 'run-20260830T142501-a3f9'],
    ['lowercase z terminator', 'run-20260830T142501z-a3f9'],
    ['missing T separator', 'run-20260830142501Z-a3f9'],
    ['suffix too short', 'run-20260830T142501Z-a3f'],
    ['suffix too long', 'run-20260830T142501Z-a3f9b'],
    ['suffix uppercase', 'run-20260830T142501Z-A3F9'],
    ['suffix non-base36', 'run-20260830T142501Z-a3f_'],
    ['suffix separator inside', 'run-20260830T142501Z-a3-9'],
    ['timestamp too short', 'run-2026083T142501Z-a3f9'],
    ['timestamp too long', 'run-202608300T142501Z-a3f9'],
    ['dashes inside the timestamp', 'run-2026-08-30T142501Z-a3f9'],
    ['colons inside the timestamp', 'run-20260830T14:25:01Z-a3f9'],
    ['leading whitespace', ' run-20260830T142501Z-a3f9'],
    ['trailing whitespace', 'run-20260830T142501Z-a3f9 '],
    ['leading newline', '\nrun-20260830T142501Z-a3f9'],
    ['trailing newline', 'run-20260830T142501Z-a3f9\n'],
    ['embedded path separator', 'run-20260830T142501Z-a3f9/etc'],
    ['suffix missing entirely', 'run-20260830T142501Z'],
    ['month 00', 'run-20260030T142501Z-a3f9'],
    ['month 13', 'run-20261330T142501Z-a3f9'],
    ['day 00', 'run-20260800T142501Z-a3f9'],
    ['day 32', 'run-20260832T142501Z-a3f9'],
    ['hour 24', 'run-20260830T242501Z-a3f9'],
    ['minute 60', 'run-20260830T146001Z-a3f9'],
    ['second 60', 'run-20260830T142560Z-a3f9'],
    ['31 February', 'run-20260231T142501Z-a3f9'],
    ['29 February in a common year', 'run-20260229T142501Z-a3f9'],
  ])('rejects %s', (_label, value) => {
    expect(isRunId(value)).toBe(false);
  });

  it('accepts 29 February in a leap year', () => {
    // The calendar check must be real, not a 1..31 range test.
    expect(isRunId('run-20240229T142501Z-a3f9')).toBe(true);
  });

  it('rejects an unbounded digit run without any numeric parsing', () => {
    // Number.parseInt saturates past 2^53-1 (bob hit this in domain/ids.ts,
    // where two different epics normalised to one canonical id). Fixed-width
    // anchored matching makes that path unreachable here: this string is
    // rejected on shape, long before anything converts it to a number.
    const absurd = `run-${'9'.repeat(500)}T142501Z-a3f9`;
    expect(isRunId(absurd)).toBe(false);
    expect(() => parseRunId(absurd)).toThrow(UsageError);
  });

  it('rejects a path-traversal attempt, since run ids become directory names', () => {
    expect(isRunId('../../etc/passwd')).toBe(false);
    expect(isRunId('run-20260830T142501Z-a3f9/../..')).toBe(false);
  });
});

describe('parseRunId (AC1)', () => {
  it('returns the timestamp text, the instant, and the suffix', () => {
    const parsed = parseRunId('run-20260830T142501Z-a3f9');

    expect(parsed.timestamp).toBe('20260830T142501Z');
    expect(parsed.suffix).toBe('a3f9');
    expect(parsed.createdAt.toISOString()).toBe('2026-08-30T14:25:01.000Z');
  });

  it('round-trips every id makeRunId produces', () => {
    const clock = new FixedClock('2026-01-02T03:04:05Z', '2027-12-31T23:59:59Z');
    const ids = new SequenceIds('0000', 'zzzz');

    for (const _ of [0, 1]) {
      const id = makeRunId(clock, ids);
      const parsed = parseRunId(id);
      expect(makeRunId(new FixedClock(parsed.createdAt), new ConstantIds(parsed.suffix))).toBe(id);
    }
  });

  it('throws UsageError naming the value, so the CLI can exit 64', () => {
    // Not InfraError: a malformed id is the caller's typo, and exit 3 would
    // wrongly tell a harness that rerunning might help.
    expect(() => parseRunId('nonsense')).toThrow(UsageError);
    expect(() => parseRunId('nonsense')).toThrow(/nonsense/);
  });

  it('carries a hint, per house error style', () => {
    try {
      parseRunId('nonsense');
      expect.unreachable('parseRunId must reject a malformed id');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as UsageError).hint).toMatch(/run-/);
    }
  });
});
