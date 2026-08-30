import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { ConfigError } from '../../../src/domain/errors.js'
import { isMissingConfigFileError, loadConfig } from '../../../src/config/index.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

/** Materialise a fixture as `<tmp>/.specwitness/config.yaml` and return the project root. */
function projectWith(fixture: string): string {
  const root = mkdtempSync(join(tmpdir(), 'specwitness-config-'))
  mkdirSync(join(root, '.specwitness'))
  writeFileSync(join(root, '.specwitness', 'config.yaml'), readFileSync(join(FIXTURES, fixture)))
  return root
}

/** Load and return the ConfigError we expect, failing loudly if the load succeeded. */
function loadExpectingError(fixture: string): ConfigError {
  try {
    loadConfig(projectWith(fixture))
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError)
    return err as ConfigError
  }
  throw new Error(`expected ${fixture} to be rejected, but it loaded successfully`)
}

describe('loadConfig — valid configs (AC1)', () => {
  it('accepts the minimal config: version + project.baseBranch is the whole required surface', () => {
    const config = loadConfig(projectWith('minimal.yaml'))

    expect(config.version).toBe(1)
    expect(config.project.baseBranch).toBe('master')
  })

  it('applies exactly the documented defaults and invents nothing else', () => {
    const config = loadConfig(projectWith('minimal.yaml'))

    expect(config.planning).toEqual({
      format: 'bmad-v6',
      planningArtifacts: 'docs/planning-artifacts',
      implementationArtifacts: 'docs/implementation-artifacts',
    })
    expect(config.setup).toEqual({})
    expect(config.gates).toEqual([])
    expect(config.services).toEqual({})
    expect(config.data).toEqual({})
    expect(config.observations).toEqual({})
    expect(config.ai).toEqual({})

    // A field the user did not write must stay undefined rather than being
    // silently materialised (the failure mode called out in the story spec).
    expect(config.project.epicBranchPattern).toBeUndefined()
  })

  it('parses the full addendum-shaped config', () => {
    const config = loadConfig(projectWith('full.yaml'))

    expect(config.project.epicBranchPattern).toBe('epic/{n}-{slug}')
    expect(config.setup.install).toBe('pnpm install')
    expect(config.data.reset).toBe('./scripts/reset-test-db.sh')
    expect(config.services.backend?.port).toBe(8000)
    expect(config.services.backend?.env).toEqual({ DJANGO_SETTINGS_MODULE: 'config.settings.test' })
  })

  it('preserves gate declaration order (AC1: order is significant)', () => {
    const config = loadConfig(projectWith('full.yaml'))

    expect(config.gates.map((gate) => gate.id)).toEqual(['lint', 'typecheck', 'unit', 'build'])
    expect(config.gates[0]?.run).toBe('pnpm lint')
  })

  it('carries readiness as a url-or-command union and defaults timeoutSec to 60', () => {
    const config = loadConfig(projectWith('full.yaml'))
    const backend = config.services.backend?.ready
    const frontend = config.services.frontend?.ready

    expect(backend).toMatchObject({ url: 'http://localhost:8000/health', timeoutSec: 60 })
    // frontend declared no timeoutSec, so the documented default applies
    expect(frontend).toMatchObject({ url: 'http://localhost:3000', timeoutSec: 60 })
  })

  it('carries provider role assignments (AC1)', () => {
    const config = loadConfig(projectWith('full.yaml'))

    expect(config.ai.providers?.claude).toEqual({ adapter: 'claude-code-cli', mode: 'subscription' })
    expect(config.ai.roles?.['contract-author']).toBe('codex')
    expect(config.ai.roles?.explainer).toBe('claude')
  })

  it('parses a mostly-commented template document (story 1.4 ships this shape)', () => {
    const config = loadConfig(projectWith('comments-only-body.yaml'))

    expect(config.project.baseBranch).toBe('main')
    expect(config.gates).toEqual([])
    expect(config.services).toEqual({})
  })
})

describe('loadConfig — invalid configs name the YAML path (AC2)', () => {
  it.each([
    // fixture, substring of the YAML path the message must name
    ['invalid-unknown-key.yaml', 'setupp'],
    ['invalid-nested-typo.yaml', 'services.backend.readyness'],
    ['invalid-missing-base-branch.yaml', 'project.baseBranch'],
    ['invalid-wrong-type.yaml', 'services.backend.ready.timeoutSec'],
    ['invalid-bad-role-ref.yaml', 'ai.roles.contract-author'],
    ['invalid-duplicate-gate-id.yaml', 'gates[1].id'],
    ['invalid-bad-version.yaml', 'version'],
  ])('%s reports the path %s with a hint', (fixture, expectedPath) => {
    const error = loadExpectingError(fixture)

    expect(error.message).toContain(expectedPath)
    expect(error.hint).toBeTruthy()
  })

  it('reports the zod reason alongside the path, not just the path', () => {
    const error = loadExpectingError('invalid-wrong-type.yaml')

    expect(error.message).toMatch(/expected number|received string/i)
  })

  it('reports every issue, first one first, when a config has several', () => {
    const root = mkdtempSync(join(tmpdir(), 'specwitness-config-'))
    mkdirSync(join(root, '.specwitness'))
    writeFileSync(
      join(root, '.specwitness', 'config.yaml'),
      ['version: 1', 'project:', '  baseBranch: 7', 'bogusKey: true', ''].join('\n'),
    )

    let error: ConfigError | undefined
    try {
      loadConfig(root)
    } catch (err) {
      error = err as ConfigError
    }

    expect(error).toBeInstanceOf(ConfigError)
    expect(error?.message).toContain('project.baseBranch')
    expect(error?.message).toContain('bogusKey')
  })
})

describe('loadConfig — file and parse failures are ConfigError, never a crash (AC2)', () => {
  it('reports a missing config file with the init hint, distinguishable from an invalid one', () => {
    const root = mkdtempSync(join(tmpdir(), 'specwitness-config-'))

    let error: ConfigError | undefined
    try {
      loadConfig(root)
    } catch (err) {
      error = err as ConfigError
    }

    expect(error).toBeInstanceOf(ConfigError)
    expect(isMissingConfigFileError(error)).toBe(true)
    expect(error?.hint).toContain('specwitness init')
    // story 1.5 renders these two cases differently
    expect(isMissingConfigFileError(loadExpectingError('invalid-unknown-key.yaml'))).toBe(false)
  })

  it('reports a YAML syntax error with line/col rather than throwing YAMLParseError', () => {
    const error = loadExpectingError('invalid-bad-syntax.yaml')

    expect(error.message).toMatch(/line \d+/i)
    expect(error.message).toMatch(/col(umn)? \d+/i)
  })

  it('rejects duplicate YAML mapping keys rather than silently taking the last one', () => {
    const error = loadExpectingError('invalid-duplicate-yaml-key.yaml')

    expect(error.message).toMatch(/duplicate|unique/i)
  })

  it.each(['invalid-empty.yaml', 'invalid-comments-only.yaml'])(
    '%s is a clear error, not a crash',
    (fixture) => {
      const error = loadExpectingError(fixture)

      expect(error.message).toMatch(/empty/i)
      expect(error.hint).toBeTruthy()
    },
  )

  it('reports an unreadable config file as a ConfigError', () => {
    const root = projectWith('minimal.yaml')
    chmodSync(join(root, '.specwitness', 'config.yaml'), 0o000)

    let error: unknown
    try {
      loadConfig(root)
    } catch (err) {
      error = err
    } finally {
      chmodSync(join(root, '.specwitness', 'config.yaml'), 0o644)
    }

    // Running as root defeats the permission bit; only assert when it took effect.
    if (error !== undefined) {
      expect(error).toBeInstanceOf(ConfigError)
      expect(isMissingConfigFileError(error)).toBe(false)
    }
  })
})

describe('loadConfig — no global state', () => {
  it('returns independent objects for independent roots (a loader, not a singleton)', () => {
    const first = loadConfig(projectWith('minimal.yaml'))
    const second = loadConfig(projectWith('comments-only-body.yaml'))

    expect(first.project.baseBranch).toBe('master')
    expect(second.project.baseBranch).toBe('main')
    expect(first).not.toBe(second)
  })
})
