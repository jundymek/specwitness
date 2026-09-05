#!/usr/bin/env node
/**
 * Reports SKIPPED test suites by name and count (story 6.1, the skipped-suite rider).
 *
 * ⚠️ **WHY THIS EXISTS.** Five merged integration suites sit behind `describeWithBrowser`
 * in `tests/integration/surfaces/helpers/browser-fixture.ts`, which calls `describe.skip`
 * when no usable Playwright environment is present. `@playwright/test` is an optional peer
 * and nothing downloads a browser in CI, so on a fresh runner those suites self-skip and
 * the job still goes green. That is *green for nothing* (Epic 4 retro §2 observation 2) one
 * level up from a criterion: a passing required check whose passing means five suites did
 * not run.
 *
 * The fix for the browser itself is story 6.9's, in wave 2. THIS script's job is
 * VISIBILITY — so that whoever reads a green CI run can see, without opening a scrollback,
 * exactly which suites did not run and how many tests that was.
 *
 * It reads vitest's own JSON report rather than hooking vitest's reporter API on purpose:
 * the JSON report is a stable, documented artifact, and a reporter plugin would put this
 * story's code inside every developer's test run — including the auto-review's concurrent
 * one — for a benefit that only exists in CI.
 *
 * ## What it does
 *
 *   1. Prints every skipped suite, grouped by file, with the number of skipped tests.
 *   2. Appends the same table to `$GITHUB_STEP_SUMMARY` when running in Actions, so the
 *      information is on the job's summary page and not only in a log nobody opens.
 *   3. **Exits non-zero when a skipped suite is not one of the KNOWN, DOCUMENTED sources
 *      below.** A skip count that changes unexpectedly must be visible, and the only way to
 *      make "unexpected" mean anything is to enumerate what is expected. A wave-2 story
 *      that legitimately adds a skip adds its pattern here, in a diff a reviewer reads —
 *      which is the whole point.
 *   4. Exits non-zero when the report is missing or unparseable. A reporting step that
 *      silently does nothing is the same failure it exists to prevent.
 *
 * Usage: `node scripts/report-skipped-suites.mjs <vitest-json-report>`
 */

import { readFileSync, appendFileSync } from 'node:fs';
import { relative } from 'node:path';

/**
 * The skip sources this repository knows about.
 *
 * Adding an entry is how a new skip becomes legitimate, and it is deliberately a code
 * change rather than a configuration one: the reviewer of the PR that introduces a skipped
 * suite is the person best placed to ask whether it should be skipped at all.
 */
const KNOWN_SKIP_SOURCES = [
  {
    id: 'browser-gated',
    // The exact string `describeWithBrowser` puts in the suite title
    // (`tests/integration/surfaces/helpers/browser-fixture.ts`). Owned by story 6.9.
    match: /\[SKIPPED: no usable Playwright environment on this machine\]/,
    note:
      'browser surface suite — `@playwright/test` is an optional peer and no browser is ' +
      'downloaded on this runner. Story 6.9 owns making these run in CI.',
  },
  {
    id: 'real-cli-opt-in',
    // `describe.skipIf(process.env.SPECWITNESS_REAL_CLI …)` in
    // `tests/integration/providers/{claude-code-cli,codex-cli}.test.ts`.
    match: /real (claude|Codex) CLI/i,
    note:
      'opt-in real provider CLI suite — runs only with SPECWITNESS_REAL_CLI set. Real ' +
      'provider invocations are the owner dogfooding step (Epic 7), never CI.',
  },
];

const reportPath = process.argv[2];
if (reportPath === undefined) {
  process.stderr.write('usage: node scripts/report-skipped-suites.mjs <vitest-json-report>\n');
  process.exit(64);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (cause) {
  process.stderr.write(
    `ERROR: could not read the vitest JSON report at ${reportPath}: ${cause.message}\n` +
      'HINT: run the suite with `--reporter=json --outputFile=<path>` before this script.\n',
  );
  process.exit(1);
}

/**
 * ⚠️ THE REPORT ITSELF IS VALIDATED BEFORE IT IS BELIEVED.
 *
 * A `?? []` fallback here would be this script's own green-for-nothing: an object with no
 * `testResults` — a reporter format change, a truncated write, a `{}` from a crashed run —
 * would report "every suite executed" and exit 0, which is precisely the reassuring silence
 * this step exists to break. So a report that is not a non-empty array of test files, or
 * that contains no test at all, is an ERROR rather than a clean bill of health.
 */
if (!Array.isArray(report?.testResults) || report.testResults.length === 0) {
  process.stderr.write(
    `ERROR: ${reportPath} is not a vitest JSON report with test results ` +
      `(testResults: ${JSON.stringify(report?.testResults)?.slice(0, 80) ?? 'absent'})\n` +
      'HINT: this step cannot tell "nothing was skipped" from "nothing was reported", and ' +
      'must not guess. Check that `pnpm test:ci` ran and wrote the report, and that the ' +
      "reporter's output shape has not changed.\n",
  );
  process.exit(1);
}

/** vitest writes jest-compatible statuses; a skipped test is `pending` or `skipped`. */
const isSkipped = (status) => status === 'pending' || status === 'skipped';

/** suite key -> { file, suite, count } */
const suites = new Map();
let skippedTests = 0;
let totalTests = 0;

for (const file of report.testResults) {
  // The inner `?? []` stays: a file that failed to COLLECT legitimately reports no
  // assertions, and that is a test failure the suite itself surfaces, not this step's
  // business. The outer guard above is the one that matters.
  for (const assertion of file.assertionResults ?? []) {
    totalTests += 1;
    if (!isSkipped(assertion.status)) {
      continue;
    }
    skippedTests += 1;
    // The OUTERMOST describe is the suite: `describeWithBrowser` titles the outermost one,
    // and that is the title carrying the reason.
    const suite = assertion.ancestorTitles?.[0] ?? assertion.title ?? '(no suite)';
    const relativeFile = relative(process.cwd(), file.name ?? '(unknown file)');
    const key = `${relativeFile} :: ${suite}`;
    const entry = suites.get(key) ?? { file: relativeFile, suite, count: 0 };
    entry.count += 1;
    suites.set(key, entry);
  }
}

if (totalTests === 0) {
  // Same argument one level down: a report listing files but no tests is a report of a run
  // that did not happen, and "0 of 0 skipped" is the most misleading true sentence
  // available.
  process.stderr.write(
    `ERROR: ${reportPath} lists ${report.testResults.length} file(s) but no tests at all\n` +
      'HINT: a run that executed nothing is not a run with no skips. Check that the suite ' +
      'actually ran before this step.\n',
  );
  process.exit(1);
}

const rows = [...suites.values()].sort(
  (a, b) => a.file.localeCompare(b.file) || a.suite.localeCompare(b.suite),
);

const classify = (suite) => KNOWN_SKIP_SOURCES.find((source) => source.match.test(suite));

const unrecognised = rows.filter((row) => classify(row.suite) === undefined);

/* ── stdout ──────────────────────────────────────────────────────────────────────────── */

/**
 * Both counts are printed, because they answer different questions and the difference has
 * bitten this repository already: `describeWithBrowser` gates FIVE FILES, and those five
 * files contain more than five `describe` blocks. "Five suites skip" and "four suites
 * skipped in one file" are both true and neither implies the other, so the report names
 * files and describe blocks separately rather than making a reader guess which it meant.
 */
const files = new Map();
for (const row of rows) {
  const entry = files.get(row.file) ?? { suites: 0, tests: 0 };
  entry.suites += 1;
  entry.tests += row.count;
  files.set(row.file, entry);
}

const lines = [];
lines.push('');
lines.push(
  `SKIPPED: ${files.size} file(s), ${rows.length} suite(s), ` +
    `${skippedTests} of ${totalTests} tests did not run`,
);
if (rows.length === 0) {
  lines.push('  none — every suite in this run executed.');
}
for (const [file, totals] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  lines.push(`  ${file} — ${totals.suites} suite(s), ${totals.tests} test(s)`);
  for (const row of rows.filter((candidate) => candidate.file === file)) {
    const source = classify(row.suite);
    lines.push(
      `    - [${source === undefined ? 'UNRECOGNISED' : source.id}] ${row.suite} (${row.count} tests)`,
    );
  }
  const note = classify(rows.find((row) => row.file === file)?.suite ?? '');
  if (note !== undefined) {
    lines.push(`      why: ${note.note}`);
  }
}
lines.push('');
process.stdout.write(lines.join('\n'));

/* ── GitHub job summary ──────────────────────────────────────────────────────────────── */

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath !== undefined && summaryPath !== '') {
  const markdown = [
    `## Skipped suites: ${rows.length} in ${files.size} file(s)`,
    '',
    `**${skippedTests} of ${totalTests} tests did not run on this runner.**`,
    '',
  ];

  if (rows.length === 0) {
    markdown.push('Every suite in this run executed.', '');
  } else {
    markdown.push('| suite | file | skipped tests | why |', '| --- | --- | --- | --- |');
    for (const row of rows) {
      const source = classify(row.suite);
      markdown.push(
        `| ${row.suite.replaceAll('|', '\\|')} | \`${row.file}\` | ${row.count} | ` +
          `${source === undefined ? '**UNRECOGNISED SKIP SOURCE**' : source.note} |`,
      );
    }
    markdown.push('');
    markdown.push(
      'A green check on a run with skipped suites means less than it looks like it means. ' +
        'Browser-gated suites are story 6.9 in wave 2 of Epic 6.',
      '',
    );
  }

  appendFileSync(summaryPath, markdown.join('\n'));
}

/* ── the guard ───────────────────────────────────────────────────────────────────────── */

if (unrecognised.length > 0) {
  process.stderr.write(
    '\nERROR: a suite was skipped for a reason this repository does not recognise:\n' +
      unrecognised.map((row) => `  - ${row.suite}  (${row.file})\n`).join('') +
      'HINT: a skip that nobody enumerated is how a suite stops proving anything without ' +
      'anybody noticing. Either remove the skip, or add its pattern to KNOWN_SKIP_SOURCES ' +
      'in scripts/report-skipped-suites.mjs so the next reader sees it named.\n',
  );
  process.exit(1);
}
