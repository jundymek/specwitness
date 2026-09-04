// The fixture application: one command that prints a checkout receipt.
//
// IT IS CORRECT, and that is the whole design of this fixture. The mechanical
// half of the contract (E1-01: the receipt states the total) is satisfied, so
// that criterion PASSES. The run still stops at exit 2, because the OTHER
// criterion asks whether the wording is courteous — and the contract's author
// wrote `verifiability: human` beside it, meaning no machine may answer.
//
// That mixed outcome is what makes the fixture prove something. If everything
// here were unadjudicable, "the human clause fired" would look identical to
// "nothing was adjudicated at all", which is the green-for-nothing hazard the
// `hazard-e4d-skipped-is-inert` fixture pins one directory over.
//
// Deterministic: no clock, no network, no filesystem, no environment.

process.stdout.write('RECEIPT\n');
process.stdout.write('  2 items\n');
process.stdout.write('  total: 41.50\n');
process.stdout.write('  Thanks. Come back soon.\n');
process.exit(0);
