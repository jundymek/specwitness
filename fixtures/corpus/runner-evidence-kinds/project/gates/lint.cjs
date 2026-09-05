// A Deterministic Gate that passes (ADR-003).
//
// Its job in this fixture is to make the run produce `gate` EVIDENCE. It is
// green on purpose: this fixture is about what the run OBSERVED, not about what
// it concluded, so nothing here may fail and give the fixture a second reason to
// go red.
//
// Deterministic: no clock, no network, no filesystem, no environment.

process.stdout.write('lint: 0 problems\n');
process.exit(0);
