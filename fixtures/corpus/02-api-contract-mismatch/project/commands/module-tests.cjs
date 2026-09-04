// THE ORDER MODULE'S OWN UNIT SUITE — and it is GREEN, which is the point.
//
// This is the story-level gate that let the defect through. Every assertion
// below is true of `app/order-response.cjs` as written, because the suite was
// written FROM that implementation: it checks that `serialize` round-trips the
// fields it produces, and it does, perfectly. There is no assertion anywhere in
// a suite written this way that can notice a field the implementation never
// had.
//
// Read alongside `.specwitness/contracts/epic-2.yaml`, which requires the
// response to carry the currency. The gap between these two files IS brief
// section 7: the pieces are good and the assembled system does not satisfy the
// specification.
//
// Also driven directly as criterion E2-03's shell probe, so "the module's own
// tests passed in this very run" is a fact the run measured rather than a claim
// this comment makes.
//
// Deterministic: no clock, no network, no filesystem, no environment.

const assert = require('node:assert/strict');

const { serialize, present, PRESENTATION_CURRENCY } = require('../app/order-response.cjs');

const order = {
  id: 'order-1',
  item: 'widget',
  quantity: 2,
  status: 'approved',
  total: 20,
  currency: 'EUR',
};

const results = [];

function check(name, run) {
  try {
    run();
    results.push(`ok   ${name}`);
  } catch (cause) {
    results.push(`FAIL ${name}: ${cause && cause.message}`);
  }
}

check('serialize carries the order id', () => {
  assert.equal(serialize(order).id, 'order-1');
});

check('serialize carries the approved status', () => {
  assert.equal(serialize(order).status, 'approved');
});

check('serialize carries the computed total', () => {
  assert.equal(serialize(order).total, 20);
});

check('the presentation layer renders the total with a currency', () => {
  assert.equal(present(order), `20.00 ${PRESENTATION_CURRENCY}`);
});

for (const line of results) {
  process.stdout.write(`${line}\n`);
}

const failed = results.filter((line) => line.startsWith('FAIL')).length;
process.stdout.write(`orders-module: ${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
