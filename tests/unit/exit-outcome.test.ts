import { describe, expect, it } from 'vitest';

import { EXIT, exitCodeForError, exitCodeForOutcome } from '../../src/cli/exit.js';
import {
  ConfigError,
  InfraError,
  IngestError,
  IntegrityError,
  ProviderError,
  UsageError,
} from '../../src/domain/errors.js';
import { INFRA_ERROR_CLASSIFICATIONS, VERDICTS } from '../../src/domain/run-outcome.js';
import type { RunOutcome } from '../../src/domain/run-outcome.js';
import { aggregate } from '../../src/domain/verdict.js';

describe('exit table — the frozen ADR-002 contract', () => {
  it('defines exactly the five documented codes', () => {
    expect(EXIT).toEqual({ PASS: 0, FAIL: 1, NEEDS_HUMAN: 2, INFRA: 3, USAGE: 64 });
  });

  it('keeps usage errors out of the 0-3 range so automations cannot confuse them', () => {
    expect(EXIT.USAGE).toBeGreaterThan(3);
  });
});

describe('exitCodeForError — every AD-7 class (ADR-002)', () => {
  it('maps UsageError to 64', () => {
    expect(exitCodeForError(new UsageError('bad flag', 'try --help'))).toBe(EXIT.USAGE);
  });

  it.each([
    ['ConfigError', new ConfigError('bad config')],
    ['IngestError', new IngestError('bad ingest')],
    ['IntegrityError', new IntegrityError('fingerprint mismatch')],
    ['ProviderError', new ProviderError('provider failed')],
    ['InfraError', new InfraError('worktree unavailable')],
  ])('maps %s to 3', (_name, err) => {
    expect(exitCodeForError(err)).toBe(EXIT.INFRA);
  });

  it('maps an unclassified error to 3 — fail closed, never a product FAIL', () => {
    expect(exitCodeForError(new Error('boom'))).toBe(EXIT.INFRA);
    expect(exitCodeForError('a string')).toBe(EXIT.INFRA);
    expect(exitCodeForError(undefined)).toBe(EXIT.INFRA);
    expect(exitCodeForError(null)).toBe(EXIT.INFRA);
    expect(exitCodeForError({ message: 'duck typed' })).toBe(EXIT.INFRA);
  });

  it('never reports any error as product FAIL (exit 1)', () => {
    const errors: unknown[] = [
      new UsageError('u'),
      new ConfigError('c'),
      new IngestError('i'),
      new IntegrityError('t'),
      new ProviderError('p'),
      new InfraError('f'),
      new Error('unknown'),
      'not an error',
    ];
    for (const err of errors) {
      expect(exitCodeForError(err)).not.toBe(EXIT.FAIL);
    }
  });

  it('classifies a ConfigError subclass declared in another layer as 3', () => {
    // Guards story 1.3's MissingConfigFileError: refining a message never changes a classification.
    class MissingConfigFileError extends ConfigError {}
    expect(exitCodeForError(new MissingConfigFileError('no config', 'run specwitness init'))).toBe(
      EXIT.INFRA,
    );
  });
});

describe('exitCodeForOutcome — every run-outcome variant (ADR-002, ADR-003)', () => {
  it('maps PASS to 0', () => {
    expect(exitCodeForOutcome({ verdict: 'PASS' })).toBe(EXIT.PASS);
  });

  it('maps FAIL to 1', () => {
    expect(exitCodeForOutcome({ verdict: 'FAIL' })).toBe(EXIT.FAIL);
  });

  it('maps a gate-failure FAIL to 1 as well, not to a distinct code (ADR-003)', () => {
    expect(exitCodeForOutcome({ verdict: 'FAIL', gateFailed: 'build' })).toBe(EXIT.FAIL);
  });

  it('maps NEEDS_HUMAN to 2', () => {
    expect(exitCodeForOutcome({ verdict: 'NEEDS_HUMAN' })).toBe(EXIT.NEEDS_HUMAN);
  });

  it.each(INFRA_ERROR_CLASSIFICATIONS)('maps infraError %j to 3', (classification) => {
    expect(exitCodeForOutcome({ infraError: classification })).toBe(EXIT.INFRA);
  });

  it('never reports an infra outcome as product FAIL — the bug of the first order', () => {
    for (const classification of INFRA_ERROR_CLASSIFICATIONS) {
      expect(exitCodeForOutcome({ infraError: classification })).not.toBe(EXIT.FAIL);
    }
  });

  it('covers every verdict in the closed union', () => {
    for (const verdict of VERDICTS) {
      const code = exitCodeForOutcome({ verdict });
      expect([EXIT.PASS, EXIT.FAIL, EXIT.NEEDS_HUMAN]).toContain(code);
    }
  });

  it('never returns the usage code for any run outcome', () => {
    const outcomes: RunOutcome[] = [
      ...VERDICTS.map((verdict) => ({ verdict })),
      { verdict: 'FAIL', gateFailed: 'build' },
      ...INFRA_ERROR_CLASSIFICATIONS.map((infraError) => ({ infraError })),
    ];
    for (const outcome of outcomes) {
      expect(exitCodeForOutcome(outcome)).not.toBe(EXIT.USAGE);
    }
  });
});

describe('aggregation and the exit table together — end to end (AC2)', () => {
  it('exits 0 for a gates-only green run', () => {
    expect(exitCodeForOutcome(aggregate([{ gateId: 'lint', status: 'pass' }], []))).toBe(EXIT.PASS);
  });

  it('exits 1 for a failed gate, carrying the gate id', () => {
    const outcome = aggregate([{ gateId: 'build', status: 'fail' }], []);
    expect(outcome).toEqual({ verdict: 'FAIL', gateFailed: 'build' });
    expect(exitCodeForOutcome(outcome)).toBe(EXIT.FAIL);
  });

  it('exits 1 for a criterion failure', () => {
    expect(exitCodeForOutcome(aggregate([], [{ criterionId: 'E1-01', status: 'fail' }]))).toBe(EXIT.FAIL);
  });

  it('exits 3 — not 1 — for a criterion-level infra error', () => {
    const code = exitCodeForOutcome(aggregate([], [{ criterionId: 'E1-01', status: 'error' }]));
    expect(code).toBe(EXIT.INFRA);
    expect(code).not.toBe(EXIT.FAIL);
  });

  it('exits 2 for a run needing human review', () => {
    expect(exitCodeForOutcome(aggregate([], [{ criterionId: 'E1-01', status: 'needs_human' }]))).toBe(
      EXIT.NEEDS_HUMAN,
    );
  });

  it('reaches all five codes across the product surface', () => {
    const codes = new Set<number>([
      exitCodeForOutcome(aggregate([], [])),
      exitCodeForOutcome(aggregate([], [{ criterionId: 'E1-01', status: 'fail' }])),
      exitCodeForOutcome(aggregate([], [{ criterionId: 'E1-01', status: 'needs_human' }])),
      exitCodeForOutcome(aggregate([], [{ criterionId: 'E1-01', status: 'error' }])),
      exitCodeForError(new UsageError('bad flag')),
    ]);
    expect([...codes].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 64]);
  });
});
