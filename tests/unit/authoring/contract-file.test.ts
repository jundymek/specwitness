import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertProjectInitialised,
  contractRelativePath,
  readContractFile,
  resolveContractPath,
  writeContractFileAtomically,
} from '../../../src/authoring/contract-file.js';
import { InfraError, UsageError } from '../../../src/domain/errors.js';

/**
 * The contract file is the artifact this whole product exists to protect, so
 * these tests are about the WRITE DISCIPLINE as much as the happy path: never a
 * half-written file, never a directory created behind the operator's back.
 */

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A temp project with `.specwitness/contracts/` already scaffolded, as `init` leaves it. */
async function project(options: { initialised?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'specwitness-contract-file-'));
  created.push(root);

  if (options.initialised !== false) {
    await mkdir(join(root, '.specwitness', 'contracts'), { recursive: true });
  }

  return root;
}

describe('resolveContractPath', () => {
  it('places a contract at .specwitness/contracts/<canonical-epic>.yaml', async () => {
    const root = await project();

    expect(resolveContractPath(root, 'epic-7')).toBe(
      join(root, '.specwitness', 'contracts', 'epic-7.yaml'),
    );
  });

  it('normalises every accepted spelling of an epic id to the same path', async () => {
    const root = await project();
    const canonical = resolveContractPath(root, 'epic-7');

    expect(resolveContractPath(root, '7')).toBe(canonical);
    expect(resolveContractPath(root, 'epic-07')).toBe(canonical);
    expect(resolveContractPath(root, 'EPIC-7')).toBe(canonical);
  });

  it('rejects a malformed epic id as a usage error, before touching the disk', async () => {
    const root = await project();

    expect(() => resolveContractPath(root, 'seven')).toThrow(UsageError);
  });

  it('reports a repo-relative path for messages', () => {
    expect(contractRelativePath('epic-7')).toBe('.specwitness/contracts/epic-7.yaml');
  });
});

describe('assertProjectInitialised', () => {
  it('passes when .specwitness/contracts/ exists', async () => {
    const root = await project();

    await expect(assertProjectInitialised(root)).resolves.toBeUndefined();
  });

  it('refuses with a hint naming init when the project was never initialised', async () => {
    const root = await project({ initialised: false });

    await expect(assertProjectInitialised(root)).rejects.toThrow(InfraError);
    await expect(assertProjectInitialised(root)).rejects.toMatchObject({
      hint: expect.stringContaining('init'),
    });
  });

  it('does NOT create the directory it is checking for', async () => {
    const root = await project({ initialised: false });

    await assertProjectInitialised(root).catch(() => undefined);

    await expect(readdir(join(root, '.specwitness'))).rejects.toThrow();
  });
});

describe('readContractFile', () => {
  it('returns undefined when no contract exists — absence is an answer, not an error', async () => {
    const root = await project();

    expect(await readContractFile(root, 'epic-7')).toBeUndefined();
  });

  it('returns the file text verbatim, including trailing newline', async () => {
    const root = await project();
    await writeFile(resolveContractPath(root, 'epic-7'), 'spec: {}\n', 'utf8');

    expect(await readContractFile(root, 'epic-7')).toBe('spec: {}\n');
  });

  it('raises an infra error rather than reporting absence when the file is unreadable', async () => {
    const root = await project();
    const path = resolveContractPath(root, 'epic-7');
    await writeFile(path, 'spec: {}\n', 'utf8');
    await chmod(path, 0o000);

    // Running as root defeats the permission bit; skip rather than assert a
    // falsehood about the environment.
    let readable = true;
    try {
      await readFile(path, 'utf8');
    } catch {
      readable = false;
    }

    if (!readable) {
      await expect(readContractFile(root, 'epic-7')).rejects.toThrow(InfraError);
    }

    await chmod(path, 0o600);
  });
});

describe('writeContractFileAtomically', () => {
  it('writes the contract text', async () => {
    const root = await project();

    await writeContractFileAtomically(root, 'epic-7', 'spec:\n  epic: epic-7\n');

    expect(await readFile(resolveContractPath(root, 'epic-7'), 'utf8')).toBe(
      'spec:\n  epic: epic-7\n',
    );
  });

  it('replaces an existing contract completely, leaving no trailing remnant', async () => {
    const root = await project();
    await writeContractFileAtomically(root, 'epic-7', 'a much longer previous contract\n');

    await writeContractFileAtomically(root, 'epic-7', 'short\n');

    expect(await readFile(resolveContractPath(root, 'epic-7'), 'utf8')).toBe('short\n');
  });

  it('leaves no temporary file behind on success', async () => {
    const root = await project();

    await writeContractFileAtomically(root, 'epic-7', 'spec: {}\n');

    expect(await readdir(join(root, '.specwitness', 'contracts'))).toEqual(['epic-7.yaml']);
  });

  it('stages in the same directory, so the rename cannot cross a filesystem', async () => {
    const root = await project();
    const seen: string[] = [];

    await writeContractFileAtomically(root, 'epic-7', 'spec: {}\n', {
      onStage: (path) => seen.push(path),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.startsWith(join(root, '.specwitness', 'contracts'))).toBe(true);
  });

  it('leaves the previous contract intact when the write fails mid-way', async () => {
    const root = await project();
    await writeContractFileAtomically(root, 'epic-7', 'the original frozen contract\n');

    await expect(
      writeContractFileAtomically(root, 'epic-7', 'a replacement that never lands\n', {
        onStage: () => {
          throw new Error('simulated crash after staging');
        },
      }),
    ).rejects.toThrow(InfraError);

    // The whole point of stage-and-rename: an interrupted write is invisible.
    expect(await readFile(resolveContractPath(root, 'epic-7'), 'utf8')).toBe(
      'the original frozen contract\n',
    );
  });

  it('removes the staged file when the write fails, so no debris accumulates', async () => {
    const root = await project();

    await expect(
      writeContractFileAtomically(root, 'epic-7', 'never lands\n', {
        onStage: () => {
          throw new Error('simulated crash after staging');
        },
      }),
    ).rejects.toThrow(InfraError);

    expect(await readdir(join(root, '.specwitness', 'contracts'))).toEqual([]);
  });

  it('round-trips a very long statement and unusual unicode unchanged', async () => {
    const root = await project();
    const exotic = `spec:\n  statement: "${'x'.repeat(5000)} — ✓ №7 🇵🇱 é é"\n`;

    await writeContractFileAtomically(root, 'epic-7', exotic);

    expect(await readFile(resolveContractPath(root, 'epic-7'), 'utf8')).toBe(exotic);
  });
});
