/**
 * The evidence discriminator must resist a CHOSEN collision — pinned against a real filename.
 *
 * This exists because the discriminator was truncated twice, and the second truncation is the
 * instructive one.
 *
 * It first shipped at 12 hex (48 bits). A chosen collision was MEASURED at 7.9 seconds over
 * ordinary schema-valid probe ids, after which two probes in one criterion write the same
 * evidence file and the first probe's reference points at the second probe's content —
 * misattributed evidence, which a reader trusts and cannot detect.
 *
 * It was then widened to 24 hex (96 bits) with a comment claiming the argument "disappears" at
 * 2^48. It does not: a truncated 96-bit digest carries only ~48 bits of COLLISION resistance,
 * because the birthday bound is half the width, and 2^48 is single-digit GPU-hours. Digest
 * WIDTH and collision RESISTANCE are different quantities. The digest is therefore carried
 * WHOLE, which ends the argument rather than relocating it to a new number.
 *
 * WHY THESE ASSERTIONS AND NOT A CONSTANT COMPARISON. A test that only read the exported
 * constant would pass while the production path quietly sliced it, so the load-bearing check
 * drives the REAL executor and inspects the filename it actually writes. Nothing else in the
 * suite would notice a reintroduced truncation: every other test asserts that two DIFFERENT ids
 * produce two DIFFERENT names, which stays true at any width right up until the day it does not
 * (Epic 3's learning 3 — a guard must encode the distinguishing fact, not a proxy for it).
 */

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import type { Evidence } from '../../../src/domain/evidence.js';
import type { Assertion, HttpAssertionTarget, HttpProbe } from '../../../src/domain/plan.js';
import { EVIDENCE_DIGEST_HEX, HttpSurfaceExecutor } from '../../../src/surfaces/http.js';

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function fixture(): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fixture server did not report a port');
  }
  return `http://127.0.0.1:${address.port}`;
}

/** Runs one real probe and returns the evidence filenames the executor actually wrote. */
async function evidenceNames(probeId: string): Promise<string[]> {
  const baseUrl = await fixture();
  const written: string[] = [];
  const recorded: Evidence[] = [];

  const statusIs200: Assertion<HttpAssertionTarget> = {
    description: 'answers 200',
    target: { source: 'status' },
    comparison: 'equals',
    expected: '200',
  };
  const probe: HttpProbe = {
    id: probeId,
    surface: 'http',
    mechanics: { serviceId: 'backend', method: 'GET', path: '/health' },
    assertions: [statusIs200],
  };

  const executor = new HttpSurfaceExecutor({
    clock: { now: () => new Date('2026-09-02T12:00:00.000Z') },
    writeEvidence: async (name) => {
      written.push(name);
      return name;
    },
    recordEvidence: (evidence) => {
      recorded.push(evidence);
    },
  });

  await executor.execute({
    criterionId: 'E4-01',
    surface: 'http',
    params: { probe, baseUrl, attempt: 1 },
  });

  return written;
}

describe('the evidence discriminator resists a chosen collision', () => {
  it('carries the WHOLE SHA-256 digest, not a truncation of it', () => {
    expect(EVIDENCE_DIGEST_HEX).toBe(64);
    // Tied to the primitive rather than to a literal, so the two cannot drift apart.
    expect(createHash('sha256').update('anything').digest('hex')).toHaveLength(EVIDENCE_DIGEST_HEX);
  });

  it('writes a filename whose discriminator is the full digest', async () => {
    // THE LOAD-BEARING CHECK: drives the real executor and reads the name it wrote, so a
    // truncation reintroduced in the production path fails here even if the constant is left
    // alone.
    const names = await evidenceNames('orders-health');
    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      const digest = /-([0-9a-f]{16,})-\d{2}\./.exec(name)?.[1];
      expect(digest, `no discriminator segment in ${name}`).toBeDefined();
      expect(digest).toHaveLength(EVIDENCE_DIGEST_HEX);
    }
  });

  it('separates the pair that collided while the digest was truncated', () => {
    // The measured witness, kept rather than recomputed: at 12 hex these two share
    // `2e47b9d025b8`. The point is not the pair but that the shipped width no longer merges it.
    const a = 'E4-01\u0000probe-4573894';
    const b = 'E4-01\u0000probe-7959525';
    const full = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

    expect(full(a).slice(0, 12)).toBe(full(b).slice(0, 12)); // the old width still merges them
    expect(full(a)).not.toBe(full(b)); // the shipped width does not
  });

  it('stays inside the filesystem component limit at maximal length', () => {
    // Truncation is often defended as a path-budget trade. There was no budget pressure to trade
    // against, and this pins that: worst case is `http-` + a 64-char criterion slug + a 64-char
    // probe slug + the digest + separators + attempt + the longest suffix.
    const worstCase =
      'http-'.length + 64 + 1 + 64 + 1 + EVIDENCE_DIGEST_HEX + 1 + 2 + '.body.txt'.length;

    expect(worstCase).toBe(211);
    expect(worstCase).toBeLessThan(255); // APFS / ext4 component limit
  });
});
