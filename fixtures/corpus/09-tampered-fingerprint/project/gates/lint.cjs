// A Deterministic Gate that would pass — and that is never executed.
//
// The integrity stage precedes every spawning stage, so a tampered contract is
// rejected before this file is ever run. It exists because a plan-less project
// with no gates is refused by `assertSomethingToAdjudicate` before the run
// starts, and that refusal is a ConfigError, not an IntegrityError. Both exit
// 3; only one of them is the class this fixture claims.
//
// So this gate is what lets the run get far enough to be refused for the RIGHT
// reason. That it never actually runs is the proof that integrity comes first.

process.stdout.write('lint ok\n');
process.exit(0);
