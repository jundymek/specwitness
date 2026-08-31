import { describe, expect, it } from 'vitest';

import { providersCheck } from '../../../src/cli/doctor/checks/providers.js';
import type { ProviderProbe } from '../../../src/cli/doctor/effects.js';

import { PROVIDER_ABSENT, testContext } from './helpers.js';

/**
 * FR-3's provider half (AC3), UJ-4, AD-4, NFR-1.
 *
 * Story 1.5 built the registry and refused to stub these checks, because "a
 * placeholder is a contract nobody agreed to". This is the consumer that seam
 * was built for — and every test here runs against INJECTED probe results, so
 * no `claude` and no `codex` is spawned and the suite behaves identically on a
 * machine that has neither.
 *
 * The property that matters most is the exit code. UJ-4's edge case is
 * explicit: with no agent CLI installed, contract GENERATION is unavailable but
 * execution of existing plans still works. So every outcome here is `pass` or
 * `warn`, never `fail` — a diagnostic that failed because an optional tool is
 * missing is one people learn to ignore.
 */

const CONFIG = [
  'version: 1',
  'project:',
  '  baseBranch: master',
  'ai:',
  '  providers:',
  '    codex:',
  '      adapter: codex-cli',
  '      mode: chatgpt',
  '  roles:',
  '    contract-author: codex',
  '',
].join('\n');

const READY: ProviderProbe = {
  hermetic: false,
  binary: 'codex',
  found: true,
  version: 'codex-cli 0.144.4',
  capable: true,
  capabilityDetail: 'exec available',
  auth: { ok: true, conclusive: true },
};

describe('ai-providers check', () => {
  it('is optional, so a missing provider can never change the exit code', () => {
    // UJ-4: no agent CLI means generation is unavailable and execution still
    // works. Marking this required would exit 3 on a working machine.
    expect(providersCheck.required).toBe(false);
  });

  it('reports a ready provider with its version, capability and mode', async () => {
    const { ctx } = await testContext({ config: CONFIG, providerProbes: { codex: READY } });

    const result = await providersCheck.run(ctx);

    expect(result.status).toBe('pass');
    expect(result.detail).toContain('codex');
    expect(result.detail).toContain('0.144.4');
    expect(result.detail).toContain('exec available');
    expect(result.detail).toContain('mode: chatgpt');
    expect(result.detail).toContain('auth appears usable');
  });

  it('warns — never fails — when the binary is absent, and says what it costs', async () => {
    const { ctx } = await testContext({
      config: CONFIG,
      providerProbes: { codex: PROVIDER_ABSENT },
    });

    const result = await providersCheck.run(ctx);

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('not found on PATH');
    // The operator needs to know what still works, not only what does not.
    expect(result.detail).toContain('existing plans still run');
  });

  it('distinguishes "the CLI said no" from "could not tell"', async () => {
    // Only the first is a diagnosis about the operator's account. A timed-out
    // probe rendered as "not authenticated" would send someone to re-login over
    // a slow machine.
    const saidNo = await testContext({
      config: CONFIG,
      providerProbes: {
        codex: {
          ...READY,
          auth: { ok: false, conclusive: true, detail: 'codex doctor: not signed in' },
        },
      },
    });
    const couldNotTell = await testContext({
      config: CONFIG,
      providerProbes: {
        codex: {
          ...READY,
          auth: { ok: false, conclusive: false, detail: 'did not respond within 5000ms' },
        },
      },
    });

    const refused = await providersCheck.run(saidNo.ctx);
    const unknown = await providersCheck.run(couldNotTell.ctx);

    expect(refused.detail).toContain('does not appear usable');
    expect(refused.detail).toContain('not signed in');
    expect(unknown.detail).toContain('auth state unknown');
    expect(unknown.detail).not.toContain('does not appear usable');
    // Both are warnings; neither is a failure.
    expect([refused.status, unknown.status]).toEqual(['warn', 'warn']);
  });

  it('never tells the operator to set an API key when auth fails', async () => {
    // D14. The obvious hint would send them straight at the metered account
    // that FR-15 and both adapters deliberately withhold — in the same doctor
    // run where billing-risk-env warns about that exact variable. Two lines of
    // one report giving opposite advice, and the more specific-looking one wins.
    const { ctx } = await testContext({
      config: CONFIG,
      providerProbes: {
        codex: {
          ...READY,
          auth: { ok: false, conclusive: true, detail: 'codex doctor: not signed in' },
        },
      },
    });

    const result = await providersCheck.run(ctx);

    expect(result.detail).not.toContain('OPENAI_API_KEY');
    expect(result.detail).not.toMatch(/set .*API.?KEY/i);
  });

  it('reports a fake adapter as hermetic, not as a missing binary', async () => {
    const { ctx } = await testContext({
      config: [
        'version: 1',
        'project:',
        '  baseBranch: master',
        'ai:',
        '  providers:',
        '    stub:',
        '      adapter: fake',
        '      mode: canned',
        '  roles:',
        '    contract-author: stub',
        '',
      ].join('\n'),
      providerProbes: {
        stub: {
          hermetic: true,
          binary: null,
          found: true,
          capable: true,
          capabilityDetail: 'runs in-process against canned responses',
          auth: null,
        },
      },
    });

    const result = await providersCheck.run(ctx);

    expect(result.status).toBe('pass');
    expect(result.detail).toContain('in-process');
    expect(result.detail).not.toContain('not found');
  });

  it('passes with no ai block at all — a normal project state, not a diagnosis', async () => {
    const { ctx } = await testContext({
      config: ['version: 1', 'project:', '  baseBranch: master', ''].join('\n'),
    });

    const result = await providersCheck.run(ctx);

    expect(result.status).toBe('pass');
    expect(result.detail).toContain('no AI providers configured');
  });

  it('reports every configured provider, not just the first', async () => {
    const { ctx } = await testContext({
      config: [
        'version: 1',
        'project:',
        '  baseBranch: master',
        'ai:',
        '  providers:',
        '    claude:',
        '      adapter: claude-code-cli',
        '      mode: subscription',
        '    codex:',
        '      adapter: codex-cli',
        '      mode: chatgpt',
        '  roles:',
        '    contract-author: codex',
        '',
      ].join('\n'),
      providerProbes: {
        claude: { ...READY, binary: 'claude', capabilityDetail: 'non-interactive available' },
        codex: PROVIDER_ABSENT,
      },
    });

    const result = await providersCheck.run(ctx);

    // Worst status wins, and it is capped at warn.
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('claude');
    expect(result.detail).toContain('codex');
  });

  it('degrades with a message rather than throwing when config did not load', async () => {
    const { ctx } = await testContext({ config: 'version: 2\n' });

    const result = await providersCheck.run(ctx);

    // `config-valid` already reports the load failure; repeating it per provider
    // would turn one fault into several.
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('config-valid');
  });
});
