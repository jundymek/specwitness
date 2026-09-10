# The viewer UI suite

This suite drives the real viewer in a browser. It runs on-demand, with
`pnpm --filter @gitnebula/viz ui`, and it is not part of `pnpm test`: a
contributor without a browser installed can still run the whole default suite.

## Why it exists

Before this suite, `boot()` had no test execution at all — the unit suite
replaces the canvas with the jsdom fake canvas, which cannot represent picking
at real coordinates, so the path a user actually takes was never run.

The suite captures the viewer state before each scenario and restores it after,
and a scenario that swaps the document must reacquire the harness handle after
the swap rather than reuse the one it held.
