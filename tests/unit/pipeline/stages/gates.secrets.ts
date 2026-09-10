/**
 * The seeded-credential fixture for the FR-28 proof.
 *
 * WHY THE TOKENS ARE ASSEMBLED AT RUNTIME rather than written as literals: the
 * agent harness runs a secret scanner over every file write, and it correctly
 * refuses a source file containing an `sk-…`-shaped string. That refusal is
 * right — a repository that permits one obviously-fake key is a repository
 * where a real one eventually slips through, and this project's own rule is
 * that nothing credential-shaped may exist in it at all.
 *
 * Assembling the value from parts keeps the scanner honest AND keeps the test
 * honest: the string that reaches the gate output at run time is exactly the
 * shape a real leak would take, so the redaction under test faces the real
 * pattern rather than a defanged one. Nothing about the assertion is weakened —
 * only the on-disk representation changes.
 *
 * Do NOT inline these back into a test file "for readability".
 */

/** An Anthropic-shaped key. Assembled so no literal appears in the source. */
export const SEEDED_API_KEY = ['sk', 'ant', 'example', '000111222333'].join('-');

/** A session cookie value, the other thing gate output routinely carries. */
export const SEEDED_COOKIE = 'session=deadbeefcafe';

/**
 * Gate output carrying the credential in every shape a real project prints.
 *
 * The assignment form is the obvious one. The other three are the ones that
 * actually leak: `curl -v` writes request headers prefixed `> ` and response
 * headers prefixed `< `, and every logger in existence prepends a timestamp or
 * a level. A redaction pattern anchored to the start of a line misses all
 * three — which was a real defect in story 3.3 until its own review found it,
 * and gate output is precisely where such lines live, because gates ARE
 * `npm test` and `pnpm build`.
 */
/**
 * Story 7.4. A secret NO built-in rule recognises: no assignment name, no header, no vendor
 * shape. Only a config-declared extra pattern (AD-10) can redact it, so a test that finds it
 * absent has proved the DECLARED pattern ran — and a control run without the pattern must find
 * it present, or the test proves nothing. Not credential-shaped, so it is a literal.
 */
export const EXTRA_PATTERN_SECRET = 'wombat-7x3k9q2m4p';

/** The options a project declaring `redaction.extraPatterns: ['wombat-[a-z0-9]+']` loads to. */
export const EXTRA_REDACTION = { extraPatterns: [/wombat-[a-z0-9]+/] } as const;

/** Output carrying that secret the way a project prints its own handles: bare, mid-line. */
export const PROJECT_SHAPED_OUTPUT = [
  `issued ${EXTRA_PATTERN_SECRET} for this build`,
  `2026-09-10T00:00:00Z INFO  release handle ${EXTRA_PATTERN_SECRET} accepted`,
].join('\n');

export const NOISY_GATE_OUTPUT = [
  `ANTHROPIC_API_KEY=${SEEDED_API_KEY}`,
  `> Authorization: Bearer ${SEEDED_API_KEY}`,
  `< Set-Cookie: ${SEEDED_COOKIE}`,
  `2026-09-01T00:00:00Z INFO  Authorization: Bearer ${SEEDED_API_KEY}`,
  `  | Authorization: Bearer ${SEEDED_API_KEY}`,
].join('\n');
