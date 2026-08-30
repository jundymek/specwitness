# ADR-002: Exit codes 0/1/2/3 kept; usage errors moved to 64

- **Status:** Accepted with documented concern (brief §38 asked for review)
- **Date:** 2026-08-30

## Decision

`verify` exits: **0** PASS · **1** FAIL · **2** NEEDS_HUMAN · **3** infrastructure/SpecWitness error (includes contract-integrity, config, and provider errors). CLI usage errors (bad arguments, unknown flags) exit **64** (BSD `EX_USAGE`; also the pattern already used in the first client's `codex-auto-review.sh`). The exit table lives in exactly one module (`cli/exit.ts`).

## Concern with the brief's scheme

Exit code 2 conventionally means "incorrect usage / misuse of shell builtins" in much of the Unix ecosystem, and commander/argparse-style parsers and the first client's own scripts use 2 for argument errors. If SpecWitness also used 2 for usage errors, an automation could mistake "typo in flag" for "NEEDS_HUMAN".

## Resolution

Keep the founder's 0/1/2/3 semantics (they are good, dense, and automation-friendly) and eliminate the ambiguity by moving usage errors to 64 and guaranteeing argument parsing failures can never return 0–3. Automations should treat: 0 merge-eligible · 1 defects found · 2 human review required · 3 rerun/fix environment · 64 fix the invocation. `--json` output additionally carries the outcome, so exit codes are a convenience, not the sole contract.

## Alternative considered

Distinct high-range codes for everything (e.g. 70+ sysexits). Rejected: loses the brief's simple 0–3 contract that the harness will script against.
