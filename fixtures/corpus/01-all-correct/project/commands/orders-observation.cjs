// The declared OBSERVATION command (Q35): exit 0, and print one JSON object on
// stdout. Anything else makes the criterion `error` rather than `fail`
// (`src/surfaces/observation.ts` — the observation command's contract is
// declared by the project owner, so violating it is the environment being
// broken, not the product).
//
// It reports what is PERSISTED, never what an endpoint said. That distinction
// is the whole reason the observation surface exists: an http probe asks "did
// the endpoint answer correctly?", this asks "and what did that do to the
// world?".
//
// Deterministic: no clock, no network, no environment. It reads one file and
// prints counts.

const store = require('../app/store.cjs');

const state = store.read();
const approved = state.orders.filter((order) => order.status === 'approved');

process.stdout.write(
  `${JSON.stringify({
    count: state.orders.length,
    approved: approved.length,
    // A string rather than a boolean so the assertion reads `equals "true"` in
    // the plan. Every value an assertion compares is rendered as text
    // (`src/surfaces/observation.ts` `render`), and `true` renders as `true`
    // either way; spelling it out keeps the plan and this file obviously the
    // same claim.
    allApproved: String(state.orders.length === approved.length),
  })}\n`,
);
process.exit(0);
