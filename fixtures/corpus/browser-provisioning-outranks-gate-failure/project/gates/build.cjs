// Fixture `browser-provisioning-outranks-gate-failure` — a gate that says no.
//
// ⚠️ IT IS NOT THE SUBJECT OF THE FIXTURE. It exists to make the pipeline stop early and
// jump PAST the probes stage to `aggregate` (`src/pipeline/run-pipeline.ts`, the
// product-negative branch), which is the exact path on which a browser environment that
// could not be provisioned would otherwise never be refused by anybody — and the run would
// report the branch as FAIL, exit 1, while the real reason it could adjudicate nothing was
// an environment problem. Infra failures are never reported as product FAIL (CLAUDE.md's
// first non-negotiable rule, AD-6, ADR-002).
//
// A REAL, ORDINARY GATE FAILURE: it prints what failed and exits non-zero. Node built-ins
// only, no network, nothing outside its own directory.

process.stdout.write('build: 1 error\n');
process.stdout.write("build: app/server.cjs — deliberate failure, this fixture's gate says no\n");
process.exit(1);
