import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { register } from '../../../src/cli/commands/doctor.js';
import { BUILTIN_CHECKS } from '../../../src/cli/doctor/checks/index.js';
import type { DoctorCheck } from '../../../src/cli/doctor/registry.js';

/**
 * AC3 at the PRODUCTION wiring point, not only inside the registry.
 *
 * The registry test proves a check can be registered and reported. This one
 * proves the command is itself open for extension: story 2.7 supplies its
 * provider checks at wiring time without editing this command, the built-in
 * list, or any existing check.
 */

function captureStdout(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join(''), restore: () => spy.mockRestore() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('doctor command wiring', () => {
  it('runs an injected check set, so story 2.7 needs no edit here', async () => {
    const providerCheck: DoctorCheck = {
      id: 'claude-cli-present',
      required: false,
      run: async () => ({ status: 'warn', detail: 'claude CLI not found on PATH' }),
    };
    const program = new Command().exitOverride();
    register(program, [providerCheck]);

    const stdout = captureStdout();
    try {
      await program.parseAsync(['doctor'], { from: 'user' });
    } finally {
      stdout.restore();
    }

    expect(stdout.text()).toContain('claude-cli-present');
    expect(stdout.text()).toContain('claude CLI not found on PATH');
    // Only the injected check ran, so this really is the wiring point rather
    // than a list that happens to be reachable.
    expect(stdout.text()).not.toContain('node-version');
  });

  it('uses the built-in checks by default', async () => {
    const program = new Command().exitOverride();
    register(program, BUILTIN_CHECKS.filter((check) => check.id === 'node-version'));

    const stdout = captureStdout();
    try {
      await program.parseAsync(['doctor'], { from: 'user' });
    } finally {
      stdout.restore();
    }

    expect(stdout.text()).toContain('node-version');
  });
});
