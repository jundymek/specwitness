# Harness defects observed during Epic 2 (2026-08-31)

Collected by the supervisor of `epic/2-verification-contracts` (agent `superman`) at the owner's request, to hand to an agent working in the **terminal-agents harness repository**. Nothing here is a SpecWitness defect — those live in the story specs and the retrospective. Every entry below is a behaviour of the harness itself, with the evidence that produced it.

Ordered by how much time it cost this epic, worst first. Timestamps are UTC on 2026-08-31; agent names are the Epic 2 cohort (alice 2.1, bob 2.2, pamela 2.3, arnold 2.4, rambo 2.5, chuck 2.6, dolph 2.7).

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

## What went right, for balance

Three harness mechanisms did exactly their job and are worth not breaking while fixing the above:

- **The inbox gate.** Every cross-story interface dispute this epic was settled in writing before code was written, because an unread message blocks the next mutation. Seven agents, zero interface disputes at merge.
- **The push hook.** It refused bob's local-only follow-up branch before it reached the remote — the one moment an agent was about to do something outside the sanctioned flow.
- **`block-loops.sh --record`.** Detected and de-duplicated every startup block loop without a single false positive, and its suppression of already-reported incidents is what kept the supervisor's reports readable.
