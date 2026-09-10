import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FixedClock } from '../../fakes/ports.js';
import { FileSurfaceExecutor } from '../../../src/surfaces/file.js';

/**
 * AC2, the half no behavioural test can prove: a `file` probe SPAWNS NO PROCESS AND OPENS NO
 * SOCKET — not in the cases a test happened to exercise, but on every path.
 *
 * So this reads the source. It follows every RUNTIME import reachable from
 * `src/surfaces/file.ts` through `src/**`, and asserts that nothing in that closure imports a
 * module that can start a process or reach a network. `import type` is erased at compile
 * time and cannot run, so it is not followed.
 *
 * This is structural rather than exhaustive, and says so: it cannot see a `require` built
 * from a string, and it does not look inside npm packages (the closure imports none that
 * spawn). What it does catch is the realistic regression — somebody reaching for a
 * `ProcessRunner`, `execa` or `fetch` wrapper from inside the one surface whose whole point
 * is that it runs nothing.
 */

const SRC = resolve(process.cwd(), 'src');
const ENTRY = join(SRC, 'surfaces', 'file.ts');

const FORBIDDEN = new Set([
  'child_process',
  'node:child_process',
  'cluster',
  'node:cluster',
  'worker_threads',
  'node:worker_threads',
  'net',
  'node:net',
  'dgram',
  'node:dgram',
  'tls',
  'node:tls',
  'http',
  'node:http',
  'https',
  'node:https',
  'http2',
  'node:http2',
  'execa',
  'undici',
]);

/** Modules that exist to spawn or to speak to the network, by path under `src/`. */
const FORBIDDEN_SOURCES = [
  'infra/process-runner.ts',
  'surfaces/shell.ts',
  'surfaces/http.ts',
  'surfaces/browser.ts',
];

const IMPORT = /^\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
const DYNAMIC = /\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

function runtimeClosure(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const pending = [entry];

  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (files.has(file)) {
      continue;
    }
    files.add(file);
    const source = readFileSync(file, 'utf8');

    const specifiers: string[] = [];
    for (const match of source.matchAll(IMPORT)) {
      if (match[1] === undefined && match[2] !== undefined) {
        specifiers.push(match[2]);
      }
    }
    for (const match of source.matchAll(DYNAMIC)) {
      const specifier = match[1] ?? match[2];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }

    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) {
        pending.push(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
      } else {
        bare.add(specifier);
      }
    }
  }

  return { files, bare };
}

describe('AC2 — the file surface can reach nothing that spawns or dials', () => {
  const { files, bare } = runtimeClosure(ENTRY);

  it('actually walked something, so an empty closure cannot pass', () => {
    expect(files.size).toBeGreaterThan(2);
    expect([...bare]).toContain('node:fs/promises');
  });

  it('imports no process or network module anywhere in its runtime closure', () => {
    expect([...bare].filter((specifier) => FORBIDDEN.has(specifier))).toEqual([]);
  });

  it('reaches none of the modules that exist to spawn or to issue requests', () => {
    const reached = [...files].map((file) => relative(SRC, file).split('\\').join('/'));
    expect(reached.filter((file) => FORBIDDEN_SOURCES.includes(file))).toEqual([]);
  });

  it('has no process runner to be handed, as a matter of type', () => {
    const construct = (): FileSurfaceExecutor =>
      new FileSurfaceExecutor({
        clock: new FixedClock('2026-09-10T12:00:00.000Z'),
        root: '/tmp/worktree',
        writeEvidence: (name) => Promise.resolve(name),
        recordEvidence: () => undefined,
        // @ts-expect-error — a file probe runs nothing, so its executor accepts no runner.
        runner: { run: () => Promise.reject(new Error('never')) },
      });
    expect(construct).toBeTypeOf('function');
  });
});
