# superman — epic/7-dogfooding-repairs, wave 5 — reports

(Kept in the worktree: pre-tool-use.sh refuses Write to ~/.local/state/terminal-agents/specwitness/superman/ as "the installed harness".)

## 2026-09-10T15:30Z

### 7.4-redaction-extra-patterns-config-surface — PR #91 — ready

AC coverage:
  - AC1 covered — `redaction.extraPatterns` strict object in `src/config/schema.ts`; invalid or empty-matching pattern is a `ConfigError` (exit 3), refusal no longer echoes the pattern (`tests/unit/config/redaction.test.ts`)
  - AC2 covered — `verify` binds stages, timeline, dispatcher (all five surfaces), provisioning, authoring; `contract`/`plan` bound as standalone edges; these are the only three commands reaching a provider or surface (grep at head). Built-ins-only `playwright-env.ts:1240` is re-redacted with the options at `playwright-provisioning.ts:324`
  - AC3 covered — every assertion is `not.toContain(secret)`, each with a control
  - AC4 covered — `persistedAbsent` walks the whole run dir incl. `result.json`
  - AC5 covered — no new redaction function in the `src` diff
  - AC6 covered — reproduced myself: edge binding stripped → red, 11 evidence files + `result.json` + stdout + stderr named; restored byte-exact → green
  - AC7 covered — the promising comments now describe shipped behaviour
Tests: "Test Files  227 passed (227)" / "Tests  4212 passed | 3 skipped (4215)"; depcruise "no dependency violations found (154 modules, 699 dependencies cruised)"; CI 5/5 pass
Codex: clean (review began after 4231c89; 9949496 landed mid-run — read by hand, sound)
Security: addressed — pattern echo fixed; ReDoS reported, not mitigated
Manual-testing evidence: present in plan.md; spec has no task boxes
Per-story docs: Dev Agent Record filled
PR title: "feat(config): let a project declare its own redaction patterns" — valid

Verdict: ready — every AC verified in the tree, AC6 red reproduced independently.

Merged by superman at Stage 4: 2026-09-10T15:27:34Z, `e5ce0b3`, head verified unchanged at 2c9ae38 immediately before.

## 2026-09-10T15:40Z

### Wave 5 closure review — epic/7-dogfooding-repairs — wave complete, epic continues

Change delivered: one merge, `e5ce0b3` (#91), 51 files, +1949/−128.

Cross-story integration:
  - 7.4 × 7.8: `file.ts:1288-1291` takes `{...deps.redaction}`; my red run named `file-E1-03` evidence — wired.
  - 7.4 × 7.0: the provisioning refusal is re-redacted with the options (`playwright-provisioning.ts:324`), downstream of built-ins-only `playwright-env.ts:1240`.
  - Corpus format: optional `persistedAbsent`, `EXPECTED_VERSION` unchanged, so it is additive for every fixture.
  - `sprint-status.yaml`: alice set her row to `review`, and I measured it `review → done`. There were no other writers.
AC sweep: 7.4 AC1–AC7 are all covered (PR #91 block above). None is unverifiable by an agent.
Pending owner:
  - the merge click on the rows deliverable PR, which is NOT OPENED YET: `git push --force-with-lease` and the `git merge` alternative were both denied by the auto-mode classifier. `59e3ce0` is local only.
  - `epic-7:` row reads `backlog`.
  - Spec `Status:` lines disagree with their `done` rows: 7.4 says `review`, 7.8 says `review`, 7.5 says `ready-for-dev`.
  - Unowned, verified: `services.ts:689-690`, where the readiness `not-found` message and hint print `binary` unredacted (`gates.ts:381` redacts the same arm).
  - 7.4's other unpatched findings: `scorecard --note` redacts with the built-ins only; ReDoS from project-authored patterns is unguarded; the "four surfaces" comment above the 7.4 row is stale.
  - Carried from waves 3–4: `browser.ts:621`, `:2094`; the pre-PR gate accepts a missing `plan.md`; the two misleading comments.
  - Harness: `pre-tool-use.sh` refuses Write to the supervisor's project-scoped runtime dir. The brief's §3 paths are not project-scoped. §10 cites ADR-001..006, but there are 009.
  - Standing: npm publishing, the claude/codex subscriptions, and the dogfooding procedure (7.1–7.3 backlog).
Verdict: wave complete. This is not the closing run, so there is no retro and no integration PR.

## 2026-09-11T07:30Z — update after the owner's answers

- The owner chose force-with-lease. Pushed `dc0d5f4 → 59e3ce0`, then `84fca7f` as a plain fast-forward.
- The owner approved a follow-up spec. Written: `7.9-readiness-not-found-is-redacted.md` plus row `7-9-readiness-not-found-is-redacted: ready-for-dev`. `sprint-status.sh` reports no drift, exit 0.
- The codex auto-review of `84fca7f` said "No actionable defects were found". The harness classed it `auto_review_findings`; I read it and signed `clean`. Security is `clean` (docs-only diff).
- Deliverable PR opened: #92 (`supervisor/epic-7-dogfooding-repairs` → `epic/7-dogfooding-repairs`), https://github.com/jundymek/specwitness/pull/92. The owner merges it.

## 2026-09-11 — owner-requested fixes added to PR #92

At the owner's explicit request, `1d78097` was added to PR #92:
- `epic-7`: `backlog → in-progress`. Not `done`: 7.1–7.3 and 7.9 are still open.
- Spec `Status:` lines to `done` for 7.4 (was `review`), 7.5 (was `ready-for-dev`) and 7.8 (was `review`). No task boxes ticked, no Dev Agent Record touched.
- Comment above the 7.4 row: "the four surfaces" became five, with a DONE note in the 7.0 row's style.
- `sprint-status.sh` still reports no drift (exit 0).
- PR #92's body still says these three are "yours" or "not mine to edit". I did not edit the body, because the brief forbids editing any PR; the commit message states the change.
- Later, at the owner's explicit request ("popraw opis PR #92"), the body was replaced with `gh pr edit 92 --body-file`. It now describes all three commits, both codex reviews and the security sign-off, and no longer lists as open the items `1d78097` closed.

## 2026-09-11T07:53Z

PR #92 was merged by the owner at 2026-09-11T07:51:41Z as `42a6876`. On the epic, `epic-7: in-progress`, `7-4-…: done` and `7-9-readiness-not-found-is-redacted: ready-for-dev`. Wave 5 has nothing left open.
