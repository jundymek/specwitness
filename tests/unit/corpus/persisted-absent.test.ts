/**
 * `expected.persistedAbsent` — story 7.4. The corpus can pin a secret absent from what a run
 * PERSISTED, not only from what it printed on stderr.
 *
 * Pure: no binary, no filesystem. The runner half that reads the run directory is exercised by
 * the `redaction-extra-patterns` fixture and by its self-check in `runner-self-check.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import type { RunResultDocument } from '../../../src/schemas/result.js';
import { parseExpectedOutcome, type ExpectedOutcomeFile } from '../../corpus/expected.js';
import { createNormalizer } from '../../corpus/normalize.js';
import { compareOutcome, type ObservedOutcome, type PersistedArtifact } from '../../corpus/runner.js';

const SECRET = 'wombat-7x3k9q2m4p';
const normalizer = createNormalizer({ paths: {}, ports: {} });

const RESULT = '.specwitness/runs/run-20260910T000000Z-ab12/result.json';
const EVIDENCE = '.specwitness/runs/run-20260910T000000Z-ab12/evidence/gate-00-build.stdout.txt';

function expectation(persistedAbsent: readonly string[]): ExpectedOutcomeFile {
  return {
    expectedVersion: 1,
    fixture: 'demo',
    why: 'A long enough sentence naming the defect class and the requirement it proves.',
    proves: ['AC6'],
    command: ['verify', 'epic-1', '--json'],
    exitCode: 0,
    outcome: { verdict: 'PASS' },
    criteria: { assertion: 'exact', statuses: {} },
    persistedAbsent: [...persistedAbsent],
  } as ExpectedOutcomeFile;
}

function observation(persisted: readonly PersistedArtifact[] | undefined, stdout = ''): ObservedOutcome {
  return {
    exitCode: 0,
    stdout,
    stderr: '',
    document: { outcome: { verdict: 'PASS' }, criteria: [] } as unknown as RunResultDocument,
    documentSource: 'run-directory',
    runDirectory: '/tmp/ws/project/.specwitness/runs/run-20260910T000000Z-ab12',
    storedResult: null,
    ...(persisted === undefined ? {} : { persisted }),
  };
}

describe('persistedAbsent', () => {
  it('passes when no persisted artifact and not stdout contains the needle', () => {
    const problems = compareOutcome(
      expectation([SECRET]),
      observation([
        { path: RESULT, contents: '{"outcome":{"verdict":"PASS"}}' },
        { path: EVIDENCE, contents: 'build issued [REDACTED]\n' },
      ]),
      normalizer,
    );
    expect(problems).toEqual([]);
  });

  it('fails naming the FILE that holds the needle — an evidence file, not only result.json', () => {
    const problems = compareOutcome(
      expectation([SECRET]),
      observation([
        { path: RESULT, contents: '{"outcome":{"verdict":"PASS"}}' },
        { path: EVIDENCE, contents: `build issued ${SECRET}\n` },
      ]),
      normalizer,
    );
    expect(problems).toEqual([`persistedAbsent: ${EVIDENCE} contains "${SECRET}"`]);
  });

  it('fails when the --json document on stdout holds the needle', () => {
    const problems = compareOutcome(
      expectation([SECRET]),
      observation([{ path: RESULT, contents: '{}' }], `{"note":"${SECRET}"}`),
      normalizer,
    );
    expect(problems.join('\n')).toContain('the --json document on stdout contains');
  });

  it('refuses to pass vacuously when the run persisted no result.json', () => {
    for (const persisted of [undefined, [] as PersistedArtifact[]]) {
      const problems = compareOutcome(expectation([SECRET]), observation(persisted), normalizer);
      expect(problems.join('\n')).toContain('no result.json was persisted');
    }
  });

  it('asserts nothing when the key is absent, so every fixture merged before it means what it did', () => {
    const expected = { ...expectation([]), persistedAbsent: undefined } as ExpectedOutcomeFile;
    expect(compareOutcome(expected, observation(undefined), normalizer)).toEqual([]);
  });

  it('is accepted by the strict loader, and an empty needle is refused', () => {
    const base = {
      expectedVersion: 1,
      fixture: 'demo',
      why: 'A long enough sentence naming the defect class and the requirement it proves.',
      proves: ['AC6'],
      command: ['verify', 'epic-1'],
      exitCode: 0,
      outcome: { verdict: 'PASS' },
      criteria: { assertion: 'exact', statuses: {} },
    };
    expect(
      parseExpectedOutcome(JSON.stringify({ ...base, persistedAbsent: [SECRET] }), 'expected.json')
        .persistedAbsent,
    ).toEqual([SECRET]);
    expect(() =>
      parseExpectedOutcome(JSON.stringify({ ...base, persistedAbsent: [''] }), 'expected.json'),
    ).toThrow();
  });
});
