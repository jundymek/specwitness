// A Deterministic Gate that passes. Exits 0 and prints one line; no clock, no
// network, no filesystem, no environment.
//
// It exists so this fixture exercises the gates stage on the way to a verdict
// rather than skipping straight to the probes: "verifies offline" should mean
// the whole pipeline ran offline, not just the part that adjudicates criteria.

process.stdout.write('lint ok\n');
process.exit(0);
