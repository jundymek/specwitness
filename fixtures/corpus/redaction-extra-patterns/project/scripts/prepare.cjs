// The declared `setup.install` command. It installs nothing: it prints the
// project-shaped secret, the way a package manager echoes a registry handle,
// and exits 0. No network, no filesystem, no clock.

process.stdout.write('prepare issued wombat-7x3k9q2m4p for this build\n');
process.exit(0);
