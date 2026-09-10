# 6.3 — The first screen of a failed load, and the seam between two validators

## The seam between the two validators

The schema the build validates against and the checks the loader performs are
not the same list. This story documents where they differ, and leaves the
validator unchanged: no field was added to the loader's checks.

## What is left for a future story

Widening the loader is contract-adjacent, so aligning the two validators is
named here as future work rather than done in passing.
