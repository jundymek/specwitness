// The Deterministic Gate: the project's own test command (ADR-003).
//
// It runs BOTH story modules' suites — the same command criterion E10-01 drives
// — and it EXITS 0. That is the flagship claim of this fixture made mechanical:
// in the very run in which SpecWitness reports FAIL, every story-level gate was
// green. A gate that had failed would appear in the outcome as `gateFailed`,
// and `expected.json` compares the whole outcome object, so the green gate is
// asserted by the absence of that key.

const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

const suite = spawnSync(process.execPath, [join(__dirname, '..', 'commands', 'module-tests.cjs')], {
  encoding: 'utf8',
});

process.stdout.write(suite.stdout ?? '');
process.stderr.write(suite.stderr ?? '');
process.exit(suite.status === 0 ? 0 : 1);
