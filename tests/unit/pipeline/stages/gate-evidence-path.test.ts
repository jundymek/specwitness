import { describe, expect, it } from 'vitest';

import {
  GATE_EVIDENCE_DIR,
  gateEvidenceRelativePath,
} from '../../../../src/pipeline/stages/gate-evidence-path.js';

/**
 * Where a gate's FULL output file lands inside the run directory.
 *
 * This exists as its own table rather than only being exercised through a gate
 * run, because the input is only constrained by `nonEmptyString` in the merged
 * config schema — a gate id has NO charset limit — and the failure mode is
 * subtle: `RunStore.writeEvidenceFile` correctly rejects a `..` segment and the
 * filesystem correctly rejects an over-long component, and BOTH arrive as an
 * `InfraError`, i.e. as exit 3 for a schema-valid config.
 *
 * That is infrastructure being blamed for something that is not infrastructure
 * — the exact failure class story 3.4 exists to prevent, reaching the operator
 * from the side nobody was watching. So the derivation is TOTAL: every string
 * maps to a safe, single path component.
 *
 * Division of labour, stated because this is where two owners of one guardrail
 * would come from: `RunStore`'s containment rule is unchanged and remains the
 * guarantee that escape is impossible. This function does not validate on its
 * behalf — it merely never needs that guarantee to fire.
 */

/** The one path component the gate id is allowed to influence. */
const fileNameOf = (path: string): string => path.slice(`${GATE_EVIDENCE_DIR}/`.length);

describe('gateEvidenceRelativePath: the ordinary shapes', () => {
  it('places files under the evidence directory', () => {
    expect(gateEvidenceRelativePath('lint', 0, 'stdout')).toBe('evidence/gate-00-lint.stdout.txt');
  });

  it('zero-pads the declaration index so a listing sorts in execution order', () => {
    expect(gateEvidenceRelativePath('lint', 0, 'stdout')).toBe('evidence/gate-00-lint.stdout.txt');
    expect(gateEvidenceRelativePath('build', 7, 'stdout')).toBe('evidence/gate-07-build.stdout.txt');
  });

  it('widens past two digits rather than truncating the index', () => {
    // Collision-freedom rests on the index being complete, not on it being two
    // characters. A project with 100+ gates is odd, not invalid.
    expect(gateEvidenceRelativePath('x', 100, 'stdout')).toBe('evidence/gate-100-x.stdout.txt');
  });

  it('keeps characters that are already safe', () => {
    expect(gateEvidenceRelativePath('type_check.v2-1', 3, 'stdout')).toBe(
      'evidence/gate-03-type_check.v2-1.stdout.txt',
    );
  });
});

describe('gateEvidenceRelativePath: is total for any schema-valid gate id', () => {
  it('never produces a path escaping the evidence directory', () => {
    const hostile = [
      '../x',
      '../../etc/passwd',
      '..',
      '.',
      '...',
      '/absolute',
      'a/b/c',
      './rel',
      'x/../../y',
    ];

    for (const id of hostile) {
      const path = gateEvidenceRelativePath(id, 1, 'stdout');
      const name = fileNameOf(path);

      expect(path.startsWith(`${GATE_EVIDENCE_DIR}/`)).toBe(true);
      // One component: the gate id can never introduce a directory level.
      expect(name).not.toContain('/');
      expect(name).not.toContain('\\');
      // Never a dotfile, and never a name that IS a traversal segment.
      expect(name.startsWith('.')).toBe(false);
      expect(name).not.toBe('..');
      expect(name).not.toBe('.');
      expect(name).not.toContain('..');
    }
  });

  it('drops the slug segment entirely when it normalizes to nothing', () => {
    // `gate-03-.txt` and `gate-03----.txt` are the filenames somebody opens an
    // issue about. The index alone is already unique, so nothing is lost.
    expect(gateEvidenceRelativePath('...', 3, 'stdout')).toBe('evidence/gate-03.stdout.txt');
    expect(gateEvidenceRelativePath('///', 3, 'stdout')).toBe('evidence/gate-03.stdout.txt');
    expect(gateEvidenceRelativePath('-', 3, 'stdout')).toBe('evidence/gate-03.stdout.txt');
    expect(gateEvidenceRelativePath('..', 3, 'stdout')).toBe('evidence/gate-03.stdout.txt');
  });

  it('substitutes unsafe characters rather than deleting them', () => {
    // Deleting would silently collapse two distinct ids to one name; the index
    // still guarantees uniqueness, but a reader should be able to tell them
    // apart by eye.
    expect(gateEvidenceRelativePath('unit tests', 2, 'stdout')).toBe('evidence/gate-02-unit-tests.stdout.txt');
  });

  it('collapses runs of substituted characters and trims the edges', () => {
    expect(gateEvidenceRelativePath('a///b', 2, 'stdout')).toBe('evidence/gate-02-a-b.stdout.txt');
    expect(gateEvidenceRelativePath('  spaced  ', 2, 'stdout')).toBe('evidence/gate-02-spaced.stdout.txt');
  });

  it('handles non-ASCII ids without emitting them raw', () => {
    const path = gateEvidenceRelativePath('lint-ünïcode-✓', 4, 'stdout');
    expect(path.startsWith('evidence/gate-04')).toBe(true);
    expect(fileNameOf(path)).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe('gateEvidenceRelativePath: length is bounded', () => {
  it('truncates an over-long gate id well inside a filesystem component limit', () => {
    // 255 bytes is the component limit on APFS and ext4. An over-long id would
    // otherwise surface as ENAMETOOLONG from RunStore's write — an InfraError,
    // i.e. exit 3, for a config that is perfectly valid.
    const path = gateEvidenceRelativePath('a'.repeat(500), 5, 'stdout');
    const name = fileNameOf(path);

    expect(Buffer.byteLength(name, 'utf8')).toBeLessThan(255);
    expect(name.startsWith('gate-05-')).toBe(true);
    expect(name.endsWith('.stdout.txt')).toBe(true);
  });

  it('does not leave a dangling separator after truncation', () => {
    const path = gateEvidenceRelativePath(`${'a'.repeat(63)}-${'b'.repeat(60)}`, 6, 'stdout');
    expect(fileNameOf(path)).not.toMatch(/-\.stdout\.txt$/);
  });

  it('stays bounded for a long non-ASCII id', () => {
    const path = gateEvidenceRelativePath('✓'.repeat(400), 7, 'stdout');
    expect(Buffer.byteLength(fileNameOf(path), 'utf8')).toBeLessThan(255);
  });
});

describe('gateEvidenceRelativePath: the two streams never share a file', () => {
  /**
   * `gateEvidence` carries a separate `stdoutFullPath` and `stderrFullPath`
   * because one pointer shared by two truncation markers has each stream
   * claiming its own distinct content lives in the same file — worse than no
   * pointer, since a reader opens it and takes stderr for stdout. That bug was
   * found in 3.3's own Codex review; this is the consumer-side guard that the
   * two names cannot converge.
   */
  it('gives stdout and stderr different paths for the same gate', () => {
    expect(gateEvidenceRelativePath('lint', 0, 'stdout')).not.toBe(
      gateEvidenceRelativePath('lint', 0, 'stderr'),
    );
  });

  it('names the stream in the path so a run directory is readable by hand', () => {
    expect(gateEvidenceRelativePath('lint', 0, 'stderr')).toBe(
      'evidence/gate-00-lint.stderr.txt',
    );
  });

  it('keeps the streams distinct even when the id normalizes to nothing', () => {
    expect(gateEvidenceRelativePath('...', 3, 'stdout')).toBe('evidence/gate-03.stdout.txt');
    expect(gateEvidenceRelativePath('...', 3, 'stderr')).toBe('evidence/gate-03.stderr.txt');
  });

  it('keeps the streams distinct after slug truncation', () => {
    const long = 'q'.repeat(300);
    expect(gateEvidenceRelativePath(long, 4, 'stdout')).not.toBe(
      gateEvidenceRelativePath(long, 4, 'stderr'),
    );
  });

  it('stays inside a filesystem component limit for BOTH streams', () => {
    for (const stream of ['stdout', 'stderr'] as const) {
      const name = fileNameOf(gateEvidenceRelativePath('a'.repeat(500), 999, stream));
      expect(Buffer.byteLength(name, 'utf8')).toBeLessThan(255);
    }
  });
});

describe('gateEvidenceRelativePath: distinct gates never collide', () => {
  it('separates two ids that slugify identically', () => {
    // `a b` and `a-b` both slug to `a-b`. The declaration index is what keeps
    // them apart, which is the third thing the index buys.
    expect(gateEvidenceRelativePath('a b', 0, 'stdout')).not.toBe(gateEvidenceRelativePath('a-b', 1, 'stdout'));
  });

  it('separates two ids that are identical after truncation', () => {
    const long = 'z'.repeat(80);
    expect(gateEvidenceRelativePath(`${long}-one`, 0, 'stdout')).not.toBe(
      gateEvidenceRelativePath(`${long}-two`, 1, 'stdout'),
    );
  });

  it('produces a unique path for every index across a declared gate list', () => {
    const ids = ['install', 'lint', 'lint', '../lint', '', '...', 'lint'];
    const paths = ids.map((id, index) => gateEvidenceRelativePath(id, index, 'stdout'));
    expect(new Set(paths).size).toBe(paths.length);
  });
});
