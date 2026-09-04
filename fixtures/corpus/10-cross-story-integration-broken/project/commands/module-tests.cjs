// BOTH STORY MODULES' OWN TEST SUITES, run together, exactly as a repository's
// `npm test` would run them.
//
// IT EXITS 0. That is this fixture's central claim, and criterion E10-01 drives
// this very command through a shell probe so that "both modules pass their own
// tests" is a fact the verification run MEASURED rather than a sentence in a
// comment. The story is explicit that a fixture 10 whose modules' suites are
// red is a fixture for a defect class story-level gates already catch, and
// therefore worthless.
//
// Deterministic: no clock, no network, no filesystem, no environment. Each
// suite is required as a module and reports its own results, so no subprocess
// and no ordering assumption is involved.

const checkoutSuite = require('../modules/checkout/test.cjs');
const fulfilmentSuite = require('../modules/fulfilment/test.cjs');

function report(name, results) {
  for (const line of results) {
    process.stdout.write(`${line}\n`);
  }
  const failed = results.filter((line) => line.startsWith('FAIL')).length;
  process.stdout.write(`${name}: ${results.length - failed} passed, ${failed} failed\n`);
  return failed;
}

const failures =
  report('checkout', checkoutSuite.results) + report('fulfilment', fulfilmentSuite.results);

process.exit(failures === 0 ? 0 : 1);
