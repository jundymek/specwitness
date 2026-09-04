/**
 * Story 6.8 — the shared prompt-assembly helper. Retires Epic 5 action item e5-A.
 *
 * THE FIRST TEST IN THIS FILE IS THE REASON THE STORY EXISTS, and it was written and
 * watched fail before `src/authoring/prompt-assembly.ts` had a single line in it.
 *
 * Epic 5 retro §2 observation 3: story 5.5 (round 2) and story 5.6 (round 13) EACH found,
 * independently and hours apart, that bounding a prompt cut off its tail — where the
 * response shape and the valid-ids rule live — so the runs with the most evidence to send
 * were exactly the runs whose prompt never said what to reply with. Neither fix was
 * applied to the other's module. This file is the guard that makes that defect
 * unrepresentable for every builder in the layer at once.
 *
 * The security assertions here follow Epic 3 retro §7 without exception: a seeded
 * credential is asserted **ABSENT**, never that `[REDACTED]` is **present**. Output
 * carrying the marker with the secret still beside it passes the weaker check.
 *
 * `SEEDED_SECRET` is the repository's one fake credential, reused rather than reinvented:
 * a second, realistic-looking fake in a test file is the shape a real leak hides in.
 */

import { describe, expect, it } from 'vitest';

import {
  PROMPT_FIELD_CAP_BYTES,
  assemblePrompt,
  promptField,
} from '../../../src/authoring/prompt-assembly.js';
import { InfraError } from '../../../src/domain/errors.js';
import { redactText, type RedactionOptions } from '../../../src/domain/evidence.js';
import { SEEDED_SECRET } from '../../fixtures/run-result.js';

const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).length;

const HEAD = [
  'You are assisting a verification tool.',
  '',
  'Do NOT state whether a criterion passes.',
  '',
  '--- THE EVIDENCE ---',
];

const TAIL = [
  '',
  '--- RESPOND WITH ONLY THIS JSON ---',
  '{"explanations":[{"criterionId":"<one of the ids above>","hypothesis":"<your text>"}]}',
  '',
  'Use only criterionIds listed above; any other id is discarded.',
];

describe('assemblePrompt — the instruction tail (AC1, the whole point of story 6.8)', () => {
  it('keeps the fixed tail WHOLE when the untrusted middle is bounded away', () => {
    // THE PATHOLOGICAL CASE. The body alone is an order of magnitude past the cap, so a
    // naive `assembled.slice(0, cap)` would return a document whose last line is a
    // half-written evidence summary and which never reaches the word "RESPOND".
    const cap = 4_000;
    const body = Array.from(
      { length: 200 },
      (_unused, index) => `evidence ${index}: ${'x'.repeat(500)}`,
    );

    const prompt = assemblePrompt({ head: HEAD, body, tail: TAIL, capBytes: cap });

    // Every tail line survives, byte for byte, in order.
    for (const line of TAIL) {
      expect(prompt).toContain(line);
    }
    expect(prompt.endsWith(TAIL.join('\n'))).toBe(true);

    // And the head does too — bounding falls on the middle, not on either end.
    for (const line of HEAD) {
      expect(prompt).toContain(line);
    }
    expect(prompt.startsWith(HEAD.join('\n'))).toBe(true);
  });

  it('really did truncate, so the assertion above is not passing vacuously', () => {
    const cap = 4_000;
    const body = Array.from(
      { length: 200 },
      (_unused, index) => `evidence ${index}: ${'x'.repeat(500)}`,
    );

    const prompt = assemblePrompt({ head: HEAD, body, tail: TAIL, capBytes: cap });

    expect(bytes(prompt)).toBeLessThanOrEqual(cap);
    // The bound was actually reached rather than the input happening to fit.
    expect(bytes(prompt)).toBeGreaterThan(cap - 500);
    // `truncationMarker`'s format, so a truncated prompt READS as truncated to whoever
    // (or whatever) receives it. Not a bare ellipsis of this module's own invention.
    expect(prompt).toMatch(/… truncated: \d+ of \d+ bytes shown/);
  });

  it('drops the body entirely rather than any instruction when the framing alone exceeds the cap', () => {
    // The right way round, and `explain.ts:503-506` says why: if something has to go, the
    // instructions survive and the evidence does not. A prompt with no evidence is a
    // useless question; a prompt with no instructions is an unanswerable one that also
    // burns the whole retry budget on schema rejections.
    const prompt = assemblePrompt({
      head: HEAD,
      body: ['some evidence that cannot fit'],
      tail: TAIL,
      capBytes: 10,
    });

    expect(prompt).toContain('--- RESPOND WITH ONLY THIS JSON ---');
    expect(prompt).not.toContain('some evidence that cannot fit');
  });

  it('respects the cap for multi-byte input without splitting a character', () => {
    // `boundedText` walks back off a continuation byte; this asserts the composed helper
    // inherits that rather than re-deriving a cut of its own. A U+FFFD in a prompt is a
    // character nobody wrote.
    const cap = 2_000;
    const prompt = assemblePrompt({
      head: HEAD,
      body: ['日本語テキスト'.repeat(2_000)],
      tail: TAIL,
      capBytes: cap,
    });

    expect(bytes(prompt)).toBeLessThanOrEqual(cap);
    expect(prompt).not.toContain('�');
    expect(prompt.endsWith(TAIL.join('\n'))).toBe(true);
  });

  it('leaves a body that fits completely alone, with no marker', () => {
    const prompt = assemblePrompt({
      head: HEAD,
      body: ['criterionId: E7-01', 'statement: the endpoint responds 200'],
      tail: TAIL,
      capBytes: 24_000,
    });

    expect(prompt).toContain('statement: the endpoint responds 200');
    expect(prompt).not.toContain('truncated:');
  });

  it('accepts an absent tail — a builder whose instructions all precede its content', () => {
    // `buildContractPrompt` and `buildPlanPrompt` are shaped this way: the instructions are
    // the HEAD and the variable content is last, so the Epic 5 tail defect never applied to
    // them. The helper supports that honestly rather than making them invent a tail.
    const prompt = assemblePrompt({ head: HEAD, body: ['the epic'], capBytes: 24_000 });

    expect(prompt).toContain('the epic');
    expect(prompt.startsWith(HEAD.join('\n'))).toBe(true);
  });
});

describe('assemblePrompt — redaction (AC1, AC2)', () => {
  it('redacts the body even when the builder did NOT call promptField', () => {
    // THIS IS THE ONE STRUCTURAL GUARANTEE STORY 6.8 CLAIMS, and the reason redaction lives
    // in the assembly step rather than only in a per-field helper a builder must remember.
    // A future provider-facing module that forgets `promptField` still cannot put an
    // unredacted assignment into a prompt through this function.
    const prompt = assemblePrompt({
      head: HEAD,
      body: [`statement: the API accepts AUTH_TOKEN=${SEEDED_SECRET}`],
      tail: TAIL,
      capBytes: 24_000,
    });

    expect(prompt).not.toContain(SEEDED_SECRET);
  });

  it('redacts a sensitive header line in the body', () => {
    const prompt = assemblePrompt({
      head: HEAD,
      body: [`actual: Authorization: Bearer ${SEEDED_SECRET}`],
      tail: TAIL,
      capBytes: 24_000,
    });

    expect(prompt).not.toContain(SEEDED_SECRET);
  });

  it('applies config-declared extra patterns when the run supplies them', () => {
    // AD-10's "config-declared extra patterns". Nothing at the CLI edge builds a
    // `RedactionOptions` today (`src/cli/commands/verify.ts:447-465` passes no `redaction`
    // key), so this proves the seam works rather than that it is wired.
    const prompt = assemblePrompt({
      head: HEAD,
      body: ['actual: internal-codename-ORCHID'],
      tail: TAIL,
      capBytes: 24_000,
      redaction: { extraPatterns: [/ORCHID/g] },
    });

    expect(prompt).not.toContain('ORCHID');
  });

  it("never redacts the head or the tail, which are the module's own literals", () => {
    // A fixed instruction line is authored in this repository, not captured from anything.
    // Running the redactor over it could only damage it — and an instruction that reads
    // `api_key: [REDACTED]` is an instruction the model cannot follow.
    const prompt = assemblePrompt({
      head: ['Return an api_key: "<the key you were given>" field.'],
      body: ['nothing sensitive'],
      capBytes: 24_000,
    });

    expect(prompt).toContain('Return an api_key: "<the key you were given>" field.');
  });

  it('redacts BEFORE it bounds, so a cut cannot leave the tail of a secret behind', () => {
    // The ordering `boundedText` already documents (`evidence.ts:653-659`), asserted
    // through the composed helper. Cutting first could split an assignment so the pattern
    // no longer matches, and the surviving half of a credential is still a credential.
    const prompt = assemblePrompt({
      head: [],
      body: [`${'padding '.repeat(40)}AUTH_TOKEN=${SEEDED_SECRET}`],
      capBytes: 400,
    });

    expect(prompt).not.toContain(SEEDED_SECRET);
    expect(prompt).not.toContain(SEEDED_SECRET.slice(0, 12));
  });
});

describe('promptField — bounding one untrusted value', () => {
  it('redacts and caps, in that order', () => {
    expect(promptField(`API_KEY=${SEEDED_SECRET}`, undefined).text).not.toContain(SEEDED_SECRET);
  });

  it('caps at the shared field cap by default', () => {
    expect(bytes(promptField('x'.repeat(5_000), undefined).text)).toBeLessThanOrEqual(PROMPT_FIELD_CAP_BYTES);
  });

  it('takes a caller-supplied cap', () => {
    expect(bytes(promptField('x'.repeat(5_000), { capBytes: 50 }).text)).toBeLessThanOrEqual(50);
  });

  it('leaves a short value untouched, with no marker', () => {
    expect(promptField('the endpoint responds 200', undefined).text).toBe('the endpoint responds 200');
  });

  it('marks a value it cut, so a clipped field reads as clipped', () => {
    expect(promptField('x'.repeat(5_000), undefined).text).toMatch(/… truncated: \d+ of \d+ bytes shown/);
  });
});

/**
 * `onOverflow: 'refuse'` — raised as a P2 by the codex review of story 6.8, and correct.
 *
 * The review's words: *"When a valid epic renders beyond 200,000 bytes, `assemblePrompt`
 * truncates the later stories or acceptance criteria, yet the resulting provider response
 * can still satisfy `DRAFT_RESPONSE_SCHEMA` and become a frozen contract. This silently
 * narrows the definition of done."*
 *
 * It was right, and it was right against my own reasoning: `CONTRACT_PROMPT_CAP_BYTES`'s
 * doc comment already said in as many words that **nothing downstream detects a truncated
 * epic** — and then mitigated that only by choosing a large number. A cap chosen so the bad
 * case is unlikely is not the same as a cap that cannot produce the bad case, and
 * `CLAUDE.md`'s "implementation must never silently change expected behavior" does not have
 * an exception for improbable inputs.
 *
 * So the two AUTHORING roles refuse rather than truncate: an oversized epic or contract is
 * an `InfraError` (exit 3, never a product FAIL) raised BEFORE any provider is invoked, so
 * it costs no quota. The two VERIFY-EDGE roles keep truncating, because what they would lose
 * is an evidence summary or one candidate — content whose absence degrades a
 * non-authoritative hypothesis rather than narrowing a definition of done.
 */
describe("onOverflow: 'refuse' — fail closed instead of silently dropping content", () => {
  const head = ['INSTRUCTIONS', ''];
  const tail = ['', 'RESPOND WITH JSON'];

  it('throws rather than truncating when the body does not fit', () => {
    expect(() =>
      assemblePrompt({
        head,
        body: ['x'.repeat(5_000)],
        tail,
        capBytes: 1_000,
        onOverflow: 'refuse',
      }),
    ).toThrow(InfraError);
  });

  it('names both sizes and prints a HINT, so the refusal is actionable', () => {
    // House convention: `ERROR:` + `HINT:` on stderr. A refusal a reader cannot act on is a
    // refusal they will work around.
    try {
      assemblePrompt({
        head,
        body: ['x'.repeat(5_000)],
        tail,
        capBytes: 1_000,
        onOverflow: 'refuse',
      });
      expect.unreachable('assemblePrompt should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(InfraError);
      const failure = error as InfraError;
      expect(failure.message).toMatch(/5[,_]?\d{3}|\d+ bytes/);
      expect(failure.message).toContain('1000');
      expect(failure.hint).toBeDefined();
    }
  });

  it('refuses even when the FRAMING alone exceeds the cap', () => {
    // The other overflow route. Truncating mode returns the framing with an empty body here;
    // refusing mode must not silently do the same, because an empty body is the most
    // complete loss of content there is.
    expect(() =>
      assemblePrompt({ head, body: ['anything'], tail, capBytes: 5, onOverflow: 'refuse' }),
    ).toThrow(InfraError);
  });

  it('is silent when the body fits — refusing is not a warning, it is an overflow', () => {
    const prompt = assemblePrompt({
      head,
      body: ['a short body'],
      tail,
      capBytes: 24_000,
      onOverflow: 'refuse',
    });

    expect(prompt).toContain('a short body');
    expect(prompt).not.toContain('truncated:');
  });

  it("defaults to 'truncate', so the verify-edge builders are unaffected", () => {
    const prompt = assemblePrompt({ head, body: ['x'.repeat(5_000)], tail, capBytes: 1_000 });

    expect(prompt).toMatch(/… truncated: \d+ of \d+ bytes shown/);
    expect(prompt.endsWith(tail.join('\n'))).toBe(true);
  });
});

/**
 * ⚠️ EXACTLY ONE REDACTION PASS. Raised as a P1 by the codex review, and correct.
 *
 * The report: *"When `RedactionOptions.extraPatterns` is not idempotent, `redactText`
 * transforms the input here and `boundedText` immediately applies the same patterns again
 * (and repeats this in the marker loop) … a broad pattern can make the first redacted value
 * fit the authoritative builders' budget, then expand on the second pass and be silently
 * truncated despite `onOverflow: 'refuse'`."*
 *
 * The first version of `boundWithMarker` called `redactText` itself and then handed the
 * result to `boundedText`, **which redacts again internally**. That is harmless for the
 * BUILT-IN patterns, which `evidence.ts:427` documents as idempotent — `[REDACTED]` contains
 * no sensitive assignment, so redacting twice is redacting once.
 *
 * It is NOT harmless for `extraPatterns`, which are **arbitrary project-supplied regexes**
 * with no idempotence guarantee at all. `/E/g` is enough to show it: the replacement
 * `[REDACTED]` itself contains an `E`, so a second pass rewrites the marker and the text
 * grows. And it grew on the wrong side of the fail-closed check — `assemblePrompt` measures
 * ONE pass to decide whether to refuse, so a second, larger pass slipped past the refusal and
 * was silently truncated. That is precisely the guarantee `onOverflow: 'refuse'` exists to
 * make, defeated by the redaction it depends on.
 *
 * The fix is to pass the ORIGINAL text to `boundedText` every time, so each candidate gets
 * exactly one pass and every measurement describes the same string.
 */
describe('redaction is applied exactly once (codex P1)', () => {
  // Deliberately non-idempotent: `[REDACTED]` contains an E, so a second pass eats its own
  // marker. A project would not write this on purpose — the point is that nothing STOPS it,
  // and a redactor must not depend on the good behaviour of a pattern it did not write.
  const EXPANDING: RedactionOptions = { extraPatterns: [/E/g] };

  it('does not apply an extra pattern twice', () => {
    const once = redactText('EEE', EXPANDING);

    const prompt = assemblePrompt({
      head: [],
      body: ['EEE'],
      capBytes: 24_000,
      redaction: EXPANDING,
    });

    expect(prompt).toBe(once);
  });

  it('never silently truncates under refuse, even with an expanding pattern', () => {
    // THE SECURITY CONSEQUENCE the P1 named. Before the fix the overflow check measured one
    // pass, the body was then built with two, and the larger result was quietly cut — inside
    // the mode whose whole purpose is that content is never quietly cut.
    const body = 'E'.repeat(200);
    const once = redactText(body, EXPANDING);
    const cap = new TextEncoder().encode(once).length + 50;

    const prompt = assemblePrompt({
      head: [],
      body: [body],
      capBytes: cap,
      redaction: EXPANDING,
      onOverflow: 'refuse',
    });

    // Either it fits and is whole, or it refuses. What it must never do is return truncated
    // content from refusal mode.
    expect(prompt).not.toContain('truncated:');
    expect(prompt).toBe(once);
  });

  it('refuses when ONE pass genuinely does not fit, with an expanding pattern', () => {
    // The other half: the refusal still fires on the honest measurement.
    expect(() =>
      assemblePrompt({
        head: [],
        body: ['E'.repeat(200)],
        capBytes: 100,
        redaction: EXPANDING,
        onOverflow: 'refuse',
      }),
    ).toThrow(InfraError);
  });

  it('bounds on one pass in truncate mode too, so the marker describes real bytes', () => {
    const body = 'E'.repeat(400);
    const once = redactText(body, EXPANDING);
    const cap = 500;

    const prompt = assemblePrompt({
      head: [],
      body: [body],
      capBytes: cap,
      redaction: EXPANDING,
    });

    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(cap);
    // `truncationMarker` reports "N of M bytes shown"; M must be the size of ONE redaction
    // pass, because that is the document the caller would otherwise have received.
    expect(prompt).toContain(`of ${new TextEncoder().encode(once).length} bytes shown`);
  });
});

/**
 * ⚠️ `promptField` MUST NOT APPLY THE CONFIGURED PATTERNS — `assemblePrompt` does, exactly
 * once. Raised as a P2 by the codex review, and it is the previous P1 one level up.
 *
 * The earlier fix made `assemblePrompt` redact each bounding candidate exactly once. It did
 * not fix the composition: `explain.ts` clips every field through `promptField` and then
 * hands the result to `assemblePrompt`, so a configured pattern was still applied twice —
 * once per helper. This module's own header had asserted the opposite in as many words
 * ("redaction is idempotent, so a field that passed through both is redacted once in
 * effect"), which is true of the BUILT-IN patterns and false of arbitrary project regexes.
 * The same wrong sentence, in the same file, surviving the fix to the thing it described.
 *
 * The resolution makes the double pass unrepresentable rather than merely avoided:
 * `PromptFieldOptions` no longer extends `RedactionOptions`, so `promptField` has **nowhere
 * to put** a configured pattern. It bounds, and applies the built-in patterns only — which
 * are documented idempotent (`evidence.ts:427`) and so may safely run again at assembly.
 */
describe('promptField applies the configured patterns zero times (codex P2)', () => {
  const EXPANDING: RedactionOptions = { extraPatterns: [/E/g] };

  it('a field routed through both helpers is redacted with the pattern exactly once', () => {
    const raw = 'EEE';
    const once = redactText(raw, EXPANDING);

    const prompt = assemblePrompt({
      head: [],
      // The field carries the options, so IT applies the configured pattern — before its own
      // cut. `assemblePrompt` then passes the branded result through untouched, which is what
      // keeps the pattern to exactly one application across the two helpers.
      body: [promptField(raw, EXPANDING)],
      capBytes: 24_000,
      redaction: EXPANDING,
    });

    expect(prompt).toBe(once);
  });

  it('still applies the BUILT-IN patterns on its own, so a field is never raw', () => {
    // `promptField` remains safe standing alone for the shapes the product recognises
    // itself; what it cannot do is apply a pattern the caller configured.
    expect(promptField(`API_KEY=${SEEDED_SECRET}`, undefined).text).not.toContain(SEEDED_SECRET);
  });
});

/**
 * ⚠️ A CONFIGURED PATTERN MUST BE APPLIED BEFORE THE FIELD IS CUT. Codex P1.
 *
 * The report: *"When a configured `extraPattern` match crosses the 400-byte field boundary,
 * `promptField` truncates the raw value before `assemblePrompt` applies that pattern. The
 * truncated fragment no longer matches the regex, so a prefix of the configured secret is
 * sent to the provider."*
 *
 * This is the ordering hazard `boundedText` documents — *"cutting first could split an
 * assignment so that the pattern no longer matches and the tail of a secret survives the
 * cut"* — and I had reasoned my way around it while fixing the double-pass P2. That
 * reasoning held only for the BUILT-IN shapes, whose `NAME=` prefix survives a truncation
 * and keeps matching. **A configured pattern has no such structure**: it is an arbitrary
 * regex, and cutting anywhere inside its match destroys the match and preserves the prefix.
 *
 * So the correct arrangement is: redact each segment ONCE, with the full options, BEFORE it
 * is bounded — and prove at assembly that it is not redacted a second time. `promptField`
 * therefore returns a branded value, which `assemblePrompt` passes through untouched.
 */
describe('a configured pattern that straddles the field cap (codex P1)', () => {
  it('never lets a prefix of the secret through', () => {
    // The secret sits so that the 400-byte field cap falls INSIDE it. Truncating first would
    // leave its opening characters in the prompt with nothing left to match.
    // ⚠️ THE SECRET MUST STRADDLE THE CUT, and arranging that takes care — a shorter secret
    // sitting at the end is simply DROPPED by truncation, which is safe and would make this
    // test pass for the wrong reason. The field cap is 400 bytes and the truncation marker
    // reserves roughly 40, so the cut lands near byte 360. With 340 bytes of padding and a
    // 100-byte secret the value is 440 bytes — over the cap, so it is really cut — and the
    // cut falls INSIDE the secret, leaving about twenty of its characters on the near side.
    // That surviving prefix is the leak.
    const secret = `CODENAME-ORCHID-${'9f2b1c7d4e6a8b0c'.repeat(5)}-END`;
    const pattern = new RegExp(secret, 'g');
    const padding = 'x'.repeat(340);

    const prompt = assemblePrompt({
      head: [],
      body: [promptField(`${padding}${secret}`, { extraPatterns: [pattern] })],
      capBytes: 24_000,
      redaction: { extraPatterns: [pattern] },
    });

    // ABSENT, and so is any leading fragment of it (Epic 3 retro §7 — a prefix is still a
    // credential, and the marker being present proves nothing about what sits beside it).
    expect(prompt).not.toContain(secret);
    expect(prompt).not.toContain(secret.slice(0, 20));
    expect(prompt).not.toContain(secret.slice(0, 12));
  });

  it('still applies the pattern exactly once end to end', () => {
    const raw = 'EEE';
    const opts = { extraPatterns: [/E/g] };

    const prompt = assemblePrompt({
      head: [],
      body: [promptField(raw, opts)],
      capBytes: 24_000,
      redaction: opts,
    });

    expect(prompt).toBe(redactText(raw, opts));
  });

  it('redacts a plain string body entry that never went through promptField', () => {
    // The structural guarantee is unchanged: anything placed in `body` is redacted, whether
    // or not the builder remembered a helper.
    const prompt = assemblePrompt({
      head: [],
      body: [`AUTH_TOKEN=${SEEDED_SECRET}`],
      capBytes: 24_000,
    });

    expect(prompt).not.toContain(SEEDED_SECRET);
  });
});
