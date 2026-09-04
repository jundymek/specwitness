/**
 * Corpus discovery and the fixture-immutability guard (story 6.1, Task 2).
 *
 * Filesystem only — no subprocess. Every case builds its own corpus root under the OS temp
 * directory, so the CHECKED-IN `fixtures/corpus/` tree is never touched by this file:
 * a test that mutated the real corpus in order to prove the corpus cannot be mutated would
 * be its own counter-example.
 *
 * ⚠️ **THE STANDING HAZARD, ONE LEVEL UP** (Epic 4 retro §2 observation 2). A criterion
 * nobody could adjudicate reported PASS because `skipped` is inert to `aggregate`. The
 * corpus version is worse: a fixture that does not run is a proof that does not exist, and
 * a green suite that ran nothing looks exactly like a green suite that ran everything. So
 * every way for the runner to see FEWER fixtures than exist has a test here, and each one
 * asserts a THROW rather than an empty list.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  describeTreeDrift,
  discoverFixtures,
  hashCorpusTree,
  machineStateReferences,
  nonLoopbackHosts,
} from '../../corpus/runner.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

/** A corpus root containing `fixtures`, each with a `project/` and an `expected.json`. */
async function makeCorpus(fixtures: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'specwitness-corpus-discovery-'));
  roots.push(root);
  for (const name of fixtures) {
    await mkdir(join(root, name, 'project'), { recursive: true });
    await writeFile(join(root, name, 'expected.json'), '{}\n', 'utf8');
    await writeFile(join(root, name, 'project', 'app.txt'), 'app\n', 'utf8');
  }
  return root;
}

describe('discovery', () => {
  it('finds every fixture directory, sorted, with its expectation path', async () => {
    const root = await makeCorpus(['beta', 'alpha']);

    const found = await discoverFixtures(root);

    expect(found.map((fixture) => fixture.name)).toEqual(['alpha', 'beta']);
    expect(found[0]?.expectedPath).toBe(join(root, 'alpha', 'expected.json'));
  });

  it('ignores README.md at the corpus root', async () => {
    const root = await makeCorpus(['alpha']);
    await writeFile(join(root, 'README.md'), '# corpus\n', 'utf8');

    expect((await discoverFixtures(root)).map((fixture) => fixture.name)).toEqual(['alpha']);
  });

  it('FAILS on an empty corpus rather than reporting nothing to run', async () => {
    // The single most important line in this file. An empty glob and a corpus that proves
    // nothing are the same event, and only a throw makes the second one visible.
    const root = await mkdtemp(join(tmpdir(), 'specwitness-corpus-discovery-'));
    roots.push(root);

    await expect(discoverFixtures(root)).rejects.toThrow(/empty corpus is a FAILURE/);
  });

  it('FAILS on a fixture directory it cannot understand', async () => {
    // A directory with no `project/` is a fixture the runner failed to parse, not a
    // directory to walk past. Walking past it is how a fixture stops running without
    // anybody noticing.
    const root = await makeCorpus(['alpha']);
    await mkdir(join(root, 'half-written'), { recursive: true });

    await expect(discoverFixtures(root)).rejects.toThrow(/half-written/);
  });

  it('FAILS on a stray file at the corpus root', async () => {
    const root = await makeCorpus(['alpha']);
    await writeFile(join(root, 'expected.json'), '{}\n', 'utf8');

    await expect(discoverFixtures(root)).rejects.toThrow(/stray file/);
  });
});

describe('the fixture-immutability guard', () => {
  it('reports no drift when nothing changed', async () => {
    const root = await makeCorpus(['alpha']);

    expect(describeTreeDrift(await hashCorpusTree(root), await hashCorpusTree(root))).toBe(null);
  });

  it('names a MODIFIED file', async () => {
    // The failure mode this closes is the one that ends the corpus: a runner that writes
    // into its own fixtures produces a corpus that drifts to match the product, silently,
    // and always in the direction that makes the suite green.
    const root = await makeCorpus(['alpha']);
    const before = await hashCorpusTree(root);
    await writeFile(join(root, 'alpha', 'expected.json'), '{"changed": true}\n', 'utf8');

    expect(describeTreeDrift(before, await hashCorpusTree(root))).toContain(
      'modified: alpha/expected.json',
    );
  });

  it('names an ADDED file', async () => {
    const root = await makeCorpus(['alpha']);
    const before = await hashCorpusTree(root);
    await writeFile(join(root, 'alpha', 'project', 'leftover.log'), 'oops\n', 'utf8');

    expect(describeTreeDrift(before, await hashCorpusTree(root))).toContain(
      'added: alpha/project/leftover.log',
    );
  });

  it('names a REMOVED file', async () => {
    const root = await makeCorpus(['alpha']);
    const before = await hashCorpusTree(root);
    await rm(join(root, 'alpha', 'project', 'app.txt'));

    expect(describeTreeDrift(before, await hashCorpusTree(root))).toContain(
      'removed: alpha/project/app.txt',
    );
  });

  it('notices a change that keeps the file SIZE identical', async () => {
    // Content-hashed, not stat'd. A one-character edit inside `expected.json` — `"pass"`
    // becoming `"fail"` — is exactly the drift that matters and exactly the drift a
    // size-or-mtime comparison would miss.
    const root = await makeCorpus(['alpha']);
    await writeFile(join(root, 'alpha', 'expected.json'), '"pass"\n', 'utf8');
    const before = await hashCorpusTree(root);
    await writeFile(join(root, 'alpha', 'expected.json'), '"fail"\n', 'utf8');

    expect(describeTreeDrift(before, await hashCorpusTree(root))).toContain('modified:');
  });
});

describe('the hermeticity scanners over checked-in fixture text', () => {
  /** A project directory containing one file with the given text. */
  async function project(text: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'specwitness-corpus-scan-'));
    roots.push(root);
    await mkdir(join(root, 'project', '.specwitness'), { recursive: true });
    await writeFile(join(root, 'project', '.specwitness', 'config.yaml'), text, 'utf8');
    return join(root, 'project');
  }

  it('reports a host that is not loopback', async () => {
    expect(
      await nonLoopbackHosts(await project('url: https://api.example.com/health\n')),
    ).toEqual(['api.example.com']);
  });

  it('accepts 127.0.0.1 and localhost', async () => {
    expect(
      await nonLoopbackHosts(
        await project('a: http://127.0.0.1:4000/health\nb: http://localhost:4001/x\n'),
      ),
    ).toEqual([]);
  });

  it('accepts a BRACKETED IPv6 loopback authority', async () => {
    // `[::1]:8080` split on `:` yields `[`, so a naive parse reports a legitimate loopback
    // fixture as reaching the network. A FALSE POSITIVE is the expensive direction in this
    // guard: it fails a correct fixture and teaches the next author that the check is noise.
    expect(await nonLoopbackHosts(await project('url: http://[::1]:8080/health\n'))).toEqual([]);
  });

  it('still reports a bracketed IPv6 address that is NOT loopback', async () => {
    expect(
      await nonLoopbackHosts(await project('url: http://[2001:db8::1]:8080/health\n')),
    ).toEqual(['[2001:db8::1]']);
  });

  it('accepts a loopback host whose port is still a placeholder', async () => {
    // The authority a checked-in fixture actually carries, before substitution.
    expect(
      await nonLoopbackHosts(await project('url: http://127.0.0.1:{{PORT:app}}/health\n')),
    ).toEqual([]);
  });

  it('reports a reference to a credential store', async () => {
    // NFR-1, AD-4, Q59 — checked where committed executable content enters the repository,
    // rather than trusted to review.
    // Two needles match this one line — `~/.claude` and `.claude/credentials` — and both
    // are reported. Overlapping patterns are fine here: the output is a list of reasons a
    // human reads, not a count anything branches on.
    expect(
      await machineStateReferences(await project('run: cat ~/.claude/credentials.json\n')),
    ).toEqual([
      '.specwitness/config.yaml: .claude/credentials',
      '.specwitness/config.yaml: ~/.claude',
    ]);
  });

  it('reports a reference to the invoking user home directory', async () => {
    expect(
      await machineStateReferences(await project('run: node $HOME/tool.js\n')),
    ).toEqual(['.specwitness/config.yaml: $HOME']);
  });
});
