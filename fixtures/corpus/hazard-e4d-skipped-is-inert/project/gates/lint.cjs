// A Deterministic Gate that passes. Exits 0 and prints one line; no clock, no
// network, no filesystem, no environment.
//
// IT IS LOAD-BEARING FOR THE HAZARD, not scenery. `assertSomethingToAdjudicate`
// refuses a project that declares no gates AND whose plan maps no criterion to
// a probe — so without this gate the run would be refused at exit 3 and the
// green-for-nothing path would never be reached. With it, the refusal is
// satisfied by ONE trivially passing gate, and the two contract criteria that
// nothing adjudicates ride along as `skipped` into a PASS.
//
// That is the shape of the hazard in one sentence: the check that exists asks
// whether ANYTHING could be adjudicated, not whether EVERYTHING was.

process.stdout.write('lint ok\n');
process.exit(0);
