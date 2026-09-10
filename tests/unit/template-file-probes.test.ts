import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { FILE_PROBE_SOURCES } from '../../src/domain/plan.js';
import { PlanSchema } from '../../src/schemas/plan.js';
import { asDocument, automated, criterion, frozenContract, planFor } from '../helpers/plan.js';

/**
 * AC6 (story 7.8) — the scaffolded template teaches the `file` surface, and what it teaches
 * is a probe the product accepts.
 *
 * `tests/unit/template.test.ts` deliberately does not un-comment the template mechanically,
 * because prose and commented YAML interleave there. The file-probe examples are different:
 * they are one indented block under one heading, so they CAN be extracted exactly — and an
 * example a reader copies into a plan and then sees rejected would teach the wrong shape at
 * the one moment the template exists for. So this test copies them the way a reader would,
 * and hands them to the real plan schema.
 */

const TEMPLATE = readFileSync(join(process.cwd(), 'templates', 'config.yaml'), 'utf8');

function taughtProbes(): unknown[] {
  const lines = TEMPLATE.split('\n');
  const start = lines.findIndex((line) => line.includes('Checking files, without writing any code'));
  expect(start, 'templates/config.yaml must carry the file-probe section').toBeGreaterThan(-1);

  const block: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.startsWith('#')) {
      break;
    }
    // The examples are the lines indented under the comment marker; prose is not.
    if (line.startsWith('#   ') || (line === '#' && block.length > 0)) {
      block.push(line.replace(/^# ?/, ''));
    }
  }

  const probes = parse(block.join('\n')) as unknown;
  expect(Array.isArray(probes), 'the taught examples must parse as a YAML list of probes').toBe(true);
  return probes as unknown[];
}

describe('the template teaches file probes that the plan schema accepts (AC6)', () => {
  const probes = taughtProbes();

  it('teaches several worked examples', () => {
    expect(probes.length).toBeGreaterThanOrEqual(4);
  });

  it.each(probes.map((probe, index) => [index, probe] as const))(
    'example %i, uncommented and pasted into a plan, validates',
    (_index, probe) => {
      const document = asDocument(
        planFor(frozenContract([criterion('E7-01')]), { criteria: [automated('E7-01')] }),
      );
      const criteria = (document.plan as { criteria: { probes: unknown[] }[] }).criteria;
      (criteria[0] as { probes: unknown[] }).probes = [probe];

      const result = PlanSchema.safeParse(document);
      expect(result.success, result.success ? '' : result.error.message).toBe(true);
    },
  );

  it('counts the bare name in its census example, so no quote style escapes it', () => {
    // Raised by the supervisor review of PR #89. The example counted the DOUBLE-QUOTED spelling
    // only, under a description promising that no file spells the key at all — so
    // `t['__handle']` and a template literal passed it. The script it teaches a project to
    // replace counted all three quote styles. Comments are stripped and the definition is
    // excluded, so the bare name is both strict and honest.
    const census = probes.find(
      (probe) => (probe as { id?: unknown }).id === 'no-hardcoded-handle',
    ) as { assertions: { target: { source: string; text?: string } }[] } | undefined;
    expect(census, 'the template keeps its census example').toBeDefined();
    const texts = (census?.assertions ?? [])
      .filter((assertion) => assertion.target.source === 'occurrences')
      .map((assertion) => assertion.target.text ?? '');
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect(text, 'a quoted census text misses the other two quote styles').not.toMatch(/["'`]/);
    }
  });

  it('names every read a file probe offers, so none is undiscoverable', () => {
    for (const source of FILE_PROBE_SOURCES) {
      expect(TEMPLATE, source).toContain(source);
    }
  });

  it('tells the reader what a missing path means, and that it reads files rather than behaviour', () => {
    expect(TEMPLATE).toContain('text that does not exist satisfies nothing');
    expect(TEMPLATE).toContain('not what the software DOES');
  });

  it('adds no active key: the file section is documentation, not configuration', () => {
    const active = parse(TEMPLATE) as Record<string, unknown>;
    expect(Object.keys(active).sort()).toEqual(['project', 'version']);
  });
});
