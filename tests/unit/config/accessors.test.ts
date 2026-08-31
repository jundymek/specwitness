import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { ConfigError } from '../../../src/domain/errors.js'
import {
  commandText,
  getObservationCommand,
  loadConfig,
  resolveRoleProvider,
  type SpecwitnessConfig,
} from '../../../src/config/index.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function load(fixture: string): SpecwitnessConfig {
  const root = mkdtempSync(join(tmpdir(), 'specwitness-config-'))
  mkdirSync(join(root, '.specwitness'))
  writeFileSync(join(root, '.specwitness', 'config.yaml'), readFileSync(join(FIXTURES, fixture)))
  return loadConfig(root)
}

describe('getObservationCommand (AC3: config-declared entries only)', () => {
  it('returns the declared command for a known id', () => {
    const config = load('full.yaml')

    expect(commandText(getObservationCommand(config, 'company-count'))).toBe(
      './scripts/specwitness/company-count.sh',
    )
  })

  it('rejects an unknown id instead of falling back to anything', () => {
    const config = load('full.yaml')

    expect(() => getObservationCommand(config, 'no-such-observation')).toThrow(ConfigError)
    expect(() => getObservationCommand(config, 'no-such-observation')).toThrow(
      /no-such-observation/,
    )
  })

  it('rejects an unknown id even when the config declares no observations at all', () => {
    const config = load('minimal.yaml')

    expect(() => getObservationCommand(config, 'company-count')).toThrow(ConfigError)
  })

  it('does not resolve inherited Object.prototype keys as observations', () => {
    const config = load('full.yaml')

    // A prototype-walking lookup would hand back a Function here; ours must not.
    expect(() => getObservationCommand(config, 'constructor')).toThrow(ConfigError)
    expect(() => getObservationCommand(config, 'toString')).toThrow(ConfigError)
  })
})

describe('resolveRoleProvider', () => {
  it('resolves a declared role to its provider config', () => {
    const config = load('full.yaml')

    expect(resolveRoleProvider(config, 'contract-author')).toEqual({
      name: 'codex',
      adapter: 'codex-cli',
      mode: 'chatgpt',
    })
    expect(resolveRoleProvider(config, 'explainer')).toMatchObject({ name: 'claude' })
  })

  it('returns undefined for a role the config does not assign', () => {
    const config = load('minimal.yaml')

    expect(resolveRoleProvider(config, 'plan-author')).toBeUndefined()
  })
})

describe('commandText', () => {
  it('reads a declared command back as a plain string for display and resolution', () => {
    const config = load('full.yaml')

    expect(commandText(config.gates[0]!.run)).toBe('pnpm lint')
    // story 1.5 splits on the first token to check resolvability; it must never execute.
    expect(commandText(config.gates[0]!.run).split(' ')[0]).toBe('pnpm')
  })
})
