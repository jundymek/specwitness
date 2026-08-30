import { describe, expect, it } from 'vitest';

import { CRITERION_STATUSES, GATE_STATUSES } from '../../src/domain/result.js';
import { INFRA_ERROR_CLASSIFICATIONS, VERDICTS } from '../../src/domain/run-outcome.js';
import {
  CriterionStatusSchema,
  GateStatusSchema,
  InfraErrorClassificationSchema,
  VerdictSchema,
} from '../../src/schemas/enums.js';
import { SCHEMA_VERSIONS, schemaVersionFor } from '../../src/schemas/versions.js';

describe('schemas/enums — derived from the domain, so they cannot drift', () => {
  it.each([
    ['CriterionStatus', CriterionStatusSchema, CRITERION_STATUSES],
    ['GateStatus', GateStatusSchema, GATE_STATUSES],
    ['Verdict', VerdictSchema, VERDICTS],
    ['InfraErrorClassification', InfraErrorClassificationSchema, INFRA_ERROR_CLASSIFICATIONS],
  ])('%s schema options equal the domain array exactly', (_name, schema, domainValues) => {
    expect([...schema.options]).toEqual([...domainValues]);
  });

  it('accepts every legal criterion status and nothing else', () => {
    for (const status of CRITERION_STATUSES) {
      expect(CriterionStatusSchema.parse(status)).toBe(status);
    }
    for (const illegal of ['PASS', 'Fail', 'pass ', 'passed', 'needs-human', 'unknown', '']) {
      expect(CriterionStatusSchema.safeParse(illegal).success).toBe(false);
    }
  });

  it('accepts every legal verdict and rejects lowercase or unknown ones', () => {
    for (const verdict of VERDICTS) {
      expect(VerdictSchema.parse(verdict)).toBe(verdict);
    }
    for (const illegal of ['pass', 'FAILED', 'NEEDS-HUMAN', 'GATE_FAILED']) {
      expect(VerdictSchema.safeParse(illegal).success).toBe(false);
    }
  });

  it('keeps gate statuses a strict subset of criterion statuses', () => {
    for (const status of GATE_STATUSES) {
      expect(CRITERION_STATUSES).toContain(status);
    }
    expect(GATE_STATUSES).not.toContain('needs_human');
    expect(GATE_STATUSES).not.toContain('error');
  });

  it('rejects non-string input', () => {
    for (const illegal of [1, null, undefined, {}, []]) {
      expect(CriterionStatusSchema.safeParse(illegal).success).toBe(false);
    }
  });
});

describe('taxonomy closure — a change here must be a deliberate ADR, not a slip', () => {
  it('pins the criterion statuses exactly', () => {
    expect([...CRITERION_STATUSES]).toEqual(['pass', 'fail', 'needs_human', 'skipped', 'error']);
  });

  it('pins the gate statuses exactly', () => {
    expect([...GATE_STATUSES]).toEqual(['pass', 'fail', 'skipped']);
  });

  it('pins the verdicts exactly', () => {
    expect([...VERDICTS]).toEqual(['PASS', 'FAIL', 'NEEDS_HUMAN']);
  });

  it('excludes usage from the infra classifications — a usage error exits 64, never 3', () => {
    expect(INFRA_ERROR_CLASSIFICATIONS).not.toContain('usage');
  });
});

describe('schemas/versions — the AD-5 registry seed', () => {
  it('holds integer versions only', () => {
    for (const version of Object.values(SCHEMA_VERSIONS)) {
      expect(Number.isInteger(version)).toBe(true);
      expect(version).toBeGreaterThanOrEqual(1);
    }
  });

  it('reads a registered version through the accessor', () => {
    for (const key of Object.keys(SCHEMA_VERSIONS)) {
      expect(schemaVersionFor(key as keyof typeof SCHEMA_VERSIONS)).toBe(
        SCHEMA_VERSIONS[key as keyof typeof SCHEMA_VERSIONS],
      );
    }
  });

  it('is frozen at runtime so no consumer can mutate the registry', () => {
    expect(Object.isFrozen(SCHEMA_VERSIONS)).toBe(true);
  });
});
