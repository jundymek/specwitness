/**
 * `redaction:` — story 7.4. The key AD-10 always named and no project could write.
 *
 * `RedactionOptions.extraPatterns` has been threaded through the domain, the surfaces and the
 * authoring path since Epic 3, and every one of those paths received `undefined` in production
 * because the Project Config had nowhere to declare a pattern. This file pins the key's one
 * shape and its fail-closed refusals; the wiring from here to every sink is pinned elsewhere.
 *
 * The planted secret is `wombat-…` on purpose: nothing in the built-in rule set matches it, so
 * a test that passes has proved the DECLARED pattern ran, not the built-ins.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadConfig } from '../../../src/config/index.js'
import { exitCodeForError } from '../../../src/cli/exit.js'
import { ConfigError } from '../../../src/domain/errors.js'
import { redactText } from '../../../src/domain/evidence.js'

const MINIMAL = 'version: 1\nproject:\n  baseBranch: master\n'
const SECRET = 'wombat-7x3k9q2m4p'

function loadBody(body: string) {
  const root = mkdtempSync(join(tmpdir(), 'specwitness-redaction-'))
  mkdirSync(join(root, '.specwitness'), { recursive: true })
  writeFileSync(join(root, '.specwitness', 'config.yaml'), body, 'utf8')
  return loadConfig(root)
}

function errorFor(body: string): ConfigError {
  try {
    loadBody(body)
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    return error as ConfigError
  }
  throw new Error('expected the config to be rejected, but it loaded successfully')
}

describe('redaction: — the one accepted shape (AC1)', () => {
  it('an absent key means no extra patterns, and is not an error', () => {
    expect(loadBody(MINIMAL).redaction).toEqual({ extraPatterns: [] })
  })

  it('an empty block and an empty list mean the same, and neither is an error', () => {
    expect(loadBody(`${MINIMAL}redaction: {}\n`).redaction).toEqual({ extraPatterns: [] })
    expect(loadBody(`${MINIMAL}redaction:\n  extraPatterns: []\n`).redaction).toEqual({
      extraPatterns: [],
    })
  })

  it('compiles each declared string to a RegExp at load', () => {
    const config = loadBody(
      `${MINIMAL}redaction:\n  extraPatterns:\n    - 'acme-[a-z0-9]{32}'\n    - 'INTERNAL_[A-Z0-9_]+'\n`,
    )
    expect(config.redaction.extraPatterns).toHaveLength(2)
    expect(config.redaction.extraPatterns.every((pattern) => pattern instanceof RegExp)).toBe(true)
    expect(config.redaction.extraPatterns.map((pattern) => pattern.source)).toEqual([
      'acme-[a-z0-9]{32}',
      'INTERNAL_[A-Z0-9_]+',
    ])
  })

  it('is a RedactionOptions as loaded: the secret is ABSENT from every occurrence, no g flag written', () => {
    const { redaction } = loadBody(`${MINIMAL}redaction:\n  extraPatterns:\n    - 'wombat-[a-z0-9]+'\n`)
    const text = `first ${SECRET} then again ${SECRET} and wombat-aaaa`

    // The control: the built-in rules alone do NOT recognise this shape. Without it the
    // assertion below could pass on the built-ins and prove nothing about the key.
    expect(redactText(text)).toContain(SECRET)

    const redacted = redactText(text, redaction)
    expect(redacted).not.toContain(SECRET)
    expect(redacted).not.toContain('wombat-aaaa')
  })
})

describe('redaction: — refusals are ConfigError and the run does not start (AC1)', () => {
  it('an invalid regex is refused, naming its YAML path, and maps to exit 3 — never 64', () => {
    const error = errorFor(`${MINIMAL}redaction:\n  extraPatterns:\n    - 'ok-[a-z]+'\n    - 'broken-('\n`)
    expect(error.message).toContain('redaction.extraPatterns[1]')
    expect(error.message).toMatch(/not a valid regular expression/)
    expect(exitCodeForError(error)).toBe(3)
  })

  it('the refusal never echoes the pattern: a project may declare a LITERAL secret as its pattern', () => {
    // A project that wants one token redacted plausibly writes the token itself as the pattern,
    // and a token can contain `(`. The engine's own message quotes the source (`/…/`), and this
    // error reaches stderr and CI logs through `printError`. The YAML path is enough to find it.
    const error = errorFor(`${MINIMAL}redaction:\n  extraPatterns:\n    - 'tok3n-literal-(value'\n`)
    expect(error.message).toContain('redaction.extraPatterns[0]')
    expect(`${error.message}\n${error.hint ?? ''}`).not.toContain('tok3n-literal')
  })

  it('a pattern that matches the empty string is refused rather than garbling all evidence', () => {
    for (const pattern of ["''", "'x*'", "'(a|)'"]) {
      const error = errorFor(`${MINIMAL}redaction:\n  extraPatterns:\n    - ${pattern}\n`)
      expect(error.message, pattern).toContain('redaction.extraPatterns[0]')
      expect(error.message, pattern).toMatch(/matches the empty string/)
    }
  })

  it('a non-string entry is refused', () => {
    const error = errorFor(`${MINIMAL}redaction:\n  extraPatterns:\n    - 42\n`)
    expect(error.message).toContain('redaction.extraPatterns[0]')
  })

  it('a bare string instead of a list is refused', () => {
    const error = errorFor(`${MINIMAL}redaction:\n  extraPatterns: 'wombat-[a-z]+'\n`)
    expect(error.message).toContain('redaction.extraPatterns')
  })

  it('an unknown key inside the block is refused, not ignored', () => {
    const error = errorFor(`${MINIMAL}redaction:\n  extraPattern:\n    - 'wombat-[a-z]+'\n`)
    expect(error.message).toContain('redaction.extraPattern: unknown key')
  })

  it('the other spellings are refused at the root: only camelCase `redaction.extraPatterns` exists', () => {
    for (const key of ['redaction-patterns', 'redactionPatterns']) {
      const error = errorFor(`${MINIMAL}${key}:\n  - 'wombat-[a-z]+'\n`)
      expect(error.message, key).toContain(`${key}: unknown key`)
    }
  })
})
