import { describe, expect, it } from 'vitest';

import { billingRiskEnvCheck } from '../../../src/cli/doctor/checks/billing-risk-env.js';

import { MINIMAL_CONFIG, testContext } from './helpers.js';

/**
 * FR-15 / UJ-4 — the billing-safety warning, before anything is spawned.
 *
 * Two properties are load-bearing and both are asserted below:
 *
 *   NAMES, NEVER VALUES. A warning that printed a key would leak a credential
 *   into terminal scrollback, CI logs and PR bodies — a worse outcome than the
 *   surprise bill it was warning about. Every assertion here checks that the
 *   variable's NAME appears and that its VALUE does not.
 *
 *   WARN, NEVER FAIL. The check is optional, so a set API key can never change
 *   doctor's exit code. Telling someone their environment is unusable because
 *   they happen to have a key exported would train them to ignore doctor.
 *
 * Presence is decided at the CLI edge and arrives on the context, so these tests
 * inject the names rather than mutating `process.env` — mutating the parent
 * environment inside a test suite is exactly what AD-4 forbids the product from
 * doing, and a test that did it would leak across files.
 */

function configWith(adapter: string, name = 'p'): string {
  return [
    'version: 1',
    'project:',
    '  baseBranch: master',
    'ai:',
    '  providers:',
    `    ${name}:`,
    `      adapter: ${adapter}`,
    '      mode: chatgpt',
    '  roles:',
    `    contract-author: ${name}`,
    '',
  ].join('\n');
}

const CONFIG_WITH_PROVIDER = configWith('codex-cli', 'codex');

describe('billing-risk-env check', () => {
  it('is optional, so a set API key can never change the exit code', () => {
    expect(billingRiskEnvCheck.required).toBe(false);
  });

  it('warns naming the variable when one billing-risk variable is present', async () => {
    const { ctx } = await testContext({
      config: CONFIG_WITH_PROVIDER,
      billingRiskEnv: ['OPENAI_API_KEY'],
    });

    const result = await billingRiskEnvCheck.run(ctx);

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('OPENAI_API_KEY present in environment');
    expect(result.detail).toContain('could bill your API account');
    expect(result.detail).toContain('provider modes');
  });

  it('names every variable at risk, not just the first', async () => {
    // Both adapters configured, so both keys are genuinely spendable.
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
        '    plan-author: claude',
        '',
      ].join('\n'),
      billingRiskEnv: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    });

    const result = await billingRiskEnvCheck.run(ctx);

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('ANTHROPIC_API_KEY');
    expect(result.detail).toContain('OPENAI_API_KEY');
  });

  it('never prints a value — only the name', async () => {
    const { ctx } = await testContext({
      config: CONFIG_WITH_PROVIDER,
      billingRiskEnv: ['OPENAI_API_KEY'],
    });

    const result = await billingRiskEnvCheck.run(ctx);

    // The context carries names only, so there is no value to leak by
    // construction; this asserts the shape the check reads, so a later
    // refactor that started carrying values would fail here rather than in
    // someone's scrollback.
    expect(ctx.billingRiskEnv).toEqual(['OPENAI_API_KEY']);
    expect(result.detail).not.toMatch(/sk-|=/);
  });

  it('passes when no billing-risk variable is present', async () => {
    const { ctx } = await testContext({
      config: CONFIG_WITH_PROVIDER,
      billingRiskEnv: [],
    });

    const result = await billingRiskEnvCheck.run(ctx);

    expect(result.status).toBe('pass');
    expect(result.detail).toContain('no billing-risk');
  });

  it('passes when no providers are configured, even with a key exported', async () => {
    // UJ-4 / the spec's failure-mode list: "No `ai` block at all in config — no
    // provider checks, no warnings, exit 0. That is a normal project state, not
    // a diagnosis." SpecWitness will spawn no provider here, so no provider call
    // can bill anything and the warning would be pure noise.
    const { ctx } = await testContext({
      config: MINIMAL_CONFIG,
      billingRiskEnv: ['OPENAI_API_KEY'],
    });

    const result = await billingRiskEnvCheck.run(ctx);

    expect(result.status).toBe('pass');
    expect(result.detail).toContain('no AI provider is configured');
  });

  it('does not warn about a key no configured provider could ever spend', async () => {
    // Only claude is configured, so `codex` is never invoked and nothing
    // SpecWitness does can bill an OpenAI account. Warning anyway would be a
    // false alarm about a real credential — the fastest way to teach an
    // operator that this line is noise, on the one check where being ignored
    // costs money.
    const { ctx } = await testContext({
      config: configWith('claude-code-cli', 'claude'),
      billingRiskEnv: ['OPENAI_API_KEY'],
    });

    const result = await billingRiskEnvCheck.run(ctx);

    expect(result.status).toBe('pass');
    expect(result.detail).not.toContain('could bill');
  });

  it('warns about only the key the configured provider could spend', async () => {
    const { ctx } = await testContext({
      config: configWith('claude-code-cli', 'claude'),
      billingRiskEnv: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    });

    const result = await billingRiskEnvCheck.run(ctx);

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('ANTHROPIC_API_KEY');
    expect(result.detail).not.toContain('OPENAI_API_KEY');
  });

  it('does not warn when the only provider is hermetic', async () => {
    // The `fake` adapter spawns nothing and holds no credentials, so no key is
    // reachable through it. Reporting billing risk for a provider that cannot
    // make a network call would be wrong about a deliberate configuration.
    const { ctx } = await testContext({
      config: configWith('fake'),
      billingRiskEnv: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    });

    const result = await billingRiskEnvCheck.run(ctx);

    expect(result.status).toBe('pass');
    expect(result.detail).not.toContain('could bill');
  });

  it('does not warn about a provider no role can reach', async () => {
    // A provider declared under `ai.providers` that no role references cannot
    // be invoked: `resolveRoleProvider` is the only way one is selected. Unused
    // provider blocks are common in real configs — kept around after a switch,
    // or added ahead of use — and warning about a key SpecWitness will never
    // spend through them is the same false alarm as warning about the wrong
    // vendor's key.
    const { ctx } = await testContext({
      config: [
        'version: 1',
        'project:',
        '  baseBranch: master',
        'ai:',
        '  providers:',
        '    codex:',
        '      adapter: codex-cli',
        '      mode: chatgpt',
        '',
      ].join('\n'),
      billingRiskEnv: ['OPENAI_API_KEY'],
    });

    const result = await billingRiskEnvCheck.run(ctx);

    expect(result.status).toBe('pass');
    expect(result.detail).not.toContain('could bill');
    // AC3 still requires the variable to be NAMED, and the detail says what
    // would turn this into a warning — the operator is told the fact and the
    // reason it is not yet a risk, rather than nothing.
    expect(result.detail).toContain('OPENAI_API_KEY');
    expect(result.detail).toContain('ai.roles');
  });

  it('still warns when the config failed to load but a key is present', async () => {
    // Config is broken, so we cannot know whether a provider is configured.
    // Staying silent about an exported key on the strength of a config we could
    // not read would be guessing in the direction of a surprise bill.
    const { ctx } = await testContext({
      config: 'version: 2\n',
      billingRiskEnv: ['ANTHROPIC_API_KEY'],
    });

    const result = await billingRiskEnvCheck.run(ctx);

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('ANTHROPIC_API_KEY');
  });
});
