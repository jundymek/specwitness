// The one command this fixture declares (setup.install), run inside the
// verification worktree before any probe.
//
// It creates a symbolic link at docs/handbook.md whose target is '../..' — from
// docs/, that is the directory CONTAINING the worktree, i.e. outside the tree
// under verification. It reads nothing and follows nothing; it only makes the
// link the file probe will then refuse to follow.

const { mkdirSync, symlinkSync } = require('node:fs');

mkdirSync('docs', { recursive: true });
symlinkSync('../..', 'docs/handbook.md');
process.stdout.write('linked docs/handbook.md outside the worktree\n');
process.exit(0);
