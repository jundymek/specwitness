import { describe, expect, it } from 'vitest';

import { STAGE_NAMES, STAGE_STATUSES } from '../../../src/domain/stage.js';
import type { StageName, StageStatus, StageTimelineEntry } from '../../../src/domain/stage.js';

/**
 * The stage sequence is frozen by AC1 and by the spine's Structural Seed, and four other
 * stories key their timeline entries off these exact strings. These tests are the
 * mechanical half of "renaming, reordering, adding or dropping one is an ADR": a
 * well-meant edit fails here rather than in a wave-B agent's branch.
 */
describe('STAGE_NAMES', () => {
  it('is exactly the eleven spine stages, in order', () => {
    // Written out literally rather than derived: a test that computed its expectation
    // from the thing under test would pass after any reordering.
    expect([...STAGE_NAMES]).toEqual([
      'resolve',
      'integrity',
      'worktree',
      'setup',
      'gates',
      'services',
      'data',
      'probes',
      'aggregate',
      'persist',
      'teardown',
    ]);
  });

  it('has eleven entries and no duplicates', () => {
    expect(STAGE_NAMES).toHaveLength(11);
    expect(new Set(STAGE_NAMES).size).toBe(11);
  });

  it('puts integrity before worktree, so a tampered contract costs no worktree (AC2)', () => {
    expect(STAGE_NAMES.indexOf('integrity')).toBeLessThan(STAGE_NAMES.indexOf('worktree'));
  });

  it('puts aggregate before persist before teardown, and teardown last', () => {
    expect(STAGE_NAMES.indexOf('aggregate')).toBeLessThan(STAGE_NAMES.indexOf('persist'));
    expect(STAGE_NAMES.indexOf('persist')).toBeLessThan(STAGE_NAMES.indexOf('teardown'));
    expect(STAGE_NAMES.at(-1)).toBe('teardown');
  });
});

describe('STAGE_STATUSES', () => {
  it('is the four-value closed vocabulary', () => {
    expect([...STAGE_STATUSES]).toEqual(['ok', 'failed', 'error', 'skipped']);
  });

  it('keeps a product-negative stage distinct from an infrastructure one', () => {
    // The distinction this epic exists to protect: `failed` is a gate that said no (the
    // run still reaches a Verdict), `error` is a thrown AD-7 error (it cannot). One
    // vocabulary with both collapsed into "bad" is how exit 3 and exit 1 swap places.
    expect(STAGE_STATUSES).toContain('failed');
    expect(STAGE_STATUSES).toContain('error');
  });
});

describe('StageTimelineEntry', () => {
  it('carries a stage name, a status and an integer duration; detail is optional', () => {
    const entry: StageTimelineEntry = { stage: 'gates', status: 'failed', durationMs: 12 };
    expect(entry.detail).toBeUndefined();
  });

  it('narrows StageName and StageStatus to their tuples', () => {
    const name: StageName = 'probes';
    const status: StageStatus = 'skipped';
    // @ts-expect-error 'lint' is a gate id, not a stage name.
    const wrongName: StageName = 'lint';
    // @ts-expect-error 'pass' is a criterion status, not a stage status.
    const wrongStatus: StageStatus = 'pass';

    expect([name, status, wrongName, wrongStatus]).toHaveLength(4);
  });
});
