# Harness defects observed during Epic 2 (2026-08-31)

Collected by the supervisor of `epic/2-verification-contracts` (agent `superman`) at the owner's request, to hand to an agent working in the **terminal-agents harness repository**. Nothing here is a SpecWitness defect — those live in the story specs and the retrospective. Every entry below is a behaviour of the harness itself, with the evidence that produced it.

Two sections, each ordered by how much time it cost, worst first: **H-1..H-11** are what the supervisor observed from the outside, **H-12..H-16** are what the agents hit from the inside and reported when asked. The split is only about how each was found — H-13 in particular cost more than several entries above it. Timestamps are UTC on 2026-08-31; agent names are the Epic 2 cohort (alice 2.1, bob 2.2, pamela 2.3, arnold 2.4, rambo 2.5, chuck 2.6, dolph 2.7).

---

## H-1. A usage-limit cut leaves every agent unreachable, with no recovery path

**Cost: ~71 minutes of full-cohort stall, then a second stall of ~2h20m.** The two worst incidents of the epic, both requiring a human-authorized keystroke from the supervisor to clear.

**What happens.** When the account's usage limit is reached, every agent's turn is cut mid-flight. Each stops in whatever phase it was in — `coding`, `pushed`, `tests-passed` — never in `inbox-pending`. `inbox-poker.sh` pokes only agents in `inbox-pending`, and it additionally (and correctly) withholds Enter from any pane showing a usage-limit notice, because that pane may be displaying a dialog. The result is that when the limit resets, **nothing wakes anybody**: the panes sit with the poker's own nudge text unsubmitted in the input box, indefinitely.

**Evidence.**
- 08:09Z all seven agents stopped; `pmset -g log` shows no sleep in the window; tmux panes alive; zero `poke-failed` events. Every pane read `You've hit your session limit · resets 11:20am (Europe/Warsaw)`. At 09:20Z the limit reset and **still nothing moved** — I confirmed zero events after the reset before intervening. Cleared at 09:24:13Z by the supervisor sending Enter to seven panes after the owner authorized it; six resumed within 30 s (the seventh, arnold, had an empty input box and legitimately had nothing to submit).
- Repeated ~11:59Z–14:20Z. Owner asked for a resume at 14:25Z; Enter to rambo/chuck/dolph at 14:26Z; rambo resumed, the other two had empty boxes and were correctly idle.

**Suggested fix.** After a limit reset, an agent whose pane shows the limit notice *and* whose input box is non-empty needs one Enter. The poker already reads the pane; the missing piece is a post-reset pass that distinguishes "limit notice with pending input" from "open dialog". Failing that, an explicit operator command (`resume-all`) would at least make the remedy discoverable — twice this epic it existed only in the supervisor's judgement.

---

## H-2. An agent idle with unsubmitted input is invisible to the poker

**Cost: 11.5 minutes of critical-path time in the one instance caught; unbounded in principle.**

`stop.sh` promotes an agent to `inbox-pending` when it sees unread mail at turn end. An agent that ends its turn with **no unread mail** goes to `idle`. If nudge text is then injected into its input box (`agent-msg.sh` uses `tmux send-keys -l`, deliberately without Enter), nothing will ever submit it: the poker's loop is scoped to `inbox-pending`.

**Evidence.** chuck (2.6), last activity 11:27:57Z, phase `idle`, clean tree, seven unpushed commits, no PR, nudge text sitting in the box, dolph queued behind him on `chuck:done`. Poker was alive and demonstrably working (it poked bob at 11:37:52Z). Supervisor sent Enter at 11:39:5xZ after checking the pane carried no dialog; `chuck phase-change idle -> resumed` at 11:40:01Z.

**Suggested fix.** Poke `idle` agents whose input box is non-empty, or emit a distinct event (`input-pending`) when a pane's box is non-empty while the agent is idle, so it is at least visible to a supervisor.

---

## H-3. The rebase nudge is sent to agents whose own PR caused the move, and to agents already `done`

**Cost: three agents reopened after their stories were finished; one of them (bob) then did 45 minutes of unplanned work that had nowhere to land; one (pamela) hit a rebase conflict that could only ever conflict.** This is the defect the cohort reported most consistently.

**What happens.** On `epic-updated`, every agent is nudged with a recipe that says to rebase *"immediately and verbatim, without waiting for the operator"*. The notifier checks neither (a) whether the recipient's own PR is the commit that moved the base, nor (b) whether the recipient is already `done` / merged. Both cases reopen a finished agent from `done`.

**Evidence — three agents, four occurrences.**
- 11:14:23Z alice's merge nudged pamela **5 seconds before pamela's own PR #10 merged**. A race.
- 11:23:13Z bob's merge nudged pamela **nine minutes after** the harness had logged `pamela done pr=10 merged`. Not a race — the notifier simply does not check.
- Both reopened pamela from `done`. She checked ground truth first (`gh pr view 10` → MERGED, tree identical to the epic tip) and therefore did **not** force-push; her `git rebase` conflicted (replaying four commits onto a base that already contained them as a squash), she aborted, and `git reset --hard` was correctly refused by the sandbox. Codex's review of her resulting no-op merge: *"HEAD and merge base resolve to identical trees. There are no code changes to review."*
- 11:26:46Z the same thing happened to bob after **his own** PR #9 merged: `bob reopened from=done unread=1`. He read the reopen as a real gap on the epic branch, ran a sixth Codex round, and produced two commits stranded on a merged branch. They turned out to contain a genuine improvement, which is the only reason this ended well — it needed an owner decision and a follow-up PR (#13) to land.

**Pamela's own two proposed fixes, either sufficient, in her order of preference:**
1. Do not send the nudge to agents whose phase is `done` or whose PR is merged. Cheapest, catches both cases.
2. Add one line to the recipe text: *"If your own PR is already merged, ignore this — you have nothing to rebase."* Costs nothing and survives whatever the phase tracking does or does not know.

**Bob's contribution to the same entry**, worth quoting because it names the human factor: *"I treated 'PR #9 is merged' as new information to act on rather than as a signal that my story was over, and started fixing forward instead of stopping to ask. The gate stopped me; my judgement did not."* An instruction that says *execute immediately and verbatim* is what turns that instinct into action.

---

## H-4. The rebase recipe is wrong after a squash merge

**Cost: a full conflicted rebase for bob; would hit every agent that rebases after any merged PR, because this project squash-merges.**

The nudge text instructs plain `git rebase origin/<epic-branch>`. After a **squash** merge the agent's original commits are not ancestors of the new base — their content matches but their patches do not — so every one of them conflicts. Bob hit this with all five of his merged commits.

**The recipe that works**, and what the nudge should say for a squash-merging project:

```
git fetch origin
git rebase --onto origin/<epic-branch> <sha-of-your-last-merged-commit>
```

That replays only the commits *after* the last merged one. Bob used it and landed cleanly.

---

## H-5. `rebase-outstanding` fires on ground truth it has not checked

**Cost: supervisor time on every occurrence; erodes trust in a signal that is supposed to be actionable.**

Three false positives observed, two distinct causes:

- **chuck, 11:38:17Z and 12:11:56Z** — reported outstanding at age 903s/904s, while `git merge-base --is-ancestor origin/epic/2-verification-contracts HEAD` in his worktree returned **true**. He *was* rebased; he had simply gone `idle` before emitting a `rebase-followed`, so the detector never saw the confirmation event.
- **pamela, 11:38:20Z, 11:38:21Z, 12:11:58Z, 12:11:59Z** (twice each time) — genuinely one commit behind, but only because the supervisor had explicitly instructed her to hold: her story was merged and the moving commit touched none of her files. The detector has no notion of "merged agent" or "held by instruction".

**Suggested fix.** Check the ancestry directly rather than waiting for a `rebase-followed` event, and suppress for agents whose PR is merged (same predicate H-3 needs). The duplicate emissions one second apart are a separate small bug.

---

## H-6. The commit-subject convention is not enforced as documented, and the hook's own HINT contradicts the project rules

`config/projects/specwitness/project.env` declares a 72-character cap, and `rules.md` says plainly that **the story id does NOT go in the subject** (it belongs in a `Refs:` trailer). Observed subjects that passed the hook:

```
111 chars: docs(2.3-agentprovider-port-roles-structured-output-gate): record review findings and 2.7 taking the runGit fix
 77 chars: fix(providers): keep the failure envelope's raw payload in step with attempts
 74 chars: fix(ingest): refuse ambiguous epics, keep indented criterion continuations
 73 chars: fix(ingest): refuse unparseable story headings and classify stat failures
```

Two problems in one: the cap is not applied, and the hook's own block HINT recommends `git commit -m "feat(<task-id>): <short subject>"` — i.e. it actively instructs agents to do the thing `rules.md` forbids. Cosmetic for this project (squash merges use the PR title), but the contradiction will keep producing non-conforming subjects for as long as the HINT says that.

---

## H-7. The Codex auto-review wrapper calls `pnpm lint --no-fix`, which cannot work here

Reported by arnold (2.4), evidence in `~/.local/state/terminal-agents/arnold/codex-auto-review.log`. This project's `lint` script forwards to `depcruise`, which has no `--no-fix` option, so the wrapper's lint step exits 1 on every run. `pnpm lint` passes when invoked correctly. The wrapper should not assume a lint runner that accepts eslint's flags.

---

## H-8. The auto-review runs `pnpm test` inside the agent's own worktree, concurrently with the agent

This is the trigger for a test-isolation defect in the project (`tests/unit/dependency-rules.test.ts` writes fixed-name scratch modules under `src/` and cruises the whole tree, so two concurrent vitest processes fail each other). The project side is being fixed under story 2.8, written for exactly this. **But the concurrency is the harness's choice**: every `pushed` fires `codex-review-auto-started`, which runs the full suite in the same directory the agent may be running it in.

**Three independent sightings**, all with the same shape: alice reproduced it deterministically (`run A: 1 failed · run B: 2 failed · sequentially: 10 passed, every time`), bob saw one unexplained `1 failed | 677 passed`, arnold saw `1 failed | 987 passed` in `exit-location.test.ts` (a file that reads every source under `src/`, i.e. exactly the file a concurrent scratch-module writer would disturb).

**Worth considering even after 2.8 lands**: running the review's suite in a throwaway copy of the worktree would make the harness robust against *any* project whose tests are not concurrency-safe, rather than requiring every project to become so.

---

## H-9. Gate marker files are resolved against the Bash tool's CWD, not the worktree root

Reported by bob (2.2). The intent-gate and inbox-gate hooks look for `intent.ready` / `intent.synced` relative to the current working directory. A `cd` into a subdirectory earlier in the session makes them appear missing, and every write is re-blocked with *"cohort intent-sync incomplete — only intent.md is editable right now"* long after the cohort has synced.

**Evidence.** bob was `intent.synced` at 07:59:40Z with all six acks present in his worktree, and still took three `cohort intent-sync incomplete` blocks at 09:27–09:28Z. Resolving the markers against `$AGENT_WORKTREE` would fix it.

---

## H-10. Story specs instruct `set-depends-on.sh` at a point where the hook forbids it

Specs 2.4–2.7 say, in their "run immediately after reading this spec" block, to call `~/.terminal-agents/scripts/set-depends-on.sh <peer>:done`. The intent-gate blocks exactly that until cohort intent-sync completes: *"set-depends-on/agent-wait is not allowed before cohort intent-sync completes."*

**Evidence.** rambo 07:47:36Z, arnold 07:56:40Z, dolph 07:58:01Z, chuck 07:53:43Z, bob 11:59:03Z — five agents, all in their first minutes. It self-resolves after sync, but it produced the epic's first block loops and cost every wave-B agent a wasted round.

**Fix is a wording change in whichever template generates that block:** put the `set-depends-on` call *after* the intent-sync step, or say plainly that it must wait for `intent.synced`.

---

## H-11. Smaller frictions, recorded because a fixer wants them

- **`git branch -D` is hook-blocked with no supervised alternative.** bob abandoned a local-only branch (`story/2.2-followup-...`) and cannot delete it; it sits unreferenced in his worktree forever. Deleting a *local, unpushed* branch is not a destructive-git risk in the sense the guardrail means.
- **The shlex fail-closed parser blocks any command whose payload contains an apostrophe**, including heredocs. This is working as designed and the HINT is excellent — but it fired on the supervisor twice and on at least bob and chuck, always on ordinary English prose ("the operator's"). Since the remedy is always "write the payload with the Write tool", the hint could be shortened and the *first* suggestion could be the one that always works.
- **`supervisor_verdict` can go stale and nothing stops a merge on a stale verdict.** PR #9 was merged two commits past the head I verdicted (be0f424 → dd0186c). The delta turned out to be a genuine improvement and the codex/security gates were fresh, so no harm — but the pre-PR gate enforces freshness for `codex_review` and not for the supervisor's verdict. Either enforce both or neither; the current asymmetry is a trap.
- **Duplicate event emissions.** `rebase-outstanding` was emitted twice for pamela one second apart (11:38:20Z / 11:38:21Z, and again at 12:11:58Z / 12:11:59Z); `rebase-followed` twice for rambo (12:12:01Z, twice).

---

# Reported by the cohort (H-12..H-16)

Solicited at the owner's request after the first pass above was written, on the reasoning that the items an agent does not bother reporting are exactly the ones a fixer wants and nobody remembers at closure. All five below are pamela's (2.3), with her own suggested fixes; each is marked DEFECT or FRICTION by her, because two are working-as-designed-but-costly rather than broken.

---

## H-12. The pre-PR gate reports one failing precondition per attempt

**DEFECT. Cost: ~4 avoidable round-trips per agent per PR, on every story — the highest recurring cost in this section.**

`gh pr create` was refused four times in a row, each time for a **different** condition, each discovered only after fixing the previous one:

```
attempt 1 → "PR body must reference test results"
attempt 2 → "PR body prose is hard-wrapped"
attempt 3 → "plan.md must include a '## Manual testing' section"
attempt 4 → success
```

Every one of those was knowable before the first attempt. Serially revealing them turns one gate into four round-trips, and each retry re-runs the body-file plumbing.

**Second-order cost, worth naming because it misled the supervisor:** the same `gh pr create … --body-file` line then appears four times in the agent's scrollback with only the last succeeding. I read that scrollback as a *pending* second PR and sent pamela a STOP on that basis. It was wrong, and it cost her a round-trip and me a correction — a serial gate does not just waste attempts, it makes the pane unreadable to anyone diagnosing from outside.

**Likely fix.** Evaluate all preconditions and report every failing one in a single message. The checks appear independent, so this should be a loop over results rather than an early return on the first failure.

---

## H-13. The secret-path matcher rejects legitimate filenames containing `.env`

**DEFECT. Cost: one forced rename and a permanent explanatory comment in the repository.**

Writing `tests/unit/providers/process-runner.env.test.ts` was refused:

```
BLOCKED by agent system: Editing secret-bearing file path is forbidden:
.../tests/unit/providers/process-runner.env.test.ts
```

It is an ordinary vitest file whose *subject* is environment construction. The matcher looks for `.env` as a substring of the basename rather than as a complete filename or a whole path segment.

The workaround is worse than the problem: the file is now `process-runner-env.test.ts` and carries a comment explaining why — a permanent wart caused by a matcher, not by a risk. Any project that tests environment handling will hit this and will invent its own worse filename.

**Likely fix.** Anchor on a complete filename or path segment (`.env`, `.env.local`, `.env.<anything>`), not a substring. `foo.env.test.ts`, `env.test.ts` and `environment.ts` are all legitimate.

---

## H-14. The auto-review sets `auto:findings` even when it found nothing to review

**DEFECT. Cost: this is the signal that made the owner stop and ask why a finished agent looked unfinished.**

A no-op sync push triggered an auto-review that concluded, verbatim:

```
The requested diff is empty: HEAD and merge base 070053f resolve to identical
trees. There are no code changes to review.
```

Correct conclusion — and the board still showed `auto:findings`. The flag records that a review **ran**, not what it **concluded**, so "nothing to review" and "problems found" are indistinguishable on the overview.

**Likely fix.** On an empty diff or zero findings, write a `clean` / `no-diff` marker instead of `findings`. Cheaper still: skip the review entirely when the diff against the merge base is empty — it cannot produce anything.

---

## H-15. The inbox gate discards the in-flight payload, and reveals unread ids one at a time

**FRICTION, and pamela is explicit that the gate should not be weakened** — reading peer messages before mutating saved real rework this epic, and it is on the "what went right" list below. The expensive part is the failure *mode*, not the rule.

A message arriving between an agent's last read and its next `Write` causes the **entire** Write to be rejected and the payload to be re-sent. She hit it six times, twice on multi-hundred-line files, once on three files in a row as messages landed seconds apart during intent-sync. (The supervisor hit the same thing four times while writing this very document.)

**Two cheaper options, neither of which relaxes the rule:**
1. Let the in-flight mutation through and block the **next** one. The agent still cannot proceed without reading, and nothing is lost.
2. **Name every currently-unread id in the block message**, so one read-batch clears the gate — rather than surfacing them one at a time as they arrive, which is what produced her four-blocks-in-a-row during intent-sync.

Her preference, and mine, is (2).

---

## H-16. `intent-ready.sh` checks section titles by exact string

**FRICTION. Cost: a spurious warning on a correct file.**

```
WARN: intent.md is missing recommended sections:
  - ## What I need from peers
```

Her file had `## What I still need from peers` — one paraphrased word was enough to miss. Harmless because it warns and continues, but an exact-string check against a heading humans will naturally reword will warn on most correct files, and a warning that is usually wrong is a warning people stop reading. A substring or fuzzy match on `need from peers` would fire only when it should.

---

## Deliberately NOT defects, recorded so a fixer does not chase them

Reported by pamela with the note that the error messages were good enough that she wanted no change:

- **The shlex fail-closed block on payloads containing apostrophes.** Working as designed; the hint says exactly what to do (write the payload with the Write tool, pass the path). No change wanted. (Already listed as friction under H-11 for the *ordering* of its hint, not its existence.)
- **`gh pr create` refused when chained with `cp`/`printf` in one command line.** Correct — the gate cannot inspect what it cannot parse — and the hint said so plainly.
- **Foreground `sleep` blocked in favour of Monitor.** Correct, and the message named the right replacement.
- **`timeout` not found on macOS.** Her own GNU-coreutils assumption on a BSD box, not a harness fault.

---

## Adjacent, not harness: orphaned processes from the documented Epic 3 gap

Not a harness defect and already recorded in the project, but it belongs in the same collection because it is the kind of thing that resurfaces as "why is this machine slow" three weeks later.

`src/infra/process-runner.ts`'s timeout detects a hung child but does not **reap orphaned descendants** when that child forks: execa kills the direct child, a grandchild inherits the stdio pipes. Story 2.3 fixed detection (`run()` always settles and always classifies) and deliberately left reaping to Epic 3 story 3.2, which owns `kill(-pgid)` under AD-8.

**Concrete evidence, from this machine:** pamela's own forking-timeout integration test left **nine orphaned `sleep 3600` processes** (all reparented to PID 1) across its runs. She reaped them by hand after noticing. A CI box running that suite repeatedly would accumulate them.

This is expected behaviour of a documented gap — but it only stays documented if the `roadmap.md` EPIC 3 wave-A line is amended to say "process-runner **lifecycle extension**", or an ADR records the split. That is the open owner item from 2.3's PR body.

---

## What went right, for balance

Three harness mechanisms did exactly their job and are worth not breaking while fixing the above:

- **The inbox gate.** Every cross-story interface dispute this epic was settled in writing before code was written, because an unread message blocks the next mutation. Seven agents, zero interface disputes at merge.
- **The push hook.** It refused bob's local-only follow-up branch before it reached the remote — the one moment an agent was about to do something outside the sanctioned flow.
- **`block-loops.sh --record`.** Detected and de-duplicated every startup block loop without a single false positive, and its suppression of already-reported incidents is what kept the supervisor's reports readable.
