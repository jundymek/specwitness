// THE DEFECT LIVES HERE, and it is a write that never happens.
//
// `record` builds a confirmation receipt, keeps it in the process's own session
// list, and returns it. What it does NOT do is write it to `store/orders.json`
// — the fixture's persistent store. The endpoint that calls it therefore
// answers 200 with a perfectly truthful-looking success message, and nothing in
// the world changed.
//
// WHY NO STORY-LEVEL GATE COULD HAVE CAUGHT THIS. There is no type error and no
// lint error: `record` returns exactly the object its caller expects. And its
// own unit suite (`commands/module-tests.cjs`) is GREEN, because every
// assertion a suite can make about this module in isolation is true — the
// receipt has the right shape, the session list grows, the same order is not
// recorded twice. A unit test observes the module's OWN state; the missing
// write is a fact about a different subsystem, and no test of this module can
// see it. Only a before/after observation of the persisted state can, which is
// exactly the surface brief section 35 asks for and story 4.5 built.

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const STORE = join(__dirname, '..', 'store', 'orders.json');

/** Confirmations this process has handled. Lost when the process ends. */
const session = [];

function readStore() {
  return JSON.parse(readFileSync(STORE, 'utf8'));
}

/**
 * Confirms an order and returns the receipt the UI renders.
 *
 * It reads the store to validate the order exists, appends to `session`, and
 * returns. The persisted store is never written.
 */
function record(orderId) {
  const state = readStore();
  const order = state.orders.find((candidate) => candidate.id === orderId);
  if (order === undefined) {
    return undefined;
  }
  if (!session.some((receipt) => receipt.orderId === orderId)) {
    session.push({ orderId, state: 'confirmed' });
  }
  return { orderId, state: 'confirmed' };
}

/** What this process has confirmed so far. Used by the module's own tests. */
function listSession() {
  return session.slice();
}

module.exports = { record, listSession, STORE };
