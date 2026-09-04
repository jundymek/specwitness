// The declared command a SHELL probe drives (E1-04).
//
// Asserted on for its exit code and its stdout, so it reports STRUCTURAL facts
// that do not depend on how many orders happen to exist when it runs. A shell
// criterion that counted rows would pass or fail depending on the order the
// pipeline executed criteria in, and a fixture whose outcome depends on
// execution order is a fixture that will go red for a reason nobody believes.
//
// It also echoes the argv it was handed, which is the AD-3 witness: a shell
// would have expanded, split or reordered something here, and nothing does.
//
// Deterministic: no clock, no network, no filesystem, no environment.

const CURRENCY = 'EUR';
const SCHEMA = 'orders/v1';

const args = process.argv.slice(2);

if (!args.includes('--config')) {
  process.stderr.write("report: expected '--config'\n");
  process.exit(64);
}

process.stdout.write('order-service 1.0.0\n');
process.stdout.write(`currency=${CURRENCY}\n`);
process.stdout.write(`schema=${SCHEMA}\n`);
process.stdout.write(`argv=${JSON.stringify(args)}\n`);
process.exit(0);
