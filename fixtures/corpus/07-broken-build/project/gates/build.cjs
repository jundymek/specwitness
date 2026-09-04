// THE DEFECT, and it is the whole fixture: this build does not succeed.
//
// A Deterministic Gate that FAILS — exit 1 with a diagnostic on stderr, exactly
// as a real compiler would. That makes it a PRODUCT negative (ADR-003): the
// branch under verification does not build, so it is demonstrably not
// mergeable, and the verdict is FAIL at exit 1 carrying `gateFailed: build`.
//
// ⚠️ WHAT THIS FILE MUST NOT DO, because each of these would silently turn the
// fixture into a test of something else:
//
//   - it must EXIST and be spawnable. A missing binary is an InfraError
//     ("gate 'build' could not start"), which is the classification this
//     fixture exists to prove does NOT happen here.
//   - it must exit PROMPTLY. A gate that hangs is killed as a timeout, which is
//     also an InfraError.
//   - it must exit NON-ZERO by its own decision, not by crashing.
//
// So: a plain, immediate, non-zero exit with a message. Deterministic — no
// clock, no network, no filesystem, no environment.

process.stderr.write("src/checkout.ts(42,7): error TS2322: type 'string' is not assignable to type 'number'\n");
process.stderr.write('build failed with 1 error\n');
process.exit(1);
