// STORY A's module: checkout. It is CORRECT, and its own test suite passes.
//
// Its vocabulary is the PAST PARTICIPLE — a decision is `approved` or
// `declined`, describing the state the cart ended in. That is a perfectly
// ordinary choice, it is used consistently throughout this module, and it is
// documented right here.
//
// Nothing in this file is a defect. Read `modules/fulfilment/index.cjs` next:
// it is also correct, and it speaks the IMPERATIVE — `approve`, `decline`. Two
// internally consistent vocabularies, one seam, and neither story's author ever
// saw the other's constant.

/** The decisions this module can reach. Past participle, throughout. */
const DECISIONS = Object.freeze({
  APPROVED: 'approved',
  DECLINED: 'declined',
});

/** Carts at or above this many minor units need a manual review. */
const AUTO_APPROVE_LIMIT_MINOR = 50_000;

/**
 * Decides a cart.
 *
 * Pure: no clock, no randomness, no I/O. The same cart always decides the same
 * way, which is what lets this fixture's expectation be written by hand.
 */
function decide(cart) {
  const total = cart.items.reduce((sum, item) => sum + item.priceMinor * item.quantity, 0);
  return {
    totalMinor: total,
    decision: total <= AUTO_APPROVE_LIMIT_MINOR ? DECISIONS.APPROVED : DECISIONS.DECLINED,
  };
}

module.exports = { decide, DECISIONS, AUTO_APPROVE_LIMIT_MINOR };
