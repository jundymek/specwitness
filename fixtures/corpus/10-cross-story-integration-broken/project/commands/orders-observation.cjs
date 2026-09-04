// The declared OBSERVATION command (Q35): exit 0, print one JSON object.
//
// It reports the PERSISTED order state, which is the only place the seam
// between the two modules is visible. The checkout response was truthful about
// checkout; the fulfilment module behaved exactly as designed; and the order is
// still `pending`.
//
// `lastOrderState` is reported as a plain string so the failure diagnosis reads
// `expected: fulfilled` against `actual: pending` — a reader who opens this in
// six months learns what the system did, not merely that a number moved.
//
// Deterministic: no clock, no network, no environment. It reads one file.

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const STORE = join(__dirname, '..', 'store', 'orders.json');

const state = JSON.parse(readFileSync(STORE, 'utf8'));
const last = state.orders[state.orders.length - 1];

const snapshot = {
  orderCount: state.orders.length,
  fulfilledOrders: state.orders.filter((order) => order.state === 'fulfilled').length,
  orderStates: state.orders.map((order) => order.state),
};

if (last !== undefined) {
  snapshot.lastOrderState = last.state;
}

process.stdout.write(`${JSON.stringify(snapshot)}\n`);
process.exit(0);
