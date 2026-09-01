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

/**
 * Epic 2 retrospective §5a, defect (ii) — assigned to story 3.7 by the owner on
 * 2026-08-31.
 *
 * The durability barrier runs AFTER the rename, and the rename is the moment the
 * write commits. Reporting a barrier failure as "could not write
 * .specwitness/contracts/<epic>.yaml" therefore told the operator the file was
 * unchanged while it had in fact been replaced — a lie about state in the module
 * whose entire purpose is that state is never ambiguous. It is also the lie that
 * invites re-running a generation over a contract that already changed underneath
 * the operator.
 *
 * Both halves of the fix are asserted: a post-rename failure is non-fatal AND
 * stays visible, and a PRE-rename failure is still fatal with the previous
 * contract intact.
 */
describe('writeContractFileAtomically — the durability barrier is not the write', () => {
  const failingBarrier = () => Promise.reject(new Error('simulated EIO fsyncing the directory'));

  it('does not report a committed write as failed when the post-rename fsync fails', async () => {
    const root = await project();
    await writeContractFileAtomically(root, 'epic-7', 'the original frozen contract\n');

    await expect(
      writeContractFileAtomically(root, 'epic-7', 'the replacement that DID land\n', {
        syncDirectory: failingBarrier,
      }),
    ).resolves.toBeUndefined();

    // The claim the old code made — "could not write" — was false: read the file.
    expect(await readFile(resolveContractPath(root, 'epic-7'), 'utf8')).toBe(
      'the replacement that DID land\n',
    );
  });

  it('reports the barrier failure as a warning naming the file, not as a write failure', async () => {
    const root = await project();
    const warnings: string[] = [];

    await writeContractFileAtomically(root, 'epic-7', 'landed\n', {
      syncDirectory: failingBarrier,
      onDurabilityWarning: (message) => warnings.push(message),
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(contractRelativePath('epic-7'));
    expect(warnings[0]).toContain('simulated EIO fsyncing the directory');
    // The wording that caused the defect must not come back through the warning.
    expect(warnings[0]).not.toContain('could not write');
  });

  it('still removes the staging directory when the barrier fails', async () => {
    const root = await project();

    await writeContractFileAtomically(root, 'epic-7', 'landed\n', {
      syncDirectory: failingBarrier,
    });

    expect(await readdir(join(root, '.specwitness', 'contracts'))).toEqual(['epic-7.yaml']);
  });

  it('keeps a PRE-rename failure fatal, with the previous contract intact', async () => {
    const root = await project();
    await writeContractFileAtomically(root, 'epic-7', 'the original frozen contract\n');

    // Fails before the rename, so nothing committed: this one MUST still throw.
    await expect(
      writeContractFileAtomically(root, 'epic-7', 'a replacement that never lands\n', {
        onStage: () => {
          throw new Error('simulated crash after staging');
        },
        syncDirectory: failingBarrier,
      }),
    ).rejects.toThrow(InfraError);

    expect(await readFile(resolveContractPath(root, 'epic-7'), 'utf8')).toBe(
      'the original frozen contract\n',
    );
  });

  it('uses the real barrier when none is injected — the seam has no production caller', async () => {
    const root = await project();

    // No `syncDirectory` option, so this exercises the shipped fsync path: the
    // one that must keep working, and that tolerates EINVAL where a filesystem
    // does not support the operation.
    await expect(
      writeContractFileAtomically(root, 'epic-7', 'durably written\n'),
    ).resolves.toBeUndefined();

    expect(await readFile(resolveContractPath(root, 'epic-7'), 'utf8')).toBe('durably written\n');
  });
});
