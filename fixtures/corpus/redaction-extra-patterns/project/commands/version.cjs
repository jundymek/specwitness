// The observation command the shell probe drives (E1-02).
//
// It prints its version on stdout, which is what E1-02 asserts, and the
// project-shaped secret on stderr, which is captured and must not be persisted.
// No network, no filesystem, no clock.

process.stdout.write('redaction-fixture-app 1.0.0\n');
process.stdout.write(`${JSON.stringify(process.argv.slice(2))}\n`);
process.stderr.write('issued wombat-7x3k9q2m4p\n');
process.exit(0);
