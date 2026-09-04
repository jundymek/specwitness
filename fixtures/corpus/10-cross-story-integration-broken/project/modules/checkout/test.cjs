// STORY A's OWN TEST SUITE. It passes. Every assertion in it is true.
//
// It is a good suite for the module it tests: it covers both decisions, the
// boundary, and the total. What it cannot do — what no suite scoped to one
// story can do — is know what the OTHER module expects to be handed.
//
// Deterministic: no clock, no network, no filesystem, no environment.

const assert = require('node:assert/strict');

const checkout = require('./index.cjs');

const results = [];

function check(name, run) {
  try {
    run();
    results.push(`ok   checkout/${name}`);
  } catch (cause) {
    results.push(`FAIL checkout/${name}: ${cause && cause.message}`);
  }
}

check('an affordable cart is approved', () => {
  assert.equal(
    checkout.decide({ items: [{ priceMinor: 1000, quantity: 2 }] }).decision,
    checkout.DECISIONS.APPROVED,
  );
});

check('a cart above the limit is declined', () => {
  assert.equal(
    checkout.decide({ items: [{ priceMinor: 60_000, quantity: 1 }] }).decision,
    checkout.DECISIONS.DECLINED,
  );
});

check('a cart exactly at the limit is approved', () => {
  assert.equal(
    checkout.decide({ items: [{ priceMinor: checkout.AUTO_APPROVE_LIMIT_MINOR, quantity: 1 }] })
      .decision,
    checkout.DECISIONS.APPROVED,
  );
});

module.exports = { results };

if (require.main === module) {
  for (const line of results) {
    process.stdout.write(`${line}\n`);
  }
  process.exit(results.some((line) => line.startsWith('FAIL')) ? 1 : 0);
}
