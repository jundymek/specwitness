import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  InfraError,
  IngestError,
  IntegrityError,
  ProviderError,
  UsageError,
} from '../../src/domain/errors.js';
import { EXIT, exitCodeForError } from '../../src/cli/exit.js';

describe('EXIT constants (ADR-002)', () => {
  it('matches the frozen exit-code table exactly', () => {
    // ADR-002. These five numbers are a product contract the harness scripts
    // against; changing one is an ADR, not a refactor.
    expect(EXIT).toEqual({
      PASS: 0,
      FAIL: 1,
      NEEDS_HUMAN: 2,
      INFRA: 3,
      USAGE: 64,
    });
  });

  it('exposes no other codes', () => {
    expect(Object.keys(EXIT).sort()).toEqual(['FAIL', 'INFRA', 'NEEDS_HUMAN', 'PASS', 'USAGE']);
  });

  it('is frozen at runtime', () => {
    expect(Object.isFrozen(EXIT)).toBe(true);
  });
});

describe('exitCodeForError', () => {
  it('maps UsageError to 64', () => {
    expect(exitCodeForError(new UsageError('bad flag'))).toBe(EXIT.USAGE);
  });

  it.each([
    ['ConfigError', new ConfigError('bad config')],
    ['IngestError', new IngestError('bad epic')],
    ['IntegrityError', new IntegrityError('fingerprint mismatch')],
    ['ProviderError', new ProviderError('provider gave up')],
    ['InfraError', new InfraError('worktree missing')],
  ])('maps %s to 3', (_label, err) => {
    expect(exitCodeForError(err)).toBe(EXIT.INFRA);
  });

  it('maps a subclass to its parent class code', () => {
    class MissingConfigError extends ConfigError {}
    class BadInvocationError extends UsageError {}

    expect(exitCodeForError(new MissingConfigError('x'))).toBe(EXIT.INFRA);
    expect(exitCodeForError(new BadInvocationError('x'))).toBe(EXIT.USAGE);
  });

  it.each([
    ['a plain Error', new Error('unclassified')],
    ['a TypeError', new TypeError('cannot read properties of undefined')],
    ['a thrown string', 'oops'],
    ['a thrown object', { code: 'ENOENT' }],
    ['null', null],
    ['undefined', undefined],
  ])('fails closed: maps %s to 3, never 0/1/2', (_label, value) => {
    // AD-7: an unclassified exception is infrastructure, never a product
    // verdict. Reporting one as PASS/FAIL/NEEDS_HUMAN would be a defect of
    // the first order.
    const code = exitCodeForError(value);

    expect(code).toBe(EXIT.INFRA);
    expect([EXIT.PASS, EXIT.FAIL, EXIT.NEEDS_HUMAN]).not.toContain(code);
  });

  it('never returns a code outside the table', () => {
    const table = Object.values(EXIT);
    const samples: unknown[] = [
      new UsageError('a'),
      new ConfigError('b'),
      new IngestError('c'),
      new IntegrityError('d'),
      new ProviderError('e'),
      new InfraError('f'),
      new Error('g'),
      'h',
      42,
      null,
      undefined,
      Symbol('i'),
    ];

    for (const sample of samples) {
      expect(table).toContain(exitCodeForError(sample));
    }
  });
});
