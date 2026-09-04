// The observation command the shell probe drives (E1-01).
//
// It is CORRECT. This fixture must reach a genuine PASS through a criterion
// that was really adjudicated, so that "the integrity check did not fire" is
// shown by a run that actually verified something.
//
// Deterministic: no clock, no network, no filesystem, no environment.

process.stdout.write('corpus-fixture-app 1.0.0\n');
process.exit(0);
