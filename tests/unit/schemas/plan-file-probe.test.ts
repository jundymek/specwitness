import { describe, expect, it } from 'vitest';

import type { ProbeSpec } from '../../../src/domain/plan.js';
import { PlanSchema, parsePlan, planDraftSchemaFor, serializePlan } from '../../../src/schemas/plan.js';
import {
  FILE_PROBE,
  asDocument,
  automated,
  criterion,
  frozenContract,
  planFor,
} from '../../helpers/plan.js';

/**
 * Story 7.8 / ADR-009 — the `file` probe as the plan schema sees it.
 *
 * The schema is the first of two refusals of a path that could leave the worktree. The
 * executor refuses again at run time (a plan file can be hand-edited after compilation),
 * and only the executor can see a SYMLINK, because that is a fact about the tree rather
 * than about the text. What the schema can refuse, it refuses here, so a hostile draft is
 * never written in the first place and the AD-2 gate feeds the reason back to the provider.
 */

const CONTRACT = frozenContract([criterion('E7-01')]);

type FileProbeInput = Record<string, unknown>;

function fileProbe(mechanics: FileProbeInput, target: FileProbeInput = { source: 'exists' }) {
  return {
    id: 'the-probe',
    surface: 'file',
    mechanics,
    assertions: [
      {
        description: 'reads the tree',
        target,
        comparison: 'equals',
        expected: 'true',
      },
    ],
  };
}

function parse(probe: unknown) {
  const document = asDocument(planFor(CONTRACT, { criteria: [automated('E7-01', FILE_PROBE)] }));
  const criteria = (document.plan as { criteria: { probes: unknown[] }[] }).criteria;
  (criteria[0] as { probes: unknown[] }).probes = [probe];
  return PlanSchema.safeParse(document);
}

function messages(probe: unknown): string {
  const result = parse(probe);
  return result.success ? '' : result.error.issues.map((issue) => issue.message).join(' | ');
}

describe('a file probe the schema accepts', () => {
  it.each([
    ['a literal path', { path: 'README.md' }, { source: 'exists' }],
    ['a nested literal path', { path: 'docs/adr/0001-record.md' }, { source: 'content' }],
    ['a bracketed path segment, which is a literal', { path: 'app/[id]/page.tsx' }, { source: 'exists' }],
    ['a recursive glob', { path: 'docs/**/*.md' }, { source: 'fileCount' }],
    [
      'a glob with exclusions',
      { path: 'src/**/*.ts', exclude: ['src/**/*.test.ts', 'src/legacy/**'] },
      { source: 'occurrences', text: '__handle', ignoreComments: 'c-like' },
    ],
    [
      'files containing every one of several texts',
      { path: 'docs/**/*.md' },
      { source: 'filesContaining', texts: ['legend', '## Decision'], ignoreCase: true },
    ],
    ['a JSON value', { path: 'package.json' }, { source: 'jsonPath', path: '$.scripts.test' }],
    ['case-folded content', { path: 'README.md' }, { source: 'content', ignoreCase: true }],
  ])('%s', (_label, mechanics, target) => {
    const result = parse(fileProbe(mechanics, target));
    expect(result.success, result.success ? '' : result.error.message).toBe(true);
  });
});

describe('a path that could leave the worktree is refused by the schema (AC2, first refusal)', () => {
  it.each([
    ['a parent segment', '../outside.md'],
    ['a parent segment in the middle', 'docs/../../outside.md'],
    ['an absolute path', '/etc/hosts'],
    ['a Windows drive path', 'C:/Windows/win.ini'],
    ['a backslash separator', 'docs\\readme.md'],
    ['a home-relative path', '~/.ssh/config'],
    ['a current-directory segment', './README.md'],
    ['an empty segment', 'docs//readme.md'],
    ['a trailing slash', 'docs/'],
    ['the empty path', ''],
    ['a NUL byte', 'README.md\u0000.txt'],
  ])('%s: %j', (_label, path) => {
    expect(parse(fileProbe({ path })).success).toBe(false);
  });

  it('refuses a parent segment inside an exclusion as well', () => {
    expect(parse(fileProbe({ path: 'docs/**/*.md', exclude: ['../secret.md'] })).success).toBe(
      false,
    );
  });

  it('names the reason, so the AD-2 gate can feed it back to the provider', () => {
    expect(messages(fileProbe({ path: '../outside.md' }))).toMatch(/\.\./);
    expect(messages(fileProbe({ path: '/etc/hosts' }))).toMatch(/absolute/);
  });
});

describe('glob grammar the matcher does not implement is refused rather than read literally', () => {
  it.each([
    ['brace expansion', 'docs/{adr,dev}/*.md'],
    ['a double star glued to text', 'docs/a**/x.md'],
  ])('%s: %j', (_label, path) => {
    expect(parse(fileProbe({ path })).success).toBe(false);
  });
});

describe('reads that need exactly one file refuse a glob (the pairing is one fact)', () => {
  it.each([
    ['content', { source: 'content' }],
    ['jsonPath', { source: 'jsonPath', path: '$.version' }],
  ])('%s on a glob', (_label, target) => {
    expect(parse(fileProbe({ path: 'docs/*.md' }, target)).success).toBe(false);
  });

  it('refuses exclusions on a literal path, which could only ever exclude the path itself', () => {
    expect(parse(fileProbe({ path: 'README.md', exclude: ['README.md'] })).success).toBe(false);
  });
});

describe('the rest of the file probe is closed', () => {
  it('refuses a command smuggled into mechanics as an unknown key', () => {
    expect(parse(fileProbe({ path: 'README.md', run: 'cat README.md' })).success).toBe(false);
  });

  it('refuses an unknown target source', () => {
    expect(parse(fileProbe({ path: 'README.md' }, { source: 'regex', pattern: '.*' })).success).toBe(
      false,
    );
  });

  it('refuses an option a source does not read', () => {
    expect(
      parse(fileProbe({ path: 'package.json' }, { source: 'jsonPath', path: '$.a', ignoreCase: true }))
        .success,
    ).toBe(false);
  });

  it.each([
    ['an empty occurrence text', { source: 'occurrences', text: '' }],
    ['no texts at all', { source: 'filesContaining', texts: [] }],
    ['an empty text among several', { source: 'filesContaining', texts: ['a', ''] }],
    ['an unknown comment syntax', { source: 'occurrences', text: 'x', ignoreComments: 'hash' }],
  ])('refuses %s', (_label, target) => {
    expect(parse(fileProbe({ path: 'src/**/*.ts' }, target)).success).toBe(false);
  });
});

describe('the draft schema and the serializer', () => {
  it('accepts a file probe in a project that declares no services and no commands', () => {
    // The point of the surface: a project with nothing declared can still be verified.
    const draft = {
      data: { bindings: [] },
      criteria: [automated('E7-01', FILE_PROBE)],
    };
    const result = planDraftSchemaFor(CONTRACT, { serviceIds: [], commandIds: [] }).safeParse(draft);
    expect(result.success, result.success ? '' : result.error.message).toBe(true);
  });

  it('round-trips through YAML with mechanics and targets intact', () => {
    const probe = {
      id: 'handle-key-census',
      surface: 'file',
      mechanics: { path: 'ui/**/*.ts', exclude: ['ui/handle-key.test.ts'] },
      assertions: [
        {
          description: 'no source spells the handle key',
          target: {
            source: 'occurrences',
            text: '"__handle"',
            ignoreCase: false,
            ignoreComments: 'c-like',
          },
          comparison: 'equals',
          expected: '0',
        },
      ],
    } satisfies ProbeSpec;

    const plan = planFor(CONTRACT, { criteria: [automated('E7-01', probe)] });
    const text = serializePlan(plan);

    expect(parsePlan(text, 'plans/epic-7.yaml')).toEqual(plan);
    expect(text).toContain('surface: file');
    expect(text.indexOf('path: ui/**/*.ts')).toBeLessThan(text.indexOf('assertions:'));
  });
});
