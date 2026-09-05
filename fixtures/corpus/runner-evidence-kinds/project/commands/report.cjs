// Drives the SHELL surface, and therefore makes the run produce `command`
// evidence.
//
// The shell surface asserts on exit code and stdout, so this prints a stable
// line and exits 0. Together with the gate and the observation command, this is
// what gives the fixture its three evidence kinds — `gate`, `command` and
// `observation` — which is the whole point of the fixture.
//
// Deterministic: no clock, no network, no filesystem, no environment.

process.stdout.write('report-tool 1.0.0\n');
process.stdout.write('catalog=stable\n');
process.exit(0);
