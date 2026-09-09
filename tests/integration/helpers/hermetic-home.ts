/**
 * A HOME that belongs to nobody — story 7.7.
 *
 * ⚠️ WHY THIS EXISTS. `execa`'s `extendEnv` defaults to true, so a child spawned
 * from a suite inherits the environment of whoever ran `vitest`, `HOME`
 * included. For most commands that is harmless. For the ones that read state
 * beneath the home directory it is not: `doctor`'s `playwright-capability`
 * check resolves `@playwright/test` from the project **and from SpecWitness's
 * own cache** (`src/infra/playwright-env.ts`), and story 7.0 made `verify`
 * write that cache on the first run whose plan carries a browser probe. From
 * that moment a suite that let the real `HOME` through reported one answer on a
 * machine that had dogfooded and another on a fresh CI runner — a green that
 * means nothing on a clean machine and a red that means nothing on a dirty one.
 * That is exactly what `tests/integration/doctor.test.ts` did until 7.7.
 *
 * The rule these helpers exist to keep: **a test's verdict is a fact about the
 * tree under test.** State a test depends on is state the test CONSTRUCTS.
 *
 * NFR-1 / AD-4 note, since this is about home directories: pointing `HOME`
 * somewhere empty is also what keeps an accidental read of `~/.claude/` or
 * `~/.codex/` out of a suite. Nothing in this repository may touch those, and a
 * test that inherits the developer's home is how it would happen by accident.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A fresh, empty home directory. The CALLER owns its removal — every suite here
 * already tracks its temp directories, and a helper that registered its own
 * cleanup would be a second, invisible one.
 */
export async function hermeticHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'specwitness-home-'));
}

/**
 * The environment overrides that put a child's whole notion of "home" inside
 * `home`.
 *
 * ALL FOUR VARIABLES, not just `HOME`, because the cache root is resolved
 * differently per platform (`src/infra/playwright-env.ts#userCacheRoot`):
 * `XDG_CACHE_HOME` wins on Linux, `LOCALAPPDATA` on Windows, and macOS derives
 * `~/Library/Caches` from the home directory alone. Overriding only `HOME`
 * would leave a Linux runner with `XDG_CACHE_HOME` exported still reading the
 * developer's cache — the same defect, surviving the fix on one platform.
 * `USERPROFILE` is what `os.homedir()` reads on Windows.
 *
 * `PLAYWRIGHT_BROWSERS_PATH` is UNSET rather than pointed anywhere: it is
 * Playwright's own registry override, it is honoured by the resolver, and an
 * operator who has it exported would otherwise move the browsers half of the
 * answer back outside the constructed home.
 */
export function hermeticHomeEnv(home: string): Record<string, string | undefined> {
  return {
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: join(home, '.cache'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    PLAYWRIGHT_BROWSERS_PATH: undefined,
  };
}

/**
 * Where SpecWitness's own Playwright cache lands under a home built by
 * `hermeticHomeEnv`.
 *
 * MIRRORED FROM THE DOCUMENTED TABLE (`src/infra/playwright-env.ts:23-27`),
 * deliberately rather than imported from it. A fixture computed by the code
 * under test can only ever agree with that code; a fixture that states the path
 * independently fails loudly if the table ever moves, which is the same reason
 * the golden corpus hand-writes `expected.json`.
 */
export function specwitnessPlaywrightCache(home: string): string {
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Caches', 'specwitness', 'playwright');
  }
  if (process.platform === 'win32') {
    return join(home, 'AppData', 'Local', 'specwitness', 'playwright');
  }
  return join(home, '.cache', 'specwitness', 'playwright');
}
