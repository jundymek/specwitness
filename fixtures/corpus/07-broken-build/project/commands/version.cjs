// The observation command criterion E1-02's shell probe would drive.
//
// It is CORRECT, and that is deliberate: nothing about this fixture's outcome
// may depend on a criterion also being wrong. The gate fails first, the
// pipeline stops, and both criteria are reported `skipped` — so this command is
// never actually executed in this fixture. It exists so the plan is a real plan
// probing a real command rather than a stub, because a fixture whose plan is
// wrong proves nothing about the class it claims.
//
// Deterministic: no clock, no network, no filesystem, no environment.

process.stdout.write('corpus-fixture-app 1.0.0\n');
process.exit(0);
