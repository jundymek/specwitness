/**
 * The corpus normaliser (story 6.1, Task 2).
 *
 * PURE — no subprocess, no filesystem.
 *
 * TWO DIRECTIONS, and the second matters more. Normalising too little produces a fixture
 * that fails on Tuesday because a run id changed. Normalising too HARD swallows a real
 * difference, and nothing goes red at all: the corpus keeps reporting green while the
 * product's behaviour moves underneath it. So every test below that proves a volatile shape
 * IS replaced is paired with one proving a meaningful difference SURVIVES.
 */

import { describe, expect, it } from 'vitest';

import { createNormalizer } from '../../corpus/normalize.js';

const normalizer = createNormalizer({
  paths: { '<PROJECT>': '/tmp/ws-1/project', '<WORKSPACE>': '/tmp/ws-1' },
  ports: { app: 45231 },
});

describe('volatile shapes are replaced', () => {
  it('replaces a run id', () => {
    expect(normalizer.normalizeText('SpecWitness run run-20260904T134152Z-2of4')).toBe(
      'SpecWitness run <RUN-ID>',
    );
  });

  it('replaces an ISO-8601 UTC timestamp, with or without fractional seconds', () => {
    expect(normalizer.normalizeText('at 2026-09-04T13:41:52.842Z and 2026-09-04T13:41:52Z')).toBe(
      'at <TIMESTAMP> and <TIMESTAMP>',
    );
  });

  it('replaces a full commit sha', () => {
    expect(
      normalizer.normalizeText('Head: d66ee2af3348ddf86e56e713a5248967d9244d61'),
    ).toBe('Head: <SHA>');
  });

  it('replaces an allocated port, naming which one it was', () => {
    expect(normalizer.normalizeText('http://127.0.0.1:45231/health')).toBe(
      'http://127.0.0.1:<PORT:app>/health',
    );
  });

  it('replaces the longest matching path first', () => {
    // `/tmp/ws-1/project` must win over `/tmp/ws-1`, or the output is `<WORKSPACE>/project`
    // — which still looks normalised and is nonetheless the wrong answer.
    expect(normalizer.normalizeText('cwd /tmp/ws-1/project, tmp /tmp/ws-1/tmp')).toBe(
      'cwd <PROJECT>, tmp <WORKSPACE>/tmp',
    );
  });

  it('rewrites duration fields in a document, and only duration fields', () => {
    const document = normalizer.normalizeDocument({
      durationMs: 12,
      attempts: 12,
      stages: [{ name: 'gates', durationMs: 4211 }],
    });

    expect(document).toEqual({
      durationMs: '<DURATION>',
      attempts: 12,
      stages: [{ name: 'gates', durationMs: '<DURATION>' }],
    });
  });
});

describe('meaningful differences survive normalisation', () => {
  it('does not touch a verdict, a criterion id or a criterion status', () => {
    const text = 'verdict: FAIL, criterion E1-02 status fail, gate build';

    expect(normalizer.normalizeText(text)).toBe(text);
  });

  it('keeps two documents different when their outcome differs', () => {
    // The mirror-image failure, stated as a test: a normaliser aggressive enough to make
    // these two equal would make the whole corpus report green forever.
    const pass = normalizer.normalizeDocument({
      runId: 'run-20260904T134152Z-2of4',
      outcome: { verdict: 'PASS' },
    });
    const fail = normalizer.normalizeDocument({
      runId: 'run-20260904T134153Z-jzux',
      outcome: { verdict: 'FAIL' },
    });

    expect(pass).not.toEqual(fail);
    // ...and they differ ONLY in the outcome: the run ids, which are not facts, are equal.
    expect((pass as { runId: string }).runId).toBe((fail as { runId: string }).runId);
  });

  it('does not rewrite a number that merely contains an allocated port', () => {
    // Port 45231 must not eat the middle of 145231000. A replacement anchored to a value
    // rather than to a shape is how a normaliser starts corrupting real data.
    expect(normalizer.normalizeText('bytes=145231000')).toBe('bytes=145231000');
  });

  it('does not treat an abbreviated sha as a full one', () => {
    // `resolve` prints `d66ee2a against 513717c`. Those are 7 characters, not 40, and a
    // normaliser that collapsed them would hide which commits a fixture actually compared.
    expect(normalizer.normalizeText('epic-1: d66ee2a against 513717c')).toBe(
      'epic-1: d66ee2a against 513717c',
    );
  });

  it('preserves every key of a document, including empty arrays', () => {
    // A diff that drops a key is a diff that hides a defect.
    expect(
      normalizer.normalizeDocument({ providerUsage: [], criteria: [], contract: null }),
    ).toEqual({ providerUsage: [], criteria: [], contract: null });
  });
});
