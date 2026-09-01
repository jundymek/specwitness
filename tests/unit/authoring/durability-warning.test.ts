import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../../src', import.meta.url));

/**
 * The post-rename durability barrier reports through `onDurabilityWarning`, and
 * a callback nobody passes is a failure nobody hears.
 *
 * The first version of the §5a (ii) fix made the barrier non-fatal and left the
 * callback optional with no production caller — which traded a lie about state
 * ("could not write" about a file that had been replaced) for a silence, and a
 * review caught it. This scan is what stops the silence coming back: a new call
 * site that forgets the warning fails here rather than in a bug report about a
 * contract nobody noticed was not durable.
 *
 * Written as a scan rather than as a behavioural test on purpose. Making a real
 * directory fsync fail is not portable — that is why the barrier is injectable
 * at all — so what CAN be checked mechanically is that every caller is wired.
 */
async function tsFilesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return tsFilesUnder(full);
      return entry.name.endsWith('.ts') ? [full] : [];
    }),
  );
  return files.flat();
}

/** The writer's own module defines the function; it is not a caller of itself. */
const DEFINITION = join(SRC, 'authoring', 'contract-file.ts');

describe('every production contract write reports a durability failure', () => {
  it('finds the call sites at all', async () => {
    // Guards against the scan passing because it looked at nothing — the same
    // failure mode `tests/unit/exit-location.test.ts` guards against.
    const files = await tsFilesUnder(SRC);
    const callers = await callSites(files);

    expect(callers.length).toBeGreaterThan(0);
  });

  it('detects an UNWIRED call site when one is present', async () => {
    // A scan that has never matched anything is not evidence. This runs the same
    // extraction over a synthetic sample, so the check is proved to work rather
    // than assumed to — the pattern `tests/unit/exit-location.test.ts` set.
    const wired = "await writeContractFileAtomically(root, epic, text, {\n  onDurabilityWarning: printWarning,\n});";
    const bare = 'await writeContractFileAtomically(root, epic, text);';

    expect(unwiredCallsIn(wired)).toBe(0);
    expect(unwiredCallsIn(bare)).toBe(1);
    expect(unwiredCallsIn(`${wired}\n${bare}`)).toBe(1);
  });

  it('passes onDurabilityWarning at every call site', async () => {
    const files = await tsFilesUnder(SRC);
    const callers = await callSites(files);

    const unwired = callers
      .filter(({ text }) => unwiredCallsIn(text) > 0)
      .map(({ file }) => file);

    expect(unwired).toEqual([]);
  });
});

/**
 * How many `writeContractFileAtomically(...)` calls in `text` omit the warning.
 *
 * The call spans lines, so this reads the invocation's argument list up to its
 * closing parenthesis rather than testing a single line.
 */
function unwiredCallsIn(text: string): number {
  let unwired = 0;
  for (const call of text.split('writeContractFileAtomically(').slice(1)) {
    const end = call.indexOf(');');
    const args = end === -1 ? call : call.slice(0, end);
    if (!args.includes('onDurabilityWarning')) {
      unwired += 1;
    }
  }
  return unwired;
}

async function callSites(files: readonly string[]): Promise<{ file: string; text: string }[]> {
  const found: { file: string; text: string }[] = [];
  for (const file of files) {
    if (file === DEFINITION) continue;
    const text = await readFile(file, 'utf8');
    if (text.includes('writeContractFileAtomically(')) {
      found.push({ file, text });
    }
  }
  return found;
}
