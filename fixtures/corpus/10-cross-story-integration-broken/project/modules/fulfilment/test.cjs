// STORY B's OWN TEST SUITE. It passes. Every assertion in it is true.
//
// It even covers the unknown-command case — the very branch the assembled
// system takes — and asserts the CORRECT behaviour for it: an unrecognised
// command leaves the state alone. That is the sharpest edge of this fixture.
// The suite is not weak, it is not missing a case, and it still cannot catch
// the defect, because it tests the module against the vocabulary the module
// declares, which is the only vocabulary its author had.
//
// Deterministic: no clock, no network, no filesystem, no environment.

const assert = require('node:assert/strict');

const fulfilment = require('./index.cjs');

const results = [];

function check(name, run) {
  try {
    run();
    results.push(`ok   fulfilment/${name}`);
  } catch (cause) {
    results.push(`FAIL fulfilment/${name}: ${cause && cause.message}`);
  }
}

check('approve fulfils a pending order', () => {
  assert.equal(
    fulfilment.advance({ state: 'pending' }, fulfilment.COMMANDS.APPROVE),
    'fulfilled',
  );
});

check('decline cancels a pending order', () => {
  assert.equal(
    fulfilment.advance({ state: 'pending' }, fulfilment.COMMANDS.DECLINE),
    'cancelled',
  );
});

check('an unrecognised command leaves the order where it was', () => {
  assert.equal(fulfilment.advance({ state: 'pending' }, 'no-such-command'), 'pending');
});

module.exports = { results };

if (require.main === module) {
  for (const line of results) {
    process.stdout.write(`${line}\n`);
  }
  process.exit(results.some((line) => line.startsWith('FAIL')) ? 1 : 0);
}
