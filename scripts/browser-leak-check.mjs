#!/usr/bin/env node
/**
 * Does a browser process outlive the run? (story 6.9, AC4.)
 *
 * ⚠️ **WHY THIS EXISTS.** `tests/integration/surfaces/helpers/browser-fixture.ts`'s header
 * states the hazard in its own words: *"A leaked browser tree is the worst leak this product
 * can produce, and it lives until reboot."* Every fixture in that file is self-limiting
 * because **when a test run is killed outright, no `afterEach` executes at all** (Epic 4
 * retro §2 observation 8). Story 6.9 puts the heaviest process tree this product spawns onto
 * a shared Linux runner, on process-group and signal code that had never run on Linux before
 * this epic — so the claim needs evidence, and **"the tests passed" is not evidence about
 * what survived them.**
 *
 * This script produces the evidence: it names every surviving browser process, with its full
 * argv and its process group, and exits non-zero when any remain.
 *
 * ## Why the process listing is an input
 *
 * `--ps-file` lets the parser be driven over trees a test could never produce on demand — a
 * Linux `headless_shell` from a macOS test run, a crashpad handler, a self-match. The
 * matching rules are the part that can be wrong, and they are the part that is tested
 * (`tests/integration/browser-leak-check.test.ts`). Without the flag the script runs `ps`
 * itself, which is what the CI job does.
 *
 * ## Why it reports a DIFF and not an absolute count
 *
 * The first version matched browser processes absolutely. On the author's laptop it reported
 * **77 survivors on a clean run**: every Electron application answers to `--type=renderer`
 * and ships a `chrome_crashpad_handler`. Narrowing the patterns until that went quiet would
 * have narrowed away precisely the helper processes most likely to outlive their parent — so
 * the patterns stay broad, and a BASELINE captured before the run is subtracted instead.
 * What is reported is what THIS RUN left behind, which is the only thing AC4 asks about.
 *
 * ## Fail-closed
 *
 * A scan that could not read a listing, or read one with no process rows, or was told to
 * subtract a baseline that is not there, is an ERROR — never a clean bill of health. A
 * checker that reports "no survivors" without looking is this story's own green-for-nothing
 * (Epic 4 retro §2 observation 2), committed by the guard itself.
 *
 * Usage:
 *   node scripts/browser-leak-check.mjs [--browsers-path <dir>]... [--ps-file <path>]
 *                                       [--baseline <path> | --write-baseline <path>]
 *                                       [--write-survivors <path>] [--reap]
 *                                       [--wait-seconds <n>] [--label <text>]
 *
 * Exit codes follow the house taxonomy where they apply: 0 clean, 1 survivors or a scan that
 * could not look, 64 usage.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

/** This script's own name, so a scan never reports itself. See SELF-EXCLUSION below. */
const SELF = 'browser-leak-check';

/**
 * Browser processes that do NOT name a registry directory in their argv.
 *
 * Matching only the registry path would make the scan blind to precisely the processes most
 * likely to outlive their parent: chromium re-executes helpers (zygote, GPU, utility) and a
 * crashpad handler whose argv may carry no bundle path at all, and on a shared runner a
 * browser from another source is still a browser this job must not have left behind.
 */
const BROWSER_PATTERNS = [
  /headless_shell/,
  /chrome_crashpad_handler/,
  /(^|[/\s])chromium([\s-]|$)/,
  /(^|[/\s])(google-)?chrome([\s-]|$)/,
  /--type=(zygote|gpu-process|utility|renderer)/,
  // The ROOT of the browser tree. `src/surfaces/browser.ts:1250-1251` spawns
  // `process.execPath` with `[cliPath, 'test', '--config', configPath]`, detached — so a
  // leaked Playwright runner is a leaked browser tree that happens to have already closed its
  // browser, and it is the process that would open another one.
  /@playwright[/\\]test[/\\]cli\.js/,
];

/** How often to re-read the listing while waiting for stragglers. */
const POLL_INTERVAL_MS = 500;

/** How many already-running processes the "before" snapshot prints. All of them are recorded. */
const BASELINE_SAMPLE = 10;

/** Milliseconds between SIGTERM and SIGKILL, matching `TEARDOWN_GRACE_MS` in process-runner.ts. */
const TEARDOWN_GRACE_MS = 2_000;

function usage(message) {
  process.stderr.write(
    `${message}\n` +
      'usage: node scripts/browser-leak-check.mjs [--browsers-path <dir>]... ' +
      '[--ps-file <path>] [--baseline <path> | --write-baseline <path>] ' +
      '[--write-survivors <path>] [--reap] [--wait-seconds <n>] [--label <text>]\n',
  );
  process.exit(64);
}

/* ── arguments ───────────────────────────────────────────────────────────────────────── */

const browsersPaths = [];
let psFile;
let baselineFile;
let writeBaselineFile;
let writeSurvivorsFile;
let reap = false;
let waitSeconds = 0;
let label = 'after the run';

const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const flag = argv[index];
  const value = argv[index + 1];

  switch (flag) {
    case '--browsers-path':
      if (value === undefined) usage(`ERROR: ${flag} needs a value`);
      browsersPaths.push(value);
      index += 1;
      break;
    case '--ps-file':
      if (value === undefined) usage(`ERROR: ${flag} needs a value`);
      psFile = value;
      index += 1;
      break;
    case '--baseline':
      if (value === undefined) usage(`ERROR: ${flag} needs a value`);
      baselineFile = value;
      index += 1;
      break;
    case '--write-baseline':
      if (value === undefined) usage(`ERROR: ${flag} needs a value`);
      writeBaselineFile = value;
      index += 1;
      break;
    case '--write-survivors':
      if (value === undefined) usage(`ERROR: ${flag} needs a value`);
      writeSurvivorsFile = value;
      index += 1;
      break;
    case '--reap':
      reap = true;
      break;
    case '--wait-seconds':
      if (value === undefined) usage(`ERROR: ${flag} needs a value`);
      waitSeconds = Number(value);
      if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
        usage(`ERROR: --wait-seconds must be a non-negative number, got ${value}`);
      }
      index += 1;
      break;
    case '--label':
      if (value === undefined) usage(`ERROR: ${flag} needs a value`);
      label = value;
      index += 1;
      break;
    default:
      usage(`ERROR: unknown argument ${flag}`);
  }
}

/* ── reading the listing ─────────────────────────────────────────────────────────────── */

/**
 * The process listing, as text.
 *
 * ⚠️ THROWS rather than returning empty. `ps` failing, or a `--ps-file` that is not there, is
 * the case where a `?? ''` would turn "could not look" into "nothing found" — and the whole
 * point of this script is that the second sentence is a claim and the first one is not.
 */
function readListing() {
  if (psFile !== undefined) {
    return readFileSync(psFile, 'utf8');
  }
  // `args` last: it contains spaces, so every other column must be parsed before it.
  return execFileSync('ps', ['-eo', 'pid,ppid,pgid,etime,args'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** One process row. `args` keeps its internal spacing, because it is quoted as evidence. */
function parse(listing) {
  const rows = [];
  for (const line of listing.split('\n')) {
    const text = line.trim();
    if (text === '') {
      continue;
    }
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(text);
    if (match === null) {
      // The header, or anything else that is not a process row.
      continue;
    }
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      elapsed: match[4],
      args: match[5],
    });
  }
  return rows;
}

/**
 * SELF-EXCLUSION — and it is not optional.
 *
 * This scanner's own command line contains the registry path it was told to look for, and on
 * Linux `ps` lists the `ps` child too. Without this a clean run would always report a leak,
 * and a guard that always fires is a guard nobody keeps. Excluded by pid AND by argv, because
 * the pid check alone does not cover the `--ps-file` fixtures the tests drive.
 */
function isSelf(row) {
  return row.pid === process.pid || row.ppid === process.pid || row.args.includes(SELF);
}

function isBrowser(row) {
  if (isSelf(row)) {
    return false;
  }
  if (browsersPaths.some((path) => path !== '' && row.args.includes(path))) {
    return true;
  }
  return BROWSER_PATTERNS.some((pattern) => pattern.test(row.args));
}

/**
 * The pids that were ALREADY running when the "before" snapshot was taken.
 *
 * THROWS when the file is absent, for the same reason `readListing` does: a missing baseline
 * means the before-step did not run, and defaulting to "nothing was running" would hide every
 * survivor in precisely the run where the job was already broken.
 */
function readBaseline() {
  if (baselineFile === undefined) {
    return new Set();
  }
  return new Set(
    readFileSync(baselineFile, 'utf8')
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0),
  );
}

/** Every browser process, or a thrown error if the listing could not be believed. */
function scan() {
  const listing = readListing();
  const rows = parse(listing);
  if (rows.length === 0) {
    throw new Error('the process listing contained no process rows at all');
  }
  return rows.filter(isBrowser);
}

/* ── the scan ────────────────────────────────────────────────────────────────────────── */

const startedAt = Date.now();
let survivors;
let baseline;

try {
  baseline = readBaseline();
  const notInBaseline = (row) => !baseline.has(row.pid);

  survivors = scan().filter(notInBaseline);

  // A straggler shutting down and a straggler that is never going away look identical in one
  // sample. Polling turns that into a measurement, and the elapsed time is the answer to
  // "how long does a killed run leak for?" — which is the number the PR body has to carry.
  while (survivors.length > 0 && (Date.now() - startedAt) / 1000 < waitSeconds) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_INTERVAL_MS);
    survivors = scan().filter(notInBaseline);
  }
} catch (cause) {
  process.stderr.write(
    `ERROR: the browser survival scan could not read what it needed: ${cause.message}\n` +
      'HINT: this step cannot tell "no browser survived" from "nothing was read", and must ' +
      'not guess. Check that `ps` is available on this runner, that the --ps-file path ' +
      'exists, and that the --baseline file was written by an earlier step.\n',
  );
  process.exit(1);
}

/* ── the "before" snapshot ───────────────────────────────────────────────────────────── */

/**
 * Recording what was already running is not a verdict, so it ALWAYS exits 0. A runner that
 * arrives with a browser up is a fact for the report, never this job's failure — and the file
 * it writes is what makes the "after" scan a statement about this run rather than about the
 * machine.
 */
if (writeBaselineFile !== undefined) {
  const pids = survivors.map((row) => row.pid);
  writeFileSync(writeBaselineFile, `${pids.join('\n')}\n`, 'utf8');
  // Bounded: a CI runner has none of these, but a developer laptop has dozens and a wall of
  // Electron argv makes the rest of the job's log unreadable. Every pid is in the FILE; the
  // listing here is a sample.
  const shown = survivors.slice(0, BASELINE_SAMPLE);
  process.stdout.write(
    `\nBROWSER SURVIVAL BASELINE (${label})\n` +
      `  ${pids.length} browser process(es) were already running; recorded in ${writeBaselineFile}\n` +
      shown.map((row) => `  ${String(row.pid).padStart(7)}  ${row.args.slice(0, 140)}\n`).join('') +
      (survivors.length > shown.length ? `  ... and ${survivors.length - shown.length} more\n` : '') +
      '\n',
  );
  process.exit(0);
}

const waitedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);

/**
 * ⚠️ SO THE CALLER CAN REAP WHAT THIS FOUND — raised as a P1 by the Codex review of this
 * branch, and right: `browser-cancelled-run-check.sh` deliberately CREATES an orphan, so a
 * survivor merely printed is a browser tree this job put on a shared runner and walked away
 * from. Detecting a leak and leaving it running is not a check; it is a leak.
 *
 * The PGID is written beside the pid because a browser is a TREE, and
 * `src/infra/process-runner.ts` reaps one with `kill(-pgid, ...)` for exactly that reason —
 * reaping the pid alone would leave the renderers and the crashpad handler behind.
 *
 * Written whether or not anything survived: an EMPTY file and a MISSING file mean different
 * things to the reaper — "nothing survived" versus "the scan never got this far".
 */
if (writeSurvivorsFile !== undefined) {
  writeFileSync(
    writeSurvivorsFile,
    survivors.map((row) => `${row.pid} ${row.pgid}`).join('\n') + (survivors.length > 0 ? '\n' : ''),
    'utf8',
  );
}

/* ── the report ──────────────────────────────────────────────────────────────────────── */

const lines = [''];
lines.push(`BROWSER SURVIVAL SCAN (${label})`);
lines.push(
  browsersPaths.length === 0
    ? '  registry: none given; matching on process patterns only'
    : `  registry: ${browsersPaths.join(', ')}`,
);
lines.push(
  baselineFile === undefined
    ? '  baseline: none; every matching process counts'
    : `  baseline: ${baseline.size} process(es) already running before the run (${baselineFile})`,
);

if (survivors.length === 0) {
  lines.push(`  RESULT: no surviving browser process (scanned after ${waitedSeconds}s)`);
} else {
  lines.push(
    `  RESULT: ${survivors.length} browser process(es) still present after ${waitedSeconds}s`,
  );
  lines.push('      PID    PPID    PGID  ELAPSED  COMMAND');
  for (const row of survivors) {
    lines.push(
      `  ${String(row.pid).padStart(7)} ${String(row.ppid).padStart(7)} ` +
        `${String(row.pgid).padStart(7)} ${row.elapsed.padStart(8)}  ${row.args}`,
    );
  }
}
lines.push('');
process.stdout.write(lines.join('\n'));

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath !== undefined && summaryPath !== '') {
  const markdown = [
    `## Browser survival scan — ${label}`,
    '',
    survivors.length === 0
      ? `**No surviving browser process** after ${waitedSeconds}s.`
      : `**${survivors.length} browser process(es) survived** ${waitedSeconds}s of waiting.`,
    '',
  ];
  if (survivors.length > 0) {
    markdown.push('| pid | ppid | pgid | elapsed | command |', '| --- | --- | --- | --- | --- |');
    for (const row of survivors) {
      markdown.push(
        `| ${row.pid} | ${row.ppid} | ${row.pgid} | ${row.elapsed} | ` +
          `\`${row.args.replaceAll('|', '\\|')}\` |`,
      );
    }
    markdown.push('');
  }
  appendFileSync(summaryPath, markdown.join('\n'));
}

/* ── reaping ─────────────────────────────────────────────────────────────────────────── */

/**
 * This process's own process group, read the way `ownProcessGroup()` does in
 * `src/infra/process-runner.ts` — Node exposes `process.pid` and `process.ppid` but no
 * `getpgid`, so `ps` is the only way to ask.
 */
function ownProcessGroup() {
  try {
    return Number(
      execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim(),
    );
  } catch {
    return null;
  }
}

/**
 * Terminate the process GROUPS the survivors belong to.
 *
 * ⚠️ **DETECTING A LEAK AND LEAVING IT RUNNING IS NOT A CHECK, IT IS A LEAK.** Raised twice by
 * the Codex review of this branch — once for the cancelled-run check and once for the
 * normal-exit step, which is the same defect in the sibling step: the job is non-blocking and
 * every later step is `always()`, so a reported survivor would simply continue running while
 * the job finished around it, and the next check would even record it in its own baseline.
 *
 * ⚠️ **THE GROUP, NOT THE PID.** A browser is a tree — renderers, a zygote, a crashpad
 * handler — and `src/infra/process-runner.ts` reaps one with `kill(-pgid, ...)` for that
 * reason. Reaping the pid alone leaves the tree.
 *
 * ⚠️ **THE SAME REFUSALS `assertSignallableProcessGroup` MAKES**
 * (`src/infra/process-runner.ts:364-376`): a pgid must be an integer greater than 1, because
 * `-1` signals every process on the machine and `0` the caller's own group; and never our own
 * group, which would kill this process mid-reap.
 *
 * ⚠️ **A DRY RUN WHENEVER THE LISTING CAME FROM `--ps-file`.** Those rows carry INVENTED pids,
 * and on a real machine an invented pgid may belong to somebody else's live process group.
 * A test fixture must not be able to signal anything, so it does not.
 *
 * Ordered AFTER the report and the survivors file, so reaping can never erase the finding, and
 * it does NOT change the exit code: a leak that had to be reaped is still a leak.
 */
function reapSurvivors() {
  const dryRun = psFile !== undefined;
  const own = ownProcessGroup();
  const groups = [...new Set(survivors.map((row) => row.pgid))];
  const lines = [`  REAPING ${groups.length} process group(s)${dryRun ? ' (dry run: the listing is a fixture, nothing is signalled)' : ''}`];

  const signallable = [];
  for (const pgid of groups) {
    if (!Number.isInteger(pgid) || pgid <= 1) {
      lines.push(`    refusing to signal process group ${pgid}: must be an integer greater than 1`);
      continue;
    }
    if (own !== null && pgid === own) {
      lines.push(`    refusing to signal process group ${pgid}: it is this process's own group`);
      continue;
    }
    lines.push(`    would signal process group ${pgid}`);
    signallable.push(pgid);
  }

  if (!dryRun) {
    for (const pgid of signallable) {
      try {
        process.kill(-pgid, 'SIGTERM');
      } catch {
        lines.push(`    process group ${pgid} was already gone at SIGTERM`);
      }
    }
    // The same SIGTERM -> grace -> SIGKILL shape as `terminateProcessGroup`.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TEARDOWN_GRACE_MS);
    for (const pgid of signallable) {
      try {
        process.kill(-pgid, 0);
        process.kill(-pgid, 'SIGKILL');
        lines.push(`    process group ${pgid} survived SIGTERM; sent SIGKILL`);
      } catch {
        lines.push(`    process group ${pgid} exited on SIGTERM`);
      }
    }
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

if (reap && survivors.length > 0) {
  reapSurvivors();
}

if (survivors.length > 0) {
  process.stderr.write(
    `\nERROR: ${survivors.length} browser process(es) outlived the run\n` +
      'HINT: a leaked browser tree lives until reboot and this runner is shared. Check the ' +
      "process group ids above against the run manifest's recorded groups, and reap them " +
      "with `kill -TERM -<pgid>` before assuming the next job's environment is clean.\n",
  );
  process.exit(1);
}
