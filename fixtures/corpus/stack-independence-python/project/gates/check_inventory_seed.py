#!/usr/bin/env python3
# A Deterministic Gate written in the target project's own language.
#
# THE POINT OF THIS FILE IS THAT IT IS NOT `pnpm test`. A gate is whatever
# the project declares in `.specwitness/config.yaml` (AD-3); SpecWitness
# resolves the first token through the OS and passes the rest as argv, with
# no shell anywhere on the path. Nothing about the gates stage knows or cares
# what language a gate is written in -- this file is the evidence for that,
# and before story 6.4 there was none.
#
# DETERMINISTIC: no clock, no network, no randomness, no environment. It
# reads one checked-in file and validates its shape. Same bytes in, same
# exit code out, on every machine and every run.
#
# Exit 0 = the seed data is well formed. Exit non-zero = it is not, which
# the gates stage reports as a GATE FAILURE (a product FAIL), not as an
# infrastructure error. This fixture's seed data is valid, so this gate
# passes -- it exists so the run actually traverses the gates stage on its
# way to a verdict rather than skipping straight to the probes.

import json
import sys

SEED_PATH = "data/seed.json"


def fail(message):
    sys.stderr.write("seed check failed: %s\n" % message)
    sys.exit(1)


try:
    with open(SEED_PATH, "r", encoding="ascii") as handle:
        seed = json.load(handle)
except (OSError, ValueError) as error:
    fail("%s could not be read as JSON (%s)" % (SEED_PATH, error))

if not isinstance(seed, dict):
    fail("%s must contain a JSON object" % SEED_PATH)

items = seed.get("items")
if not isinstance(items, list) or not items:
    fail("%s must declare a non-empty 'items' array" % SEED_PATH)

for index, item in enumerate(items):
    if not isinstance(item, dict):
        fail("items[%d] is not an object" % index)
    if not isinstance(item.get("id"), str) or not item["id"]:
        fail("items[%d] has no non-empty string 'id'" % index)
    if not isinstance(item.get("stock"), int) or item["stock"] < 0:
        fail("items[%d] has no non-negative integer 'stock'" % index)

sys.stdout.write("seed ok: %d items\n" % len(items))
sys.exit(0)
