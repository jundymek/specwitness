// THE TEST THAT ENFORCES THE CONVENTION — and therefore has to name the very
// spelling it forbids. gitnebula's census counted this file and reported 2 where
// the criterion required 0. The census probe excludes it by name.
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./specs/viewer.pw.ts', import.meta.url), 'utf8');
if (source.includes("__gitnebula")) {
  throw new Error('a spec spells the handle key instead of importing HARNESS_HANDLE_KEY');
}
