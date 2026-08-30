# ADR-004: Git worktree + process-group lifecycle for isolation (no containers in V0)

- **Status:** Accepted (brief §17 preference confirmed)
- **Date:** 2026-08-30

## Decision

`verify` resolves `--head` to a SHA and creates a **detached git worktree in the OS temp directory** — never inside the source repo's tree. The source repository is otherwise read-only (worktree add/remove are the only writes). Every spawned service/probe runs in its own process group; a run manifest records worktree paths and pgids before use; teardown kills groups and removes worktrees; `specwitness clean` reaps leftovers from crashed runs.

## Rationale

Stack-independent, dependency-free, fast, and preserves the supervisor workspace and implementation branches untouched (brief §16–17). Meets the "effectively read-only toward the implementation" requirement without requiring Docker on contributor machines.

## Recorded limitations

- No network/filesystem sandboxing: project services can still reach anything the user's machine can. Mitigated by policy (AD-3: only trusted config commands run; no production URLs by default), not by containment.
- Port collisions between the verification services and the developer's own running services are possible; config owns ports, doctor can pre-check.
- Shared global caches (npm/pnpm store, pyenv, etc.) mean "isolated" ≠ "hermetic". Acceptable for V0 dogfooding.

## Future

Container-based execution can be added as an alternative `EnvironmentProvider` adapter without domain changes; revisit if dogfooding shows environment bleed causing misclassification.
