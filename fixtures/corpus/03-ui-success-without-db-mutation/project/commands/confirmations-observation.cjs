// The declared OBSERVATION command (Q35): exit 0, print one JSON object.
//
// It reads the PERSISTED store and nothing else. It never asks the service what
// it thinks happened — that is the entire point of the observation surface, and
// of this fixture: an http probe asks "did the endpoint answer correctly?",
// this asks "and what did that do to the world?".
//
// `lastConfirmedOrderId` IS OMITTED WHEN NOTHING IS CONFIRMED, deliberately.
// The observation surface reports an unresolved path as absent and never as
// zero or empty string (`src/surfaces/observation.ts` — "defaulting a missing
// count to 0 makes 0 - 0 == 0 satisfy a delta assertion, reporting a green
// criterion for a command that produced nothing"). So an absent key here makes
// the failure say, in the report, exactly what went wrong: the store holds no
// confirmation at all.
//
// Deterministic: no clock, no network, no environment. It reads one file.

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const STORE = join(__dirname, '..', 'store', 'orders.json');

const state = JSON.parse(readFileSync(STORE, 'utf8'));
const confirmations = Array.isArray(state.confirmations) ? state.confirmations : [];
const last = confirmations[confirmations.length - 1];

const snapshot = {
  confirmedOrders: confirmations.length,
  pendingOrders: state.orders.filter((order) => order.state === 'pending').length,
};

if (last !== undefined) {
  snapshot.lastConfirmedOrderId = last.orderId;
}

process.stdout.write(`${JSON.stringify(snapshot)}\n`);
process.exit(0);
