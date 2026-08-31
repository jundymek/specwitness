import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// Only the public surface: `src/config/` bans deep imports, and everything
// needed is exported from the index.
import { loadConfig } from '../../src/config/index.js';
import { scaffold } from '../../src/infra/scaffold.js';

/**
 * The contract between story 1.4's shipped skeleton and story 1.3's schema.
 *
 * `init` promises a config that is valid the moment it is written — the first
 * half of UJ-4 (install → init → doctor) is worthless if `doctor`'s very first
 * required check fails on the file `init` just produced. Asserting the shape by
 * hand would only test my reading of the schema, so this runs the real loader:
 * if either side drifts, this test goes red rather than a user's terminal.
 */
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'specwitness-template-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function makeGitDir(head = 'ref: refs/heads/master\n'): Promise<void> {
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, '.git', 'HEAD'), head, 'utf8');
}

describe('the shipped template validates against the real config schema', () => {
  it('loads without error straight after init', async () => {
    await makeGitDir();
    await scaffold(root);

    expect(() => loadConfig(root)).not.toThrow();
  });

  it('produces the documented defaults for every omitted block', async () => {
    // The skeleton declares almost nothing, so what the user gets on day one is
    // mostly defaults. Pinning them here means a change to those defaults has to
    // be a deliberate decision rather than a surprise in a generated file.
    await makeGitDir();
    await scaffold(root);

    const config = loadConfig(root);

    expect(config.version).toBe(1);
    expect(config.project.baseBranch).toBe('master');
    expect(config.planning.format).toBe('bmad-v6');
    expect(config.planning.planningArtifacts).toBe('docs/planning-artifacts');
    expect(config.gates).toEqual([]);
    expect(config.services).toEqual({});
    expect(config.observations).toEqual({});
  });

  it.each([['main'], ['develop'], ['release/2026-q3'], ['true'], ['123']])(
    'stays valid when HEAD names branch %s',
    async (branch) => {
      // A branch name must never be able to produce an invalid config: `true`
      // and `123` are legal Git names that YAML would otherwise read as a
      // boolean and a number, failing the schema's string type.
      await makeGitDir(`ref: refs/heads/${branch}\n`);
      await scaffold(root);

      const config = loadConfig(root);

      expect(config.project.baseBranch).toBe(branch);
    },
  );

  it('declares no commands at all, so doctor has nothing to resolve', async () => {
    // Story 1.5's `commands-resolvable` check is REQUIRED and PATH-resolves the
    // first token of every declared command. A skeleton declaring `pnpm lint`
    // would fail it on any machine without pnpm — so a fresh init must declare
    // nothing. If a future story uncomments part of the skeleton, this fails and
    // whoever did it has to talk to whoever owns doctor.
    await makeGitDir();
    await scaffold(root);

    const config = loadConfig(root);

    expect(config.setup.install).toBeUndefined();
    expect(config.gates).toHaveLength(0);
    expect(Object.keys(config.services)).toHaveLength(0);
    expect(Object.keys(config.data)).toHaveLength(0);
    expect(Object.keys(config.observations)).toHaveLength(0);
    expect(config.ai.providers).toBeUndefined();
    expect(config.ai.roles).toBeUndefined();
  });

  it('writes only version and project as active YAML keys', async () => {
    // The same invariant one level down: not "no commands after defaults are
    // applied", but "nothing beyond the required surface is uncommented".
    await makeGitDir();
    await scaffold(root);

    const raw = parse(await readFile(join(root, '.specwitness', 'config.yaml'), 'utf8'), {
      uniqueKeys: true,
    }) as Record<string, unknown>;

    expect(Object.keys(raw).sort()).toEqual(['project', 'version']);
  });

  it('documents examples that are actually valid when switched on', async () => {
    // A commented example is documentation the user is invited to switch on. If
    // uncommenting one produced a config the strict schema rejects, the skeleton
    // would be a trap rather than a starting point, and the failure would land
    // on the user rather than on us.
    //
    // Written by hand rather than mechanically uncommenting the template: the
    // template interleaves prose comments with commented-out YAML, and no
    // regex separates the two reliably enough to trust. A test that mostly
    // exercises its own un-commenting heuristic proves very little. Per the
    // project's fixture culture, the expectation is authored, not generated.
    //
    // KEEP IN SYNC with templates/config.yaml: this mirrors every example it
    // ships. If you edit an example there, edit it here.
    await makeGitDir();
    await scaffold(root);

    const fullyConfigured = [
      'version: 1',
      'project:',
      '  baseBranch: master',
      '  epicBranchPattern: "epic/{n}-{slug}"',
      'planning:',
      '  format: bmad-v6',
      '  planningArtifacts: docs/planning-artifacts',
      '  implementationArtifacts: docs/implementation-artifacts',
      'setup:',
      '  install: pnpm install',
      'gates:',
      '  - { id: lint,      run: pnpm lint }',
      '  - { id: typecheck, run: pnpm typecheck }',
      '  - { id: unit,      run: pnpm test }',
      '  - { id: build,     run: pnpm build }',
      'services:',
      '  backend:',
      '    run: python manage.py runserver 8000',
      '    port: 8000',
      '    ready: { url: "http://localhost:8000/health", timeoutSec: 60 }',
      '    env: { DJANGO_SETTINGS_MODULE: config.settings.test }',
      '  frontend:',
      '    run: pnpm dev',
      '    port: 3000',
      '    ready: { url: "http://localhost:3000" }',
      'data:',
      '  reset: ./scripts/reset-test-db.sh',
      'observations:',
      '  company-count: { run: ./scripts/specwitness/company-count.sh }',
      'ai:',
      '  providers:',
      '    claude: { adapter: claude-code-cli, mode: subscription }',
      '    codex:  { adapter: codex-cli,       mode: chatgpt }',
      '  roles:',
      '    contract-author: codex',
      '    plan-author: codex',
      '    explainer: claude',
      '',
    ].join('\n');

    await writeFile(join(root, '.specwitness', 'config.yaml'), fullyConfigured, 'utf8');

    expect(() => loadConfig(root)).not.toThrow();
  });

  it('ships every example key that the fully-configured fixture uses', async () => {
    // Guards the duplication above: if the template drops or renames an example
    // key, the fixture is no longer mirroring it and the sync note is a lie.
    await makeGitDir();
    await scaffold(root);

    const template = await readFile(join(root, '.specwitness', 'config.yaml'), 'utf8');

    for (const key of [
      'epicBranchPattern',
      'planningArtifacts',
      'implementationArtifacts',
      'install:',
      'gates:',
      'services:',
      'port:',
      'ready:',
      'env:',
      'data:',
      'observations:',
      'providers:',
      'roles:',
      'contract-author:',
      'plan-author:',
      'explainer:',
    ]) {
      expect(template, `template should document ${key}`).toContain(key);
    }
  });
});
