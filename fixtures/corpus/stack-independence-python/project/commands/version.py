#!/usr/bin/env python3
# The target project's own packaged command, for the SHELL probe (E1-02).
#
# A structural criterion: "the packaged command reports its version". In a
# Node project this would be `node cli.js --version`; here it is Python, and
# the plan's shell probe asserts on exit code and stdout without knowing or
# caring which. The `argumentAllowlist` in the plan is what bounds the
# arguments a probe may pass (AD-3) -- that mechanism is language-agnostic
# too, and this file is the first fixture to show it.

import sys

NAME = "inventory-service"
VERSION = "2.1.0"

if "--version" in sys.argv[1:]:
    sys.stdout.write("%s %s\n" % (NAME, VERSION))
    sys.exit(0)

sys.stderr.write("usage: version.py --version\n")
sys.exit(64)
