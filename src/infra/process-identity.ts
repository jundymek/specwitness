/**
 * Is this process group still the one we recorded? — story 3.2, AD-8.
 *
 * `specwitness clean` replays manifests written days ago and then SIGNALS what
 * it finds. That is the most dangerous thing in this story, and the reason is
 * pid reuse: a process-group id is a pid, pids are recycled, and a pgid recorded
 * last week may be the operator's editor today. Killing the wrong process tree
 * is worse than leaking — a leak is visible in `ps` and recoverable by hand,
 * while a wrongly-killed tree is neither.
 *
 * WHAT THIS MODULE ESTABLISHES, precisely:
 *
 *   liveness  `kill(-pgid, 0)` would succeed, i.e. the group has members.
 *   identity  the EARLIEST start time among the group's members sits within
 *             `IDENTITY_WINDOW_MS` of the instant SpecWitness recorded that
 *             pgid (`RunStore.readProcessGroupRecords`).
 *
 * WHY THE EARLIEST MEMBER RATHER THAN THE LEADER. Every member of a group we
 * created is the leader or a descendant of it, so the earliest surviving member
 * started at or after the leader — which SpecWitness recorded within
 * milliseconds of spawning it. A group that merely REUSED this pgid, on the
 * other hand, could only have been created after our group emptied, which is
 * necessarily later than our recording. For that group to fall inside the
 * window, the machine would have to have burned through the entire pid space in
 * ten seconds. Using the leader alone would have been slightly tighter but
 * would have refused to reap the common orphan shape (`npm` exits, the server
 * it spawned does not), which is the shape this command exists for.
 *
 * WHAT IT DOES NOT GUARANTEE, said plainly: nothing here proves the group is
 * ours in the cryptographic sense, and no portable API can. It proves the group
 * that exists now began when ours did. Anything it cannot prove is reported and
 * NOT signalled — the failure direction is always "leave it running and say
 * so".
 *
 * AD-3: `ps` is spawned as a fixed binary with a fixed argument array through
 * the `ProcessRunner` port. No shell, no command string, no interpolation of
 * anything a provider or a config could influence.
 */

import type { ProcessRunner } from '../domain/process-runner.js';

/**
 * How far the earliest member's start time may sit from the recorded instant.
 *
 * Ten seconds, and each half of it is doing something. EARLY: `ps` reports
 * `lstart` with one-second granularity and the process genuinely starts a
 * moment before SpecWitness records it, after an fsync. LATE: a clock that has
 * been nudged, or a very slow durable write. It is enormous compared to the
 * real skew (milliseconds) and microscopic compared to any credible pid-reuse
 * interval, which is exactly the shape a safety margin should have.
 */
export const IDENTITY_WINDOW_MS = 10_000;

/** How long `ps` may take before the probe gives up and reports `unknown`. */
const PS_TIMEOUT_MS = 10_000;

/** What is known about one process group, right now. */
export interface ProcessGroupProbe {
  readonly pgid: number;
  /**
   * `live` — the group has members. `gone` — it has none, so there is nothing
   * to reap and nothing may be signalled. `unknown` — the probe itself failed,
   * which is never treated as `gone`: reporting "nothing to do" because a
   * diagnostic broke is how a leak becomes invisible.
   */
  readonly state: 'live' | 'gone' | 'unknown';
  /** Earliest start time among the group's members. Present only when `live`. */
  readonly startedAt?: Date;
  /** True when this is the group SpecWitness itself is running in. */
  readonly ownProcessGroup?: boolean;
  /** Why the probe could not answer. Present only when `unknown`. */
  readonly detail?: string;
}

interface ProcessRow {
  readonly pid: number;
  readonly pgid: number;
  readonly startedAt: Date;
}

/**
 * Probes every requested process group in ONE `ps` call.
 *
 * A full process listing rather than `ps -g`, deliberately: BSD `ps` (macOS) and
 * procps `ps` (Linux) disagree about what `-g` selects — on one it is a process
 * group, on the other a session — and a flag that quietly means something else
 * on the operator's OS is the last thing this particular command should rely
 * on. `-A -o pid=,pgid=,lstart=` means the same thing on both.
 *
 * `LC_ALL=C` is set on the child so `lstart` is parseable regardless of the
 * operator's locale. Note that this SETS a variable rather than reading one:
 * nothing here inspects the parent environment.
 */
export async function probeProcessGroups(
  runner: ProcessRunner,
  pgids: readonly number[],
  cwd: string,
): Promise<ReadonlyMap<number, ProcessGroupProbe>> {
  const probes = new Map<number, ProcessGroupProbe>();
  if (pgids.length === 0) {
    return probes;
  }

  const result = await runner.run({
    binary: 'ps',
    args: ['-A', '-o', 'pid=,pgid=,lstart='],
    cwd,
    timeoutMs: PS_TIMEOUT_MS,
    // Inherited so PATH resolves `ps`; LC_ALL forced so the date format is the
    // C-locale one this module knows how to parse.
    env: { inherit: true, set: { LC_ALL: 'C' } },
  });

  if (result.outcome !== 'completed' || result.exitCode !== 0) {
    const detail = describeProbeFailure(result.outcome, result.exitCode, result.stderr);
    for (const pgid of pgids) {
      probes.set(pgid, { pgid, state: 'unknown', detail });
    }
    return probes;
  }

  const rows = parseProcessRows(result.stdout);
  // Our own group is derived from the SAME snapshot rather than a second call,
  // so there is no window in which the two could disagree.
  const ownGroup = rows.find((row) => row.pid === process.pid)?.pgid;

  for (const pgid of pgids) {
    const members = rows.filter((row) => row.pgid === pgid);
    if (members.length === 0) {
      probes.set(pgid, { pgid, state: 'gone' });
      continue;
    }

    let earliest = members[0]?.startedAt as Date;
    for (const member of members) {
      if (member.startedAt.getTime() < earliest.getTime()) {
        earliest = member.startedAt;
      }
    }

    probes.set(pgid, {
      pgid,
      state: 'live',
      startedAt: earliest,
      ownProcessGroup: ownGroup !== undefined && ownGroup === pgid,
    });
  }

  return probes;
}

/**
 * Does a live group's start time match when SpecWitness recorded that pgid?
 *
 * Exported so the decision is testable on its own: it is the single comparison
 * standing between `clean` and somebody else's process tree.
 */
export function startTimeMatchesRecord(startedAt: Date, recordedAt: Date): boolean {
  return Math.abs(startedAt.getTime() - recordedAt.getTime()) <= IDENTITY_WINDOW_MS;
}

/**
 * Parses `pid pgid lstart` rows.
 *
 * `lstart` is the whole rest of the line (`Sun Aug 31 22:10:45 2026`) and
 * contains spaces, so the first two fields are split off and the remainder is
 * handed to `Date` whole. A row that does not parse is DROPPED rather than
 * guessed at: an unparseable row means the group looks absent, and looking
 * absent means nothing gets signalled — the safe direction.
 */
function parseProcessRows(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(trimmed);
    if (match === null) {
      continue;
    }
    const [, pidText = '', pgidText = '', startText = ''] = match;
    const startedAt = new Date(startText);
    if (Number.isNaN(startedAt.getTime())) {
      continue;
    }
    rows.push({ pid: Number(pidText), pgid: Number(pgidText), startedAt });
  }

  return rows;
}

/** A sentence an operator can act on, for each way `ps` can fail. */
function describeProbeFailure(
  outcome: string,
  exitCode: number | null,
  stderr: string,
): string {
  if (outcome === 'not-found') {
    return 'ps is not on PATH, so process groups could not be checked';
  }
  if (outcome === 'timed-out') {
    return `ps did not answer within ${PS_TIMEOUT_MS}ms, so process groups could not be checked`;
  }
  const reason = stderr.trim().split('\n')[0] ?? '';
  return `ps failed (${outcome}, exit ${exitCode ?? 'none'})${reason === '' ? '' : `: ${reason}`}`;
}
