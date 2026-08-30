# Review — Version & Reality Grounding

**Lens:** every committed decision must be web-researched or reality-checked, not asserted from training data.
**Reviewed:** `ARCHITECTURE-SPINE.md` (Stack table, AD-1, AD-4, AD-8, Deferred) against addendum §B and fresh registry/EOL checks run 2026-08-30 on this machine.
**Verdict: CONCERNS** — the addendum's same-day local verification covers most *version numbers*, but the spine made three commitments that contradict the verified data or were never checked at all: the Node floor, the TypeScript line, and the pnpm major. Several behavioral assumptions (execa process groups, Playwright peer wiring) are asserted without any grounding.

## Method

Ground truth gathered in this review (2026-08-30):

- `npm view <pkg> version dist-tags engines` for typescript, commander, zod, execa, yaml, vitest, tsup, pnpm, @playwright/test, dependency-cruiser
- `npm view <pkg> time` for publish dates (typescript lines, tsup, execa 10, commander 15)
- Local: Node v22.20.0, npm 10.9.3, pnpm 9.15.0, claude 2.1.251, codex-cli 0.144.4
- endoflife.date/nodejs for Node support status

## Findings

### F-1 (BLOCKER) — Node ">=20" floor is impossible with the pinned stack, and Node 20 is EOL

Spine Stack table: `Node.js (runtime floor) >=20 (dev on 22 LTS)`. Nothing in either document grounds this floor; it reads as a training-data default. Reality:

- **Node 20 went EOL 2026-04-30** (endoflife.date, confirmed today). Shipping a greenfield tool whose floor is an EOL runtime is a bad look and a support liability.
- **commander 15.0.0 declares `engines.node >=22.12.0`** (registry, checked today).
- **execa 10.0.1 declares `engines.node >=22`**.
- **dependency-cruiser 18.2.0** (named in AD-1 as the dependency-direction enforcer) declares `engines.node ^22||^24||>=26` — Node 20 cannot even run the lint gate.
- vitest 4.1.11: `^20.0.0 || ^22.0.0 || >=24.0.0` (dev-only, but same story).

With commander 15 + execa 10 pinned, `npm install` on Node 20 emits engine warnings at best and the CLI may hit >=22 syntax/API at runtime. **Fix:** floor `>=22.12.0` (or simply `>=22.12`), and note current LTS reality: 26 is Active LTS, 24 and 22 are Maintenance. "Dev on 22" is defensible (matches this machine's v22.20.0) but should say Maintenance LTS, not imply 22 is *the* LTS.

### F-2 (MAJOR) — TypeScript "5.9.x vs 7.x" framing is stale: a stable 6.0.x line exists and 5.9 is a dead branch

Spine: `TypeScript 5.9.x (TS 7.x evaluation deferred)`; Deferred section frames the choice as "pin 5.9.x now; re-evaluate 7.x". Addendum §B verified only that 7.0.2 is `latest`. Registry reality (checked today):

- The 5.9 line **ended at 5.9.3** (releases: 5.9.2, 5.9.3, nothing since).
- A **stable 6.0.x line exists — 6.0.2 and 6.0.3 published** — the continuation of the JS-based compiler (dist-tag `beta: 6.0.0-beta` plus stable 6.0.x releases). TS 6 is the designed bridge release toward 7 (aligned semantics, deprecations flagged).
- `latest` is 7.0.2 (Go-based), `next` is 7.1.0-dev.

The binary "5.9 vs 7" decision was made without discovering that 6.0.x exists. Pinning 5.9.x pins an unmaintained branch two majors behind. **Fix:** either pin **6.0.x** (JS compiler, current non-Go stable, smoothest path to 7) or adopt 7.0.x outright; if conservatism wins, at minimum the ADR/memlog note must acknowledge 6.0.x and say why it was skipped. There is no "5.9.x LTS" — TypeScript has no LTS concept.

### F-3 (MAJOR) — pnpm "9.x" is a local-machine echo, not a researched choice

Spine: `pnpm (dev) 9.x`. Addendum §B lists pnpm 9.15.0 — but that is *what is installed on this machine*, not the current release. Registry today: **pnpm latest = 11.24.0** — the 9.x line is **two majors behind**. For a greenfield repo this pin was copied from the environment rather than checked. 9.x still works, but new-project defaults (lockfile version, `packageManager`/corepack behavior, catalogs, config keys) have moved twice since. **Fix:** pin pnpm 11.x (or 10.x with a reason), and record it via the `packageManager` field so the choice is enforced rather than ambient.

### F-4 (CONCERN) — Fresh majors adopted with zero breaking-change research; execa process-group behavior asserted, not verified

- **commander 15.0.0 published 2026-05-29** (~3 months old); **execa 10.0.1 published 2026-07-31** (~4 weeks old; 10.0.0 on 2026-07-17). Both docs record only "these are the current versions" — neither records what broke going 14→15 or 9→10. For commander the known-verified fact is only the version number; for execa, nothing about its API surface was checked at all (execa isn't even mentioned outside the Stack table).
- AD-8 commits to specific process semantics: "Every spawned service/probe process starts in its own process group; teardown kills process groups", with pgids recorded in a manifest. Whether execa 10 exposes this (`detached: true` + killing `-pgid` yourself? its `cleanup`/`forceKillAfterDelay` behavior? what changed in v10?) — and whether it behaves as expected on macOS (the primary dev OS) — was **never verified anywhere**. This is the single most load-bearing unverified behavioral claim in the spine, because AD-8's orphan-reaping guarantee depends on it.

**Fix:** Epic 1 must include a spike story that proves spawn-in-own-pgroup + record-pgid + kill-group on macOS with execa 10 (or drops to raw `child_process` behind the ProcessRunner port — the port makes this cheap), and a changelog pass on commander 14→15 and execa 9→10 before APIs are written against them.

### F-5 (CONCERN) — Playwright wiring is version-verified but pattern-unverified; dependency-cruiser unpinned

- `@playwright/test 1.62.x` matches registry latest (1.62.1, engines `>=20` — moot after F-1). The **optional peer dependency** pattern itself is workable (`peerDependencies` + `peerDependenciesMeta.optional: true` is standard npm/pnpm behavior). But two assumptions are ungrounded:
  1. The spine never resolves *how* the browser surface consumes Playwright: the `@playwright/test` runner (shell out to `npx playwright test` on generated scenario files?) vs the `playwright` library API (`chromium.launch()` from the surface executor). These are different packages with different peer implications; only `@playwright/test` is named.
  2. Browser **binaries** require a separate `playwright install`; neither doc routes this through `proofgate doctor`, which is exactly where a missing-browser failure would otherwise land as a mislabeled InfraError mid-run.
- **dependency-cruiser** is committed to by name in AD-1 ("lint rule / dependency-cruiser check added in Epic 1") but appears nowhere in the Stack table and was never version-checked by the addendum. Current: 18.2.0, engines `^22||^24||>=26` — fine once F-1 is fixed, but pin it (18.x) so Epic 1 doesn't guess.

### Verified clean (no action)

- **zod 4.5.x** — registry latest 4.5.4, matches. Neither doc makes zod-3-era API claims (good); one opportunity worth an ADR line: zod 4's native `z.toJSONSchema()` is the natural feed for codex `--output-schema` (addendum §B) — schemas written once, exported as JSON Schema for codex, used natively for the validation gate (AD-2). Ensure implementers write against zod 4 docs, not zod 3 muscle memory (`.errors`→`.issues`, error-map changes, etc. — this review did not audit those specifics, and no doc claims them).
- **yaml 2.9.x** — matches latest 2.9.0. Note `next: 3.0.0-1` exists; 2.9 pin is correct today.
- **vitest 4.1.x** — matches latest 4.1.11.
- **tsup 8.5.x** — matches latest 8.5.1, but last publish 2025-11-12 (~9.5 months quiet) and the project has long-standing maintenance concerns. Acceptable for V0; a one-line fallback note (tsdown or plain tsc — a CLI barely needs bundling) would future-proof the choice.
- **claude CLI >=2.1.x / codex CLI >=0.144.x** — genuinely well-grounded: addendum §B is a same-day, same-machine capability probe including the exact flags AD-4 depends on (`-p --output-format json`; `exec --output-schema`), and AD-4's runtime capability probing is the right defense against flag drift. One caveat: codex is a **0.x** package, so ">=0.144.x" carries no semver stability promise — the runtime probe, not the version floor, is the real contract (which AD-4 already says; keep it that way).
- **Exit code 64 (EX_USAGE)** — matches BSD sysexits convention and the harness's own precedent (addendum §A); grounded.
- **No starter/scaffold is leaned on** — the structural seed is hand-rolled, so there are no live starter defaults to drift; nothing to check there.

## Summary of required changes

| # | Severity | Change |
| --- | --- | --- |
| F-1 | Blocker | Node floor `>=22.12` (Node 20 is EOL; commander 15/execa 10/dep-cruiser 18 require >=22) |
| F-2 | Major | Re-decide TS pin knowing 6.0.x stable exists; 5.9 is a dead branch, "5.9 vs 7" is a false binary |
| F-3 | Major | pnpm pin: 11.x (current) not 9.x (local echo); enforce via `packageManager` |
| F-4 | Concern | Epic 1 spike: execa 10 pgroup semantics on macOS; changelog pass commander 14→15, execa 9→10 |
| F-5 | Concern | Specify @playwright/test runner vs playwright lib; doctor checks browser binaries; pin dependency-cruiser 18.x in Stack table |
