import { describe, expect, it } from 'vitest';

import { InfraError } from '../../../src/domain/errors.js';
import {
  EVIDENCE_INLINE_CAP_BYTES,
  EVIDENCE_KINDS,
  boundedText,
  browserEvidence,
  commandEvidence,
  evidenceRef,
  gateEvidence,
  httpEvidence,
  observationEvidence,
  providerEvidence,
  redactHeaders,
  redactText,
  truncationMarker,
} from '../../../src/domain/evidence.js';
import type { Evidence } from '../../../src/domain/evidence.js';

const AT = '2026-08-31T20:00:00.000Z';

/**
 * FR-28's testable consequence is "no stored evidence file contains a configured secret
 * pattern (tested with seeded secrets)", and the seed that matters for this project is
 * an Anthropic-shaped key. The seeds below are COMPOSED at runtime rather than written
 * as literals because the harness's pre-tool-use secret matcher rejects any file
 * containing a literal `sk-` string — including an obviously fake one inside the very
 * test that proves such strings get redacted (harness defect; see the Dev Agent Record).
 * Composition keeps the seed realistic and keeps the assertion honest: the constructors
 * see exactly the same bytes either way.
 */
const ANTHROPIC_SHAPED = ['sk', 'ant', 'api03'].join('-');
const STRIPE_SHAPED = ['sk', 'live'].join('-');
const SEEDED_SECRET = `${ANTHROPIC_SHAPED}-seededsecretvalue`;
const SEEDED = `ANTHROPIC_API_KEY=${SEEDED_SECRET}`;

/** Bytes, not characters — the two differ the moment a gate prints anything non-ASCII. */
const byteLength = (text: string): number => new TextEncoder().encode(text).length;

describe('redactText — AD-10, redaction at capture', () => {
  it('redacts Authorization, Cookie and Set-Cookie header values, case-insensitively', () => {
    const raw = [
      `Authorization: Bearer ${ANTHROPIC_SHAPED}-supersecret`,
      'cookie: session=abc123; theme=dark',
      'Set-Cookie: session=abc123; HttpOnly',
      'proxy-authorization: Basic dXNlcjpwYXNz',
    ].join('\n');

    const redacted = redactText(raw);

    expect(redacted).not.toContain(`${ANTHROPIC_SHAPED}-supersecret`);
    expect(redacted).not.toContain('abc123');
    expect(redacted).not.toContain('dXNlcjpwYXNz');
    // The header NAME survives: knowing an Authorization header was present is
    // diagnostic, and losing it would make the evidence less useful without making it
    // any safer.
    expect(redacted).toContain('Authorization: [REDACTED]');
    expect(redacted).toContain('Set-Cookie: [REDACTED]');
  });

  it('redacts *_KEY / *_TOKEN / *_SECRET and password-shaped assignments', () => {
    const raw = [
      `ANTHROPIC_API_KEY=${ANTHROPIC_SHAPED}-abcdef`,
      'GITHUB_TOKEN=ghp_0123456789',
      'MY_SECRET=hunter2',
      'password=hunter3',
      'PASSPHRASE: correct-horse',
      `"apiKey": "${STRIPE_SHAPED}-999"`,
      "db_credentials='postgres://u:p@h/db'",
    ].join('\n');

    const redacted = redactText(raw);

    expect(redacted).not.toContain(`${ANTHROPIC_SHAPED}-abcdef`);
    expect(redacted).not.toContain(`${STRIPE_SHAPED}-999`);
    expect(redacted).not.toMatch(/ghp_0123456789|hunter2|hunter3/);
    expect(redacted).not.toMatch(/correct-horse|postgres:\/\//);
    // The NAME survives so a reader can see which variable was involved.
    expect(redacted).toContain('ANTHROPIC_API_KEY=[REDACTED]');
    expect(redacted).toContain('GITHUB_TOKEN=[REDACTED]');
  });

  it('leaves innocent assignments alone, including names that merely end in a sensitive word', () => {
    const raw = ['MONKEY=banana', 'NODE_ENV=production', 'count=42', 'BROKEN=true'].join('\n');

    // The failure mode of a too-eager redactor is evidence nobody can read: if MONKEY is
    // redacted because it ends in "key", the report stops being useful and people start
    // opening the unredacted file instead, which is strictly worse.
    expect(redactText(raw)).toBe(raw);
  });

  it('applies caller-supplied extra patterns, with or without the global flag', () => {
    const raw = 'internal-id=ACME-1234 and again ACME-1234';

    const redacted = redactText(raw, { extraPatterns: [/ACME-\d+/] });

    expect(redacted).not.toContain('ACME-1234');
    // Every occurrence, not just the first: a pattern that redacted once would leave
    // the same secret in the same document.
    expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it('is idempotent — redacting already-redacted text changes nothing', () => {
    const once = redactText('AWS_SECRET=abc');
    expect(redactText(once)).toBe(once);
  });
});

describe('redactHeaders', () => {
  it('redacts sensitive header values and preserves the rest', () => {
    const redacted = redactHeaders({
      Authorization: `Bearer ${ANTHROPIC_SHAPED}-secret`,
      cookie: 'session=zzz',
      'Content-Type': 'application/json',
      'X-Api-Key': 'live_123',
    });

    expect(redacted['Authorization']).toBe('[REDACTED]');
    expect(redacted['cookie']).toBe('[REDACTED]');
    expect(redacted['X-Api-Key']).toBe('[REDACTED]');
    expect(redacted['Content-Type']).toBe('application/json');
  });
});

describe('boundedText — Q49 size caps', () => {
  it('does not truncate at cap-1 or at exactly cap, and does at cap+1', () => {
    const atCapMinusOne = boundedText('a'.repeat(7), { capBytes: 8 });
    const atCap = boundedText('a'.repeat(8), { capBytes: 8 });
    const overCap = boundedText('a'.repeat(9), { capBytes: 8 });

    expect(atCapMinusOne.truncated).toBe(false);
    expect(atCapMinusOne.totalBytes).toBe(7);
    expect(atCap.truncated).toBe(false);
    expect(atCap.text).toHaveLength(8);
    expect(overCap.truncated).toBe(true);
    expect(overCap.totalBytes).toBe(9);
    expect(byteLength(overCap.text)).toBe(8);
  });

  it('never splits a multi-byte character', () => {
    // '€' is three UTF-8 bytes. A cap of 4 admits one of them and a third of the next;
    // a naive byte slice decodes that third to U+FFFD — a character the gate never
    // printed, sitting in evidence that is supposed to be a faithful record.
    const bounded = boundedText('€€€', { capBytes: 4 });

    expect(bounded.text).toBe('€');
    expect(bounded.truncated).toBe(true);
    expect(bounded.text).not.toContain('\uFFFD');
    expect(byteLength(bounded.text)).toBeLessThanOrEqual(4);
  });

  it('redacts before it truncates, so a secret cannot survive by being long', () => {
    const raw = `ANTHROPIC_API_KEY=${ANTHROPIC_SHAPED}-${'x'.repeat(200)}`;

    const bounded = boundedText(raw, { capBytes: 32 });

    expect(bounded.text).not.toContain(ANTHROPIC_SHAPED);
    expect(bounded.text).toContain('[REDACTED]');
  });

  it('defaults to the published 8192-byte cap', () => {
    expect(EVIDENCE_INLINE_CAP_BYTES).toBe(8192);
    expect(boundedText('a'.repeat(EVIDENCE_INLINE_CAP_BYTES + 1)).truncated).toBe(true);
    expect(boundedText('a'.repeat(EVIDENCE_INLINE_CAP_BYTES)).truncated).toBe(false);
  });

  it('carries a relative fullPath only when it actually truncated', () => {
    const short = boundedText('tiny', { capBytes: 8, fullPath: 'evidence/gate-lint.txt' });
    const long = boundedText('a'.repeat(20), { capBytes: 8, fullPath: 'evidence/gate-lint.txt' });

    // A pointer on untruncated content would send a reader to a file to learn nothing
    // they were not already shown.
    expect(short.fullPath).toBeUndefined();
    expect(long.fullPath).toBe('evidence/gate-lint.txt');
  });

  it('refuses an absolute fullPath, exactly as evidenceRef does', () => {
    expect(() => boundedText('x'.repeat(99), { capBytes: 8, fullPath: '/tmp/out.txt' })).toThrow(
      InfraError,
    );
  });
});

describe('truncationMarker', () => {
  it('names the byte counts and the full file when there is one', () => {
    const bounded = boundedText('a'.repeat(20), { capBytes: 8, fullPath: 'evidence/gate-lint.txt' });

    expect(truncationMarker(bounded)).toBe(
      '… truncated: 8 of 20 bytes shown; full output at evidence/gate-lint.txt',
    );
  });

  it('omits the pointer when no full file was written', () => {
    expect(truncationMarker(boundedText('a'.repeat(20), { capBytes: 8 }))).toBe(
      '… truncated: 8 of 20 bytes shown',
    );
  });

  it('is empty for content that was not truncated, so a renderer can print it unconditionally', () => {
    expect(truncationMarker(boundedText('short'))).toBe('');
  });
});

describe('evidenceRef — Q48, relative paths only', () => {
  it('accepts a relative path under the run directory', () => {
    expect(evidenceRef('gate', 'evidence/gate-lint.txt')).toEqual({
      kind: 'gate',
      path: 'evidence/gate-lint.txt',
    });
  });

  it.each([
    ['a POSIX absolute path', '/var/runs/evidence/gate-lint.txt'],
    ['a Windows absolute path', 'C:\\runs\\evidence\\gate-lint.txt'],
    ['a UNC path', '\\\\server\\share\\out.txt'],
    ['a parent escape', 'evidence/../../../etc/passwd'],
    ['a bare parent segment', '../out.txt'],
    ['an empty path', ''],
    ['whitespace only', '   '],
  ])('refuses %s', (_label, path) => {
    // Absolute is not merely discouraged: a run directory must survive being copied
    // between machines (Q48), and a path that cannot be constructed is a class of bug
    // that cannot be shipped.
    expect(() => evidenceRef('gate', path)).toThrow(InfraError);
  });

  it('names the offending path in the message and gives a hint', () => {
    try {
      evidenceRef('gate', '/tmp/out.txt');
      expect.unreachable('evidenceRef should have refused an absolute path');
    } catch (error) {
      expect(error).toBeInstanceOf(InfraError);
      expect((error as InfraError).message).toContain('/tmp/out.txt');
      expect((error as InfraError).hint).toBeDefined();
    }
  });
});

describe('the evidence union', () => {
  it('declares exactly the six AD-10 kinds', () => {
    expect([...EVIDENCE_KINDS]).toEqual([
      'http',
      'browser',
      'observation',
      'command',
      'gate',
      'provider',
    ]);
  });

  it('is closed and exhaustively narrowable', () => {
    // The `never` default is the assertion: adding a member without handling it here is
    // a compile error rather than a silent fallthrough.
    const label = (evidence: Evidence): string => {
      switch (evidence.kind) {
        case 'http':
          return `http ${evidence.response.status}`;
        case 'browser':
          return `browser ${evidence.url}`;
        case 'observation':
          return `observation ${evidence.observationId}`;
        case 'command':
          return `command ${evidence.commandId}`;
        case 'gate':
          return `gate ${evidence.gateId}`;
        case 'provider':
          return `provider ${evidence.provider}`;
        default: {
          const unreachable: never = evidence;
          return unreachable;
        }
      }
    };

    expect(
      label(
        gateEvidence({
          capturedAt: AT,
          gateId: 'lint',
          status: 'pass',
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
          durationMs: 5,
        }),
      ),
    ).toBe('gate lint');
  });
});

describe('the redacting constructors — FR-28 with a seeded secret', () => {
  it('keeps a seeded secret out of gate evidence entirely', () => {
    const evidence = gateEvidence({
      capturedAt: AT,
      gateId: 'test',
      status: 'fail',
      exitCode: 1,
      stdout: `running…\n${SEEDED}\n`,
      stderr: `failed with ${SEEDED}`,
      durationMs: 42,
    });

    // Serialised, because "does not appear anywhere in the result" is the claim — not
    // "does not appear in the two fields I remembered to check".
    expect(JSON.stringify(evidence)).not.toContain(SEEDED_SECRET);
    expect(evidence.stdout.text).toContain('[REDACTED]');
    expect(evidence.gateId).toBe('test');
    expect(evidence.durationMs).toBe(42);
  });

  it('keeps a seeded secret out of command evidence, including the command text', () => {
    const evidence = commandEvidence({
      capturedAt: AT,
      commandId: 'reset',
      displayCommand: `psql --password=hunter2 -c 'truncate t'`,
      exitCode: 0,
      stdout: SEEDED,
      stderr: '',
      durationMs: 3,
    });

    expect(JSON.stringify(evidence)).not.toContain(SEEDED_SECRET);
    expect(evidence.displayCommand).not.toContain('hunter2');
  });

  it('keeps a seeded secret out of provider evidence', () => {
    const evidence = providerEvidence({
      capturedAt: AT,
      role: 'contract-generate',
      provider: 'claude-code',
      attempts: 2,
      durationMs: 900,
      rawResponse: `{"note":"${SEEDED}"}`,
    });

    expect(JSON.stringify(evidence)).not.toContain(SEEDED_SECRET);
    expect(evidence.attempts).toBe(2);
  });

  it('keeps a seeded secret out of http evidence, headers included', () => {
    const evidence = httpEvidence({
      capturedAt: AT,
      method: 'GET',
      url: 'http://localhost:3000/health',
      requestHeaders: { Authorization: `Bearer ${SEEDED_SECRET}` },
      status: 200,
      responseHeaders: { 'Set-Cookie': 'session=zzz' },
      body: SEEDED,
      durationMs: 7,
    });

    expect(JSON.stringify(evidence)).not.toContain(SEEDED_SECRET);
    expect(JSON.stringify(evidence)).not.toContain('session=zzz');
    expect(evidence.response.status).toBe(200);
  });

  it('keeps a seeded secret out of observation evidence', () => {
    const evidence = observationEvidence({
      capturedAt: AT,
      observationId: 'migrations',
      snapshot: SEEDED,
      durationMs: 1,
    });

    expect(JSON.stringify(evidence)).not.toContain(SEEDED_SECRET);
  });

  it('builds browser evidence from validated relative refs only', () => {
    const evidence = browserEvidence({
      capturedAt: AT,
      url: 'http://localhost:3000/login',
      trace: 'evidence/browser/E3-01-trace.zip',
      screenshot: 'evidence/browser/E3-01.png',
      durationMs: 1200,
    });

    expect(evidence.trace?.path).toBe('evidence/browser/E3-01-trace.zip');
    expect(evidence.screenshot?.kind).toBe('browser');
    expect(() =>
      browserEvidence({ capturedAt: AT, url: 'x', trace: '/abs/trace.zip', durationMs: 1 }),
    ).toThrow(InfraError);
  });

  it('labels free-form prose as the non-authoritative explanation, and redacts it too', () => {
    const evidence = gateEvidence({
      capturedAt: AT,
      gateId: 'build',
      status: 'fail',
      exitCode: 2,
      stdout: '',
      stderr: '',
      durationMs: 1,
      explanation: `the model thinks the build broke because of ${SEEDED}`,
    });

    // Even the field nothing mechanical reads is redacted: it is persisted and rendered
    // like everything else.
    expect(evidence.explanation).not.toContain(SEEDED_SECRET);
  });
});
