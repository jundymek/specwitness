/**
 * Ephemeral port allocation for corpus fixtures (story 6.1).
 *
 * Opens real loopback sockets and closes them; spawns no process.
 *
 * ⚠️ **THE PROPERTY IS DISTINCTNESS, and no checked-in fixture can currently expose its
 * absence.** Both fixtures shipped by story 6.1 declare one `{{PORT:…}}` name each, so a
 * loop that released each socket before asking for the next would look correct forever —
 * until a wave-2 fixture declares two services, gets one port twice, and produces a failure
 * that reads as "the corpus is flaky" rather than as a defect in the harness. The guard
 * goes in now, while the reasoning is written down, rather than when it bites somebody who
 * did not write this code.
 */

import { createServer } from 'node:net';

import { describe, expect, it } from 'vitest';

import { allocatePorts } from '../../corpus/runner.js';

describe('allocatePorts', () => {
  it('returns one port per name', async () => {
    const ports = await allocatePorts(['app', 'worker', 'db']);

    expect(Object.keys(ports).sort()).toEqual(['app', 'db', 'worker']);
    for (const port of Object.values(ports)) {
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThanOrEqual(65_535);
    }
  });

  it('never hands the same port to two names', async () => {
    // Twelve names in one batch, twice over: enough that a release-then-reallocate loop
    // would be very likely to repeat a port at least once, and a batch that holds every
    // socket cannot repeat one at all, because the OS will not offer a port it has bound.
    for (let round = 0; round < 2; round += 1) {
      const names = Array.from({ length: 12 }, (_, index) => `service-${index}`);

      const ports = await allocatePorts(names);
      const values = Object.values(ports);

      expect(new Set(values).size, `round ${round}: ${JSON.stringify(ports)}`).toBe(
        names.length,
      );
    }
  });

  it('releases every socket, so the ports it returned are bindable afterwards', async () => {
    // The other half: holding the sockets until allocation completes must not mean holding
    // them for the run. A port the runner never released is a port the fixture's own
    // service cannot bind.
    const ports = await allocatePorts(['app', 'worker']);

    for (const port of Object.values(ports)) {
      await new Promise<void>((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.close(() => resolve());
        });
      });
    }
  });

  it('returns an empty map for an empty request', async () => {
    // A fixture with no services declares no placeholder, and that is not an error.
    expect(await allocatePorts([])).toEqual({});
  });
});
