/**
 * Installs the fake `codex` binary (`codex-shim.sh`) into a throwaway directory
 * and hands back the handles a test needs to assert on it.
 *
 * Story 2.5. The adapter suite must never spawn the real Codex CLI, never read
 * `~/.codex/`, and never consume a ChatGPT subscription (AD-12: the one real-CLI
 * test is tagged and skipped by default). Everything else runs against this.
 *
 * USAGE
 *   const shim = await installCodexShim({ mode: 'capable', answer: '{"criteria":[]}' });
 *   try {
 *     // put `shim.dir` first on the CHILD's PATH — never on this process's
 *     await runner.run({ binary: 'codex', args, cwd, timeoutMs,
 *                        env: { inherit: true, set: { PATH: shim.pathPrefixedWith(process.env.PATH) } } });
 *     expect(await shim.argv()).toEqual(['exec', '--output-schema', ...]);
 *   } finally {
 *     await shim.cleanup();
 *   }
 *
 * The absent-binary case is deliberately NOT a mode: it is produced by pointing
 * PATH at an empty directory (`installMissingCodex()`), so the ENOENT comes from
 * the operating system rather than from a simulation of it.
 */

import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SHIM_SOURCE = fileURLToPath(new URL('./codex-shim.sh', import.meta.url));

/**
 * Which failure the fake binary should model. One mode per failure the adapter
 * has to tell apart — a single "unhappy" shim would let a test pass while the
 * adapter conflated "missing binary" with "binary said no".
 */
export type CodexShimMode =
  /** Behaves like codex-cli 0.144.4: answers `--version`, `doctor` and `exec`. */
  | 'capable'
  /** On PATH, but `--version` errors — found something we cannot identify. */
  | 'version-fails'
  /** A DIFFERENT program named `codex`: exits 0, prints plausible text. */
  | 'not-codex'
  /** `exec` exists but rejects `--output-schema` (an older codex). */
  | 'exec-rejecting'
  /** `--version` works, `exec` is not a subcommand at all. */
  | 'version-only'
  /** Exits 0 and writes NO answer file — must never be a silent empty success. */
  | 'last-message-missing'
  /** `exec` fails mid-stream with a non-zero exit. */
  | 'nonzero-exit'
  /** Never answers — exercises the per-call timeout. */
  | 'hanging'
  /** `codex doctor` reports "not signed in" (said no, conclusively). */
  | 'auth-missing'
  /** This codex has no `doctor` subcommand — "could not tell", not a diagnosis. */
  | 'no-doctor-subcommand';

export interface InstalledShim {
  /** The directory to put FIRST on the child's PATH. Contains only `codex`. */
  readonly dir: string;
  /** Full path to the fake binary. */
  readonly binary: string;
  /** `dir` prepended to an existing PATH value. */
  pathPrefixedWith(existing: string | undefined): string;
  /** Every argument the shim received, in order. Exact-argv assertions use this. */
  argv(): Promise<string[]>;
  /** The working directory the child actually started in. */
  cwd(): Promise<string>;
  /** The child's full environment as `NAME=VALUE`, values included. */
  env(): Promise<string[]>;
  /** The child's environment as a map — convenient for withholding assertions. */
  envMap(): Promise<Record<string, string>>;
  /** Content of the file passed to `--output-schema`, or undefined if none was. */
  schema(): Promise<string | undefined>;
  /** How many times the fake binary ran — proves "probed once per session". */
  invocations(): Promise<number>;
  cleanup(): Promise<void>;
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/** Splits a NUL-separated recording. Newlines inside a value survive intact. */
function splitNul(raw: string | undefined): string[] {
  if (raw === undefined || raw === '') {
    return [];
  }
  const parts = raw.split('\0');
  // The writer NUL-TERMINATES rather than separates, so the tail is always ''.
  if (parts.at(-1) === '') {
    parts.pop();
  }
  return parts;
}

export interface InstallShimOptions {
  readonly mode?: CodexShimMode;
  /** Exact text the shim writes to the `--output-last-message` file. */
  readonly answer?: string;
}

export async function installCodexShim(options: InstallShimOptions = {}): Promise<InstalledShim> {
  const dir = await mkdtemp(join(tmpdir(), 'specwitness-codex-shim-'));
  const binary = join(dir, 'codex');

  await copyFile(SHIM_SOURCE, binary);
  // 0o755: executable, and not group/world writable — a PATH entry anyone could
  // rewrite would be a genuine hazard even in a test.
  await chmod(binary, 0o755);
  await writeFile(join(dir, 'mode'), options.mode ?? 'capable', 'utf8');
  if (options.answer !== undefined) {
    await writeFile(join(dir, 'answer'), options.answer, 'utf8');
  }

  return {
    dir,
    binary,
    pathPrefixedWith: (existing) =>
      existing === undefined || existing === '' ? dir : `${dir}${delimiter}${existing}`,
    argv: async () => splitNul(await readIfPresent(join(dir, 'record.argv'))),
    cwd: async () => (await readIfPresent(join(dir, 'record.cwd')))?.trimEnd() ?? '',
    env: async () => splitNul(await readIfPresent(join(dir, 'record.env'))),
    envMap: async () => {
      const entries = splitNul(await readIfPresent(join(dir, 'record.env')));
      const map: Record<string, string> = {};
      for (const entry of entries) {
        const eq = entry.indexOf('=');
        if (eq > 0) {
          map[entry.slice(0, eq)] = entry.slice(eq + 1);
        }
      }
      return map;
    },
    schema: async () => readIfPresent(join(dir, 'record.schema')),
    invocations: async () => Number((await readIfPresent(join(dir, 'record.count')))?.trim() ?? '0'),
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A PATH entry with no `codex` in it, so a lookup produces a real ENOENT from
 * the OS. Story 2.5 requires a missing binary to surface as a typed flag
 * (`outcome: 'not-found'`), never a throw — and that is only worth asserting
 * against a genuine ENOENT rather than a simulated one.
 */
export async function installMissingCodex(): Promise<{
  readonly dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'specwitness-codex-absent-'));
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
