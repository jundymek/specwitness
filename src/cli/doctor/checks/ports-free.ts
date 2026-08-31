/**
 * Declared service ports (questions doc Q26/Q27, optional).
 *
 * Ports are declared explicitly per service; V0 never auto-allocates, so a
 * collision is diagnosable rather than mysterious — which is the whole point of
 * pre-checking them here, before a service stage fails halfway through a run.
 *
 * WARN, NOT FAIL. Q27 words an occupied port as an `InfraError` at the SERVICES
 * stage, where a bound port really does stop the run. At diagnosis time it is
 * different: the port a developer is using right now, in the dev server they are
 * about to stop, is not a broken environment. So doctor reports it and leaves
 * the exit code alone. The divergence is recorded in DECISIONS.md.
 *
 * The probe binds and immediately releases. Any bind failure counts as occupied
 * — a permission error is still a port this project cannot have.
 */

import type { DoctorCheck } from '../registry.js';

const HOST = '127.0.0.1';

export const portsFreeCheck: DoctorCheck = {
  id: 'ports-free',
  required: false,
  async run(ctx) {
    if (!ctx.config.ok) {
      return {
        status: 'warn',
        detail: 'cannot check declared ports: the project config did not load (see config-valid)',
      };
    }

    const declared = Object.entries(ctx.config.value.services)
      .map(([name, service]) => ({ name, port: service.port }))
      .filter((entry): entry is { name: string; port: number } => entry.port !== undefined);

    if (declared.length === 0) {
      return { status: 'pass', detail: 'no service ports declared' };
    }

    const occupied: { name: string; port: number; reason: string }[] = [];
    for (const { name, port } of declared) {
      const probe = await ctx.effects.probePort(port, HOST);
      if (!probe.free) {
        occupied.push({ name, port, reason: probe.reason ?? 'bind failed' });
      }
    }

    if (occupied.length > 0) {
      const listed = occupied
        .map((entry) => `services.${entry.name} port ${entry.port} (${entry.reason})`)
        .join('; ');

      return {
        status: 'warn',
        // The hint names an OCCUPIED port, not the first declared one: sending
        // someone to inspect a port that is free is worse than giving no hint.
        // It stays advisory text rather than a command doctor runs — spawning
        // lsof to name a process is work a diagnostic was not asked to do.
        detail: `${listed} — find the holder with: lsof -i :${occupied[0]?.port ?? ''}`,
      };
    }

    return { status: 'pass', detail: `all ${declared.length} declared ports are free` };
  },
};
