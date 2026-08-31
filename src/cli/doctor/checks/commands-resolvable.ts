/**
 * Declared-command resolvability (FR-2, FR-3, required).
 *
 * AD-3, restated because this file is where it would be easiest to break:
 * doctor RESOLVES commands, it never executes them. Nothing here spawns a
 * process, and in particular there is no `which` subprocess and no shell — the
 * PATH scan is implemented by hand precisely so that no declared string is ever
 * handed to an interpreter. Execution arrives in Epic 3, behind `DeclaredCommand`.
 *
 * Only the FIRST token of each command is resolved. A consequence worth stating:
 * a command written in shell syntax (`FOO=bar cmd`, `a && b`, a leading `cd`)
 * reports its literal first token as unresolvable. That is deliberate and
 * honest — under AD-3 those forms would not run as written anyway, so a green
 * check here would be a promise doctor cannot keep.
 */

import { delimiter, isAbsolute, join } from 'node:path';

import { commandText, type SpecwitnessConfig } from '../../../config/index.js';
import type { DoctorContext } from '../context.js';
import type { DoctorCheck } from '../registry.js';

interface DeclaredEntry {
  /** The config id a user can search for, e.g. `gates[lint]`. */
  readonly id: string;
  readonly command: string;
}

/**
 * Every surface story 1.3 declares commands on, in a stable order so the failure
 * list reads the same way twice.
 */
function collectDeclared(config: SpecwitnessConfig): DeclaredEntry[] {
  const entries: DeclaredEntry[] = [];

  if (config.setup.install !== undefined) {
    entries.push({ id: 'setup.install', command: commandText(config.setup.install) });
  }

  for (const gate of config.gates) {
    entries.push({ id: `gates[${gate.id}]`, command: commandText(gate.run) });
  }

  for (const [name, service] of Object.entries(config.services)) {
    entries.push({ id: `services.${name}.run`, command: commandText(service.run) });
    // `ready` is always present (story 1.3 made it required), but only the
    // command variant carries anything to resolve: a url-only readiness block
    // has no command, and handing `undefined` to the resolver would be a bug.
    if (service.ready.command !== undefined) {
      entries.push({
        id: `services.${name}.ready.command`,
        command: commandText(service.ready.command),
      });
    }
  }

  for (const [key, command] of Object.entries(config.data)) {
    entries.push({ id: `data.${key}`, command: commandText(command) });
  }

  for (const [id, observation] of Object.entries(config.observations)) {
    entries.push({ id: `observations.${id}.run`, command: commandText(observation.run) });
  }

  return entries;
}

/**
 * The executable token of a command line.
 *
 * A quoted first token is honoured so a path containing spaces resolves; beyond
 * that this is a whitespace split, not a shell parser, and deliberately so.
 */
export function firstToken(command: string): string {
  const trimmed = command.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const closing = trimmed.indexOf(quote, 1);
    if (closing > 0) {
      return trimmed.slice(1, closing);
    }
  }
  return trimmed.split(/\s+/)[0] ?? '';
}

type Resolution = { readonly ok: true } | { readonly ok: false; readonly reason: string };

async function resolveToken(token: string, ctx: DoctorContext): Promise<Resolution> {
  if (token === '') {
    return { ok: false, reason: 'the command is empty' };
  }

  // A token carrying a separator names a file, not something to look up: an
  // explicit path must be resolved against the project root, never PATH.
  if (token.includes('/') || isAbsolute(token)) {
    const path = isAbsolute(token) ? token : join(ctx.projectRoot, token);
    if (await ctx.effects.isExecutableFile(path)) {
      return { ok: true };
    }
    if (await ctx.effects.pathExists(path)) {
      return { ok: false, reason: `${path} exists but is not executable (chmod +x)` };
    }
    return { ok: false, reason: `no such file: ${path}` };
  }

  // POSIX: an EMPTY PATH component means the current directory, and execvp —
  // which is what Node's spawn ultimately uses — honours that. Dropping those
  // entries would make doctor report a command as unresolvable that the runner
  // can execute perfectly well, which is the one kind of wrong answer a
  // diagnostic must not give. The project root stands in for the working
  // directory, since that is where Epic 3 runs declared commands.
  const rawEntries = ctx.pathVar === '' ? [] : ctx.pathVar.split(delimiter);
  const directories = rawEntries.map((entry) => (entry === '' ? ctx.projectRoot : entry));

  for (const directory of directories) {
    if (await ctx.effects.isExecutableFile(join(directory, token))) {
      return { ok: true };
    }
  }

  return {
    ok: false,
    reason: directories.length === 0 ? 'PATH is empty' : 'not found on PATH',
  };
}

export const commandsResolvableCheck: DoctorCheck = {
  id: 'commands-resolvable',
  required: true,
  async run(ctx) {
    if (!ctx.config.ok) {
      return {
        status: 'fail',
        detail: 'cannot check declared commands: the project config did not load (see config-valid)',
      };
    }

    const declared = collectDeclared(ctx.config.value);
    if (declared.length === 0) {
      return { status: 'pass', detail: 'no commands declared' };
    }

    const unresolved: string[] = [];
    for (const entry of declared) {
      const token = firstToken(entry.command);
      const resolution = await resolveToken(token, ctx);
      if (!resolution.ok) {
        unresolved.push(`${entry.id}: "${token}" — ${resolution.reason}`);
      }
    }

    if (unresolved.length > 0) {
      // Every failure, not just the first: a developer fixing them one doctor
      // run at a time is the slowest possible way to learn what is wrong.
      return {
        status: 'fail',
        detail: `${unresolved.length} of ${declared.length} declared commands do not resolve — ${unresolved.join('; ')}`,
      };
    }

    return { status: 'pass', detail: `all ${declared.length} declared commands resolve` };
  },
};
