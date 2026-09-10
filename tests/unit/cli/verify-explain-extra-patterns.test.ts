import { describe, expect, it } from 'vitest';

import { explainVerifiedRun } from '../../../src/cli/verify/explain.js';
import { configSchema } from '../../../src/config/schema.js';
import type { ProcessRunner, ProcessRunOptions } from '../../../src/domain/process-runner.js';
import type { RunResult } from '../../../src/domain/run-result.js';
import { FixedClock } from '../../fakes/ports.js';
import { fullyPopulatedRunResult } from '../../fixtures/run-result.js';
import { processResult } from '../pipeline/stages/gates.helpers.js';

/**
 * Story 7.4 — `verify --explain` sends the explainer no text a declared extra pattern matches.
 *
 * `explainRun` has taken a `redaction` option since story 6.8, and its CALLER — this edge —
 * never passed one: the comment on that option said so. The config already reaches this edge,
 * so the run's `config.redaction` is what it now forwards.
 *
 * Observed from the outside: the explainer is the real `claude-code-cli` adapter, driven through
 * an injected runner that records what it was asked to run and answers like Claude Code would.
 * Nothing spawns and nothing under `~/.claude/` is read.
 *
 * The CONTROL, without the pattern, must carry the secret into the prompt — or the absence
 * assertion would pass on a prompt that never contained it.
 */

const SECRET = 'wombat-7x3k9q2m4p';

class ClaudeLikeRunner implements ProcessRunner {
  readonly calls: ProcessRunOptions[] = [];

  async run(options: ProcessRunOptions) {
    this.calls.push(options);
    if (options.args.includes('--version')) {
      return processResult({ stdout: '2.1.251 (Claude Code)\n' });
    }
    return processResult({
      stdout: `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{"ok":true}' })}\n`,
    });
  }
}

/** A run whose one failing criterion quotes the secret in its statement. */
function runQuotingTheSecret(): RunResult {
  const base = fullyPopulatedRunResult();
  return {
    ...base,
    criteria: base.criteria.map((criterion) =>
      criterion.status === 'fail'
        ? { ...criterion, statement: `An unknown flag exits 64 and names handle ${SECRET}.` }
        : criterion,
    ),
  };
}

async function explainerPrompt(declare: boolean): Promise<string> {
  const runner = new ClaudeLikeRunner();
  const config = configSchema.parse({
    version: 1,
    project: { baseBranch: 'master' },
    ai: {
      providers: { claude: { adapter: 'claude-code-cli', mode: 'subscription' } },
      roles: { explainer: 'claude' },
    },
    ...(declare ? { redaction: { extraPatterns: ['wombat-[a-z0-9]+'] } } : {}),
  });

  await explainVerifiedRun({
    result: runQuotingTheSecret(),
    config,
    clock: new FixedClock('2026-09-10T00:00:00.000Z', '2026-09-10T00:00:01.000Z'),
    warn: () => undefined,
    createRunner: () => runner,
  });

  const drafting = runner.calls.filter(
    (call) => !call.args.includes('--version') && !call.args.includes('Reply with the single word: ok'),
  );
  expect(drafting.length, 'the explainer must have been invoked').toBeGreaterThan(0);
  return drafting.map((call) => [...call.args, call.input ?? ''].join('\n')).join('\n');
}

describe('story 7.4 — the explain edge forwards the run\'s extra patterns (AD-10, AC2)', () => {
  it('a failing criterion quoting a project-shaped secret: in the prompt on built-ins, ABSENT with the pattern', async () => {
    expect(await explainerPrompt(false), 'control').toContain(SECRET);
    expect(await explainerPrompt(true)).not.toContain(SECRET);
  });
});
