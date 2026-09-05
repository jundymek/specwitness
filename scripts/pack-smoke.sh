#!/usr/bin/env bash
#
# Packed-tarball smoke test (AC3).
#
# Building and testing in the repo proves the source works. It does not prove
# the *published package* works: `files`, the `bin` mapping, the shebang and
# the executable bit only matter once the tarball is installed somewhere else.
# Epic 1's exit criterion is "npx specwitness --help works from a packed
# tarball", so that is what this checks — as a real consumer, with npm, in a
# throwaway directory outside the repo.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

cd "$REPO_ROOT"
echo "==> building"
pnpm build

echo "==> packing"
pnpm pack --pack-destination "$WORKDIR" >/dev/null
TARBALL="$(find "$WORKDIR" -maxdepth 1 -name 'specwitness-*.tgz' -print -quit)"
if [ -z "$TARBALL" ]; then
  echo "ERROR: pnpm pack produced no tarball" >&2
  exit 1
fi
echo "    $(basename "$TARBALL")"

echo "==> installing the tarball as a consumer would"
CONSUMER="$WORKDIR/consumer"
mkdir -p "$CONSUMER"
cd "$CONSUMER"
npm init -y >/dev/null 2>&1
# Output is kept on failure only: the install resolves this package's four
# runtime dependencies from the registry, so a network-restricted environment
# fails here, and swallowing npm's message would make that undiagnosable.
if ! install_log="$(npm install --no-audit --no-fund "$TARBALL" 2>&1)"; then
  echo "ERROR: installing the packed tarball failed" >&2
  echo "$install_log" >&2
  echo "HINT: this step needs registry access to resolve runtime dependencies" >&2
  exit 1
fi

CLI="$CONSUMER/node_modules/.bin/specwitness"
if [ ! -x "$CLI" ]; then
  echo "ERROR: bin entry missing or not executable at $CLI" >&2
  exit 1
fi

echo "==> specwitness --help must exit 0"
set +e
"$CLI" --help >/dev/null
help_rc=$?
set -e
if [ "$help_rc" -ne 0 ]; then
  echo "ERROR: 'specwitness --help' exited $help_rc from the packed install, expected 0" >&2
  exit 1
fi

echo "==> exit codes 64 and 3 must survive packaging"
# The 3 case used to rely on `init` being an unimplemented stub. Story 1.4
# implemented it, so this now asserts something better and permanent: the
# consumer directory is not a Git repository, so `init` raises a real AD-7
# InfraError, and the check proves that error still maps to 3 through a packed
# install. Keep the invocation in $CONSUMER (a mktemp dir) — anywhere inside a
# repository it would scaffold for real and exit 0.
set +e
"$CLI" definitely-not-a-command >/dev/null 2>&1
usage_rc=$?
"$CLI" init >/dev/null 2>&1
infra_rc=$?
set -e
if [ "$usage_rc" -ne 64 ]; then
  echo "ERROR: unknown command exited $usage_rc, expected 64" >&2
  exit 1
fi
if [ "$infra_rc" -ne 3 ]; then
  echo "ERROR: init outside a Git repository exited $infra_rc, expected 3" >&2
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# WHAT THE TARBALL CONTAINS (story 6.7, AC2).
#
# ⚠️ THIS IS AN ALLOW-LIST, AND THAT REPLACED A DENY-LIST DELIBERATELY. Until story 6.7
# this step grepped for `^package/(src|tests)/` — which passes any tree nobody thought to
# name. `fixtures/` is exactly such a tree: it arrived in Epic 6, it carries fixture apps,
# configs and (in the non-Node fixture) a second language's source, and the old deny-list
# would have shipped every byte of it without a murmur. A packaging guard is only worth
# what its DEFAULT is, so the default here is "refuse".
#
# The allow-list is `dist/` + `templates/` (the `files` field) plus the files npm includes
# whatever `files` says: `package.json` always, and `README.md` / `LICENSE` / `LICENCE` /
# `CHANGELOG.md` when they exist at the root. Those four are npm's rule, not ours — see
# https://docs.npmjs.com/cli/configuring-npm/package-json#files — so listing them here is
# describing npm's behaviour, not widening our surface.
#
# ⚠️ IT ASSERTS THE LISTED TARBALL, NOT THE `files` FIELD. The two disagree in ways only
# packing reveals (`.npmignore`, npm's always-include rules, a `files` entry that matches
# nothing). Reading `package.json` would prove what we asked for; this proves what we got.
echo "==> the tarball must contain the built CLI and templates ONLY"

# ⚠️ THE LISTING IS READ ONCE, INTO A VARIABLE, AND EVERY CHECK BELOW GREPS THE VARIABLE.
# This is not tidiness — it is a LINUX BUG FIX, and CI on ubuntu-latest is what found it
# while macOS stayed green (run 33967685767).
#
# The checks below used to be `tar -tzf "$TARBALL" | grep -q …`. `grep -q` exits the
# instant it matches, which closes the pipe; GNU tar then fails writing to it, prints
# `tar: stdout: write error`, and `set -o pipefail` (line 11) makes the whole pipeline
# non-zero — so a check REPORTED FAILURE ON A MATCH. The Linux job failed with
# `ERROR: the tarball is missing dist/cli.js` while printing `package/dist/cli.js` two
# lines below it. BSD tar on macOS exits quietly on SIGPIPE, so the same code passed
# locally and in the macOS job: a guard that was wrong on one platform only.
#
# Reading once removes the early-exit pipe entirely, and incidentally replaces eight
# invocations of tar with one.
tarball_listing="$(tar -tzf "$TARBALL")"

# Top-level entry of every path, deduped: `package/dist/cli.js` -> `dist`.
actual_entries="$(printf '%s\n' "$tarball_listing" | sed 's|^package/||' | cut -d/ -f1 | sort -u | grep -v '^$')"

# `templates` and `dist` are the `files` field; the rest are npm's always-include set.
allowed_entries='CHANGELOG.md
LICENCE
LICENSE
README.md
dist
package.json
templates'

unexpected="$(comm -23 <(echo "$actual_entries") <(echo "$allowed_entries" | sort))"
if [ -n "$unexpected" ]; then
  echo "ERROR: the tarball ships entries that are not the built CLI or templates:" >&2
  echo "$unexpected" | sed 's/^/         /' >&2
  echo "" >&2
  echo "       full tarball listing:" >&2
  printf '%s\n' "$tarball_listing" | sed 's/^/         /' >&2
  echo "HINT: check the 'files' field in package.json. fixtures/, tests/, docs/ and src/" >&2
  echo "      must never ship — fixtures/corpus/ in particular carries fixture apps and" >&2
  echo "      a second language's source." >&2
  exit 1
fi

# Named explicitly ON TOP of the allow-list above, which already rejects them. The
# allow-list is the guard; these four lines are the ERROR MESSAGE. A future edit that
# widens the allow-list by accident still trips here, and the reader is told which
# forbidden tree appeared rather than being handed a diff of directory names.
for forbidden in src tests fixtures docs; do
  if printf '%s\n' "$tarball_listing" | grep -Eq "^package/${forbidden}/"; then
    echo "ERROR: tarball contains ${forbidden}/ — it must never ship" >&2
    printf '%s\n' "$tarball_listing" | grep -E "^package/${forbidden}/" | sed 's/^/         /' >&2
    exit 1
  fi
done

# The two files the `bin` mapping and the config scaffold actually need. Asserting only
# what must be ABSENT would pass an empty tarball — Epic 4 retro §2 observation 7: two
# assertions that both ran against empty output and both passed.
for required in dist/cli.js templates/config.yaml; do
  if ! printf '%s\n' "$tarball_listing" | grep -Fqx "package/${required}"; then
    echo "ERROR: the tarball is missing ${required}" >&2
    printf '%s\n' "$tarball_listing" | sed 's/^/         /' >&2
    exit 1
  fi
done

# ⚠️ THE SOURCE DOES SHIP — INSIDE THE SOURCEMAP — AND THAT IS PINNED RATHER THAN HIDDEN.
# `dist/cli.js.map` carries `sourcesContent` for all ~120 modules, so "no source ships" is
# FALSE about this package even though no `src/` PATH appears above. Story 6.7 left the
# sourcemap in place deliberately (a stack trace from a user's exit-3 report is worth more
# than 2.3MB, and the repository is public and MIT, so nothing is disclosed that a reader
# cannot already fetch) — see DECISIONS.md D3. This check exists so that the day someone
# decides otherwise, they change a stated expectation instead of discovering a surprise.
if printf '%s\n' "$tarball_listing" | grep -Fqx 'package/dist/cli.js.map'; then
  echo "    note: dist/cli.js.map ships and embeds the TypeScript source (DECISIONS.md D3)"
fi

echo "==> npm publish --dry-run must be clean"
# Back to the repository: everything since the install has run inside $CONSUMER, and
# `npm publish` reads the manifest of the CURRENT directory. Running it from the consumer
# would dry-run the throwaway `npm init -y` package and report a clean result about
# nothing at all.
cd "$REPO_ROOT"
# --dry-run PUBLISHES NOTHING. It runs every pre-publish check and prints the manifest it
# WOULD send. Publishing is Epic 7 and the owner's decision (story 6.7 is explicitly
# forbidden from it), so this is the strongest packaging assertion available here.
if ! publish_log="$(npm publish --dry-run 2>&1)"; then
  echo "ERROR: npm publish --dry-run failed" >&2
  echo "$publish_log" >&2
  exit 1
fi
# ⚠️ REPORTING ONLY — ITS EXIT STATUS MUST NOT BE THE CHECK'S VERDICT, hence `|| true`.
# The pass condition is the `if !` above: `npm publish --dry-run` succeeded. These three
# lines are a convenience for whoever reads the CI log.
#
# Without `|| true` this is a latent failure with a trigger nobody would connect to it: an
# npm configured with `loglevel=warn`, `error` or `silent` prints no `npm notice` lines at
# all, so `grep` matches nothing and exits 1, and `set -euo pipefail` (line 11) turns a
# SUCCESSFUL dry run into a failed packaging check.
#
# This is the THIRD time on this branch that a pipeline meant only to PRINT had its exit
# status treated as a verdict — after `grep -q` closing the pipe under GNU tar, and the
# same shape in the guard that found it. Worth naming, because the pattern is the defect,
# not any one instance of it.
echo "$publish_log" | grep -E 'npm notice (total files|package size|unpacked size):' | sed 's/^npm notice/   /' || true

echo "OK: packed tarball installs and behaves (help 0, usage 64, infra 3); contents are dist+templates only"
