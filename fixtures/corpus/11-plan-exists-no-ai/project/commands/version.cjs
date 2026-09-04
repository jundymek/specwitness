// The observation command the shell probe drives (E1-01).
//
// Deterministic: no clock, no network, no filesystem, no environment. It prints
// a fixed string and echoes the argv it was handed, which is also the AD-3
// witness — a shell would have expanded or reordered something here, and
// nothing does.

process.stdout.write('corpus-fixture-app 1.0.0\n');
process.stdout.write(`${JSON.stringify(process.argv.slice(2))}\n`);
process.exit(0);
