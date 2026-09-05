#!/bin/sh
# The declared `setup.install` command for the corpus fixture `setup-install-runs`.
#
# It stands in for a real dependency install without being one: no network, no
# package manager, no ecosystem. All it does is put a file into the verification
# worktree that nothing else in the fixture puts there — which is exactly the
# property a real install has and the only one this fixture needs.
#
# Every path below is relative, so everything it writes lands inside the
# verification worktree the stage set as the working directory. It reads nothing
# from the machine running the suite.
set -eu

mkdir -p vendor
printf 'deps-installed 1.0.0\n' > vendor/installed.txt

echo "prepared vendor/installed.txt"
