/**
 * Story 4.5 — the observation surface against REAL subprocesses.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE UNIT SUITE. The story's spec is emphatic that
 * every classification test must PRODUCE THE STATE rather than assert over a mocked outcome
 * value. A scripted `'not-found'` proves the `switch` handles a string; it proves nothing
 * about whether a genuinely missing binary arrives as `'not-found'` at all. The unit suite
 * covers the mapping; this file covers the reality it maps — the same division story 3.4
 * drew, for the same reason.
 *
 * HERMETIC (AD-12). Every command is `process.execPath` with `-e`, exactly like the merged
 * `tests/integration/process-runner.test.ts` and `gates.test.ts`. No `claude`, no `codex`,
 * no network, no real database, never this repository. Fixtures live in a per-test temp
 * directory: the auto-review wrapper runs `pnpm test` in this worktree CONCURRENTLY with the
 * agent (H-8), so nothing may share a fixed path.
 *
 * NO ORPHANED PROCESSES. Every command here exits immediately; the one timeout test uses a
 * short injected timeout against a sleeper, and the real runner tears its process GROUP down
 * on timeout. Epic 2's timeout test leaked nine `sleep 3600` processes onto this machine,
 * which is why this paragraph exists and why the sleeper is bounded rather than hour-long.
 *
 * THE GOLDEN VERIFICATION CORPUS IS EPIC 6's. AC3 names "the duplicate-submission scenario
 * fixture" and "Golden Corpus fixture 5"; that corpus does not exist yet. The fixtures here
 * are INLINE, and no passing run of this file should be read as corpus coverage.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { deriveCriterionResult } from '../../../src/domain/criterion-result.js';
import type { ContractCriterionRef } from '../../../src/domain/criterion-result.js';
import type { Evidence } from '../../../src/domain/evidence.js';
import { createProcessRunner } from '../../../src/infra/process-runner.js';
import { ObservationSurfaceExecutor } from '../../../src/surfaces/observation.js';
import type { ObservationExecutorDeps } from '../../../src/surfaces/observation.js';
import { FixedClock } from '../../fakes/ports.js';

const NODE = process.execPath;

const AUTOMATED: ContractCriterionRef = {
  criterionId: 'E4-01',
  statement: 'Submitting the form twice creates exactly one company row.',
  severity: 'critical',
  verifiability: 'automated',
};

/** Every temp directory this file created, removed after each test. */
const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'specwitness-observation-int-'));
  created.push(dir);
  return dir;
}

/** What the executor persisted, so a test can inspect the exact bytes. */
class Recorder {
  readonly files: { name: string; contents: string }[] = [];
  readonly members: Evidence[] = [];

  readonly write = (name: string, contents: string): Promise<string> => {
    this.files.push({ name, contents });
    return Promise.resolve(name);
  };

  readonly record = (evidence: Evidence): void => {
    this.members.push(evidence);
  };

  everythingPersisted(): string {
    return [
      ...this.files.map((f) => f.contents),
      ...this.members.map((m) => JSON.stringify(m)),
    ].join('\n');
  }
}

/**
 * An executor spawning a REAL `node -e <script>` as its observation command.
 *
 * The script is passed as an ARGUMENT, never as a command line: `ProcessRunner` takes
 * `(binary, args[])` and there is no shell on this path, so the script's `;` and quotes
 * arrive at the child as literal argv text (AD-3).
 */
function executorFor(
  cwd: string,
  script: string,
  overrides: Partial<ObservationExecutorDeps> = {},
): { executor: ObservationSurfaceExecutor; recorder: Recorder } {
  const recorder = new Recorder();
  return {
    recorder,
    executor: new ObservationSurfaceExecutor({
      runner: createProcessRunner(new FixedClock('2026-09-02T00:00:00.000Z')),
      clock: new FixedClock('2026-09-02T00:00:00.000Z'),
      cwd,
      timeoutMs: 30_000,
      writeEvidence: recorder.write,
      recordEvidence: recorder.record,
      resolveCommand: () => ({
        commandId: 'company-count',
        displayCommand: `node -e ${script}`,
        binary: NODE,
        baseArgs: ['-e', script],
      }),
      ...overrides,
    }),
  };
}

function request(paramOverrides: Record<string, unknown> = {}) {
  return {
    criterionId: 'E4-01',
    surface: 'observation' as const,
    params: {
      probeId: 'count-companies',
      mechanics: { commandId: 'company-count', args: [] },
      assertions: [
        {
          description: 'exactly one company row exists',
          target: { source: 'jsonPath', path: '$.count', phase: 'snapshot' },
          comparison: 'equals',
          expected: '1',
        },
      ],
      ...paramOverrides,
    },
  };
}

describe('a real observation command emitting JSON (AC1)', () => {
  it('parses stdout and satisfies the assertion', async () => {
    const cwd = await workspace();
    const { executor } = executorFor(cwd, 'console.log(JSON.stringify({count: 1}))');

    const attempt = await executor.execute(request());

    expect(attempt.execError).toBeUndefined();
    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(true);
    expect(deriveCriterionResult(AUTOMATED, [attempt]).status).toBe('pass');
  });

  it('reads stdout only, even when the command also writes to stderr', async () => {
    const cwd = await workspace();
    const { executor } = executorFor(
      cwd,
      'console.error("warning: deprecated"); console.log(JSON.stringify({count: 1}))',
    );

    const attempt = await executor.execute(request());

    expect(attempt.execError).toBeUndefined();
    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(true);
  });

  it('runs the command in the worktree cwd', async () => {
    const cwd = await workspace();
    const { executor } = executorFor(
      cwd,
      'console.log(JSON.stringify({dir: process.cwd()}))',
    );

    const attempt = await executor.execute(
      request({
        assertions: [
          {
            description: 'runs in the verification worktree',
            target: { source: 'jsonPath', path: '$.dir', phase: 'snapshot' },
            comparison: 'contains',
            expected: 'specwitness-observation-int-',
          },
        ],
      }),
    );

    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(true);
  });
});

describe('AC2 — the classification, produced rather than mocked', () => {
  it('classifies genuinely invalid JSON as error, NOT fail', async () => {
    const cwd = await workspace();
    const { executor } = executorFor(cwd, 'console.log("not json")');

    const attempt = await executor.execute(request());

    expect(attempt.execError).toBeDefined();
    expect(attempt.assertionEvaluations).toEqual([]);

    const derived = deriveCriterionResult(AUTOMATED, [attempt]);
    // THE HEADLINE DEFECT THIS STORY EXISTS TO PREVENT: a broken observation command
    // reported as a product FAIL, i.e. infrastructure blamed on the branch.
    expect(derived.status).toBe('error');
    expect(derived.status).not.toBe('fail');
  });

  it('classifies a real non-zero exit as error even when the JSON is valid', async () => {
    const cwd = await workspace();
    const { executor } = executorFor(
      cwd,
      'console.log(JSON.stringify({count: 1})); process.exit(1)',
    );

    const attempt = await executor.execute(request());

    expect(attempt.execError).toBeDefined();
    expect(deriveCriterionResult(AUTOMATED, [attempt]).status).toBe('error');
  });

  it('classifies a genuinely missing binary as error, recording a reference but no member', async () => {
    const cwd = await workspace();
    const { executor, recorder } = executorFor(cwd, 'unused', {
      resolveCommand: () => ({
        commandId: 'company-count',
        displayCommand: 'specwitness-no-such-binary-4-5',
        binary: 'specwitness-no-such-binary-4-5',
        baseArgs: [],
      }),
    });

    const attempt = await executor.execute(request());

    expect(attempt.execError).toBeDefined();
    expect(attempt.execError?.message).toMatch(/not found/i);
    // Nothing was observed, so no typed MEMBER is recorded — the union cannot represent
    // "nothing ran" honestly. But this derives to a persisted non-pass, and FR-28 requires
    // a reference on every one of those, so an attempt RECORD is written and ref'd instead.
    // Amended by story 4.7, which measured this surface as the only one of the three
    // producing a non-pass with zero references. See
    // `tests/unit/surfaces/observation-attempt-record.test.ts`.
    expect(recorder.members).toEqual([]);
    expect(attempt.evidence.length).toBeGreaterThan(0);
    expect(deriveCriterionResult(AUTOMATED, [attempt]).evidence?.length ?? 0).toBeGreaterThan(0);
    expect(deriveCriterionResult(AUTOMATED, [attempt]).status).toBe('error');
  });

  it('classifies a real timeout as error and leaves no process behind', async () => {
    const cwd = await workspace();
    // A BOUNDED sleeper, deliberately: Epic 2's timeout test leaked nine `sleep 3600`
    // processes onto this machine. Two seconds is well past the 150ms cap below, so the
    // timeout fires reliably, and even a total teardown failure leaves nothing for long.
    const { executor } = executorFor(cwd, 'setTimeout(() => {}, 2000)', { timeoutMs: 150 });

    const attempt = await executor.execute(request());

    expect(attempt.execError).toBeDefined();
    expect(attempt.execError?.message).toMatch(/timed out/i);
    expect(attempt.assertionEvaluations).toEqual([]);
    expect(deriveCriterionResult(AUTOMATED, [attempt]).status).toBe('error');
  });

  it('stores the raw broken output as evidence while erroring out (AC2)', async () => {
    const cwd = await workspace();
    const { executor, recorder } = executorFor(
      cwd,
      'console.log("<html>500 Internal Server Error</html>")',
    );

    const attempt = await executor.execute(request());

    expect(attempt.execError).toBeDefined();
    expect(attempt.evidence.length).toBeGreaterThan(0);
    expect(recorder.everythingPersisted()).toContain('500 Internal Server Error');
  });
});

describe('AC3 — the duplicate-submission invariant (brief §35)', () => {
  /**
   * THE EPIC'S SHOWCASE, and a roadmap exit criterion.
   *
   * A real counter file stands in for the database. The "action" is a submission that
   * appends a row — performed TWICE, which is the defect. Every response-level check would
   * be green (both submissions succeed); only the state invariant catches it.
   *
   * The assertion is brief §35 expressed as data, exactly as `domain/plan.ts` documents:
   * `{path: '$.count', phase: 'delta', comparison: 'equals', expected: '1'}`.
   */
  const COUNT_SCRIPT =
    'const fs=require("fs");' +
    'const p=process.argv[1];' +
    'const rows=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,"utf8")):[];' +
    'console.log(JSON.stringify({count: rows.length}))';

  const submit = async (rowsPath: string, times: number): Promise<void> => {
    const { readFile } = await import('node:fs/promises');
    for (let i = 0; i < times; i += 1) {
      const existing = JSON.parse(await readFile(rowsPath, 'utf8')) as unknown[];
      await writeFile(rowsPath, JSON.stringify([...existing, { id: i }]));
    }
  };

  const duplicateRequest = () =>
    request({
      mechanics: { commandId: 'company-count', args: [], around: 'submit-company-form' },
      assertions: [
        {
          description: 'submitting the form twice creates exactly one company row',
          target: { source: 'jsonPath', path: '$.count', phase: 'delta' },
          comparison: 'equals',
          expected: '1',
        },
      ],
    });

  it('FAILS the criterion with requests=2 and rows-created=2', async () => {
    const cwd = await workspace();
    const rowsPath = join(cwd, 'rows.json');
    await writeFile(rowsPath, '[]');

    const { executor, recorder } = executorFor(cwd, COUNT_SCRIPT, {
      resolveCommand: () => ({
        commandId: 'company-count',
        displayCommand: `node -e <count> ${rowsPath}`,
        binary: NODE,
        baseArgs: ['-e', COUNT_SCRIPT, rowsPath],
      }),
      // The duplicate submission: the action is performed TWICE.
      runAction: () => submit(rowsPath, 2),
    });

    const attempt = await executor.execute(duplicateRequest());

    // It is a product FAIL, not an error: the observation command worked perfectly. The
    // PRODUCT is wrong.
    expect(attempt.execError).toBeUndefined();
    const derived = deriveCriterionResult(AUTOMATED, [attempt]);
    expect(derived.status).toBe('fail');
    expect(derived.expected).toBe('1');
    expect(derived.actual).toBe('2');

    // The evidence really shows the two counts — 0 before, 2 after — rather than merely
    // existing. This is the brief's §35 example realized end to end.
    const persisted = recorder.everythingPersisted();
    expect(persisted).toContain('"count":0');
    expect(persisted).toContain('"count":2');
    expect(derived.evidence?.length).toBeGreaterThan(0);
  });

  it('PASSES the same invariant when the form is submitted once', async () => {
    const cwd = await workspace();
    const rowsPath = join(cwd, 'rows.json');
    await writeFile(rowsPath, '[]');

    const { executor } = executorFor(cwd, COUNT_SCRIPT, {
      resolveCommand: () => ({
        commandId: 'company-count',
        displayCommand: `node -e <count> ${rowsPath}`,
        binary: NODE,
        baseArgs: ['-e', COUNT_SCRIPT, rowsPath],
      }),
      runAction: () => submit(rowsPath, 1),
    });

    const attempt = await executor.execute(duplicateRequest());

    // The control case. Without it, a probe that always reported `fail` would pass the test
    // above — the guard has to distinguish the defect, not merely observe one.
    expect(deriveCriterionResult(AUTOMATED, [attempt]).status).toBe('pass');
  });
});

describe('seeded-secret proof against a real command (AD-10)', () => {
  const CANARY = 'PAMELA-4-5-INTEGRATION-CANARY-DO-NOT-LEAK';

  it('keeps the secret out of every stored artifact', async () => {
    const cwd = await workspace();
    // The command leaks the canary three ways: an env-style assignment on stdout, a header
    // on stderr, and a raw non-JSON payload — the three shapes AC2 and Task 6 name.
    const script =
      `console.error("Authorization: Bearer ${CANARY}");` +
      `console.log("AWS_SECRET_ACCESS_KEY=${CANARY}");` +
      `console.log("not json either")`;
    const { executor, recorder } = executorFor(cwd, script);

    const attempt = await executor.execute(request());
    const derived = deriveCriterionResult(AUTOMATED, [attempt]);

    expect(attempt.execError).toBeDefined();

    // ASSERT THE SECRET IS ABSENT — never that `[REDACTED]` is PRESENT. Output carrying the
    // marker with the secret still beside it survives a marker-presence test green, which is
    // exactly the leak shape Epic 3's retro §7 records.
    const everywhere = [
      recorder.everythingPersisted(),
      JSON.stringify(attempt),
      JSON.stringify(derived),
      attempt.execError?.message ?? '',
      attempt.execError?.hint ?? '',
    ].join('\n');
    expect(everywhere).not.toContain(CANARY);

    // And specifically the FULL-COPY bytes handed to the writer — the copy `boundedText`
    // never sees, and the one a naive seeded-secret test misses entirely.
    expect(recorder.files.length).toBeGreaterThan(0);
    for (const file of recorder.files) {
      expect(file.contents).not.toContain(CANARY);
    }
  });
});
