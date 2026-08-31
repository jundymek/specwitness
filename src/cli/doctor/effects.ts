/**
 * The real side effects behind `DoctorContext.effects`.
 *
 * Every outward-facing thing doctor does lives here — spawning `git`, statting a
 * file, resolving a module, binding a port — so that checks stay pure logic over
 * an injected surface and unit tests need no real git, socket or filesystem.
 *
 * AD-3: the ONLY command this module ever spawns is `git`, with a fixed argument
 * array and no shell. Project-declared commands are RESOLVED, never executed —
 * doctor diagnoses, and execution arrives in Epic 3 behind `DeclaredCommand`.
 */

import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { execa } from 'execa';

/** Outcome of a trusted-tooling subprocess (git only). */
export interface RunOutcome {
  /** `null` when the process was killed (e.g. a timeout) or never started. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** True when the binary itself could not be spawned (ENOENT on PATH). */
  readonly notFound: boolean;
}

export interface RunOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
}

export interface PortProbe {
  readonly free: boolean;
  /** Populated only when the bind failed, e.g. `EADDRINUSE`. */
  readonly reason?: string;
}

export interface DoctorEffects {
  /** Spawns trusted tooling (git). Never a project-declared command. */
  runGit(args: readonly string[], options: RunOptions): Promise<RunOutcome>;
  /** True when the path exists and is a regular file with an executable bit. */
  isExecutableFile(path: string): Promise<boolean>;
  /** True when the path exists at all (file or directory). */
  pathExists(path: string): Promise<boolean>;
  /** True when `specifier` resolves from `fromDir` (project-local node_modules). */
  resolvesFrom(specifier: string, fromDir: string): boolean;
  /** Binds and immediately releases a localhost port to see whether it is free. */
  probePort(port: number, host: string): Promise<PortProbe>;
}

interface SpawnFailure extends Error {
  code?: string;
  timedOut?: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

/** The subset of an execa result — resolved OR thrown — that classification needs. */
interface SpawnLike {
  code?: string;
  cause?: unknown;
  timedOut?: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

/** True when this spawn outcome carries an ENOENT, from either shape execa uses. */
function isEnoent(result: SpawnLike): boolean {
  if (result.code === 'ENOENT') {
    return true;
  }
  const cause = result.cause;
  return (
    typeof cause === 'object' && cause !== null && (cause as { code?: string }).code === 'ENOENT'
  );
}

/**
 * True when the BINARY could not be found — and not merely when something
 * raised ENOENT.
 *
 * Two traps live here, both found the same way (a story modelling its own code
 * on this function, going red, and reporting it) and both reproduced against
 * the installed execa before being fixed.
 *
 * ONE: `reject: false` means a binary that is not on PATH does NOT throw — it
 * RESOLVES, with `code: 'ENOENT'` and `exitCode: undefined`. Testing for ENOENT
 * only inside a `catch` therefore never ran, and `notFound` was false for every
 * input this function had ever seen: doctor reported "git exited without a
 * code" on a machine with no git installed, which is the single diagnosis it
 * most exists to give. Both paths now funnel through here so they cannot
 * disagree again.
 *
 * TWO: an invalid `cwd` raises the SAME ENOENT as a missing binary. Classifying
 * on ENOENT alone would make doctor say "git not found on PATH; install git" to
 * an operator whose git is fine and whose directory is not — a confidently
 * wrong diagnosis, which is worse than a vague one from the tool whose whole
 * job is to tell "missing" from "hung" from "said no". So the filesystem is
 * asked, and only a real directory lets an ENOENT mean "no such binary".
 *
 * Reported by story 2.3 (pamela), whose `ProcessRunner` hit both.
 */
async function isBinaryNotFound(result: SpawnLike, cwd: string): Promise<boolean> {
  if (!isEnoent(result)) {
    return false;
  }

  try {
    const stats = await stat(cwd);
    return stats.isDirectory();
  } catch {
    // The cwd itself is what is missing. Not a diagnosis about the binary.
    return false;
  }
}

/**
 * execa reports an invalid `cwd` on the error's MESSAGE, leaving `stderr` empty,
 * because no child ever ran to write anything. Passing the empty string through
 * would report a failure with no explanation at all.
 */
function explain(stderr: unknown, message: unknown): string {
  const text = typeof stderr === 'string' ? stderr : '';
  if (text !== '') {
    return text;
  }
  return typeof message === 'string' ? message : '';
}

async function runGit(args: readonly string[], options: RunOptions): Promise<RunOutcome> {
  try {
    const result = await execa('git', [...args], {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      reject: false,
      // Prompt-free by contract: git must never open an editor, a pager or a
      // credential prompt while doctor is diagnosing.
      input: '',
      env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      extendEnv: true,
    });

    const spawn = result as unknown as SpawnLike;
    return {
      exitCode: result.exitCode ?? null,
      stdout: result.stdout,
      stderr: explain(result.stderr, (result as unknown as { message?: unknown }).message),
      timedOut: result.timedOut === true,
      notFound: await isBinaryNotFound(spawn, options.cwd),
    };
  } catch (error) {
    // `reject: false` suppresses non-zero exits AND spawn failures, so reaching
    // here is rarer than it looks — but a killed process or an invalid option
    // still lands here, and it must classify identically.
    const failure = error as SpawnFailure;
    return {
      exitCode: failure.exitCode ?? null,
      stdout: failure.stdout ?? '',
      stderr: explain(failure.stderr, failure.message),
      timedOut: failure.timedOut === true,
      notFound: await isBinaryNotFound(failure as SpawnLike, options.cwd),
    };
  }
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    // Any execute bit (owner/group/other) counts: doctor reports resolvability,
    // and deciding whether THIS user may run it is the runner's problem in
    // Epic 3, where the failure is observable rather than guessed.
    return stats.isFile() && (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function resolvesFrom(specifier: string, fromDir: string): boolean {
  try {
    // Resolving relative to a file inside the directory is what makes this a
    // PROJECT-local lookup: a dependency hoisted into SpecWitness's own
    // node_modules must not make a target project look provisioned.
    const require = createRequire(pathToFileURL(join(fromDir, 'noop.js')));
    require.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

async function probePort(port: number, host: string): Promise<PortProbe> {
  return await new Promise<PortProbe>((resolve) => {
    const server = createServer();
    let settled = false;

    const settle = (probe: PortProbe): void => {
      if (settled) {
        return;
      }
      settled = true;
      // The socket is released before the promise resolves, always: doctor must
      // never leave a listener holding the port it just told the user is free.
      server.close(() => resolve(probe));
    };

    server.once('error', (error: NodeJS.ErrnoException) => {
      settled = true;
      server.close();
      resolve({ free: false, reason: error.code ?? error.message });
    });

    server.once('listening', () => settle({ free: true }));

    try {
      server.listen({ port, host, exclusive: true });
    } catch (error) {
      settled = true;
      resolve({ free: false, reason: (error as Error).message });
    }
  });
}

export function createDoctorEffects(): DoctorEffects {
  return { runGit, isExecutableFile, pathExists, resolvesFrom, probePort };
}
