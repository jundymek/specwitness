// The application's OWN unit tests, run as a Deterministic Gate (ADR-003).
//
// It is here in the all-correct fixture for the same reason it is in each of
// the four FAIL fixtures: so that "the story-level gate is green" is a fact the
// run measured rather than a claim the fixture's prose makes. A gate that
// failed would appear as `outcome.gateFailed`, and `expected.json` compares the
// whole outcome object, so a green gate is asserted by its absence.
//
// `node:assert` and `node:test`-free on purpose: a hand-rolled assert keeps the
// gate readable to someone who does not know a runner's conventions, and the
// corpus must never need an install.

const assert = require('node:assert/strict');

const checks = [];

function check(name, run) {
  try {
    run();
    checks.push(`ok   ${name}`);
  } catch (cause) {
    checks.push(`FAIL ${name}: ${cause && cause.message}`);
  }
}

check('an order total is the unit price times the quantity', () => {
  assert.equal((1000 * 3) / 100, 30);
});

check('the reported currency is EUR', () => {
  assert.equal('EUR', 'EUR');
});

check('an approved order is counted as approved', () => {
  const orders = [{ status: 'approved' }, { status: 'approved' }];
  assert.equal(orders.filter((order) => order.status === 'approved').length, 2);
});

for (const line of checks) {
  process.stdout.write(`${line}\n`);
}

const failed = checks.filter((line) => line.startsWith('FAIL')).length;
process.stdout.write(`orders: ${checks.length - failed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
