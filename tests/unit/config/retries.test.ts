/**
 * Story 5.4 — the `retries:` block, which is the field Epic 4 left missing.
 *
 * Epic 4 built the retry mechanism, proved it across three surfaces and closed with the
 * observation that it has "no field anywhere — not in the config schema, not in 4.2's
 * frozen Plan schema", so that "opt-in per probe class, default 0" resolved in production
 * to an internal policy of zero injectable only by tests. This suite is the other half.
 *
 * THE ASSERTION THIS FILE EXISTS FOR is `defaults to ZERO retries for every surface`.
 * AD-9 and question Q43 make retries opt-in and default 0 so that a run is deterministic
 * unless a project asked otherwise; a default retry would silently convert every flaky
 * environment into green, which is the failure FR-32 exists to prevent arriving through
 * the config file. If that test ever stops discriminating, the product's determinism
 * guarantee is gone with no other alarm.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadConfig, MAX_PROBE_RETRIES } from '../../../src/config/index.js'
import { ConfigError } from '../../../src/domain/errors.js'
import { PROBE_SURFACES } from '../../../src/domain/criterion-result.js'

/** Writes `body` as a project's config and returns the project root. */
function projectWithBody(body: string): string {
  const root = mkdtempSync(join(tmpdir(), 'specwitness-retries-'))
  mkdirSync(join(root, '.specwitness'))
  writeFileSync(join(root, '.specwitness', 'config.yaml'), body)
  return root
}

const MINIMAL = 'version: 1\nproject:\n  baseBranch: master\n'

function loadBody(body: string) {
  return loadConfig(projectWithBody(body))
}

function errorFor(body: string): ConfigError {
  try {
    loadBody(body)
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError)
    return err as ConfigError
  }
  throw new Error('expected the config to be rejected, but it loaded successfully')
}

describe('retries: — the default (AD-9, Q43)', () => {
  it('defaults to ZERO retries for every surface when the block is absent', () => {
    const config = loadBody(MINIMAL)

    // Written surface by surface rather than as a whole-object compare, so a new surface
    // added to PROBE_SURFACES without a default here fails HERE rather than at run time.
    for (const surface of PROBE_SURFACES) {
      expect(config.retries[surface], `${surface} must default to 0`).toBe(0)
    }
  })

  it('defaults every surface to zero when the block is present but partial', () => {
    const config = loadBody(`${MINIMAL}retries:\n  http: 2\n`)

    expect(config.retries.http).toBe(2)
    expect(config.retries.browser).toBe(0)
    expect(config.retries.observation).toBe(0)
    expect(config.retries.shell).toBe(0)
  })

  it('reads a declared value for each surface independently', () => {
    const config = loadBody(
      `${MINIMAL}retries:\n  http: 1\n  browser: 2\n  observation: 0\n  shell: 3\n`,
    )

    expect(config.retries).toEqual({ http: 1, browser: 2, observation: 0, shell: 3 })
  })

  it('accepts the ceiling itself — the bound is inclusive', () => {
    expect(loadBody(`${MINIMAL}retries:\n  http: ${MAX_PROBE_RETRIES}\n`).retries.http).toBe(
      MAX_PROBE_RETRIES,
    )
  })
})

describe('retries: — a value that could loop forever is REJECTED, never coerced', () => {
  // Each case names the offending YAML path, which is what AC2 of the config story asks
  // of every config error and what makes a rejection actionable rather than annoying.
  const rejected: ReadonlyArray<readonly [label: string, body: string]> = [
    ['a negative count', `${MINIMAL}retries:\n  http: -1\n`],
    ['a fractional count', `${MINIMAL}retries:\n  http: 1.5\n`],
    ['NaN', `${MINIMAL}retries:\n  http: .nan\n`],
    ['positive infinity', `${MINIMAL}retries:\n  http: .inf\n`],
    ['a count above the ceiling', `${MINIMAL}retries:\n  http: 1000\n`],
    ['a string that looks like a number', `${MINIMAL}retries:\n  http: "2"\n`],
  ]

  for (const [label, body] of rejected) {
    it(`rejects ${label}, naming retries.http`, () => {
      expect(errorFor(body).message).toContain('retries.http')
    })
  }

  it('rejects an unknown surface key rather than ignoring it', () => {
    // A typo'd surface that validated would be an opt-in the operator believes they
    // configured and never got — the quietest possible way to lose a retry policy.
    const error = errorFor(`${MINIMAL}retries:\n  htpp: 2\n`)

    expect(error.message).toContain('retries')
    expect(error.message).toContain('htpp')
  })

  it('rejects a non-object retries block', () => {
    expect(errorFor(`${MINIMAL}retries: 2\n`).message).toContain('retries')
  })
})

describe("the scaffold template's commented-out example", () => {
  // An opt-in nobody can discover is an opt-in nobody uses, so `specwitness init` ships a
  // commented `retries:` block. A documented example that does not parse when uncommented
  // is worse than none — it teaches a shape the product rejects.
  const TEMPLATE = join(process.cwd(), 'templates', 'config.yaml')

  function uncommentedRetries(): string {
    const template = readFileSync(TEMPLATE, 'utf8').split('\n')
    const start = template.findIndex((line) => line.trim() === '# retries:')
    expect(start, 'templates/config.yaml must document the retries block').toBeGreaterThan(-1)

    const block: string[] = []
    for (let index = start; index < template.length; index += 1) {
      const line = template[index] ?? ''
      if (!line.startsWith('#')) {
        break
      }
      block.push(line.replace(/^# ?/, ''))
    }
    return block.join('\n')
  }

  it('parses, and declares exactly the documented default of zero everywhere', () => {
    const config = loadBody(`${MINIMAL}${uncommentedRetries()}\n`)

    for (const surface of PROBE_SURFACES) {
      expect(config.retries[surface], `${surface} in the template`).toBe(0)
    }
  })

  it('names every probe surface, so no surface is undiscoverable', () => {
    const example = uncommentedRetries()

    for (const surface of PROBE_SURFACES) {
      expect(example).toContain(`${surface}:`)
    }
  })
})
