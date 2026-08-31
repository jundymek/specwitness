#!/bin/sh
# A fake `codex` binary. Story 2.5 (codex-cli adapter) tests the adapter against
# this instead of the real Codex CLI: the suite must never spawn a real agent CLI,
# never touch `~/.codex/`, and never consume anyone's ChatGPT subscription.
#
# Installed by `tests/fixtures/bin/install-shim.ts` into a per-test temp directory
# under the name `codex`, with that directory placed first on the child's PATH.
#
# WHY IT IS CONFIGURED BY FILE AND NOT BY ENVIRONMENT
# ---------------------------------------------------
# The behaviour is read from `mode` next to this script, not from an environment
# variable, because the module under test *constructs the child environment* —
# that is the whole point of FR-15 withholding. A shim keyed on an env var would
# stop working precisely in the tests that build an environment with
# `inherit: false`, and would couple the fixture to the thing it is meant to
# observe. Reading a sibling file keeps the shim's behaviour independent of the
# environment it is asked to record.
#
# Everything it observes is likewise written next to itself, so a test reads the
# recording without needing to have passed a path in.
#
# RECORDING FORMAT
#   record.argv    every argument, NUL-separated (a prompt may contain newlines,
#                  so line-separation would corrupt the very argv we assert on)
#   record.cwd     the working directory the process actually started in
#   record.env     the full child environment, NUL-separated `NAME=VALUE`
#                  (full values, not just names: proving a withheld variable is
#                  absent means proving its VALUE never arrived)
#   record.schema  a copy of the file passed to `--output-schema`, when any
#   record.count   number of invocations, so "probed once per session" is testable

set -u

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mode=capable
[ -f "$here/mode" ] && mode=$(cat "$here/mode")

# --- record what we were asked to do -----------------------------------------
: >"$here/record.argv"
for arg in "$@"; do
  printf '%s\0' "$arg" >>"$here/record.argv"
done

pwd >"$here/record.cwd"

: >"$here/record.env"
# `env -0` is not portable to every /usr/bin/env, so NUL-terminate each line
# ourselves. `while read` would mangle backslashes; `printf %s` does not.
env | while IFS= read -r line; do
  printf '%s\0' "$line" >>"$here/record.env"
done

count=0
[ -f "$here/record.count" ] && count=$(cat "$here/record.count")
echo $((count + 1)) >"$here/record.count"

# --- pull the flags we care about out of argv --------------------------------
subcommand=${1:-}
last_message_file=
schema_file=
cd_dir=
saw_skip_git_repo_check=0
saw_help=0

while [ $# -gt 0 ]; do
  case "$1" in
    -o | --output-last-message)
      last_message_file=${2:-}
      shift
      ;;
    --output-schema)
      schema_file=${2:-}
      shift
      ;;
    -C | --cd)
      cd_dir=${2:-}
      shift
      ;;
    --skip-git-repo-check)
      saw_skip_git_repo_check=1
      ;;
    -h | --help)
      saw_help=1
      ;;
  esac
  shift
done

[ -n "$schema_file" ] && [ -f "$schema_file" ] && cp "$schema_file" "$here/record.schema"

# --- behaviours ---------------------------------------------------------------
# Each mode models ONE failure the adapter must classify correctly. They are
# deliberately separate: a single "unhappy" shim would let a test pass while the
# adapter conflated "missing binary" with "binary said no".

# `absent` has no case here on purpose — that mode is produced by NOT installing
# the shim at all, which is the only faithful way to get a real ENOENT from the
# operating system rather than a simulation of one.

case "$mode" in
  hanging)
    # Never answers. Exercises the per-call timeout: the adapter must surface
    # `timed-out` rather than hang the suite.
    #
    # `exec` REPLACES this shell with `sleep`, deliberately, and the distinction
    # is not cosmetic. Written as `while true; do sleep 3600; done`, the shell
    # forks a `sleep` GRANDCHILD that inherits the inherited stdout/stderr pipes.
    # Killing the shell on timeout then leaves the grandchild holding those pipes
    # open, and execa waits for them to close — so the run never settles and the
    # timeout silently fails to fire. Measured: that shape hangs past 90s against
    # a 750ms timeout. With `exec` there is exactly ONE process, killing it
    # closes the pipes, and the timeout works.
    exec sleep 3600
    ;;

  version-fails)
    # On PATH, but `--version` errors: "found something called codex that we
    # cannot identify". Must NOT be reported as a usable provider.
    if [ "$subcommand" = "--version" ]; then
      echo "codex: unrecognized option '--version'" >&2
      exit 2
    fi
    ;;

  not-codex)
    # The nastiest case: a DIFFERENT program named `codex` earlier on PATH.
    # It exits 0 and prints plausible text, so a probe that merely checks the
    # exit code will wrongly conclude the real Codex CLI is installed.
    echo "codex 1.0 - unrelated tool"
    exit 0
    ;;
esac

case "$subcommand" in
  --version)
    # Matches addendum section B, re-verified on this machine 2026-08-31.
    echo "codex-cli 0.144.4"
    exit 0
    ;;

  doctor)
    # The Q58 auth-readiness probe: the CLI's own public surface. NEVER
    # filesystem inspection of `~/.codex/`.
    case "$mode" in
      auth-missing)
        echo "Not signed in. Run 'codex login'." >&2
        exit 1
        ;;
      no-doctor-subcommand)
        echo "error: unrecognized subcommand 'doctor'" >&2
        exit 2
        ;;
      *)
        echo "Authentication: OK"
        exit 0
        ;;
    esac
    ;;

  exec)
    # `exec --help` is how the adapter probes for flags: it lists the real CLI's
    # options WITHOUT invoking a model, so probing costs nothing and consumes no
    # subscription. Answered before the failure modes below, because help is
    # answered even by a codex whose `exec` would reject the flags we need.
    if [ "$saw_help" = 1 ]; then
      case "$mode" in
        version-only)
          echo "error: unrecognized subcommand 'exec'" >&2
          exit 2
          ;;
        exec-rejecting)
          # An older codex: `exec` exists and lists flags, but not the one we need.
          echo "Usage: codex exec [OPTIONS] [PROMPT]"
          echo "  -C, --cd <DIR>"
          echo "  -o, --output-last-message <FILE>"
          exit 0
          ;;
        *)
          # Mirrors `codex exec --help` on codex-cli 0.144.4, verified 2026-08-31.
          echo "Usage: codex exec [OPTIONS] [PROMPT]"
          echo "  -s, --sandbox <SANDBOX_MODE>"
          echo "  -C, --cd <DIR>"
          echo "      --skip-git-repo-check"
          echo "      --output-schema <FILE>"
          echo "      --json"
          echo "  -o, --output-last-message <FILE>"
          exit 0
          ;;
      esac
    fi

    case "$mode" in
      exec-rejecting)
        # An older codex whose `exec` does not accept `--output-schema`. The
        # adapter must produce a capability error, never a hopeful invocation.
        echo "error: unexpected argument '--output-schema' found" >&2
        exit 2
        ;;
      version-only)
        echo "error: unrecognized subcommand 'exec'" >&2
        exit 2
        ;;
      last-message-missing)
        # Ran, said it succeeded, wrote no answer file. The adapter must report a
        # provider failure NAMING the missing file — never a TypeError and never
        # a silent empty success.
        echo "thinking..." >&2
        exit 0
        ;;
      nonzero-exit)
        echo "stream error: connection reset" >&2
        exit 1
        ;;
    esac

    # Progress on stdout and stderr, exactly as the real CLI does. This is why
    # the adapter reads the last-message FILE rather than scraping stdout, and
    # why non-empty stderr must not be treated as failure.
    echo "codex: working..."
    echo "codex: 1 file read" >&2

    if [ -n "$last_message_file" ]; then
      # The answer comes from a sibling file for the same reason `mode` does:
      # the adapter builds the child environment, so a fixture that read its
      # payload from the environment would break in exactly the withholding
      # tests. A test writes `answer` when it cares what comes back.
      if [ -f "$here/answer" ]; then
        cp "$here/answer" "$last_message_file"
      else
        printf '%s' '{"criteria":[]}' >"$last_message_file"
      fi
    fi
    exit 0
    ;;
esac

echo "codex: unrecognized invocation" >&2
exit 64
