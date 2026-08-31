import { describe, expect, it } from 'vitest';

import { stripCodeFence } from '../../../src/providers/text.js';

/**
 * `stripCodeFence` is the ONE fence stripper both CLI adapters share (story 2.4
 * lands it, story 2.5 imports it — agreed in writing during cohort intent-sync
 * so the two adapters cannot diverge into two subtly different strippers).
 *
 * Its contract is narrow on purpose. A model asked for JSON often wraps it in a
 * markdown fence; unwrapping that is CLI-output translation and belongs to the
 * adapter, which keeps `providers/invoke.ts`'s schema gate schema-pure (AD-2).
 *
 * The load-bearing property is the NEGATIVE one: anything this function does not
 * positively recognise as a fenced payload comes back BYTE-IDENTICAL. An adapter
 * returns raw text and the gate decides whether it is valid; a stripper that
 * "helpfully repairs" ambiguous input would corrupt a payload on its way to a
 * validator that would otherwise have rejected it honestly.
 */

describe('stripCodeFence', () => {
  describe('unwraps a fenced payload', () => {
    it('strips a json-tagged fence', () => {
      expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    });

    it('strips a bare fence with no language tag', () => {
      expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
    });

    it('strips an arbitrary language tag, not just json', () => {
      // The adapter must not care which tag the model chose.
      expect(stripCodeFence('```yaml\na: 1\n```')).toBe('a: 1');
    });

    it('tolerates a trailing newline after the closing fence', () => {
      expect(stripCodeFence('```json\n{"a":1}\n```\n')).toBe('{"a":1}');
    });

    it('tolerates leading and trailing whitespace around the fence', () => {
      expect(stripCodeFence('  \n```json\n{"a":1}\n```\n  \n')).toBe('{"a":1}');
    });

    it('preserves the payload interior verbatim, including blank lines', () => {
      // Interior formatting is the model's content, not the fence's.
      expect(stripCodeFence('```json\n{\n  "a": 1\n}\n```')).toBe('{\n  "a": 1\n}');
    });

    it('preserves interior backticks that do not open a fence', () => {
      expect(stripCodeFence('```\nuse `git status`\n```')).toBe('use `git status`');
    });

    it('handles an empty fenced payload', () => {
      expect(stripCodeFence('```json\n\n```')).toBe('');
    });
  });

  describe('returns input unchanged when it is not a fenced payload', () => {
    it('leaves bare JSON alone', () => {
      expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
    });

    it('leaves prose alone', () => {
      expect(stripCodeFence('no fence here')).toBe('no fence here');
    });

    it('leaves the empty string alone', () => {
      expect(stripCodeFence('')).toBe('');
    });

    it('leaves an UNTERMINATED fence alone', () => {
      // Ambiguous: a truncated response is a real failure mode, and guessing
      // where the payload ends would hand the gate a silently-corrupted body.
      // Returning it raw lets the gate reject it and record the attempt.
      const raw = '```json\n{"a":1}';
      expect(stripCodeFence(raw)).toBe(raw);
    });

    it('leaves a fence that opens mid-text alone', () => {
      // Prose before the fence means the model did not return a fenced payload;
      // it returned a message that happens to contain one. Not our call to edit.
      const raw = 'Here you go:\n```json\n{"a":1}\n```';
      expect(stripCodeFence(raw)).toBe(raw);
    });

    it('leaves text with a closing fence but no opening fence alone', () => {
      const raw = '{"a":1}\n```';
      expect(stripCodeFence(raw)).toBe(raw);
    });
  });

  describe('properties', () => {
    it('is idempotent', () => {
      const once = stripCodeFence('```json\n{"a":1}\n```');
      expect(stripCodeFence(once)).toBe(once);
    });

    it('does not strip a second, nested fence level', () => {
      // One level only. A payload that is ITSELF a fenced block is content.
      expect(stripCodeFence('````\n```json\n{"a":1}\n```\n````')).toBe('```json\n{"a":1}\n```');
    });

    it('never throws, whatever it is handed', () => {
      const nasty = ['```', '``````', '`', '\n\n\n', '```json', '```\n```', '```\n```\n```'];
      for (const input of nasty) {
        expect(() => stripCodeFence(input)).not.toThrow();
      }
    });
  });
});
