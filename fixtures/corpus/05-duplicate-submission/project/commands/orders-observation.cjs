// The declared OBSERVATION command (Q35): exit 0, print one JSON object.
//
// It reports the PERSISTED rows, which is the only place this fixture's defect
// is visible. Both responses the service gave were successes; the store is
// where the second row appeared.
//
// `orderIds` IS REPORTED AS A LIST, deliberately. A count alone would make the
// failure read `expected: 0, actual: 1`, which is true and says almost nothing;
// the list makes the report say `["order-1"]` against `["order-1","order-2"]`,
// which shows the duplicate row itself to whoever opens the failure in six
// months.
//
// `rowsWithoutIdempotencyKey` is reported because it names the mechanism: the
// duplicate check cannot match a key no persisted row carries.
//
// Deterministic: no clock, no network, no environment. It reads one file.

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const STORE = join(__dirname, '..', 'store', 'orders.json');

const state = JSON.parse(readFileSync(STORE, 'utf8'));

process.stdout.write(
  `${JSON.stringify({
    orderCount: state.orders.length,
    orderIds: state.orders.map((row) => row.id),
    rowsWithoutIdempotencyKey: state.orders.filter(
      (row) => row.idempotencyKey === undefined,
    ).length,
  })}\n`,
);
process.exit(0);
