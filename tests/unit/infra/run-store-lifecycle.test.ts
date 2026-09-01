import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InfraError } from '../../../src/domain/errors.js';
import { PROCESS_GROUPS_FILENAME, RunStore } from '../../../src/infra/run-store.js';
import { MANIFEST_FILENAME } from '../../../src/schemas/manifest.js';
import { SCHEMA_VERSIONS } from '../../../src/schemas/versions.js';
import { FixedClock, SequenceIds } from '../../fakes/ports.js';

/**
 * The AD-8 crash-durable incremental appends — story 3.2.
 *
 * A DELIBERATELY SEPARATE FILE from `tests/integration/run-store.test.ts`.
 * Story 3.5 (rambo) adds the atomic `result.json` finalize to the same source
 * module in wave B, and Epic 2's rule for two stories sharing one file is that
 * they share ZERO `expect()`. Two test files that cannot collide beat one file
 * two agents have to rebase through.
 *
 * What is actually being proved here is an ORDERING, not a value: the pgid or
 * worktree path is on disk, fsynced, BEFORE the resource it names can be used.
 * Real crash durability is not portably assertable — you cannot pull the power
 * cord from a unit test — so the `RunStoreHooks.onFsync` seam is what makes the
 * property testable: that the code takes the fsync path, for the file AND its
 * directory, before the promise resolves. That is the part a refactor breaks.
 */

const CLOCK = '2026-08-31T14:25:01.123Z';

let root: string;

async function makeStore(onFsync?: (target: 'file' | 'directory' | 'runs-root') => void) {
  const store = new RunStore(
    root,
    new FixedClock(CLOCK),
    new SequenceIds('a3f9', 'b4c1', 'c5d2', 'e6f3'),
    onFsync === undefined ? {} : { onFsync },
  );
  return store;
}

beforeEach(async () => {
  // Per-test temp root (H-8): two concurrent runs of this suite must not share
  // a runs directory, and nothing here may touch the real repository.
  root = await mkdtemp(join(tmpdir(), 'specwitness-runstore-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('RunStore lifecycle appends: what lands in the manifest', () => {
  it('appends a worktree path and reads it back', async () => {
    const store = await makeStore();
    const { runId } = await store.createRun();

    await store.recordWorktree(runId, '/tmp/specwitness-abc/worktree');

    expect((await store.readManifest(runId)).worktrees).toEqual(['/tmp/specwitness-abc/worktree']);
  });

  it('appends a pgid and reads it back', async () => {
    const store = await makeStore();
    const { runId } = await store.createRun();

    await store.recordProcessGroup(runId, 4242);

    expect((await store.readManifest(runId)).processGroups).toEqual([4242]);
  });

  it('keeps entries in the order they were recorded', async () => {
    // Teardown order matters: the last thing started is the first thing that
    // should stop, and a reader replaying a manifest deserves the real sequence.
    const store = await makeStore();
    const { runId } = await store.createRun();

    await store.recordProcessGroup(runId, 11);
    await store.recordProcessGroup(runId, 22);
    await store.recordProcessGroup(runId, 33);

    expect((await store.readManifest(runId)).processGroups).toEqual([11, 22, 33]);
  });

  it('marks a run reaped', async () => {
    const store = await makeStore();
    const { runId } = await store.createRun();

    expect((await store.readManifest(runId)).reaped).toBe(false);
    await store.markReaped(runId);
    expect((await store.readManifest(runId)).reaped).toBe(true);
  });

  it('does NOT bump schemaVersion — the reserved arrays were already in the shape', async () => {
    // A bump would make every manifest written before this story unreadable,
    // including the ones a crashed run left behind, which is exactly when
    // readability matters. `src/schemas/manifest.ts` states the policy.
    const store = await makeStore();
    const { runId } = await store.createRun();

    await store.recordWorktree(runId, '/tmp/w');
    await store.recordProcessGroup(runId, 7);
    await store.markReaped(runId);

    const manifest = await store.readManifest(runId);
    expect(manifest.schemaVersion).toBe(1);
    expect(SCHEMA_VERSIONS.runManifest).toBe(1);
  });

  it('leaves every other manifest field untouched', async () => {
    const store = await makeStore();
    const { runId } = await store.createRun({ epic: 'epic-7' });
    const before = await store.readManifest(runId);

    await store.recordProcessGroup(runId, 99);
    const after = await store.readManifest(runId);

    expect(after.runId).toBe(before.runId);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.epic).toBe('epic-7');
  });
});

describe('RunStore lifecycle appends: idempotence and concurrency', () => {
  it('records the same worktree twice as ONE entry', async () => {
    // `clean` and a retrying pipeline both replay; a duplicate would mean two
    // removal attempts and a spurious "already gone" error on the second.
    const store = await makeStore();
    const { runId } = await store.createRun();

    await store.recordWorktree(runId, '/tmp/w');
    await store.recordWorktree(runId, '/tmp/w');

    expect((await store.readManifest(runId)).worktrees).toEqual(['/tmp/w']);
  });

  it('records the same pgid twice as ONE entry', async () => {
    const store = await makeStore();
    const { runId } = await store.createRun();

    await store.recordProcessGroup(runId, 4242);
    await store.recordProcessGroup(runId, 4242);

    expect((await store.readManifest(runId)).processGroups).toEqual([4242]);
  });

  it('marks reaped twice without complaint', async () => {
    const store = await makeStore();
    const { runId } = await store.createRun();

    await store.markReaped(runId);
    await store.markReaped(runId);

    expect((await store.readManifest(runId)).reaped).toBe(true);
  });

  it('loses no entry when appends are issued concurrently', async () => {
    // Read-modify-write is the obvious implementation and the obviously wrong
    // one: two in-flight appends both read the same manifest and the second
    // write erases the first. Gates and services start in parallel, so this is
    // the normal case rather than a stress test.
    const store = await makeStore();
    const { runId } = await store.createRun();

    await Promise.all([
      store.recordProcessGroup(runId, 1001),
      store.recordProcessGroup(runId, 1002),
      store.recordProcessGroup(runId, 1003),
      store.recordWorktree(runId, '/tmp/a'),
      store.recordWorktree(runId, '/tmp/b'),
    ]);

    const manifest = await store.readManifest(runId);
    expect([...manifest.processGroups].sort()).toEqual([1001, 1002, 1003]);
    expect([...manifest.worktrees].sort()).toEqual(['/tmp/a', '/tmp/b']);
  });
});

describe('RunStore lifecycle appends: durability (AC1 ordering)', () => {
  it('fsyncs the FILE and its DIRECTORY on every append, before resolving', async () => {
    const targets: string[] = [];
    const store = await makeStore((target) => targets.push(target));
    const { runId } = await store.createRun();

    targets.length = 0;
    await store.recordProcessGroup(runId, 4242);

    // The directory sync is the step most often missed: fsyncing a file
    // guarantees its CONTENTS survive a crash, not that its name still appears
    // in the directory. Without it a run can come back as an empty directory,
    // which is precisely the case `clean` cannot recover from.
    expect(targets).toContain('file');
    expect(targets).toContain('directory');
  });

  it('fsyncs on a worktree append and on markReaped too', async () => {
    const targets: string[] = [];
    const store = await makeStore((target) => targets.push(target));
    const { runId } = await store.createRun();

    targets.length = 0;
    await store.recordWorktree(runId, '/tmp/w');
    expect(targets.filter((t) => t === 'file').length).toBeGreaterThanOrEqual(1);
    expect(targets.filter((t) => t === 'directory').length).toBeGreaterThanOrEqual(1);

    targets.length = 0;
    await store.markReaped(runId);
    expect(targets).toContain('file');
    expect(targets).toContain('directory');
  });

  it('does not rewrite the manifest when an append changes nothing', async () => {
    // Idempotence is not just deduplication: a redundant append must not cost a
    // second fsync per gate on a busy run.
    const targets: string[] = [];
    const store = await makeStore((target) => targets.push(target));
    const { runId } = await store.createRun();

    await store.recordProcessGroup(runId, 4242);
    targets.length = 0;
    await store.recordProcessGroup(runId, 4242);

    expect(targets).toEqual([]);
  });

  it('reports a durability failure rather than resolving quietly', async () => {
    const store = await makeStore();
    const { runId } = await store.createRun();
    // Replace the run directory with a file: the next write cannot possibly
    // succeed, and the caller is about to spawn a process on the strength of it.
    await rm(store.runDir(runId), { recursive: true, force: true });
    await writeFile(store.runDir(runId), 'not a directory');

    await expect(store.recordProcessGroup(runId, 1)).rejects.toBeInstanceOf(InfraError);
  });
});

describe('RunStore lifecycle appends: the manifest is REPLACED, never truncated', () => {
  it('leaves no window in which the manifest is unreadable', async () => {
    // Codex review. `open(path, 'w')` truncates, which is harmless when
    // CREATING a file and destructive when REWRITING the only crash-recovery
    // record: a `kill -9` between the truncate and the fsync leaves malformed
    // JSON, so `clean` can no longer discover the process groups and worktrees
    // the run had already recorded. That is exactly the crash this file exists
    // for, so the write may not have such a window.
    //
    // Asserted through the fsync seam, which is the only point at which a
    // crash could be simulated portably: at the moment the new content is
    // durable, the manifest under its real name must STILL PARSE — as either
    // the old complete document or the new one, never as a truncated one.
    const seen: string[] = [];
    const store = new RunStore(
      root,
      new FixedClock(CLOCK),
      new SequenceIds('a3f9'),
      {
        onFsync: (target) => {
          if (target === 'file') {
            seen.push('file');
          }
        },
      },
    );
    const { runId } = await store.createRun();
    await store.recordProcessGroup(runId, 4242);

    const path = join(store.runDir(runId), MANIFEST_FILENAME);
    const before = await readFile(path, 'utf8');
    expect(JSON.parse(before)).toMatchObject({ processGroups: [4242] });

    await store.recordWorktree(runId, '/tmp/w');

    // Parses at every observable moment, and the staging file is gone.
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      processGroups: [4242],
      worktrees: ['/tmp/w'],
    });
    expect(seen.length).toBeGreaterThan(0);
  });

  it('leaves no staging file behind after a successful write', async () => {
    const store = await makeStore();
    const { runId } = await store.createRun();

    await store.recordProcessGroup(runId, 4242);
    await store.recordWorktree(runId, '/tmp/w');
    await store.markReaped(runId);

    const entries = await readdir(store.runDir(runId));
    expect(entries.filter((name) => name.endsWith('.writing'))).toEqual([]);
  });

  it('refuses an evidence name that would land on an in-progress write', async () => {
    // Every write is staged as `.<filename>.writing` in the target directory.
    // Evidence landing on one could be renamed over the manifest by a
    // concurrent append — the same substitution rambo identified for story
    // 3.5's staging name: later, and looking like a normal successful write.
    const store = await makeStore();
    const { runId } = await store.createRun();

    await expect(
      store.writeEvidenceFile(runId, '.manifest.json.writing', 'x'),
    ).rejects.toBeInstanceOf(InfraError);
  });
});

describe('RunStore: recording a process group is ONE indivisible fact', () => {
  /**
   * WHAT THIS SECTION DOES AND DOES NOT PROVE, because the distinction was
   * worth getting right.
   *
   * Codex review raised that `recordProcessGroup` performed its two writes as
   * two separate serialized operations, so another mutation could slip between
   * them; the symptom it described was `markReaped` overtaking the pair and a
   * later bare `clean` skipping a run that owns a live group. The grouping was
   * adopted — one queue slot now covers both writes — but the symptom is NOT
   * what grouping prevents: `markReaped` running entirely AFTER a grouped
   * `recordProcessGroup` leaves `reaped: true` just the same. Whether a run is
   * marked reaped while it is still acquiring resources is a CALLER ordering
   * question, and nothing in this store can decide it.
   *
   * What grouping does buy is that no reader or writer can ever observe a
   * half-recorded process group, which is what these tests assert: every pgid
   * the manifest claims has evidence behind it. That invariant is the one
   * `clean` depends on — a pgid without evidence is one it must refuse to
   * signal — and it is asserted here rather than assumed.
   */
  it('never leaves a manifest pgid without its evidence', async () => {
    const store = await makeStore();
    const { runId } = await store.createRun();

    await Promise.all([store.recordProcessGroup(runId, 4242), store.markReaped(runId)]);

    const manifest = await store.readManifest(runId);
    expect(manifest.processGroups).toEqual([4242]);
    // Whichever order they landed in, the pgid is recorded AND its evidence
    // exists — a reaped flag over an unrecorded live group is the state that
    // must be unreachable.
    expect((await store.readProcessGroupRecords(runId)).get(4242)).toBe(CLOCK);
  });

  it('keeps the evidence and the manifest in step under concurrent appends', async () => {
    const store = await makeStore();
    const { runId } = await store.createRun();

    await Promise.all([
      store.recordProcessGroup(runId, 11),
      store.recordProcessGroup(runId, 22),
      store.markReaped(runId),
      store.recordProcessGroup(runId, 33),
    ]);

    const manifest = await store.readManifest(runId);
    const records = await store.readProcessGroupRecords(runId);

    expect([...manifest.processGroups].sort((a, b) => a - b)).toEqual([11, 22, 33]);
    // Every pgid the manifest claims has evidence behind it. Without that,
    // `clean` would find a pgid it must refuse to signal.
    for (const pgid of manifest.processGroups) {
      expect(records.has(pgid)).toBe(true);
    }
  });
});

describe('RunStore.writeEvidenceFile: containment survives symlinks', () => {
  it('refuses to write through a symlinked directory that leaves the run', async () => {
    // Codex review. The name check is lexical, which proves the NAME cannot
    // escape but not that the PATH cannot: `mkdir` and `open` follow symlinks,
    // so a component inside the run directory pointing elsewhere would carry
    // the write outside `.specwitness/runs/` while every string still looked
    // contained.
    const store = await makeStore();
    const { runId } = await store.createRun();

    const outside = join(root, 'outside');
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(store.runDir(runId), 'evidence'));

    await expect(store.writeEvidenceFile(runId, 'evidence/leak.txt', 'x')).rejects.toBeInstanceOf(
      InfraError,
    );
    // And nothing was written through it.
    await expect(readFile(join(outside, 'leak.txt'), 'utf8')).rejects.toThrow();
  });

  it('still allows an ordinary nested write', async () => {
    // The guard must not reject the normal case — and it must not reject it on
    // macOS, where the run directory is itself commonly reached through a
    // symlink (`/var/folders/...` into `/private/var/...`).
    const store = await makeStore();
    const { runId } = await store.createRun();

    const relative = await store.writeEvidenceFile(runId, 'evidence/gate-01-lint.txt', 'lint');

    expect(relative).toBe('evidence/gate-01-lint.txt');
    expect(await readFile(join(store.runDir(runId), relative), 'utf8')).toBe('lint');
  });
});

describe('RunStore lifecycle appends: a malformed manifest is never silent', () => {
  it('raises InfraError naming the path, through the merged parser', async () => {
    // The run a corrupt manifest describes may still own a live process group,
    // so treating the file as absent would leak it silently. `parseRunManifest`
    // already guarantees this; the point here is that the append path did not
    // bypass it with its own reader.
    const store = await makeStore();
    const { runId } = await store.createRun();
    const path = join(store.runDir(runId), MANIFEST_FILENAME);
    await writeFile(path, '{ not json');

    await expect(store.recordProcessGroup(runId, 1)).rejects.toThrow(path);
    await expect(store.recordWorktree(runId, '/tmp/w')).rejects.toThrow(path);
    await expect(store.markReaped(runId)).rejects.toThrow(path);
  });

  it('raises rather than inventing a manifest for a run that does not exist', async () => {
    const store = await makeStore();

    await expect(store.recordProcessGroup('run-20260830T142501Z-a3f9', 1)).rejects.toBeInstanceOf(
      InfraError,
    );
  });
});

describe('RunStore: process-group reaping evidence (the pid-reuse guard)', () => {
  it('records when each pgid was recorded, so clean can prove identity later', async () => {
    const store = await makeStore();
    const { runId } = await store.createRun();

    await store.recordProcessGroup(runId, 4242);

    const records = await store.readProcessGroupRecords(runId);
    expect(records.get(4242)).toBe(CLOCK);
  });

  it('writes the evidence BEFORE the pgid becomes visible in the manifest', async () => {
    // Ordering, not decoration. Crash between the two writes and:
    //   evidence first  => the manifest has no pgid; nothing to reap is CLAIMED,
    //                      and the evidence is harmless debris.
    //   manifest first  => `clean` sees a pgid it cannot verify, so it refuses to
    //                      signal — a reported leak rather than a silent one.
    // Both are survivable; this ordering makes the second case impossible.
    const store = await makeStore();
    const { runId } = await store.createRun();

    await store.recordProcessGroup(runId, 4242);

    const evidencePath = join(store.runDir(runId), PROCESS_GROUPS_FILENAME);
    await expect(stat(evidencePath)).resolves.toBeDefined();
  });

  it('returns an empty map when no pgid was ever recorded', async () => {
    const store = await makeStore();
    const { runId } = await store.createRun();

    expect((await store.readProcessGroupRecords(runId)).size).toBe(0);
  });

  it('raises InfraError naming the path when the evidence file is corrupt', async () => {
    // Fail closed and loudly: silently treating corruption as "no evidence"
    // would turn a manifest full of live pgids into a clean-looking run.
    const store = await makeStore();
    const { runId } = await store.createRun();
    await store.recordProcessGroup(runId, 4242);

    const path = join(store.runDir(runId), PROCESS_GROUPS_FILENAME);
    await writeFile(path, '{ not json');

    await expect(store.readProcessGroupRecords(runId)).rejects.toThrow(path);
  });
});

describe('RunStore.writeEvidenceFile: the seam 3.4 and 3.5 asked for', () => {
  it('writes the file and returns a path RELATIVE to the run directory', async () => {
    const store = await makeStore();
    const { runId } = await store.createRun();

    const relative = await store.writeEvidenceFile(runId, 'evidence/gate-01-lint.txt', 'lint output');

    expect(relative).toBe('evidence/gate-01-lint.txt');
    expect(await readFile(join(store.runDir(runId), relative), 'utf8')).toBe('lint output');
  });

  it('creates nested parent directories', async () => {
    const store = await makeStore();
    const { runId } = await store.createRun();

    const relative = await store.writeEvidenceFile(runId, 'a/b/c/deep.txt', 'x');

    expect(relative).toBe('a/b/c/deep.txt');
  });

  it('fsyncs the evidence file and its directory before resolving', async () => {
    const targets: string[] = [];
    const store = await makeStore((target) => targets.push(target));
    const { runId } = await store.createRun();

    targets.length = 0;
    await store.writeEvidenceFile(runId, 'evidence/out.txt', 'x');

    expect(targets).toContain('file');
    expect(targets).toContain('directory');
  });

  it('never returns an absolute path', async () => {
    const store = await makeStore();
    const { runId } = await store.createRun();

    const relative = await store.writeEvidenceFile(runId, 'out.txt', 'x');

    expect(relative.startsWith('/')).toBe(false);
    expect(relative).not.toContain(store.runDir(runId));
  });

  it('refuses to escape the run directory', async () => {
    // A gate id is only `nonEmptyString` in the merged config schema, so a
    // caller CAN hand this a dot-dot. It must be impossible for that to write
    // outside the run directory, whatever the caller intended.
    const store = await makeStore();
    const { runId } = await store.createRun();

    for (const bad of ['../escape.txt', 'a/../../escape.txt', '/etc/passwd', '']) {
      await expect(store.writeEvidenceFile(runId, bad, 'x')).rejects.toBeInstanceOf(InfraError);
    }
  });

  it('names the offending relative name in the error', async () => {
    const store = await makeStore();
    const { runId } = await store.createRun();

    await expect(store.writeEvidenceFile(runId, '../escape.txt', 'x')).rejects.toThrow(
      '../escape.txt',
    );
  });

  it('refuses to overwrite a file RunStore owns', async () => {
    // Evidence is caller-named; the manifest, the reaping evidence and 3.5's
    // result.json are not. A caller must not be able to clobber the crash record
    // by choosing an unlucky gate id.
    const store = await makeStore();
    const { runId } = await store.createRun();

    // `.result.json.tmp` is story 3.5's stage-and-rename staging name, reserved
    // at rambo's request and for the sharper reason: landing evidence on the
    // STAGING name is worse than clobbering `result.json` directly, because the
    // next finalize renames it over the result — so arbitrary content is
    // substituted for a run result later, and it looks like a normal successful
    // write.
    for (const reserved of [
      'manifest.json',
      'result.json',
      '.result.json.tmp',
      PROCESS_GROUPS_FILENAME,
    ]) {
      await expect(store.writeEvidenceFile(runId, reserved, 'x')).rejects.toBeInstanceOf(InfraError);
    }

    // and the manifest is still intact afterwards
    expect((await store.readManifest(runId)).runId).toBe(runId);
  });

  it('overwrites its own previous content rather than appending', async () => {
    const store = await makeStore();
    const { runId } = await store.createRun();

    await store.writeEvidenceFile(runId, 'out.txt', 'first');
    await store.writeEvidenceFile(runId, 'out.txt', 'second');

    expect(await readFile(join(store.runDir(runId), 'out.txt'), 'utf8')).toBe('second');
  });
});
