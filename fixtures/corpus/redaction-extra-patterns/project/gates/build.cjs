// A Deterministic Gate that passes, printing the project-shaped secret on both
// streams on its way. No network, no filesystem, no clock.

process.stdout.write('build ok, release handle wombat-7x3k9q2m4p\n');
process.stderr.write('2026-09-10T09:00:00Z INFO handle wombat-7x3k9q2m4p attached\n');
process.exit(0);
