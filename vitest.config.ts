import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  // Mirrors tsup's define so `--version` reads identically from source and bundle.
  define: { __SW_VERSION__: JSON.stringify(pkg.version) },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Integration tests assert on the real bin entry, so build it first.
    globalSetup: ['tests/setup/build-cli.ts'],
    // Integration tests spawn the built binary; give them room without hiding hangs.
    testTimeout: 30_000,
  },
});
