// THE CONFIRMATION MODULE'S OWN UNIT SUITE — and it is GREEN, which is the
// point.
//
// Every assertion below is true of `app/confirmations.cjs` as written. The
// receipt has the right shape, the session list grows, and confirming the same
// order twice does not duplicate it. All of that is a fact about the MODULE'S
// OWN state, and the module's own state is correct.
//
// The missing write is a fact about a different subsystem — the persisted store
// — and no unit test of this module can observe it. That is why the defect
// survives a story-level gate, and why the fixture's answer has to come from a
// before/after observation of what was actually persisted.
//
// Also driven directly as criterion E3-03's shell probe, so "the module's own
// tests passed in this very run" is measured rather than asserted in prose.
//
// Deterministic: no clock, no network, no environment beyond the store file the
// module itself reads.

const assert = require('node:assert/strict');

const confirmations = require('../app/confirmations.cjs');

const results = [];

function check(name, run) {
  try {
    run();
    results.push(`ok   ${name}`);
  } catch (cause) {
    results.push(`FAIL ${name}: ${cause && cause.message}`);
  }
}

check('confirming a known order returns a confirmed receipt', () => {
  assert.deepEqual(confirmations.record('order-1'), { orderId: 'order-1', state: 'confirmed' });
});

check('confirming an unknown order returns nothing', () => {
  assert.equal(confirmations.record('order-does-not-exist'), undefined);
});

check('the session records the confirmation', () => {
  assert.deepEqual(confirmations.listSession(), [{ orderId: 'order-1', state: 'confirmed' }]);
});

check('confirming the same order twice does not duplicate it', () => {
  confirmations.record('order-1');
  assert.equal(confirmations.listSession().length, 1);
});

for (const line of results) {
  process.stdout.write(`${line}\n`);
}

const failed = results.filter((line) => line.startsWith('FAIL')).length;
process.stdout.write(`confirmations-module: ${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
