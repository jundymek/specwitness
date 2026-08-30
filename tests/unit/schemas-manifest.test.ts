/**
 * Story 1.6 AC1 — the run manifest schema (AD-5).
 *
 * The manifest is the crash-recovery record: story 3.2's `clean` replays these
 * files to reap worktrees and process groups left behind by a killed run. So
 * the shape is a contract, and the version-mismatch policy lives here rather
 * than in the shared registry (bob and I agreed the split deliberately — what
 * a mismatch MEANS is artifact-specific).
 */

import { describe, expect, it } from 'vitest';

import { InfraError } from '../../src/domain/errors.js';
import {
  RUN_MANIFEST_VERSION,
  RunManifestSchema,
  newRunManifest,
  parseRunManifest,
} from '../../src/schemas/manifest.js';
import { SCHEMA_VERSIONS, schemaVersionFor } from '../../src/schemas/versions.js';

const VALID = {
  schemaVersion: 1,
  runId: 'run-20260830T142501Z-a3f9',
  createdAt: '2026-08-30T14:25:01.123Z',
  epic: 'epic-7',
  worktrees: [],
  processGroups: [],
  reaped: false,
};

describe('registry wiring (AD-5)', () => {
  it('registers the manifest version in the shared registry', () => {
    // The one-line addition to story 1.2's registry, read through its
    // accessor rather than by indexing the object.
    expect(schemaVersionFor('runManifest')).toBe(RUN_MANIFEST_VERSION);
    expect(SCHEMA_VERSIONS.runManifest).toBe(1);
  });
});

describe('newRunManifest (AC1 skeleton)', () => {
  it('builds exactly the documented skeleton', () => {
    const manifest = newRunManifest({
      runId: 'run-20260830T142501Z-a3f9',
      createdAt: new Date('2026-08-30T14:25:01.123Z'),
      epic: 'epic-7',
    });

    expect(manifest).toStrictEqual({
      schemaVersion: 1,
      runId: 'run-20260830T142501Z-a3f9',
      createdAt: '2026-08-30T14:25:01.123Z',
      epic: 'epic-7',
      worktrees: [],
      processGroups: [],
      reaped: false,
    });
  });

  it('records a null epic when none was given, rather than omitting the key', () => {
    // Present-and-null, not absent: story 3.2 reads these files back and an
    // absent key is indistinguishable from an older writer's omission.
    const manifest = newRunManifest({
      runId: 'run-20260830T142501Z-a3f9',
      createdAt: new Date('2026-08-30T14:25:01.000Z'),
    });

    expect(manifest.epic).toBeNull();
    expect(Object.keys(manifest)).toContain('epic');
  });

  it('writes timestamps as ISO-8601 UTC with full precision', () => {
    const manifest = newRunManifest({
      runId: 'run-20260830T142501Z-a3f9',
      createdAt: new Date('2026-08-30T14:25:01.123Z'),
    });

    // Milliseconds are kept here even though the run id truncates to seconds.
    expect(manifest.createdAt).toBe('2026-08-30T14:25:01.123Z');
    expect(manifest.createdAt.endsWith('Z')).toBe(true);
  });

  it('reserves the resource arrays empty for story 3.2', () => {
    const manifest = newRunManifest({
      runId: 'run-20260830T142501Z-a3f9',
      createdAt: new Date('2026-08-30T14:25:01.000Z'),
    });

    expect(manifest.worktrees).toStrictEqual([]);
    expect(manifest.processGroups).toStrictEqual([]);
    expect(manifest.reaped).toBe(false);
  });
});

describe('RunManifestSchema', () => {
  it('accepts the skeleton', () => {
    expect(RunManifestSchema.safeParse(VALID).success).toBe(true);
  });

  it('accepts populated resource arrays, so 3.2 needs no schema break', () => {
    const populated = {
      ...VALID,
      worktrees: ['/tmp/specwitness-abc/head'],
      processGroups: [12345, 12346],
      reaped: true,
    };

    expect(RunManifestSchema.safeParse(populated).success).toBe(true);
  });

  it.each([
    ['a malformed runId', { ...VALID, runId: 'nonsense' }],
    ['a non-UTC createdAt', { ...VALID, createdAt: '2026-08-30T14:25:01+05:30' }],
    ['a createdAt that is not a timestamp', { ...VALID, createdAt: 'yesterday' }],
    ['a missing runId', { ...VALID, runId: undefined }],
    ['a missing schemaVersion', { ...VALID, schemaVersion: undefined }],
    ['a non-integer schemaVersion', { ...VALID, schemaVersion: 1.5 }],
    ['a non-array worktrees', { ...VALID, worktrees: 'none' }],
    ['a non-integer pgid', { ...VALID, processGroups: [1.5] }],
    ['a non-boolean reaped', { ...VALID, reaped: 'no' }],
  ])('rejects %s', (_label, candidate) => {
    expect(RunManifestSchema.safeParse(candidate).success).toBe(false);
  });

  it('rejects unknown keys rather than silently dropping them', () => {
    // Strict on read: a key we do not understand means a newer writer, and
    // silently discarding it would lose a worktree path story 3.2 needs.
    const extra = { ...VALID, somethingNew: true };
    expect(RunManifestSchema.safeParse(extra).success).toBe(false);
  });
});

describe('parseRunManifest — the mismatch policy (AD-5)', () => {
  it('returns the parsed manifest for a current-version file', () => {
    const manifest = parseRunManifest(JSON.stringify(VALID), '/runs/x/manifest.json');
    expect(manifest.runId).toBe('run-20260830T142501Z-a3f9');
  });

  it('throws InfraError naming the file when the JSON is unparseable', () => {
    // Never a crash and never a silent skip: a corrupt manifest means a
    // worktree may still be on disk, and pretending the run does not exist
    // would leak it forever.
    expect(() => parseRunManifest('{not json', '/runs/x/manifest.json')).toThrow(InfraError);
    expect(() => parseRunManifest('{not json', '/runs/x/manifest.json')).toThrow(
      /\/runs\/x\/manifest\.json/,
    );
  });

  it('throws InfraError naming the file when the shape is wrong', () => {
    expect(() => parseRunManifest('{"schemaVersion":1}', '/runs/x/manifest.json')).toThrow(
      InfraError,
    );
    expect(() => parseRunManifest('{"schemaVersion":1}', '/runs/x/manifest.json')).toThrow(
      /\/runs\/x\/manifest\.json/,
    );
  });

  it('says a NEWER specwitness wrote a manifest from the future', () => {
    // The actionable message: upgrading is the fix, not deleting the run.
    const future = JSON.stringify({ ...VALID, schemaVersion: RUN_MANIFEST_VERSION + 1 });

    expect(() => parseRunManifest(future, '/runs/x/manifest.json')).toThrow(InfraError);
    expect(() => parseRunManifest(future, '/runs/x/manifest.json')).toThrow(/newer/i);
  });

  it('carries a hint on every failure, per house error style', () => {
    for (const bad of ['{not json', '{"schemaVersion":99}', '{}']) {
      try {
        parseRunManifest(bad, '/runs/x/manifest.json');
        expect.unreachable(`parseRunManifest must reject ${bad}`);
      } catch (err) {
        expect(err).toBeInstanceOf(InfraError);
        expect((err as InfraError).hint).toBeDefined();
      }
    }
  });
});
