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
 *   liveness  `kill(-pgid, 0)` — asked directly, and the ONLY thing allowed to
 *             conclude `gone`. It is the same question the eventual signal asks,
 *             so it cannot be defeated by a `ps` line this module misparsed.
 *   identity  the EARLIEST start time among the group's members sits within
 *             `IDENTITY_WINDOW_MS` of the instant SpecWitness recorded that
 *             pgid (`RunStore.readProcessGroupRecords`).
 *
 * ABSENCE IS NEVER INFERRED FROM SILENCE. If `ps` cannot be run, cannot be
 * parsed, or describes no member of a group that `kill(-pgid, 0)` says is
 * alive, the answer is `unknown` — reported, not signalled, and not marked
 * reaped. A diagnostic that failed must never read as evidence that there was
 * nothing to find.
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

/** What `ps` told us, including what it told us badly. */
interface ProcessSnapshot {
  readonly rows: readonly ProcessRow[];
  /**
   * Process groups with at least one member whose START TIME could not be
   * parsed. The group is demonstrably alive; it just cannot be dated, so it
   * must never be reported as `gone`.
   */
  readonly undatable: ReadonlySet<number>;
  /**
   * PIDs whose row was present but undatable — the same fact indexed by
   * process rather than by group, because `probeProcesses` asks about a pid.
   *
   * Kept separately rather than derived: a pid appearing in `undatable` would
   * only mean "some member of the group with that NUMBER was undatable", which
   * is a different claim and true by coincidence.
   */
  readonly undatablePids: ReadonlySet<number>;
  /**
   * True when some line could not be attributed to a pgid at all. Then no
   * absence can be proved from this snapshot, because the missing member could
   * have been in any of those lines.
   */
  readonly unattributable: boolean;
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

  const snapshot = parseProcessSnapshot(result.stdout);
  // Our own group is derived from the SAME snapshot rather than a second call,
  // so there is no window in which the two could disagree.
  const ownGroup = snapshot.rows.find((row) => row.pid === process.pid)?.pgid;

  for (const pgid of pgids) {
    // `kill(-pgid, 0)` is asked FIRST and is authoritative about existence: it
    // is the same question the eventual signal asks, and it cannot be defeated
    // by a `ps` line this module failed to parse. Only it may conclude `gone`.
    const exists = processGroupExists(pgid);

    if (exists === false) {
      probes.set(pgid, { pgid, state: 'gone' });
      continue;
    }

    const members = snapshot.rows.filter((row) => row.pgid === pgid);

    if (members.length === 0 || snapshot.undatable.has(pgid)) {
      // Alive (or possibly alive) but not describable. NEVER `gone`: reporting
      // absence because a diagnostic could not read a line is how a live
      // process group ends up marked reaped and left running forever.
      probes.set(pgid, {
        pgid,
        state: 'unknown',
        detail: describeUndescribable(exists, snapshot.undatable.has(pgid), snapshot),
      });
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

/** What is known about one process, right now. */
export interface ProcessProbe {
  readonly pid: number;
  readonly state: 'live' | 'gone' | 'unknown';
  /** When the OS says it started. Present only when `live`. */
  readonly startedAt?: Date;
  readonly detail?: string;
}

/**
 * Probes individual PROCESSES — used to ask whether a run's owner is still
 * running, so `clean` never reaps a verification that is still going.
 *
 * Same one-`ps` shape and the same one-sided rule as the group probe: `gone` is
 * concluded only from evidence of absence, and anything unreadable is `unknown`.
 * `unknown` makes `clean` leave the run alone, which is the safe direction here
 * too — refusing to reap costs a leak an operator can see, while reaping a live
 * run kills their verification.
 */
export async function probeProcesses(
  runner: ProcessRunner,
  pids: readonly number[],
  cwd: string,
): Promise<ReadonlyMap<number, ProcessProbe>> {
  const probes = new Map<number, ProcessProbe>();
  if (pids.length === 0) {
    return probes;
  }

  const result = await runner.run({
    binary: 'ps',
    args: ['-A', '-o', 'pid=,pgid=,lstart='],
    cwd,
    timeoutMs: PS_TIMEOUT_MS,
    env: { inherit: true, set: { LC_ALL: 'C' } },
  });

  if (result.outcome !== 'completed' || result.exitCode !== 0) {
    const detail = describeProbeFailure(result.outcome, result.exitCode, result.stderr);
    for (const pid of pids) {
      probes.set(pid, { pid, state: 'unknown', detail });
    }
    return probes;
  }

  const snapshot = parseProcessSnapshot(result.stdout);

  for (const pid of pids) {
    // Asked first and authoritative about existence, exactly as for groups: it
    // is the same question the decision actually turns on, and it cannot be
    // defeated by a `ps` line this module failed to parse.
    const exists = processExists(pid);

    if (exists === false) {
      probes.set(pid, { pid, state: 'gone' });
      continue;
    }

    const row = snapshot.rows.find((candidate) => candidate.pid === pid);
    if (row !== undefined && !snapshot.undatablePids.has(pid)) {
      probes.set(pid, { pid, state: 'live', startedAt: row.startedAt });
      continue;
    }

    // Present but undatable, or alive but unlisted, or unparseable output. All
    // three are `unknown`, and `clean` treats an unknown owner as ALIVE — which
    // costs a visible leak rather than a killed verification.
    probes.set(pid, {
      pid,
      state: 'unknown',
      detail: snapshot.undatablePids.has(pid)
        ? 'ps listed the process but its start time could not be parsed, so its identity could not be verified'
        : exists === true
          ? 'the process is alive but ps did not list it, so its identity could not be verified'
          : 'ps produced output this build could not parse, so the process could not be proved absent',
    });
  }

  return probes;
}

/**
 * Does a process exist? `undefined` when it cannot be asked.
 *
 * The single-process twin of `processGroupExists`, with the same one-sided
 * rule: only a definite ESRCH may conclude absence. EPERM means it exists and
 * belongs to somebody else, which is not "gone".
 */
function processExists(pid: number): boolean | undefined {
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return false;
    }
    if (code === 'EPERM') {
      return true;
    }
    return undefined;
  }
}

/**
 * Is a run's recorded owner still the process that owns it?
 *
 * The check runs in the OPPOSITE direction to the process-group one, and is
 * sound for the same reason. A run's owner must have STARTED BEFORE the run
 * recorded it — it is the process that did the recording. If that owner died,
 * its pid can only have been reused by a process that started after the death,
 * which is after the record. So "started at or before the recorded instant"
 * identifies the true owner, and a recycled pid fails it.
 *
 * NO FORWARD SLACK, and the reason is the one that made the first version
 * wrong. `ps lstart` reports whole seconds, so a start time is TRUNCATED — it
 * only ever moves EARLIER than the truth, never later. A genuine owner
 * therefore satisfies `reported <= true start < recordedAt` on its own, and the
 * second of slack the first version added bought nothing for it. What that
 * slack did buy was a pid reused within the same second as the record looking
 * like the original owner — and because the guard errs toward "still running",
 * a long-lived replacement would make every future `clean` skip that crashed
 * run permanently. The rounding direction is what settles it: correcting for a
 * granularity that only ever underestimates, by overestimating, adds a failure
 * mode instead of removing one.
 */
export function ownerStartedBeforeRecord(startedAt: Date, recordedAt: Date): boolean {
  return startedAt.getTime() <= recordedAt.getTime();
}

/**
 * Does a process group have any member? `undefined` when it cannot be asked.
 *
 * Signal 0 delivers nothing; it only performs the existence and permission
 * check. EPERM means the group exists and belongs to someone else, which is
 * emphatically not "gone".
 *
 * `pgid <= 1` is refused rather than probed: `kill(-0, …)` addresses the
 * CALLER's own process group, so passing 0 through would ask a question about
 * ourselves and answer it about somebody else's run.
 */
function processGroupExists(pgid: number): boolean | undefined {
  if (!Number.isInteger(pgid) || pgid <= 1) {
    return undefined;
  }
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return false;
    }
    if (code === 'EPERM') {
      return true;
    }
    return undefined;
  }
}

/** Why a group could not be described, in a sentence an operator can act on. */
function describeUndescribable(
  exists: boolean | undefined,
  undatable: boolean,
  snapshot: ProcessSnapshot,
): string {
  if (undatable) {
    return 'the process group is alive but ps reported a member whose start time could not be parsed, so its identity could not be verified';
  }
  if (exists === true) {
    return 'the process group is alive but ps did not list any of its members, so its identity could not be verified';
  }
  if (snapshot.unattributable) {
    return 'ps produced output this build could not parse, so the process group could not be proved absent';
  }
  return 'the process group could not be checked';
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
 * Parses `pid pgid lstart` rows, KEEPING TRACK OF WHAT IT COULD NOT PARSE.
 *
 * `lstart` is the whole rest of the line (`Sun Aug 31 22:10:45 2026`) and
 * contains spaces, so the first two fields are split off and the remainder is
 * handed to `Date` whole.
 *
 * An earlier version simply DROPPED any line it could not parse, and that was a
 * defect of exactly the kind this command exists to prevent: a live member with
 * an unreadable `lstart` disappeared from the snapshot, the group then looked
 * empty, and `clean` reported the run reaped while the processes kept running.
 * Silence about a failed parse is indistinguishable from evidence of absence.
 *
 * So a failure is now RECORDED. A line whose pid and pgid parsed but whose date
 * did not makes that group undatable; a line that did not parse at all makes the
 * whole snapshot unable to prove any absence.
 */
function parseProcessSnapshot(stdout: string): ProcessSnapshot {
  const rows: ProcessRow[] = [];
  const undatable = new Set<number>();
  const undatablePids = new Set<number>();
  let unattributable = false;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(trimmed);
    if (match === null) {
      unattributable = true;
      continue;
    }
    const [, pidText = '', pgidText = '', startText = ''] = match;
    const pgid = Number(pgidText);
    const startedAt = new Date(startText);
    if (Number.isNaN(startedAt.getTime())) {
      // The process is demonstrably alive — we are looking at its row — we
      // simply cannot date it. That is `unknown`, never `gone`, for the group
      // it belongs to AND for the process itself.
      undatable.add(pgid);
      undatablePids.add(Number(pidText));
      continue;
    }
    rows.push({ pid: Number(pidText), pgid, startedAt });
  }

  return { rows, undatable, undatablePids, unattributable };
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
