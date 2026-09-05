// THE SUBMISSION MODULE'S OWN UNIT SUITE — and it is GREEN, which is the point.
//
// Each function is tested against inputs the test itself constructs:
// `isDuplicate` is handed rows that carry the idempotency key, and `toRow` is
// checked for the fields it does produce. Every assertion is true.
//
// The defect is in the COMPOSITION — what `toRow` writes is not what
// `isDuplicate` reads — and no test of either function in isolation can see it.
// That is why this suite passes while the assembled system creates duplicate
// rows, and it is the reason brief section 7 says epic-level verification is a
// different job from story-level review.
//
// Also driven directly as criterion E5-03's shell probe, so "the module's own
// tests passed in this very run" is measured rather than asserted in prose.
//
// Deterministic: no clock, no network, no filesystem, no environment.

const assert = require('node:assert/strict');

const { isDuplicate, toRow } = require('../app/submissions.cjs');

const results = [];

function check(name, run) {
  try {
    run();
    results.push(`ok   ${name}`);
  } catch (cause) {
    results.push(`FAIL ${name}: ${cause && cause.message}`);
  }
}

check('isDuplicate finds a row carrying the key', () => {
  assert.equal(isDuplicate([{ id: 'order-1', idempotencyKey: 'k1' }], 'k1'), true);
});

check('isDuplicate rejects an unseen key', () => {
  assert.equal(isDuplicate([{ id: 'order-1', idempotencyKey: 'k1' }], 'k2'), false);
});

check('isDuplicate on an empty store is false', () => {
  assert.equal(isDuplicate([], 'k1'), false);
});

check('toRow accepts the submission', () => {
  assert.deepEqual(toRow(1, { item: 'widget', quantity: 2 }), {
    id: 'order-1',
    item: 'widget',
    quantity: 2,
    status: 'accepted',
  });
});

check('toRow numbers each row distinctly', () => {
  assert.notEqual(
    toRow(1, { item: 'widget', quantity: 1 }).id,
    toRow(2, { item: 'widget', quantity: 1 }).id,
  );
});

for (const line of results) {
  process.stdout.write(`${line}\n`);
}

const failed = results.filter((line) => line.startsWith('FAIL')).length;
process.stdout.write(`submissions-module: ${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
