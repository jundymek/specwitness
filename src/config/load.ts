/**
 * Reading and validating `.specwitness/config.yaml`.
 *
 * `loadConfig` is a LOADER, not a singleton: it holds no cache and no module-level
 * state. The CLI edge calls it once and passes the result down (spine: "config
 * loaded once, validated, passed down; no global mutable state").
 *
 * Every failure mode — missing file, unreadable file, YAML syntax error, duplicate
 * mapping key, empty document, schema violation — leaves this module as a
 * `ConfigError` carrying the offending YAML path, the reason, and a hint. Nothing
 * else escapes, so a caller never sees a raw ENOENT or a YAMLParseError. Story
 * 1.1's global handler prints `ERROR: <message>` + `HINT: <hint>` to stderr and
 * exits 3, which is AC2 delivered end to end without this module writing output
 * or naming an exit code.
 *
 * This module executes nothing. It reads one file.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { YAMLParseError, parse as parseYaml } from 'yaml';
import type { z } from 'zod';

import { ConfigError } from '../domain/errors.js';

import { MissingConfigFileError } from './errors.js';
import { configSchema } from './schema.js';
import type { SpecwitnessConfig } from './types.js';

/** Path of the config file relative to a project root. */
export const CONFIG_RELATIVE_PATH = join('.specwitness', 'config.yaml');

const INIT_HINT = "run 'specwitness init' to scaffold config";

/** One zod validation issue, as produced by the config schema. */
type ConfigIssue = z.core.$ZodIssue;

interface NodeError extends Error {
  code?: string;
}

/**
 * Render a zod issue path as the YAML path a user can find in their own file:
 * `['services','backend','ready','timeoutSec']` -> `services.backend.ready.timeoutSec`
 * `['gates', 1, 'id']`                          -> `gates[1].id`
 */
function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) {
    return '<root>';
  }

  return path.reduce<string>((rendered, segment) => {
    if (typeof segment === 'number') {
      return `${rendered}[${segment}]`;
    }
    return rendered === '' ? String(segment) : `${rendered}.${String(segment)}`;
  }, '');
}

/**
 * Turn one zod issue into `path: reason`.
 *
 * An unrecognized-key issue is the special case: zod points `path` at the PARENT
 * object and carries the offending key in `issue.keys`, so the key has to be
 * appended or the message would name the wrong location — the one thing AC2 asks
 * this function to get right.
 */
function formatIssue(issue: ConfigIssue): string {
  if (issue.code === 'unrecognized_keys') {
    const parent = formatIssuePath(issue.path);
    const prefix = parent === '<root>' ? '' : `${parent}.`;
    return issue.keys
      .map((key) => `${prefix}${key}: unknown key (remove it or fix the spelling)`)
      .join('; ');
  }

  return `${formatIssuePath(issue.path)}: ${issue.message}`;
}

/**
 * Load and validate the Project Config for `projectRoot`.
 *
 * @throws {ConfigError} for every failure; `MissingConfigFileError` (a subclass,
 *   still exit 3) when the file is simply absent.
 */
export function loadConfig(projectRoot: string): SpecwitnessConfig {
  const configPath = join(projectRoot, CONFIG_RELATIVE_PATH);

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeError).code === 'ENOENT') {
      throw new MissingConfigFileError(`no config file at ${configPath}`, INIT_HINT);
    }
    throw new ConfigError(
      `cannot read ${configPath}: ${(error as Error).message}`,
      'check the file permissions and that the path is a readable file',
    );
  }

  let parsed: unknown;
  try {
    // `uniqueKeys` already defaults to true in yaml 2.x; passed explicitly because
    // a last-wins duplicate key would silently discard a declared command, and a
    // future default change must not turn that into a security-relevant surprise.
    parsed = parseYaml(raw, { uniqueKeys: true });
  } catch (error) {
    if (error instanceof YAMLParseError) {
      // The library's own message already ends with "at line L, column C" and is
      // followed by a multi-line code frame. Keep the first line (position and
      // all) so the CLI prints one tight `ERROR:` line rather than a snippet,
      // and only append a position if a future version stops including one.
      const [summary = error.message] = error.message.split('\n');
      const position = error.linePos?.[0];
      const where =
        position === undefined || /line \d+/.test(summary)
          ? ''
          : ` at line ${position.line}, column ${position.col}`;
      throw new ConfigError(
        `${configPath} is not valid YAML: ${summary.replace(/:$/, '')}${where}`,
        'fix the YAML syntax; indentation must use spaces, not tabs',
      );
    }
    throw new ConfigError(
      `${configPath} could not be parsed: ${(error as Error).message}`,
      'fix the YAML syntax and try again',
    );
  }

  if (parsed === null || parsed === undefined) {
    throw new ConfigError(
      `${configPath} is empty: a config must declare at least 'version: 1' and 'project.baseBranch'`,
      INIT_HINT,
    );
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(formatIssue);
    const summary =
      issues.length > 1
        ? `${issues.join('; ')} (${issues.length} problems in total)`
        : (issues[0] ?? 'unknown validation failure');

    throw new ConfigError(
      `invalid config in ${configPath}: ${summary}`,
      'fix the listed key(s); every section is optional except version and project.baseBranch',
    );
  }

  return result.data;
}
