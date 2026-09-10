import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deriveCriterionResult } from '../../../src/domain/criterion-result.js';
import type {
  AssertionEvaluation,
  ContractCriterionRef,
  ProbeAttempt,
} from '../../../src/domain/criterion-result.js';
import { InfraError } from '../../../src/domain/errors.js';
import type { ObservationEvidence } from '../../../src/domain/evidence.js';
import type {
  AssertionComparison,
  FileAssertionTarget,
  FileProbe,
} from '../../../src/domain/plan.js';
import { FileSurfaceExecutor } from '../../../src/surfaces/file.js';
import type { FileExecutorDeps } from '../../../src/surfaces/file.js';
import { FixedClock } from '../../fakes/ports.js';

import { RecordingEvidence } from './observation.helpers.js';

/**
 * Story 7.8 — the `file` surface executor, against a REAL filesystem.
 *
 * Nothing here is a string-level simulation of a path. Every tree is written into a fresh
 * `mkdtemp` directory, every symlink is a real `symlink(2)`, and the executor resolves them
 * through the operating system. The spec is explicit about why: "a unit test over a string
 * path would have passed through the whole class of defect". The worktree root is itself
 * reached through macOS's `/var -> /private/var` link on a developer machine, which is the
 * realpath case every confinement check has to survive.
 */

const CRITERION: ContractCriterionRef = {
  criterionId: 'E7-08',
  statement: 'a project can be verified without writing a probe script',
  severity: 'normal',
  verifiability: 'automated',
};

let scratch: string;
let root: string;
let outside: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'specwitness-file-surface-'));
  root = join(scratch, 'worktree');
  outside = join(scratch, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'a file outside the worktree\n');
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function tree(files: Readonly<Record<string, string | Uint8Array>>): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents);
  }
}

interface AssertionInput {
  readonly target: FileAssertionTarget;
  readonly comparison?: AssertionComparison;
  readonly expected: string;
}

function probe(mechanics: FileProbe['mechanics'], ...inputs: readonly AssertionInput[]): FileProbe {
  return {
    id: 'the-probe',
    surface: 'file',
    mechanics,
    assertions: inputs.map((input, index) => ({
      description: `assertion ${index}`,
      target: input.target,
      comparison: input.comparison ?? 'equals',
      expected: input.expected,
    })),
  };
}

async function run(
  spec: FileProbe | Record<string, unknown>,
  deps: Partial<FileExecutorDeps> = {},
): Promise<{ attempt: ProbeAttempt; evidence: RecordingEvidence }> {
  const evidence = new RecordingEvidence();
  const executor = new FileSurfaceExecutor({
    clock: new FixedClock('2026-09-10T12:00:00.000Z'),
    root,
    writeEvidence: evidence.write,
    recordEvidence: evidence.record,
    ...deps,
  });
  const attempt = await executor.execute({
    criterionId: CRITERION.criterionId,
    surface: 'file',
    params: { ...spec, attempt: 1 },
  });
  return { attempt, evidence };
}

function evaluation(attempt: ProbeAttempt, index = 0): AssertionEvaluation {
  const found = attempt.assertionEvaluations[index];
  if (found === undefined) {
    throw new Error(
      `no evaluation ${index}; execError: ${attempt.execError?.message ?? 'none'}`,
    );
  }
  return found;
}

/* ── AC2 ─────────────────────────────────────────────────────────────────────────────── */

describe('AC2 — every read stays inside the worktree, or nothing is read at all', () => {
  it("refuses a '..' path as InfraError, before reading anything", async () => {
    const { evidence } = await run(probe({ path: 'README.md' }, { target: { source: 'exists' }, expected: 'true' }));
    expect(evidence.files.length).toBeGreaterThan(0); // the harness itself records evidence

    const refused = new RecordingEvidence();
    await expect(
      new FileSurfaceExecutor({
        clock: new FixedClock('2026-09-10T12:00:00.000Z'),
        root,
        writeEvidence: refused.write,
        recordEvidence: refused.record,
      }).execute({
        criterionId: CRITERION.criterionId,
        surface: 'file',
        params: {
          ...probe({ path: '../outside/secret.txt' }, { target: { source: 'content' }, comparison: 'contains', expected: 'a file' }),
          attempt: 1,
        },
      }),
    ).rejects.toBeInstanceOf(InfraError);
    expect(refused.files).toEqual([]);
    expect(refused.members).toEqual([]);
  });

  it('refuses an absolute path as InfraError, even one naming a real readable file', async () => {
    await expect(
      run(probe({ path: join(outside, 'secret.txt') }, { target: { source: 'exists' }, expected: 'true' })),
    ).rejects.toThrow(InfraError);
  });

  it('refuses a symlinked FILE that resolves outside the worktree (real symlink)', async () => {
    await symlink(join(outside, 'secret.txt'), join(root, 'notes.md'));

    for (const target of [
      { source: 'exists' },
      { source: 'content' },
      { source: 'fileCount' },
    ] as const) {
      await expect(
        run(probe({ path: 'notes.md' }, { target, expected: 'x' })),
        `${target.source} through an escaping symlink`,
      ).rejects.toThrow(/outside the verification worktree/);
    }
  });

  it('refuses a RELATIVE symlink that climbs out, which a string check on the plan cannot see', async () => {
    await mkdir(join(root, 'docs'));
    await symlink('../../outside', join(root, 'docs', 'vendor'));

    await expect(
      run(probe({ path: 'docs/vendor/secret.txt' }, { target: { source: 'content' }, comparison: 'contains', expected: 'a' })),
    ).rejects.toThrow(InfraError);
  });

  it('refuses an escaping symlink that a GLOB matched', async () => {
    await tree({ 'docs/real.md': 'real\n' });
    await symlink(join(outside, 'secret.txt'), join(root, 'docs', 'escape.md'));

    await expect(
      run(probe({ path: 'docs/*.md' }, { target: { source: 'occurrences', text: 'a' }, expected: '0' })),
    ).rejects.toThrow(/outside the verification worktree/);
  });

  it('refuses a DANGLING symlink whose target lies outside, without needing it to exist', async () => {
    await symlink('../outside/not-there.txt', join(root, 'ghost.md'));

    await expect(
      run(probe({ path: 'ghost.md' }, { target: { source: 'exists' }, expected: 'false' })),
    ).rejects.toThrow(InfraError);
  });

  it("refuses a '..' inside an exclusion as well as in the path", async () => {
    await tree({ 'docs/a.md': 'a\n' });
    await expect(
      run(probe({ path: 'docs/*.md', exclude: ['../x.md'] }, { target: { source: 'fileCount' }, expected: '1' })),
    ).rejects.toThrow(InfraError);
  });

  it('refuses a parent directory swapped for a symlink between resolution and open (a race)', async () => {
    // Raised as a P1 by the codex review: O_NOFOLLOW guards only the last component. A process
    // running beside verification can rename a checked directory and put a symlink in its
    // place, and open() then follows it. The seam puts a REAL swap in exactly that window.
    await tree({ 'docs/notes.md': 'inside\n' });
    await writeFile(join(outside, 'notes.md'), 'a secret outside the worktree\n');
    const beforeOpen = async (): Promise<void> => {
      await rename(join(root, 'docs'), join(root, 'docs-old'));
      await symlink(outside, join(root, 'docs'));
    };

    await expect(
      run(
        probe({ path: 'docs/notes.md' }, { target: { source: 'content' }, comparison: 'contains', expected: 'inside' }),
        { beforeOpen },
      ),
    ).rejects.toThrow(/outside the verification worktree/);
  });

  it('follows a symlink that stays inside the worktree', async () => {
    await tree({ 'docs/v2/guide.md': 'the current guide\n' });
    await symlink('v2', join(root, 'docs', 'current'));

    const { attempt } = await run(
      probe({ path: 'docs/current/guide.md' }, { target: { source: 'content' }, comparison: 'contains', expected: 'current guide' }),
    );
    expect(evaluation(attempt).satisfied).toBe(true);
  });

  it('works when the worktree root is itself reached through a symlink', async () => {
    await tree({ 'README.md': '# hello\n' });
    const alias = join(scratch, 'alias');
    await symlink(root, alias);

    const { attempt } = await run(
      probe({ path: 'README.md' }, { target: { source: 'exists' }, expected: 'true' }),
      { root: alias },
    );
    expect(evaluation(attempt).satisfied).toBe(true);
  });

  it('refuses a worktree root that does not exist as InfraError, not as absence', async () => {
    await expect(
      run(probe({ path: 'README.md' }, { target: { source: 'exists' }, expected: 'false' }), {
        root: join(scratch, 'never-created'),
      }),
    ).rejects.toThrow(InfraError);
  });
});

/* ── AC4 ─────────────────────────────────────────────────────────────────────────────── */

describe('AC4 — absence is a fact, and what it means depends on the source', () => {
  it('reads a missing path as existence: the value false, compared like any other value', async () => {
    const { attempt } = await run(
      probe(
        { path: 'CHANGELOG.md' },
        { target: { source: 'exists' }, expected: 'true' },
        { target: { source: 'exists' }, expected: 'false' },
      ),
    );

    expect(evaluation(attempt, 0)).toMatchObject({ satisfied: false, actual: 'false' });
    expect(evaluation(attempt, 1)).toMatchObject({ satisfied: true, actual: 'false' });
    expect(deriveCriterionResult(CRITERION, [attempt]).status).toBe('fail');
  });

  it('reads a missing path for content as UNSATISFIED for every comparison, the negative ones included', async () => {
    const comparisons: readonly AssertionComparison[] = [
      'equals',
      'notEquals',
      'contains',
      'notContains',
      'greaterThan',
      'lessThan',
    ];
    const { attempt } = await run(
      probe(
        { path: 'docs/MIGRATION.md' },
        ...comparisons.map((comparison) => ({
          target: { source: 'content' } as const,
          comparison,
          expected: 'TODO',
        })),
      ),
    );

    expect(attempt.execError).toBeUndefined();
    expect(attempt.assertionEvaluations).toHaveLength(comparisons.length);
    for (const [index, comparison] of comparisons.entries()) {
      const read = evaluation(attempt, index);
      expect(read.satisfied, comparison).toBe(false);
      expect(read.actual, comparison).toMatch(/^absent/);
    }
    expect(deriveCriterionResult(CRITERION, [attempt]).status).toBe('fail');
  });

  it('escapes an UNREADABLE path — a directory where a file was named — as an execError', async () => {
    await tree({ 'docs/readme.md': 'x\n' });
    const { attempt } = await run(
      probe({ path: 'docs' }, { target: { source: 'content' }, comparison: 'notContains', expected: 'x' }),
    );

    expect(attempt.execError?.message).toMatch(/directory/);
    expect(attempt.assertionEvaluations).toEqual([]);
    expect(deriveCriterionResult(CRITERION, [attempt]).status).toBe('error');
  });

  it.skipIf(process.getuid?.() === 0)(
    'escapes a permission error as an execError, never as absence',
    async () => {
      await tree({ 'locked.md': 'you cannot read me\n' });
      await chmod(join(root, 'locked.md'), 0o000);
      try {
        const { attempt } = await run(
          probe({ path: 'locked.md' }, { target: { source: 'content' }, comparison: 'notContains', expected: 'x' }),
        );
        expect(attempt.execError?.message).toMatch(/could not be read/);
        expect(deriveCriterionResult(CRITERION, [attempt]).status).toBe('error');
      } finally {
        await chmod(join(root, 'locked.md'), 0o644);
      }
    },
  );

  it('reads a glob that matched nothing as unsatisfied for a content read, even `equals "0"`', async () => {
    const { attempt } = await run(
      probe(
        { path: 'packages/viz/ui/**/*.ts' },
        { target: { source: 'occurrences', text: '__gitnebula' }, expected: '0' },
        { target: { source: 'filesContaining', texts: ['x'] }, expected: '0' },
      ),
    );

    // The census this replaces reported zeroes for a directory that did not exist yet, so
    // "no forbidden spelling" passed over code that had never been written.
    expect(evaluation(attempt, 0)).toMatchObject({ satisfied: false });
    expect(evaluation(attempt, 1)).toMatchObject({ satisfied: false });
    expect(evaluation(attempt, 0).actual).toMatch(/^absent/);
  });

  it('but counts files as an existence read, so zero files is the value "0"', async () => {
    const { attempt } = await run(
      probe({ path: 'test-fixtures/build-*.sh' }, { target: { source: 'fileCount' }, expected: '0' }),
    );
    expect(evaluation(attempt)).toMatchObject({ satisfied: true, actual: '0' });
  });

  it('reads a literal directory as existing', async () => {
    await tree({ 'docs/adr/0001-first.md': '# ADR\n' });
    const { attempt } = await run(probe({ path: 'docs/adr' }, { target: { source: 'exists' }, expected: 'true' }));
    expect(evaluation(attempt).satisfied).toBe(true);
  });

  it('refuses to count files in a literal directory, and says to use a glob', async () => {
    await tree({ 'docs/adr/0001-first.md': '# ADR\n' });
    const { attempt } = await run(probe({ path: 'docs/adr' }, { target: { source: 'fileCount' }, expected: '1' }));
    expect(attempt.execError?.message).toMatch(/directory/);
    expect(attempt.execError?.hint).toMatch(/docs\/adr\/\*/);
  });

  it('reads a missing JSON file as unsatisfied, and a missing key the same way', async () => {
    await tree({ 'package.json': '{"scripts":{"test":"vitest run"}}' });
    const { attempt } = await run(
      probe(
        { path: 'package.json' },
        { target: { source: 'jsonPath', path: '$.scripts.ui' }, comparison: 'notContains', expected: 'playwright' },
      ),
    );
    expect(evaluation(attempt)).toMatchObject({ satisfied: false });
    expect(evaluation(attempt).actual).toMatch(/^absent/);

    const missing = await run(
      probe({ path: 'nope.json' }, { target: { source: 'jsonPath', path: '$.a' }, comparison: 'notEquals', expected: '1' }),
    );
    expect(evaluation(missing.attempt).satisfied).toBe(false);
  });

  it('escapes a file that is not valid JSON as an execError', async () => {
    await tree({ 'package.json': '{ "scripts": ' });
    const { attempt } = await run(
      probe({ path: 'package.json' }, { target: { source: 'jsonPath', path: '$.scripts' }, comparison: 'notEquals', expected: 'x' }),
    );
    expect(attempt.execError?.message).toMatch(/not valid JSON/);
  });

  it('escapes a control character in a file name the TREE chose, rather than printing it', async () => {
    // A branch names its own files. An ANSI escape in one must not reach the terminal
    // through the error message that names it.
    await tree({ 'docs/bad\u001b[31mname.md': new Uint8Array([0xff, 0xfe, 0x81]) });
    const { attempt } = await run(
      probe({ path: 'docs/*.md' }, { target: { source: 'occurrences', text: 'x' }, expected: '0' }),
    );
    expect(attempt.execError?.message).toContain('\\u001b');
    expect(attempt.execError?.message).not.toContain('\u001b');
  });

  it('escapes a file that is not UTF-8 text as an execError', async () => {
    await tree({ 'logo.md': new Uint8Array([0xff, 0xfe, 0x00, 0x81, 0x90]) });
    const { attempt } = await run(
      probe({ path: 'logo.md' }, { target: { source: 'content' }, comparison: 'notContains', expected: 'x' }),
    );
    expect(attempt.execError?.message).toMatch(/UTF-8/);
  });
});

/* ── the three defects ADR-009 measured ──────────────────────────────────────────────── */

describe('the three defects found in hand-written probes are not reproducible here', () => {
  it('1. finds a report two directories deeper than the non-recursive search looked', async () => {
    // `findReport` read `docs`, `docs/dev` and `packages/viz/ui` one level deep. The
    // reports lived at docs/dev/epic-6/<story>/README.md.
    await tree({
      'docs/dev/epic-6/6.3-viz-load-failure/README.md':
        '# 6.3 — The first screen of a failed load, and the seam between two validators\n\n' +
        'Widening the loader is contract-adjacent.\n',
      'docs/dev/notes.md': 'unrelated\n',
    });

    const { attempt } = await run(
      probe(
        { path: 'docs/**/*.md' },
        { target: { source: 'filesContaining', texts: ['validator', 'widen'], ignoreCase: true }, comparison: 'greaterThan', expected: '0' },
        { target: { source: 'fileCount' }, expected: '2' },
      ),
    );
    expect(evaluation(attempt, 0)).toMatchObject({ satisfied: true, actual: '1' });
    expect(evaluation(attempt, 1)).toMatchObject({ satisfied: true });
  });

  it('2. matches the words the document used, case-folded, rather than a guessed phrase', async () => {
    // The criterion was satisfied by "the seam between two validators"; the probe looked for
    // /validator[- ]gap|required-versus-checked/i and reported the document missing.
    await tree({ 'docs/dev/epic-6/6.3/README.md': 'THE SEAM BETWEEN TWO VALIDATORS\n' });

    const exact = await run(
      probe({ path: 'docs/**/*.md' }, { target: { source: 'filesContaining', texts: ['validator gap'], ignoreCase: true }, expected: '0' }),
    );
    const stem = await run(
      probe({ path: 'docs/**/*.md' }, { target: { source: 'filesContaining', texts: ['validator'], ignoreCase: true }, expected: '1' }),
    );
    const cased = await run(
      probe({ path: 'docs/**/*.md' }, { target: { source: 'filesContaining', texts: ['validator'] }, expected: '0' }),
    );

    expect(evaluation(exact.attempt).satisfied).toBe(true);
    expect(evaluation(stem.attempt).satisfied).toBe(true);
    expect(evaluation(cased.attempt).satisfied).toBe(true);
  });

  it('3. does not count a spelling inside a comment, nor inside the test that forbids it', async () => {
    await tree({
      'ui/specs/viewer.pw.ts':
        'import { HARNESS_HANDLE_KEY } from "../handle.js";\n' +
        '// never spell "__gitnebula" here — import HARNESS_HANDLE_KEY instead\n' +
        '/* nor here: "__gitnebula" */\n' +
        'const handle = window[HARNESS_HANDLE_KEY];\n',
      'ui/handle-key.test.ts': 'expect(source).not.toContain("__gitnebula");\n',
    });

    const naive = await run(
      probe({ path: 'ui/**/*.ts' }, { target: { source: 'occurrences', text: '"__gitnebula"' }, expected: '3' }),
    );
    const honest = await run(
      probe(
        { path: 'ui/**/*.ts', exclude: ['ui/handle-key.test.ts'] },
        { target: { source: 'occurrences', text: '"__gitnebula"', ignoreComments: 'c-like' }, expected: '0' },
        { target: { source: 'filesContaining', texts: ['HARNESS_HANDLE_KEY'] }, comparison: 'greaterThan', expected: '0' },
      ),
    );

    expect(evaluation(naive.attempt)).toMatchObject({ satisfied: true, actual: '3' });
    expect(evaluation(honest.attempt, 0)).toMatchObject({ satisfied: true, actual: '0' });
    expect(evaluation(honest.attempt, 1).satisfied).toBe(true);
  });
});

describe('comment stripping reads code, not comment-shaped text inside code', () => {
  async function count(source: string, text: string): Promise<string | undefined> {
    await tree({ 'src/a.ts': source });
    const { attempt } = await run(
      probe({ path: 'src/a.ts' }, { target: { source: 'occurrences', text, ignoreComments: 'c-like' }, expected: '-1' }),
    );
    return evaluation(attempt).actual;
  }

  it('keeps a spelling after a URL inside a string, whose // is not a comment', async () => {
    expect(await count('const u = "http://example.test"; const k = "__key";\n', '"__key"')).toBe('1');
  });

  it('keeps a spelling after a regex literal containing //', async () => {
    expect(await count('const re = /\\/\\//; const k = "__key";\n', '"__key"')).toBe('1');
  });

  it('keeps division followed by a real comment apart', async () => {
    expect(await count('const half = total / 2; // "__key"\nconst k = "__key";\n', '"__key"')).toBe('1');
  });

  it('keeps template literals, including multi-line ones', async () => {
    expect(await count('const t = `line // not a comment\n"__key"`;\n', '"__key"')).toBe('1');
  });

  it('blanks a block comment with spaces, so it cannot join two tokens into a match', async () => {
    expect(await count('const ab = a/* x */b;\n', 'ab')).toBe('1');
    expect(await count('a/* x */b\n', 'ab')).toBe('0');
  });

  it('tracks ${} nesting, so a template inside an interpolation cannot end the outer one', async () => {
    // Raised by the codex review of this branch, and it was right: the inner backtick used to
    // end the outer template, the rest of the line was then read as a `//` comment, and the
    // code after it vanished from the count — an UNDERcount, the direction that passes.
    expect(await count('const s = `${`http://x`}`; forbidden();\n', 'forbidden()')).toBe('1');
  });

  it('strips a comment inside an interpolation, and keeps an object literal inside one', async () => {
    expect(await count('const s = `a ${ x /* "__key" */ } b`;\n', '"__key"')).toBe('0');
    expect(await count('const s = `${ {a: 1}.a } // "__key"`;\n', '"__key"')).toBe('1');
  });

  it('refuses an unterminated template literal as an execError rather than guessing where it ends', async () => {
    await tree({ 'src/a.ts': 'const t = `never closed "__key";\n' });
    const { attempt } = await run(
      probe({ path: 'src/a.ts' }, { target: { source: 'occurrences', text: '"__key"', ignoreComments: 'c-like' }, expected: '0' }),
    );
    expect(attempt.execError?.message).toMatch(/unterminated template literal/);
  });

  it('refuses an unterminated block comment as an execError rather than guessing where it ends', async () => {
    await tree({ 'src/a.ts': 'const k = "__key"; /* never closed\n' });
    const { attempt } = await run(
      probe({ path: 'src/a.ts' }, { target: { source: 'occurrences', text: '"__key"', ignoreComments: 'c-like' }, expected: '1' }),
    );
    expect(attempt.execError?.message).toMatch(/unterminated block comment/);
  });
});

/* ── glob semantics ──────────────────────────────────────────────────────────────────── */

describe('glob semantics', () => {
  it('`**` matches zero or more directories', async () => {
    await tree({ 'docs/top.md': 'a', 'docs/x/y/deep.md': 'a', 'docs/x/skip.txt': 'a' });
    const { attempt } = await run(probe({ path: 'docs/**/*.md' }, { target: { source: 'fileCount' }, expected: '2' }));
    expect(evaluation(attempt)).toMatchObject({ satisfied: true, actual: '2' });
  });

  it('never descends node_modules or .git by wildcard, but does read other dot-directories', async () => {
    await tree({
      'README.md': 'a',
      'node_modules/pkg/README.md': 'a',
      '.git/README.md': 'a',
      '.github/README.md': 'a',
    });
    const { attempt } = await run(probe({ path: '**/README.md' }, { target: { source: 'fileCount' }, expected: '2' }));
    expect(evaluation(attempt)).toMatchObject({ satisfied: true, actual: '2' });
  });

  it('still reads a literal path that names node_modules explicitly', async () => {
    await tree({ 'node_modules/pkg/package.json': '{"version":"1.0.0"}' });
    const { attempt } = await run(
      probe({ path: 'node_modules/pkg/package.json' }, { target: { source: 'jsonPath', path: '$.version' }, expected: '1.0.0' }),
    );
    expect(evaluation(attempt).satisfied).toBe(true);
  });

  it('removes excluded files from what the glob matched', async () => {
    await tree({ 'src/a.ts': 'x', 'src/a.test.ts': 'x', 'src/b/c.test.ts': 'x' });
    const { attempt } = await run(
      probe({ path: 'src/**/*.ts', exclude: ['src/**/*.test.ts'] }, { target: { source: 'fileCount' }, expected: '1' }),
    );
    expect(evaluation(attempt)).toMatchObject({ satisfied: true, actual: '1' });
  });

  it('matches exact names, so a case-insensitive filesystem cannot pass what Linux fails', async () => {
    await tree({ 'README.md': '# hi\n' });
    const literal = await run(probe({ path: 'readme.md' }, { target: { source: 'exists' }, expected: 'false' }));
    const glob = await run(probe({ path: 'readme.*' }, { target: { source: 'fileCount' }, expected: '0' }));
    expect(evaluation(literal.attempt).satisfied).toBe(true);
    expect(evaluation(glob.attempt).satisfied).toBe(true);
  });

  it('refuses content on a glob at run time too, for a hand-edited plan', async () => {
    await expect(
      run(probe({ path: 'docs/*.md' }, { target: { source: 'content' }, expected: 'x' })),
    ).rejects.toThrow(InfraError);
  });

  it('escapes a walk past its bound as an execError rather than reading a partial tree', async () => {
    await tree({ 'a/1.md': 'x', 'a/2.md': 'x', 'a/3.md': 'x' });
    const { attempt } = await run(
      probe({ path: 'a/*.md' }, { target: { source: 'fileCount' }, expected: '3' }),
      { limits: { maxFiles: 2 } },
    );
    expect(attempt.execError?.message).toMatch(/more than 2 files/);
  });

  it('escapes a file past the size bound as an execError rather than counting part of it', async () => {
    await tree({ 'big.txt': 'x'.repeat(64) });
    const { attempt } = await run(
      probe({ path: 'big.txt' }, { target: { source: 'occurrences', text: 'x' }, expected: '64' }),
      { limits: { maxFileBytes: 16 } },
    );
    expect(attempt.execError?.message).toMatch(/larger than 16 bytes/);
  });
});

/* ── text handling ───────────────────────────────────────────────────────────────────── */

describe('text handling', () => {
  it('reads CRLF as LF and drops a byte-order mark, so a Windows checkout reads alike', async () => {
    await tree({ 'notes.md': '\uFEFFline one\r\nline two\r\n' });
    const { attempt } = await run(
      probe(
        { path: 'notes.md' },
        { target: { source: 'content' }, comparison: 'contains', expected: 'line one\nline two' },
        { target: { source: 'content' }, comparison: 'equals', expected: 'line one\nline two\n' },
      ),
    );
    expect(evaluation(attempt, 0).satisfied).toBe(true);
    expect(evaluation(attempt, 1).satisfied).toBe(true);
  });

  it('folds case on both sides of a content comparison when asked', async () => {
    await tree({ 'README.md': 'Runs On-Demand, not in pnpm test\n' });
    const { attempt } = await run(
      probe(
        { path: 'README.md' },
        { target: { source: 'content', ignoreCase: true }, comparison: 'contains', expected: 'on-demand' },
        { target: { source: 'content' }, comparison: 'contains', expected: 'on-demand' },
      ),
    );
    expect(evaluation(attempt, 0).satisfied).toBe(true);
    expect(evaluation(attempt, 1).satisfied).toBe(false);
  });

  it('counts non-overlapping occurrences', async () => {
    await tree({ 'a.txt': 'aaaa' });
    const { attempt } = await run(probe({ path: 'a.txt' }, { target: { source: 'occurrences', text: 'aa' }, expected: '2' }));
    expect(evaluation(attempt)).toMatchObject({ satisfied: true, actual: '2' });
  });

  it('reads a JSON value with the observation surface’s own accessor', async () => {
    await tree({ 'package.json': JSON.stringify({ scripts: { test: 'pnpm -r test' }, n: [1, 2] }) });
    const { attempt } = await run(
      probe(
        { path: 'package.json' },
        { target: { source: 'jsonPath', path: '$.scripts.test' }, expected: 'pnpm -r test' },
        { target: { source: 'jsonPath', path: '$.n[1]' }, comparison: 'greaterThan', expected: '1' },
      ),
    );
    expect(evaluation(attempt, 0).satisfied).toBe(true);
    expect(evaluation(attempt, 1).satisfied).toBe(true);
  });
});

/* ── AD-13 shape, evidence, redaction ────────────────────────────────────────────────── */

describe('AD-13 — the same attempt shape as every other surface', () => {
  it('returns one evaluation per assertion, satisfied ones included, and no status', async () => {
    await tree({ 'README.md': '# project\n' });
    const { attempt } = await run(
      probe(
        { path: 'README.md' },
        { target: { source: 'exists' }, expected: 'true' },
        { target: { source: 'content' }, comparison: 'contains', expected: 'missing words' },
      ),
    );

    expect(attempt.attempt).toBe(1);
    expect(attempt.assertionEvaluations.map((e) => e.satisfied)).toEqual([true, false]);
    expect(attempt.assertionEvaluations[1]).toMatchObject({ expected: 'missing words' });
    expect(Object.keys(attempt)).not.toContain('status');
    expect(attempt.durationMs).toBe(0);
  });

  it('records one observation member naming the probe, and refs what it wrote', async () => {
    await tree({ 'docs/a.md': 'alpha\n', 'docs/b/c.md': 'alpha beta\n' });
    const { attempt, evidence } = await run(
      probe({ path: 'docs/**/*.md' }, { target: { source: 'occurrences', text: 'alpha' }, expected: '2' }),
    );

    expect(evidence.members).toHaveLength(1);
    const member = evidence.members[0] as ObservationEvidence;
    expect(member.kind).toBe('observation');
    expect(member.observationId).toBe('file:the-probe');
    // The report says WHERE each count came from, which is what would have exposed the
    // comment-counting defect to the first reader of the evidence.
    expect(member.snapshot.text).toContain('docs/b/c.md');
    expect(member.snapshot.text).toContain('"docs/a.md": 1');
    expect(attempt.evidence.length).toBeGreaterThan(0);
    expect(attempt.evidence.every((ref) => ref.kind === 'observation')).toBe(true);
  });

  it('on an execError records no member but still refs a record of what was attempted (FR-28)', async () => {
    await tree({ 'docs/x.md': 'x' });
    const { attempt, evidence } = await run(
      probe({ path: 'docs' }, { target: { source: 'content' }, comparison: 'contains', expected: 'x' }),
    );

    expect(attempt.execError).toBeDefined();
    expect(evidence.members).toEqual([]);
    expect(attempt.evidence).toHaveLength(1);
    expect(evidence.files[0]?.contents).toMatch(/^nothing was observed/);
  });

  it('redacts what it read before it reaches an evaluation or the run directory', async () => {
    await tree({ 'config.json': JSON.stringify({ token: 'hunter2-secret' }) });
    const { attempt, evidence } = await run(
      probe({ path: 'config.json' }, { target: { source: 'jsonPath', path: '$.token' }, expected: 'something-else' }),
      { redaction: { extraPatterns: [/hunter2-secret/] } },
    );

    expect(evaluation(attempt).actual).not.toContain('hunter2');
    for (const file of evidence.files) {
      expect(file.contents).not.toContain('hunter2');
    }
  });

  it('refuses malformed params as InfraError — a wiring defect, never a product FAIL', async () => {
    await expect(run({ id: 'p', surface: 'file', mechanics: {}, assertions: [] })).rejects.toThrow(
      InfraError,
    );
  });
});
