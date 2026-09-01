/**
 * Story 3.1 AC1 — resolving a revision to a COMMIT sha, and never fetching.
 *
 * Two properties here are load-bearing far beyond their size:
 *
 *  1. The `^{commit}` peel. An annotated tag resolves to the TAG OBJECT's sha
 *     without it, so the worktree would be created at a revision the run record
 *     does not name — evidence describing something that was never verified.
 *  2. No implicit fetch. It is asserted the only way that means anything: by
 *     byte-comparing every ref in the repository before and after a failed
 *     resolution. An implicit fetch would make the verdict depend on network
 *     state AND would write to the source repository, in the one story whose
 *     whole point is that the repository is read-only.
 */

import { rm } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { SystemClock } from '../../../src/infra/clock.js';
import { createProcessRunner } from '../../../src/infra/process-runner.js';
import { createGitVcs } from '../../../src/infra/vcs.js';
import type { RepoRoot } from '../../../src/domain/vcs.js';
import { git, makeRepo, refsSnapshot, type FixtureRepo } from './fixture-repo.js';

const scratches: string[] = [];

afterEach(async () => {
  await Promise.all(scratches.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function vcs(): ReturnType<typeof createGitVcs> {
  return createGitVcs({ runner: createProcessRunner(new SystemClock()) });
}

async function repoWithRoot(label: string): Promise<{ repo: FixtureRepo; root: RepoRoot }> {
  const repo = await makeRepo(label);
  scratches.push(repo.scratch);
  const resolved = await vcs().resolveRoot({ explicitRoot: repo.path, cwd: repo.path });
  if (resolved.outcome !== 'resolved') {
    throw new Error(`fixture root did not resolve: ${resolved.outcome}`);
  }
  return { repo, root: resolved.root };
}

describe('resolveRef — resolution', () => {
  it('resolves a branch name to its commit sha', async () => {
    const { repo, root } = await repoWithRoot('ref-branch');

    const result = await vcs().resolveRef(root, 'head', 'main');

    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.sha).toBe(repo.headSha);
    expect(result.role).toBe('head');
  });

  it('resolves a full sha to itself', async () => {
    const { repo, root } = await repoWithRoot('ref-sha');

    const result = await vcs().resolveRef(root, 'base', repo.firstSha);

    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.sha).toBe(repo.firstSha);
  });

  it('resolves a remote-tracking ref that exists locally', async () => {
    const { repo, root } = await repoWithRoot('ref-remote');
    // A remote-tracking ref, created WITHOUT a network: this is the
    // `origin/epic/7-slug` shape AC1 names, and it must resolve from the
    // local ref store alone.
    await git(repo.path, 'update-ref', 'refs/remotes/origin/epic/7-slug', repo.headSha);

    const result = await vcs().resolveRef(root, 'head', 'origin/epic/7-slug');

    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.sha).toBe(repo.headSha);
  });
});

describe('resolveRef — the annotated-tag peel', () => {
  it('resolves an annotated tag to the COMMIT, not the tag object', async () => {
    const { repo, root } = await repoWithRoot('ref-tag');

    const result = await vcs().resolveRef(root, 'head', repo.tagName);

    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    // The whole point. Without `^{commit}` this is `repo.tagObjectSha`, the
    // worktree gets created at a revision nothing reports, and the run's
    // evidence describes a commit that was never checked out.
    expect(result.sha).toBe(repo.firstSha);
    expect(result.sha).not.toBe(repo.tagObjectSha);
  });

  it("proves the fixture's tag object and commit really do differ", async () => {
    const { repo } = await repoWithRoot('ref-tag-distinct');

    // Guards the test above from becoming vacuous: if a future git made an
    // annotated tag resolve to its commit directly, the peel assertion would
    // pass for the wrong reason and nobody would notice.
    expect(repo.tagObjectSha).not.toBe(repo.firstSha);
    const objectType = (await git(repo.path, 'cat-file', '-t', repo.tagName)).trim();
    expect(objectType).toBe('tag');
  });
});

describe('resolveRef — a missing ref, and the no-fetch guarantee', () => {
  it('reports not-found for a ref that exists on no remote we have', async () => {
    const { root } = await repoWithRoot('ref-missing');

    const result = await vcs().resolveRef(root, 'head', 'origin/epic/99-never-fetched');

    expect(result.outcome).toBe('not-found');
    if (result.outcome === 'resolved') return;
    expect(result.ref).toBe('origin/epic/99-never-fetched');
    expect(result.role).toBe('head');
  });

  it('does NOT fetch: every ref is byte-identical after the failure', async () => {
    const { repo, root } = await repoWithRoot('ref-nofetch');
    // A remote that would answer if anyone ever contacted it. Nothing here
    // should: the assertion below is that the ref store is untouched.
    await git(repo.path, 'remote', 'add', 'origin', 'https://example.invalid/repo.git');

    const before = await refsSnapshot(repo.path);
    const result = await vcs().resolveRef(root, 'head', 'origin/epic/99-never-fetched');
    const after = await refsSnapshot(repo.path);

    expect(result.outcome).toBe('not-found');
    // Byte comparison: a new ref, a moved ref or a deleted one all show up.
    expect(after).toBe(before);
  });

  it('reports not-found for a base ref too, naming the base role', async () => {
    const { root } = await repoWithRoot('ref-missing-base');

    // A base that does not resolve is still an error. Recording a null base
    // would silently disable the v2 differential feature the run record exists
    // to accommodate.
    const result = await vcs().resolveRef(root, 'base', 'no-such-base-branch');

    expect(result.outcome).toBe('not-found');
    if (result.outcome === 'resolved') return;
    expect(result.role).toBe('base');
  });

  it('does not mistake a nonexistent ref for a valid one (no --verify echo)', async () => {
    const { root } = await repoWithRoot('ref-echo');

    // Without `--verify`, `git rev-parse nonsense` prints `nonsense` and exits
    // 0 — so this asserts the flag is actually there.
    const result = await vcs().resolveRef(root, 'head', 'definitely-not-a-ref');

    expect(result.outcome).not.toBe('resolved');
  });
});

describe('resolveRef — ambiguity', () => {
  it('refuses an ambiguous short name and lists what matched', async () => {
    const { repo, root } = await repoWithRoot('ref-ambiguous');
    // One name answered by both a branch and a tag: git calls this ambiguous
    // and so do we, because picking one would silently verify the other's
    // revision half the time.
    await git(repo.path, 'branch', 'release', repo.firstSha);
    await git(repo.path, 'tag', 'release', repo.headSha);

    const result = await vcs().resolveRef(root, 'head', 'release');

    expect(result.outcome).toBe('ambiguous');
    if (result.outcome !== 'ambiguous') return;
    expect(result.candidates).toContain('refs/heads/release');
    expect(result.candidates).toContain('refs/tags/release');
  });

  it('proves git itself would have picked one silently', async () => {
    const { repo, root } = await repoWithRoot('ref-ambiguous-silent');
    await git(repo.path, 'branch', 'release', repo.firstSha);
    await git(repo.path, 'tag', 'release', repo.headSha);

    // This is why the adapter cannot trust a zero exit code. git resolves the
    // ambiguous name, exits 0, and picks by precedence — so an operator who
    // meant the branch would silently get the tag's revision. Asserted here so
    // that if a future git ever starts failing instead, the reason this
    // refusal exists is still on record rather than looking like paranoia.
    const picked = (await git(repo.path, 'rev-parse', '--verify', 'release^{commit}')).trim();
    expect([repo.firstSha, repo.headSha]).toContain(picked);

    const result = await vcs().resolveRef(root, 'head', 'release');
    expect(result.outcome).toBe('ambiguous');
  });

  it('does NOT refuse a branch and its remote-tracking ref at the same commit', async () => {
    const { repo, root } = await repoWithRoot('ref-same-commit');
    // The everyday case: `main` and `origin/main` both exist and agree.
    // Refusing this would fail runs for no reason, so ambiguity is decided on
    // the COMMITS the candidates resolve to, not on how many refs matched.
    await git(repo.path, 'update-ref', 'refs/remotes/main/HEAD', repo.headSha);

    const result = await vcs().resolveRef(root, 'head', 'main');

    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.sha).toBe(repo.headSha);
  });
});
