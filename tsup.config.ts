import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  entry: { cli: 'src/cli/main.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // The bin entry must be directly executable: shebang + the executable bit.
  banner: { js: '#!/usr/bin/env node' },
  // `--version` is resolved at build time. Reading package.json at runtime would
  // need a different relative path from `src/` than from `dist/`; vitest.config.ts
  // injects the same constant so source and bundle always agree.
  define: { __SW_VERSION__: JSON.stringify(pkg.version) },
  onSuccess: async () => {
    const { chmod } = await import('node:fs/promises');
    await chmod(new URL('./dist/cli.js', import.meta.url), 0o755);
  },
});
