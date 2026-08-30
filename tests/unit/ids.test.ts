import { describe, expect, it } from 'vitest';

import { UsageError } from '../../src/domain/errors.js';
import {
  buildCriterionId,
  isCriterionId,
  normalizeEpicId,
  parseCriterionId,
} from '../../src/domain/ids.js';
import { EXIT, exitCodeForError } from '../../src/cli/exit.js';

describe('normalizeEpicId — the single implementation (Consistency Conventions)', () => {
  it.each([
    ['7', 'epic-7'],
    ['epic-7', 'epic-7'],
    ['epic-07', 'epic-7'],
    ['07', 'epic-7'],
    ['EPIC-7', 'epic-7'],
    ['Epic-07', 'epic-7'],
    ['  7  ', 'epic-7'],
    ['epic-0007', 'epic-7'],
    ['1', 'epic-1'],
    ['epic-42', 'epic-42'],
    ['100', 'epic-100'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeEpicId(input)).toBe(expected);
  });

  it('is idempotent', () => {
    for (const input of ['7', 'epic-07', 'EPIC-7', '  07 ']) {
      const once = normalizeEpicId(input);
      expect(normalizeEpicId(once)).toBe(once);
    }
  });

  it.each([
    ['', 'empty string'],
    ['   ', 'whitespace only'],
    ['0', 'epic zero'],
    ['epic-0', 'prefixed epic zero'],
    ['-1', 'negative'],
    ['7.5', 'non-integer'],
    ['seven', 'word'],
    ['epic-', 'prefix with no number'],
    ['epic-x', 'prefix with non-digits'],
    ['e7', 'wrong prefix'],
    ['epic7', 'missing separator'],
    ['epic-7-1', 'trailing segment'],
    ['7 8', 'two numbers'],
    ['+7', 'explicit sign'],
    ['٧', 'non-ASCII digit'],
  ])('rejects %j (%s) with a UsageError', (input) => {
    expect(() => normalizeEpicId(input)).toThrow(UsageError);
  });

  it('attaches a HINT to the rejection and maps to exit 64 (ADR-002)', () => {
    try {
      normalizeEpicId('seven');
      expect.unreachable('normalizeEpicId should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      const usageError = err as UsageError;
      expect(usageError.hint).toBeDefined();
      expect(usageError.hint).not.toBe('');
      expect(usageError.message).toContain('seven');
      expect(exitCodeForError(usageError)).toBe(EXIT.USAGE);
    }
  });

  it('is pure: repeated calls return the same value', () => {
    expect(normalizeEpicId('epic-07')).toBe(normalizeEpicId('epic-07'));
  });

  it('rejects epic numbers beyond the safe integer range rather than colliding', () => {
    // 2^53 and 2^53+1 both parse to 9007199254740992. Silently normalising two
    // DIFFERENT epics to one canonical id would make the gate verify the wrong
    // epic's contract — the one failure this module exists to prevent.
    expect(() => normalizeEpicId('9007199254740993')).toThrow(UsageError);
    expect(() => normalizeEpicId('epic-9007199254740993')).toThrow(UsageError);
  });

  it('never emits a canonical id containing Infinity', () => {
    // A long digit string overflows to Infinity, yielding the malformed id
    // 'epic-Infinity'.
    expect(() => normalizeEpicId('9'.repeat(1000))).toThrow(UsageError);
    for (const input of ['9007199254740993', '9'.repeat(1000), '1'.repeat(40)]) {
      let normalized: string | undefined;
      try {
        normalized = normalizeEpicId(input);
      } catch {
        continue; // rejected, which is the point
      }
      expect(normalized).not.toContain('Infinity');
    }
  });

  it('still accepts the largest safe epic number', () => {
    expect(normalizeEpicId('9007199254740991')).toBe('epic-9007199254740991');
  });

  it('normalizes distinct inputs to distinct canonical ids', () => {
    const inputs = ['1', '2', '7', '42', '9007199254740991'];
    const canonical = inputs.map((input) => normalizeEpicId(input));
    expect(new Set(canonical).size).toBe(inputs.length);
  });
});

describe('criterion ids — canonical format E<n>-<NN>', () => {
  it.each([
    [7, 1, 'E7-01'],
    [7, 9, 'E7-09'],
    [7, 10, 'E7-10'],
    [1, 1, 'E1-01'],
    [12, 3, 'E12-03'],
    [7, 100, 'E7-100'],
  ])('builds criterion id for epic %i sequence %i as %j', (epic, sequence, expected) => {
    expect(buildCriterionId(epic, sequence)).toBe(expected);
  });

  it('does not zero-pad the epic number (E7-01, never E07-01)', () => {
    expect(buildCriterionId(7, 1)).toBe('E7-01');
    expect(buildCriterionId(7, 1)).not.toBe('E07-01');
  });

  it.each([
    ['E7-01', true],
    ['E1-01', true],
    ['E12-03', true],
    ['E7-100', true],
    ['E07-01', false],
    ['E7-1', false],
    ['7-01', false],
    ['e7-01', false],
    ['E7_01', false],
    ['E-01', false],
    ['E7-', false],
    ['E0-01', false],
    ['E7-00', false],
    ['', false],
    ['E7-01 ', false],
  ])('validates %j as %s', (value, expected) => {
    expect(isCriterionId(value)).toBe(expected);
  });

  it('round-trips build and parse', () => {
    for (const [epic, sequence] of [
      [7, 1],
      [1, 42],
      [12, 3],
      [7, 100],
    ] as const) {
      expect(parseCriterionId(buildCriterionId(epic, sequence))).toEqual({
        epicNumber: epic,
        sequence,
      });
    }
  });

  it('rejects malformed criterion ids with a UsageError carrying a hint', () => {
    expect(() => parseCriterionId('E07-1')).toThrow(UsageError);
    try {
      parseCriterionId('nope');
      expect.unreachable('parseCriterionId should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as UsageError).hint).toBeDefined();
      expect(exitCodeForError(err)).toBe(EXIT.USAGE);
    }
  });

  it('rejects out-of-range build inputs rather than emitting a malformed id', () => {
    expect(() => buildCriterionId(0, 1)).toThrow(UsageError);
    expect(() => buildCriterionId(7, 0)).toThrow(UsageError);
    expect(() => buildCriterionId(-1, 1)).toThrow(UsageError);
    expect(() => buildCriterionId(7.5, 1)).toThrow(UsageError);
  });

  it('rejects unsafe integers in build, validate and parse alike', () => {
    // Same precision hazard as epic ids: without this, parse would not
    // round-trip and two distinct criteria could share a canonical id.
    expect(() => buildCriterionId(9007199254740993, 1)).toThrow(UsageError);
    expect(() => buildCriterionId(7, 9007199254740993)).toThrow(UsageError);
    expect(isCriterionId('E9007199254740993-01')).toBe(false);
    expect(isCriterionId(`E7-${'9'.repeat(1000)}`)).toBe(false);
    expect(() => parseCriterionId('E9007199254740993-01')).toThrow(UsageError);
    expect(() => parseCriterionId(`E7-${'9'.repeat(1000)}`)).toThrow(UsageError);
  });

  it('round-trips at the safe-integer boundary', () => {
    const id = buildCriterionId(9007199254740991, 99);
    expect(parseCriterionId(id)).toEqual({ epicNumber: 9007199254740991, sequence: 99 });
  });
});
