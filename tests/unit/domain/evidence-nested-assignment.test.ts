/**
 * A regression test for a REAL LEAK in `redactText`, found by story 4.1.
 *
 * ============================================================================
 * WHAT LEAKED, AND WHY IT MATTERED HERE
 * ============================================================================
 *
 * `BARE_ASSIGNMENT` matches `<name><separator><value>` where an unquoted value
 * runs to the next whitespace. So in `boot: ANTHROPIC_API_KEY=<secret>` the
 * FIRST match is `boot: ANTHROPIC_API_KEY=<secret>` — name `boot`, value
 * `ANTHROPIC_API_KEY=<secret>`. `boot` is not a sensitive name, the unquoted
 * value was returned verbatim, and the global scan resumed PAST the whole match,
 * so the nested sensitive assignment was never examined at all.
 *
 * The QUOTED arm already recursed into its value to close precisely this hole
 * (`{"note":"ANTHROPIC_API_KEY=…"}` was handled, and its comment says why). The
 * BARE arm did not, and the asymmetry was invisible because the obvious test —
 * a bare `ANTHROPIC_API_KEY=<secret>` on its own — passes either way.
 *
 * It surfaced in Epic 4 rather than Epic 3 because story 4.1 is the first
 * consumer of untrusted SERVICE output, and the shapes that leak are exactly
 * what a booting service prints: every logger in existence writes
 * `INFO: …` or `<phase>: …` before the rest of the line.
 *
 * ============================================================================
 * WHY THESE CASES
 * ============================================================================
 *
 * Both directions are asserted, because a redactor that over-redacts is its own
 * failure mode: people respond to unreadable evidence by opening the unredacted
 * file. So the innocent text around the secret must SURVIVE — the fix must
 * redact the value and nothing else.
 */

import { describe, expect, it } from 'vitest';

import { redactText } from '../../../src/domain/evidence.js';

// Assembled at runtime, never written as a literal: the harness's secret scanner
// correctly refuses a source file containing an `sk-…`-shaped string, and this
// project's rule is that nothing credential-shaped exists in the repository.
const SECRET = ['sk', 'ant', 'example', '000111222333'].join('-');

describe('a sensitive assignment nested inside an INNOCENT BARE assignment', () => {
  it('redacts one preceded by a prefix key and a colon', () => {
    expect(redactText(`boot: ANTHROPIC_API_KEY=${SECRET}`)).not.toContain(SECRET);
  });

  it('redacts one preceded by a log level, the shape every logger writes', () => {
    expect(redactText(`INFO: ANTHROPIC_API_KEY=${SECRET}`)).not.toContain(SECRET);
  });

  it('redacts one nested two levels deep', () => {
    expect(redactText(`outer: inner: password=${SECRET}`)).not.toContain(SECRET);
  });

  it('still redacts the cases that already worked', () => {
    // Guards against a "fix" that moved the hole rather than closing it.
    expect(redactText(`ANTHROPIC_API_KEY=${SECRET}`)).not.toContain(SECRET);
    expect(redactText(`starting server ANTHROPIC_API_KEY=${SECRET}`)).not.toContain(SECRET);
    expect(redactText(`{"note":"ANTHROPIC_API_KEY=${SECRET}"}`)).not.toContain(SECRET);
  });

  it('leaves the innocent text around the secret intact', () => {
    // Over-redaction is a real failure mode, not a safe direction: evidence
    // nobody can read is evidence people bypass.
    const redacted = redactText(`INFO: ANTHROPIC_API_KEY=${SECRET}`);
    expect(redacted).toContain('INFO');
    expect(redacted).toContain('ANTHROPIC_API_KEY');
    expect(redacted).toContain('[REDACTED]');
  });

  it('does not redact an innocent nested assignment', () => {
    expect(redactText('INFO: NODE_ENV=production')).toBe('INFO: NODE_ENV=production');
  });

  it('still redacts a secret that FOLLOWS an already-redacted token', () => {
    // The adversarial case for the idempotency guard: service output is
    // untrusted, so a service can print the literal `[REDACTED]` itself and try
    // to ride behind it. The guard skips recursion into a value that already
    // carries one — this proves that does not create a hiding place, because a
    // later assignment is whitespace-separated and is matched independently by
    // the global scan.
    const text = `INFO: cached=[REDACTED] ANTHROPIC_API_KEY=${SECRET}`;
    expect(redactText(text)).not.toContain(SECRET);
  });

  it('does NOT let a marker FRAGMENT inside a token buy an exemption', () => {
    // Codex review, P1, and a genuine hole in the first version of this fix.
    // Idempotency was guarded on the INNOCENT branch by "does this value contain
    // a marker head?", which adversarial output can satisfy on purpose: here the
    // marker fragment and the secret live in the SAME whitespace-free token, so
    // the global scan never gets a second chance at it and `secret` survived.
    //
    // Captured output is attacker-influenced, so marker presence can never prove
    // this function produced it. Idempotency now lives on the sensitive branch
    // and compares the WHOLE value, which nothing can ride inside.
    const text = `INFO: [REDACTED_ANTHROPIC_API_KEY=${SECRET}`;
    expect(redactText(text)).not.toContain(SECRET);
  });

  it('remains idempotent', () => {
    // `[REDACTED]` contains no sensitive assignment, so redacting twice must be
    // the same as redacting once — evidence gets copied between fields.
    const once = redactText(`INFO: ANTHROPIC_API_KEY=${SECRET}`);
    expect(redactText(once)).toBe(once);
  });
});

describe('the recursion is BOUNDED — untrusted text cannot exhaust the stack', () => {
  it('survives a pathologically nested token instead of overflowing', () => {
    // Measured while adding the nested-assignment fix, BEFORE it shipped: an
    // unbounded recursion threw `RangeError: Maximum call stack size exceeded`
    // on this exact input. Service output is untrusted, so a crash in the
    // redactor is a denial of service triggerable by anything the verified
    // application logs — this is a security guard, not a benchmark.
    const nested = `${'a:'.repeat(5000)}x`;

    expect(() => redactText(nested)).not.toThrow();
  });

  it('fails CLOSED at the depth bound: over-redacts rather than passing text through', () => {
    // Beyond the bound the remainder is replaced wholesale. Deep nesting is
    // therefore unreadable (safe) rather than unexamined (unsafe).
    const deep = `${'a:'.repeat(40)}ANTHROPIC_API_KEY=${SECRET}`;

    expect(redactText(deep)).not.toContain(SECRET);
  });

  it('stays fast on a large realistic service log', () => {
    const line = 'INFO: NODE_ENV=production PORT=3000 host=127.0.0.1\n';
    const started = Date.now();

    redactText(line.repeat(20000));

    expect(Date.now() - started).toBeLessThan(5000);
  });
});
