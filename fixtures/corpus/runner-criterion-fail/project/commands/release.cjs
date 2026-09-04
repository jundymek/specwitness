// The fixture application: one command that reports the release channel.
//
// THE DEFECT IS HERE, ON PURPOSE, AND IT IS ONE LINE. The contract requires
// this command to report the `stable` channel (criterion E1-02). It reports
// `beta`. Everything else about the fixture is correct — it exits 0, so E1-01
// passes — which is what makes the expected outcome a MIXED one: a run that
// fails for exactly one stated reason and not incidentally.
//
// Deterministic: no clock, no network, no filesystem, no environment.

process.stdout.write('release-tool 2.0.0\n');
process.stdout.write('channel=beta\n');
process.exit(0);
