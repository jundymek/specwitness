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

echo "==> the tarball must not ship sources or tests"
if tar -tzf "$TARBALL" | grep -Eq '^package/(src|tests)/'; then
  echo "ERROR: tarball contains src/ or tests/ — check the package.json files field" >&2
  tar -tzf "$TARBALL" | grep -E '^package/(src|tests)/' >&2
  exit 1
fi

echo "OK: packed tarball installs and behaves (help 0, usage 64, infra 3)"
