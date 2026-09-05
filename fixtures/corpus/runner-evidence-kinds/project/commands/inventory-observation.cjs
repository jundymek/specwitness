// Drives the OBSERVATION surface, and therefore makes the run produce
// `observation` evidence.
//
// Prints one JSON object on stdout and exits 0. The observation surface reads
// the document, so the shape matters and the values do not need to change: this
// fixture takes a single snapshot and asserts a property of it, rather than a
// delta around an action, because there is no action here to wrap.
//
// Deterministic: no clock, no network, no filesystem, no environment. The same
// two lines on every run, on every platform.

process.stdout.write(JSON.stringify({ items: 3, allInStock: true }) + '\n');
process.exit(0);
