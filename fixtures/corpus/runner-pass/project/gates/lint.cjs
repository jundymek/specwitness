// A Deterministic Gate that passes. Exits 0 and prints one line; no clock, no
// network, no filesystem. It exists so this fixture exercises the gates stage
// on its way to a verdict rather than skipping straight to the probes.

process.stdout.write('lint ok\n');
process.exit(0);
