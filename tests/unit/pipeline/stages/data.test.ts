import { describe, expect, it } from 'vitest';

import { REDACTED, type CommandEvidence } from '../../../../src/domain/evidence.js';
import { createDataStage, type DataStageDeps } from '../../../../src/pipeline/stages/data.js';

import { NOISY_GATE_OUTPUT, SEEDED_API_KEY } from './gates.secrets.js';
import {
  declaredData,
  failingWriter,
  infraErrorFrom,
  processResult,
  recordingRunner,
  recordingWriter,
  refusingRunner,
  stageContext,
  WORKTREE,
} from './data.helpers.js';

/**
 * Story 4.3, AC3 — the `data` stage.
 *
 * The spine of this suite is a CLASSIFICATION rule, not a behaviour: **every data-command
 * failure is `InfraError` (exit 3), never a product FAIL.** A `data.reset` command that fails has
 * told you nothing about the branch — the application may be perfect — so exit 1 would assert
 * "this branch has defects" on no evidence at all, and would either block a mergeable branch or
 * route repair automation at code that is fine.
 *
 * Every test here spawns ZERO subprocesses; the integration suite does the real spawning.
 */

const RESET = { id: 'reset', run: 'node -e "process.exit(0)"' };
const SEED = { id: 'seed', run: 'node -e "console.log(1)"' };
const MIGRATE = { id: 'migrate', run: 'node -e "console.log(2)"' };

function deps(overrides: Partial<DataStageDeps> & Pick<DataStageDeps, 'data' | 'runner'>) {
  return overrides as DataStageDeps;
}

describe('the data stage runs declared commands before probes (AC3)', () => {
  it('runs every declared command, in declaration order, in the worktree', async () => {
    const runner = recordingRunner(processResult(), processResult(), processResult());
    const stage = createDataStage(
      deps({ data: declaredData([RESET, SEED, MIGRATE]), runner, writeEvidence: recordingWriter() }),
    );

    const result = await stage.run(stageContext());

    expect(result.status).toBe('ok');
    expect(runner.calls).toHaveLength(3);
    // Declaration order. `config.data` is a `z.record`, so this is an explicit reliance on
    // object insertion order — stated in the module header and pinned end-to-end by the
    // integration suite's real-YAML fixture.
    expect(runner.calls.map((call) => call.args.at(-1))).toStrictEqual([
      'process.exit(0)',
      'console.log(1)',
      'console.log(2)',
    ]);
    for (const call of runner.calls) {
      expect(call.cwd).toBe(WORKTREE);
      expect(call.binary).toBe('node');
    }
  });

  it('keeps the stage name and does not touch the verdict', async () => {
    const runner = recordingRunner(processResult());
    const stage = createDataStage(deps({ data: declaredData([RESET]), runner }));
    const context = stageContext();

    await stage.run(context);

    expect(stage.name).toBe('data');
    // The data stage adjudicates NOTHING. `aggregate()` is AD-6's only converter.
    expect(context.run.gates).toStrictEqual([]);
    expect(context.run.criteria).toStrictEqual([]);
    expect(context.run.outcome).toBeUndefined();
  });

  it('publishes each process group so a killed run can still be reaped', async () => {
    const seen: number[] = [];
    const runner = recordingRunner(processResult({ pgid: 111 }), processResult({ pgid: 222 }));
    const stage = createDataStage(
      deps({
        data: declaredData([RESET, SEED]),
        runner,
        onProcessGroup: (pgid) => {
          seen.push(pgid);
        },
      }),
    );

    await stage.run(stageContext());

    expect(seen).toStrictEqual([111, 222]);
  });

  it('resolves ok, spawning nothing, when no data commands are declared', async () => {
    const runner = refusingRunner();

    const result = await createDataStage(deps({ data: {}, runner })).run(stageContext());

    expect(result.status).toBe('ok');
    expect(runner.calls).toStrictEqual([]);
  });

  it('resolves ok, saying so, when no data runner was wired in', async () => {
    // 4.1's services reasoning, NOT 3.4's gates reasoning, and the difference is load-bearing:
    // an unwired GATES stage must throw because `aggregate()` over an empty gate set returns
    // PASS, so it would manufacture a green verdict. The data stage adjudicates nothing and
    // cannot manufacture a verdict on its own. The CLI edge binds this in 4.7; a throw before
    // then would break every `verify` on the epic branch for a stage nobody has wired.
    const result = await createDataStage(undefined).run(stageContext());

    expect(result.status).toBe('ok');
    expect(result.detail ?? '').toMatch(/nothing/i);
  });
});

describe('every data-command failure is infrastructure, never a product FAIL (AC3)', () => {
  it('throws InfraError when a data command exits non-zero', async () => {
    const runner = recordingRunner(
      processResult({ exitCode: 1, stderr: 'relation does not exist' }),
    );
    const context = stageContext();
    const stage = createDataStage(deps({ data: declaredData([RESET]), runner }));

    const error = await infraErrorFrom(stage.run(context));

    expect(error.message).toContain('reset');
    expect(error.message).toContain('1');
    // The whole point of AC3: nothing claims the BRANCH failed.
    expect(context.run.gates).toStrictEqual([]);
    expect(context.run.criteria).toStrictEqual([]);
    expect(context.run.outcome).toBeUndefined();
  });

  it('throws InfraError naming the binary when it is not on PATH', async () => {
    const runner = recordingRunner(processResult({ outcome: 'not-found', exitCode: null }));
    const stage = createDataStage(
      deps({ data: declaredData([{ id: 'reset', run: 'psqlx --file reset.sql' }]), runner }),
    );

    const error = await infraErrorFrom(stage.run(stageContext()));

    expect(error.message).toContain('psqlx');
  });

  it('throws InfraError when a data command times out', async () => {
    const runner = recordingRunner(processResult({ outcome: 'timed-out', exitCode: null }));
    const stage = createDataStage(deps({ data: declaredData([RESET]), runner, timeoutMs: 400 }));

    const error = await infraErrorFrom(stage.run(stageContext()));

    expect(error.message).toContain('reset');
    expect(error.message).toContain('400');
  });

  it('throws InfraError when a data command cannot be spawned', async () => {
    const runner = recordingRunner(
      processResult({ outcome: 'spawn-failed', exitCode: null, stderr: 'EACCES' }),
    );
    const stage = createDataStage(deps({ data: declaredData([RESET]), runner }));

    const error = await infraErrorFrom(stage.run(stageContext()));

    expect(error.message).toContain('reset');
  });

  it('spawns NOTHING after the first failure', async () => {
    // Scripted with ONE result for THREE declared commands: the double throws a naming error on
    // an unscripted call, so a stage that carried on would fail loudly rather than silently.
    const runner = recordingRunner(processResult({ exitCode: 2 }));
    const stage = createDataStage(deps({ data: declaredData([RESET, SEED, MIGRATE]), runner }));

    await infraErrorFrom(stage.run(stageContext()));

    expect(runner.calls).toHaveLength(1);
  });
});

describe('the worktree refusal — the destructive-command path (AD-8, FR-19)', () => {
  it('throws InfraError, spawning nothing, when data is declared and there is no worktree', async () => {
    // Falling back to the project root would run the operator's `reset` command against the
    // WRONG TREE, and a reset plausibly drops a schema. Identical refusal and identical reason
    // as `createGatesStage` at the same point — it just matters more here.
    const runner = refusingRunner();
    const stage = createDataStage(deps({ data: declaredData([RESET]), runner }));

    const error = await infraErrorFrom(stage.run(stageContext({ worktreePath: null })));

    expect(error.message).toMatch(/worktree/i);
    expect(runner.calls).toStrictEqual([]);
  });

  it('resolves ok with no worktree when nothing is declared', async () => {
    // The refusal is about RUNNING commands in the wrong tree, not about the stage existing.
    const runner = refusingRunner();

    const result = await createDataStage(deps({ data: {}, runner })).run(
      stageContext({ worktreePath: null }),
    );

    expect(result.status).toBe('ok');
    expect(runner.calls).toStrictEqual([]);
  });
});

describe('malformed declared commands are refused before anything is spawned (AD-3)', () => {
  it.each([
    ['backslash-escaped quotes', 'node -e \\"console.log(1)\\"', /backslash/i],
    ['an unterminated quote', 'node -e "console.log(1)', /unterminated/i],
    ['text glued to a quoted executable', '"node"-e', /attached/i],
  ])('refuses %s', async (_label, run, expected) => {
    // The same three refusals as gates, IMPORTED rather than reimplemented: a second splitter
    // would eventually disagree with doctor about which token is the executable.
    const runner = refusingRunner();
    const stage = createDataStage(deps({ data: declaredData([{ id: 'reset', run }]), runner }));

    const error = await infraErrorFrom(stage.run(stageContext()));

    expect(error.message).toMatch(expected);
    expect(runner.calls).toStrictEqual([]);
  });
});

describe('evidence for data commands (AC2)', () => {
  it('records command evidence for each executed command, keyed by its config id', async () => {
    const runner = recordingRunner(
      processResult({ stdout: 'truncated 3 tables' }),
      processResult({ stdout: 'seeded 12 rows' }),
    );
    const context = stageContext();
    const stage = createDataStage(
      deps({ data: declaredData([RESET, SEED]), runner, writeEvidence: recordingWriter() }),
    );

    await stage.run(context);

    const evidence = context.run.evidence.filter(
      (item): item is CommandEvidence => item.kind === 'command',
    );
    expect(evidence.map((item) => item.commandId)).toStrictEqual(['reset', 'seed']);
    expect(evidence[0]?.displayCommand).toContain('node');
    expect(evidence[0]?.stdout.text).toContain('truncated 3 tables');
    expect(evidence[0]?.exitCode).toBe(0);
  });

  it('records evidence for a command that FAILED, before throwing', async () => {
    // A failing reset is exactly the command whose output an operator needs. The accumulator
    // survives a thrown stage, so this reaches the report.
    const runner = recordingRunner(processResult({ exitCode: 1, stderr: 'permission denied' }));
    const context = stageContext();
    const stage = createDataStage(
      deps({ data: declaredData([RESET]), runner, writeEvidence: recordingWriter() }),
    );

    await infraErrorFrom(stage.run(context));

    const evidence = context.run.evidence.filter(
      (item): item is CommandEvidence => item.kind === 'command',
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.stderr.text).toContain('permission denied');
  });

  it('writes full redacted copies through the injected writer, never a constructed path', async () => {
    const writer = recordingWriter();
    const runner = recordingRunner(processResult({ stdout: 'x'.repeat(20_000) }));
    const stage = createDataStage(
      deps({ data: declaredData([RESET]), runner, writeEvidence: writer }),
    );

    await stage.run(stageContext());

    expect(writer.written).toHaveLength(1);
    // A RELATIVE name handed to the writer — `RunStore` is the sole writer under
    // `.specwitness/runs/` (AD-8) and the only module permitted to build a path there.
    expect(writer.written[0]?.name).not.toContain('.specwitness/runs');
    expect(writer.written[0]?.name).toMatch(/^evidence\/data-\d+-reset\.stdout\.txt$/);
  });

  it('records bounded inline evidence even with no writer wired', async () => {
    // `writeEvidence` is OPTIONAL (unlike the gates stage's): the evidence constructors perform
    // no I/O, so the inline copy — the part a report shows — lands either way. Only the pointer
    // to a full copy is lost, and its absence is already expressible.
    const runner = recordingRunner(processResult({ stdout: 'ok' }));
    const context = stageContext();

    await createDataStage(deps({ data: declaredData([RESET]), runner })).run(context);

    const evidence = context.run.evidence.filter(
      (item): item is CommandEvidence => item.kind === 'command',
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.stdout.text).toContain('ok');
    // The pointer to a full copy lives on the BoundedText, and is present only when the inline
    // copy was truncated AND a full copy was written. Neither happened here.
    expect(evidence[0]?.stdout.fullPath).toBeUndefined();
  });

  it('does not let an evidence-write failure replace the real diagnosis', async () => {
    // The run is about to throw a precise InfraError ("data command 'reset' failed"). Letting an
    // ENOSPC escape would replace that with the wrong cause — the same
    // durability-rewrites-a-conclusion mistake the gates stage documents.
    const runner = recordingRunner(processResult({ exitCode: 1, stderr: 'nope' }));
    const stage = createDataStage(
      deps({ data: declaredData([RESET]), runner, writeEvidence: failingWriter() }),
    );

    const error = await infraErrorFrom(stage.run(stageContext()));

    expect(error.message).toContain('reset');
    expect(error.message).not.toContain('ENOSPC');
  });
});

describe('redaction is fail-closed on the capture path (AD-10, Epic 3 retro §6)', () => {
  /**
   * The seeded credential is IMPORTED from the shared fixture, not redeclared here.
   *
   * Reused from story 3.4's fixture rather than duplicated, for the reason story 4.1 gave when it
   * hit the same wall in cohort 1: a second seeded-secret constant is a second thing to keep in
   * step with the redactor. `NOISY_GATE_OUTPUT` additionally carries the credential in all four
   * shapes a real project prints it — a bare assignment plus the three prefixed forms (`> `, `< `
   * and a timestamped log line) that a start-of-line-anchored pattern misses, which was a real
   * defect in story 3.3.
   */
  const SECRET = SEEDED_API_KEY;

  it('keeps a seeded secret out of evidence, the writer, and the error message', async () => {
    // The assertion is that the SECRET IS ABSENT — never that `[REDACTED]` is present. Output
    // carrying the marker with the secret still beside it passes a marker-presence assertion
    // green (Epic 3 retro §7).
    const writer = recordingWriter();
    const runner = recordingRunner(
      processResult({
        outcome: 'spawn-failed',
        exitCode: null,
        stdout: NOISY_GATE_OUTPUT,
        stderr: `failed to start\n${NOISY_GATE_OUTPUT}`,
      }),
    );
    const context = stageContext();
    const stage = createDataStage(
      deps({ data: declaredData([RESET]), runner, writeEvidence: writer }),
    );

    const error = await infraErrorFrom(stage.run(context));

    // 1. Not in the error message — which reaches `printError` and is written to stderr verbatim.
    expect(error.message).not.toContain(SECRET);
    expect(error.hint ?? '').not.toContain(SECRET);
    // 2. Not in the inline evidence.
    expect(JSON.stringify(context.run.evidence)).not.toContain(SECRET);
    // 3. Not in anything handed to the writer, i.e. not in the persisted full copy.
    expect(JSON.stringify(writer.written)).not.toContain(SECRET);
    // And the redaction did happen, rather than the output having vanished.
    expect(JSON.stringify(context.run.evidence)).toContain(REDACTED);
  });

  it('redacts capture output UNDECLARED — a shell-ish quote in output is not a shell', async () => {
    // `{shellCommand: true}` is reserved for DECLARED commands, text the project owner wrote.
    // Passing capture output as declared is the fail-open direction: shell context is declared by
    // the caller and never inferred from the text, because an apostrophe in prose is
    // indistinguishable from a shell delimiter.
    const runner = recordingRunner(
      processResult({ stdout: `it's done: ANTHROPIC_API_KEY=${SECRET}` }),
    );
    const context = stageContext();

    await createDataStage(deps({ data: declaredData([RESET]), runner })).run(context);

    expect(JSON.stringify(context.run.evidence)).not.toContain(SECRET);
  });
});
