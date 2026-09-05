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
 * Exit codes follow the house taxonomy: 0 clean, 1 survivors FOUND, 3 the scan could not look
 * (infra), 64 usage. 1 and 3 are deliberately different — see the exit(3) below.
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
];

/**
 * The ROOT of the browser tree, kept separate from the browsers themselves.
 *
 * `src/surfaces/browser.ts:1250-1251` spawns `process.execPath` with
 * `[cliPath, 'test', '--config', configPath]`, detached — so a leaked Playwright runner is a
 * leaked browser tree that has merely closed its browser already, and it is the process that
 * would open another one. It counts as a survivor.
 *
 * ⚠️ BUT IT IS NOT A BROWSER, AND `--browsers-only` EXISTS BECAUSE OF THAT. The runner starts
 * BEFORE chromium, so a caller waiting for "a browser to appear" that accepts this process can
 * act before any browser exists. That is what made `browser-cancelled-run-check.sh`'s vacuity
 * guard vacuous — reported as a P1 on this branch.
 */
const PLAYWRIGHT_RUNNER_PATTERN = /@playwright[/\\]test[/\\]cli\.js/;

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
      '[--write-survivors <path>] [--reap] [--browsers-only] [--owned-pgid <n>]... ' +
      '[--wait-seconds <n>] [--label <text>]\n',
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
let browsersOnly = false;
let exclusiveMachine = false;
const ownedPgids = [];
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
    // Narrows the match to real browsers, excluding the Playwright runner. Used by the
    // launch predicate in browser-cancelled-run-check.sh; see PLAYWRIGHT_RUNNER_PATTERN.
    case '--browsers-only':
      browsersOnly = true;
      break;
    // ⚠️ THE ONE CONDITION UNDER WHICH A BASELINE DIFF IS OWNERSHIP. See ownedGroups below.
    case '--exclusive-machine':
      exclusiveMachine = true;
      break;
    // The tighter ownership bound, for a caller that KNOWS which groups it spawned.
    //
    // ⚠️ VALIDATED, because an unvalidated value flag swallows the next FLAG. A caller emitted
    // `--owned-pgid` with an empty value, this parser took the following `--label` as its
    // value, and the step died with a usage error naming the label text — a caller bug wearing
    // this script's face (CI run 33913171525, exit 64). "The caller should not do that" is not
    // a parser.
    case '--owned-pgid': {
      if (value === undefined) usage(`ERROR: ${flag} needs a value`);
      const pgid = Number(value);
      if (value.startsWith('-') || !Number.isInteger(pgid) || pgid <= 1) {
        usage(`ERROR: ${flag} needs a process group id greater than 1, got '${value}'`);
      }
      ownedPgids.push(pgid);
      index += 1;
      break;
    }
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

if (exclusiveMachine && baselineFile === undefined) {
  usage(
    'ERROR: --exclusive-machine needs --baseline: without one nothing is subtracted, so every ' +
      'matching process would look new and be treated as this run\'s',
  );
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
  return execFileSync('ps', ['-eo', 'pid,ppid,pgid,etime,lstart,args'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * ⚠️ IDENTITY IS PID **PLUS THE ABSOLUTE START INSTANT**, COMPARED EXACTLY.
 *
 * A pid alone is not an identity: if a baseline browser exits and the OS hands its pid to a
 * browser THIS job launches, matching on pid subtracts a genuine survivor and the scan reports
 * clean while a leak runs on.
 *
 * The first fix for that derived a start time from `etime` (`sampledAt - elapsed`). Both inputs
 * have one-second resolution and the two scans happen at different moments, so the derived value
 * needed a ±3s tolerance — **and a pid reused inside those three seconds fell straight back into
 * the hole.** Reported as a P2 on this branch, against the very fix meant to close it.
 *
 * `lstart` is an ABSOLUTE instant reported by `ps`, identical on every scan of the same process.
 * So identity is exact equality and needs no tolerance at all. A derived value needed a band; a
 * measured one does not.
 *
 * **Twice this instrument was able to report in its own favour** — first counting already-dead
 * processes as orphans, then subtracting a reused pid — and both times the fault was in how it
 * INFERS identity rather than in what it does with it. That is why this is now keyed on something
 * `ps` measures rather than something this script computes.
 *
 * The residual, stated: `lstart` itself has one-second resolution, so a pid reused within the
 * SAME SECOND would still collide. That is the limit of what `ps` offers, and it is a far smaller
 * window than the three seconds it replaces.
 */

/** One process row. `args` keeps its internal spacing, because it is quoted as evidence. */
function parse(listing) {
  const rows = [];
  for (const line of listing.split('\n')) {
    const text = line.trim();
    if (text === '') {
      continue;
    }
    // `lstart` is `Www Mmm dd HH:MM:SS YYYY` on both macOS and Linux, and it contains spaces —
    // hence the explicit shape rather than a field count.
    const match =
      /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(
        text,
      );
    if (match === null) {
      // The header, or anything else that is not a process row.
      continue;
    }
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      elapsed: match[4],
      // The ABSOLUTE instant this process started, as `ps` reports it. See IDENTITY below.
      // Spaces collapsed so it survives a whitespace-separated baseline file.
      startedAt: match[5].replace(/\s+/g, '_'),
      args: match[6],
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

/**
 * ⚠️ OWNERSHIP, WHICH IS A DIFFERENT AND MUCH STRONGER CLAIM THAN "LOOKS LIKE A BROWSER".
 *
 * A process running a binary out of the browsers registry THIS job was given is this job's.
 * Everything the broad patterns catch — the operator's Chrome, an Electron app — is suspicious
 * enough to REPORT and never sufficient to SIGNAL. See `reapSurvivors`.
 */
/**
 * DETECTION: does this look like it came from a browsers registry we were told about?
 *
 * Substring is right here and deliberately stays. Detection is broad on purpose — a browser
 * helper that outlives its parent is the thing being hunted, and over-reporting costs nothing.
 */
function matchesRegistry(row) {
  return browsersPaths.some((path) => path !== '' && row.args.includes(path));
}



function isBrowser(row) {
  if (isSelf(row)) {
    return false;
  }
  if (matchesRegistry(row)) {
    return true;
  }
  if (BROWSER_PATTERNS.some((pattern) => pattern.test(row.args))) {
    return true;
  }
  // The Playwright runner counts as a survivor, but never as evidence that a BROWSER is up.
  return !browsersOnly && PLAYWRIGHT_RUNNER_PATTERN.test(row.args);
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
    return [];
  }
  return readFileSync(baselineFile, 'utf8')
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts[0] !== undefined && parts[0] !== '')
    .map((parts) => ({ pid: Number(parts[0]), startedAt: parts[1] ?? '' }))
    .filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0);
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
  // Exact equality on pid AND the absolute start instant. A baseline entry whose start could not
  // be read (`unknown`, or an older pid-only file) matches NOTHING: identity we cannot establish
  // must not subtract a process, because over-reporting is the safe direction for a leak check.
  const notInBaseline = (row) =>
    !baseline.some(
      (entry) =>
        entry.pid === row.pid && entry.startedAt !== '' && entry.startedAt === row.startedAt,
    );

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
  // ⚠️ THREE, NOT ONE. "I looked and found survivors" is a FINDING; "I could not look" is
  // INFRA, and the product's own taxonomy (ADR-002 / AD-6) keeps those apart for exactly the
  // reason they must be kept apart here: a caller that cannot tell them apart reads a broken
  // `ps` as a positive detection. That is precisely how the launch predicate in
  // browser-cancelled-run-check.sh could fire without a browser. Reported as a P1 on this
  // branch, alongside the Playwright-runner half of the same defect.
  process.exit(3);
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
  // pid AND start instant — see IDENTITY above.
  writeFileSync(
    writeBaselineFile,
    `${survivors.map((row) => `${row.pid} ${row.startedAt}`).join('\n')}\n`,
    'utf8',
  );
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
    : `  baseline: ${baseline.length} process(es) already running before the run (${baselineFile})`,
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

  // ⚠️ FAIL CLOSED WHEN WE DO NOT KNOW OUR OWN GROUP. Raised as a P1 by the Codex review of
  // this branch. The own-group refusal was written as `own !== null && pgid === own`, which
  // meant a failed `ps` DISABLED the very check that stops `kill(-pgid, ...)` killing this
  // checker and every other process sharing its group. A safety guard that switches itself off
  // when it cannot answer is not a guard — and `assertSignallableProcessGroup`
  // (src/infra/process-runner.ts:364-376) refuses rather than guesses for the same reason.
  // Reporting the leak is not affected: the exit code below is unchanged.
  if (own === null) {
    process.stdout.write(
      `  REAPING REFUSED: the scanner cannot determine its own process group, so it will not\n` +
        `    signal any group. ${groups.length} group(s) left running and reported above.\n`,
    );
    return;
  }

  const lines = [`  REAPING ${groups.length} process group(s)${dryRun ? ' (dry run: the listing is a fixture, nothing is signalled)' : ''}`];

  // ⚠️ ONLY GROUPS THIS RUN OWNS. Raised as a P1 on this branch, and it is the destructive
  // failure mode of the whole script: the patterns match any Chrome or Electron process ON
  // PURPOSE, so run locally, a browser window the operator opened during the wait is absent from
  // the baseline and would have had its ENTIRE GROUP signalled. An early local run of the
  // cancelled-run check really did report a Vivaldi renderer that appeared during its wait; with
  // reaping armed, this script would have killed the author's browser.
  //
  // A group is owned when it contains at least one process running out of the browsers registry
  // this job was given — the whole group then goes, because a browser is a tree and its helpers
  // do not all name the registry themselves. `--owned-pgid` narrows it further for a caller that
  // knows exactly which groups it spawned.
  // ⚠️ OWNERSHIP FOR DESTRUCTION IS THE CALLER'S PGID LIST, AND NOTHING ELSE.
  //
  // Raised as a P1 on this branch and it goes deeper than the three prefix fixes before it: the
  // whole ownership model rested on SHARED PATHS. `~/.cache/ms-playwright` is the registry every
  // Playwright on the machine uses, and any Chrome may reference a file under the workspace - so
  // a concurrently running Playwright, or the operator's browser with a download from this
  // directory, satisfied "owned" and had its entire group signalled. Separator boundaries fixed
  // the spelling of those paths; they never made the paths run-specific, because they are not.
  //
  // Only a caller that SPAWNED a group can vouch for it. `--owned-pgid` is that statement, and it
  // is now the sole authority to signal. The path heuristics remain, but only for DETECTION -
  // which is the split this script has been converging on all along, applied to the last place
  // that had it wrong.
  // ⚠️ TWO WAYS TO OWN A GROUP, AND THE SECOND ONE NAMES ITS PRECONDITION.
  //
  // Two P1s on this branch pulled opposite ways. One: shared paths cannot authorise a kill,
  // because a neighbour's Playwright uses the same `~/.cache/ms-playwright` and may touch the
  // same workspace. The other: a detected survivor that is never reaped outlives the job,
  // "indefinitely if the workflow is moved to a persistent runner".
  //
  // They resolve by naming the precondition rather than pretending a path proves ownership. IF
  // THIS JOB OWNS THE WHOLE MACHINE AND THE MACHINE IS DISCARDED AFTERWARDS, then "appeared
  // after the baseline" IS run-specific: nothing else could have started it. True of a
  // GitHub-hosted runner, false of a laptop or a self-hosted one — so the caller must ASSERT it
  // (`--exclusive-machine`, which the workflow passes only when RUNNER_ENVIRONMENT is
  // github-hosted). Absent that assertion, only a caller-supplied pgid authorises a signal.
  const ownedGroups = new Set(
    exclusiveMachine ? survivors.map((row) => row.pgid) : ownedPgids,
  );
  if (exclusiveMachine) {
    lines.push(
      '    ownership: --exclusive-machine — every survivor appeared after the baseline on a ' +
        'machine this job owns exclusively',
    );
  }

  const signallable = [];
  for (const pgid of groups) {
    if (!Number.isInteger(pgid) || pgid <= 1) {
      lines.push(`    refusing to signal process group ${pgid}: must be an integer greater than 1`);
      continue;
    }
    if (pgid === own) {
      lines.push(`    refusing to signal process group ${pgid}: it is this process's own group`);
      continue;
    }
    // ⚠️ EITHER SIGNAL IS SUFFICIENT, AND COMPOSING THEM AS *AND* WAS A P1 ON THIS BRANCH.
    // The previous version required BOTH, so a caller that KNEW a group was its own still had
    // the registry heuristic veto it. The case that exposed it is the one the cancelled-run
    // check exists for: when chromium has exited but its detached `@playwright/test/cli.js`
    // runner has not, the runner is a survivor whose argv names no registry path — so registry
    // ownership is empty, reaping was refused, and the check left behind exactly the process it
    // was cleaning up. The caller knows more than the heuristic.
    if (!ownedGroups.has(pgid) && !ownedPgids.includes(pgid)) {
      lines.push(
        `    NOT reaped, reported only: process group ${pgid} was not claimed by the caller ` +
          '(--owned-pgid). A shared browsers registry or workspace path is not proof of ' +
          'ownership and no longer authorises a signal.',
      );
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
