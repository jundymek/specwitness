// THE DEFECT, and it is the whole fixture: this service does not start.
//
// It exits immediately with a non-zero code and a diagnostic, exactly as a real
// service would when a required environment variable is missing or a migration
// has not been applied. `services.ts` diagnoses that as "exited before it
// became ready" and raises an InfraError: exit 3, and NEVER a product FAIL. A
// service that would not start says nothing about whether the branch satisfies
// its contract.
//
// ⚠️ "BROKEN" HERE MEANS "DOES NOT START", NEVER "DOES SOMETHING UNEXPECTED".
// This file is committed executable content that runs in CI on two platforms on
// every PR (AD-3), so its whole behaviour is: print two lines, exit 1. It opens
// no socket, reads no environment, touches no filesystem, resolves no hostname
// and spawns nothing.
//
// ⚠️ WHAT THIS FILE MUST NOT DO, because each would make the fixture prove
// something other than what it claims — a fixture that exits 3 for the wrong
// reason is worse than no fixture, because it looks like evidence:
//
//   - it must NOT bind the port. Binding and then failing readiness would test
//     the readiness probe instead of service startup.
//   - it must NOT hang. A service that never exits is a readiness TIMEOUT, a
//     different row of the classification table, and it would cost the fixture
//     its full `ready.timeoutSec` on every CI run.
//   - it must NOT be missing or unspawnable. That is "could not be started",
//     again a different row.
//   - the port must NOT already be in use. The corpus runner allocates a fresh
//     ephemeral loopback port per run, and the services stage proves it free
//     before spawning anything, so a collision cannot be this fixture's cause.
//
// The argv the config passes is read and echoed rather than ignored, so the
// output records that the port really was substituted — evidence for the reader
// of a failed run that the placeholder mechanism worked and the cause is this
// script, not the harness.

const port = process.argv[2];

process.stderr.write(`corpus-fixture-service: refusing to start (port ${port} was never bound)\n`);
process.stderr.write('corpus-fixture-service: RELEASE_CHANNEL is not set\n');
process.exit(1);
