import { describe, expect, it } from 'vitest';

import { boundedText, redactText } from '../../../src/domain/evidence.js';

/**
 * NFR guard: redaction must stay LINEAR in the size of captured output.
 *
 * Reported by story 3.6's agent with measurements against the merged source: the
 * assignment pattern was quadratic in the length of an unbroken run of identifier
 * characters. 64 KB of base64 took 5.8 seconds; extrapolated, 1 MB took ~25 minutes.
 *
 * Why that is reachable rather than pathological — the narrowing that makes this worth
 * guarding. Ordinary multi-line log output is fast, because whitespace terminates the
 * backtracking. But a gate is `pnpm build` or `npm test`, and its output plausibly
 * carries a base64 `data:` URI, an inline source map, a minified bundle echoed in an
 * error, or a long JWT from a failing auth test. Any one of those is a six-figure
 * character run on a single line, and `verify` would appear to HANG inside capture — in
 * the stage whose entire purpose is to fail fast before any AI spend, with no output,
 * because the hang is inside the code that produces the output.
 *
 * The thresholds below are deliberately loose (seconds, not milliseconds). This test
 * exists to catch a return to quadratic behaviour, not to police millisecond drift on
 * whatever machine happens to run it — a tight bound here would be a flaky test, and a
 * flaky NFR guard gets deleted rather than investigated.
 */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** One unbroken run of identifier characters — a bundle, a data URI, a JWT. */
function unbrokenRun(bytes: number): string {
  let out = '';
  while (out.length < bytes) {
    out += BASE64_ALPHABET;
  }
  return out.slice(0, bytes);
}

function millis(work: () => void): number {
  const started = performance.now();
  work();
  return performance.now() - started;
}

describe('redaction stays linear on captured output (NFR)', () => {
  it('handles a 256 KB unbroken run without hanging', () => {
    // At the reported quadratic rate this input took roughly 90 seconds. Linear, it is
    // milliseconds. Two seconds separates those two worlds by a wide enough margin that
    // a slow CI box cannot turn it red on its own.
    const elapsed = millis(() => {
      redactText(unbrokenRun(256 * 1024));
    });

    expect(elapsed).toBeLessThan(2000);
  });

  it('scales roughly linearly rather than quadratically as the run doubles', () => {
    // The shape of the curve, not its height: doubling the input roughly doubled the time
    // when this was fixed, and roughly quadrupled it before. A 6x allowance for a 4x
    // input is loose enough for a noisy machine and far under the 16x that quadratic
    // growth would produce.
    const small = millis(() => redactText(unbrokenRun(32 * 1024)));
    const large = millis(() => redactText(unbrokenRun(128 * 1024)));

    // Floor the baseline: on a fast machine `small` can round to a fraction of a
    // millisecond, and dividing by it would make the ratio meaningless.
    expect(large).toBeLessThan(Math.max(small, 1) * 6 + 500);
  });

  it('handles a megabyte of ordinary multi-line log output', () => {
    // The common case, and the one that was always fast — pinned so a fix for the run
    // above cannot regress it.
    let raw = '';
    while (raw.length < 1024 * 1024) {
      raw += 'INFO  building module foo/bar/baz.ts in 12ms\n';
    }

    const elapsed = millis(() => {
      boundedText(raw);
    });

    expect(elapsed).toBeLessThan(2000);
  });

  it('still redacts a secret that sits at the end of a very long unbroken run', () => {
    // The property the fix must not trade away: speed is worthless if it is bought by
    // scanning less. The secret is placed after 128 KB of noise, where a naive
    // "give up on long inputs" fix would stop looking.
    const raw = `${unbrokenRun(128 * 1024)}\nANTHROPIC_API_KEY=${['sk', 'ant'].join('-')}-perfcanary`;

    const redacted = redactText(raw);

    expect(redacted).not.toContain('perfcanary');
    expect(redacted).toContain('ANTHROPIC_API_KEY=[REDACTED]');
  });
});
