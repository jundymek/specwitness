import { describe, expect, it } from 'vitest';

import {
  DOCTOR_SCHEMA_VERSION,
  hasRequiredFailure,
  overallStatus,
  renderHuman,
  renderJson,
} from '../../../src/cli/doctor/render.js';
import type { DoctorCheckReport } from '../../../src/cli/doctor/registry.js';

const REPORTS: DoctorCheckReport[] = [
  { id: 'node-version', required: true, status: 'pass', detail: 'Node 22.20.0 (>=22.12)' },
  { id: 'git-present', required: true, status: 'pass', detail: 'git version 2.43.0' },
  {
    id: 'config-valid',
    required: true,
    status: 'fail',
    detail: 'services.web.ready.timeoutSec: expected number, received string',
  },
  {
    id: 'playwright-capability',
    required: false,
    status: 'warn',
    detail: '@playwright/test does not resolve from this project',
  },
];

describe('overallStatus', () => {
  it('is fail when any REQUIRED check failed', () => {
    expect(overallStatus(REPORTS)).toBe('fail');
  });

  it('is fail when an optional check fails too — status describes checks, not the exit code', () => {
    expect(
      overallStatus([{ id: 'x', required: false, status: 'fail', detail: 'broken' }]),
    ).toBe('fail');
  });

  it('is warn when nothing failed but something warned', () => {
    expect(
      overallStatus([
        { id: 'a', required: true, status: 'pass', detail: '' },
        { id: 'b', required: false, status: 'warn', detail: '' },
      ]),
    ).toBe('warn');
  });

  it('is pass when every check passed', () => {
    expect(overallStatus([{ id: 'a', required: true, status: 'pass', detail: '' }])).toBe('pass');
  });
});

describe('hasRequiredFailure', () => {
  it('is what drives the exit code: only a REQUIRED failure counts', () => {
    expect(hasRequiredFailure(REPORTS)).toBe(true);
    expect(
      hasRequiredFailure([
        { id: 'a', required: true, status: 'pass', detail: '' },
        { id: 'b', required: false, status: 'fail', detail: '' },
        { id: 'c', required: false, status: 'warn', detail: '' },
      ]),
    ).toBe(false);
  });
});

describe('renderJson', () => {
  it('emits the stable AC2 shape', () => {
    const json = JSON.parse(renderJson(REPORTS, '2026-08-31T06:12:41.000Z')) as unknown;

    expect(json).toEqual({
      schemaVersion: 1,
      timestamp: '2026-08-31T06:12:41.000Z',
      status: 'fail',
      checks: [
        { id: 'node-version', status: 'pass', required: true, detail: 'Node 22.20.0 (>=22.12)' },
        { id: 'git-present', status: 'pass', required: true, detail: 'git version 2.43.0' },
        {
          id: 'config-valid',
          status: 'fail',
          required: true,
          detail: 'services.web.ready.timeoutSec: expected number, received string',
        },
        {
          id: 'playwright-capability',
          status: 'warn',
          required: false,
          detail: '@playwright/test does not resolve from this project',
        },
      ],
    });
  });

  it('pins schemaVersion 1 — later changes must be additive', () => {
    expect(DOCTOR_SCHEMA_VERSION).toBe(1);
  });

  it('preserves check order', () => {
    const parsed = JSON.parse(renderJson(REPORTS, '2026-08-31T06:12:41.000Z')) as {
      checks: { id: string }[];
    };

    expect(parsed.checks.map((check) => check.id)).toEqual([
      'node-version',
      'git-present',
      'config-valid',
      'playwright-capability',
    ]);
  });

  it('ends with a newline so shell redirection produces a well-formed file', () => {
    expect(renderJson(REPORTS, '2026-08-31T06:12:41.000Z').endsWith('\n')).toBe(true);
  });
});

describe('renderHuman', () => {
  it('marks each check with its status glyph, id and detail', () => {
    const lines = renderHuman(REPORTS).split('\n');

    expect(lines[0]).toContain('✓');
    expect(lines[0]).toContain('node-version');
    expect(lines[2]).toContain('✗');
    expect(lines[2]).toContain('config-valid');
    expect(lines[2]).toContain('expected number, received string');
    expect(lines[3]).toContain('⚠');
  });

  it('summarises counts on the last line', () => {
    const lines = renderHuman(REPORTS).trim().split('\n');

    expect(lines.at(-1)).toMatch(/2 passed.*1 warning.*1 failed/);
  });

  it('marks an optional failing check so a red line is not mistaken for a blocker', () => {
    const output = renderHuman([{ id: 'ports-free', required: false, status: 'warn', detail: 'x' }]);

    expect(output).toContain('optional');
  });
});
