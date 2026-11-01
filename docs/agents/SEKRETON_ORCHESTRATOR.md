# Sekreton Orchestrator

**Audience: agent.**

Last reviewed **28 Oct 2026**. Owner decisions: #4429 and #4452; the parallel level comes from #4404.

This page is for any agent (Claude Code, Codex, or a fresh session) acting as the
orchestrator for the Sekreton lane on `thatskiff33/AlpineClubBookingsNZ`.
[`AGENTS.md`](../../AGENTS.md) and [`COORDINATION.md`](COORDINATION.md) win wherever
this page disagrees with them. The only exceptions are the ones #4429 records, which
those two files name.

## Goal (owner, 26 Oct 2026, #4429)

Every open issue is closed with a plain-English close-out comment. Every PR it needed is
CI-green on its exact head and merged with a merge commit under AGENTS.md "Completion
and Merge". The orchestrator's job is to **fill Sekreton's gaps and keep Sekreton
moving**, with no owner input outside the owner's two daily review windows.

The scope is **every open issue**, not a focus list. A focus or priority list only
orders the queue. An issue is skipped only for a reason named in "Skip only for"
below, and the log says which reason applies.

## Why an orchestrator is needed: Sekreton's gaps

| Gap | Who fills it |
| --- | --- |
| Task sandboxes have no GitHub write (ALP-83): no CLAIM, LANE-SYNC, review, ready or close-out comment | Orchestrator, as `thatskiff33-agents` |
| The project ships by pull request, so Sekreton never merges | Orchestrator merges under gate #3959 |
| Sekreton's gates are only `lint` + `knip` (4 GB sandbox, `.sekreton/config.toml`) | Orchestrator runs `typecheck`, `test:related`, `test:named`, mutation checks and realdb suites locally (WSL host: 16 cores, 23 GB, Docker), and fixes red PR CI |
| The 4 GB sandbox is killed (exit 137) by `typecheck`, `test:related`, `test:named` or wide vitest runs | Every brief forbids those commands and asks for commits after each step. On a 137, send `request_changes` with that rule; the orchestrator runs the heavy checks locally |
| Agents can't push to a branch someone else opened | Orchestrator finishes released PRs in a local worktree |
| Task plans must be approved, and dependent tasks only start once their predecessors ship | Orchestrator approves plans and edits dependencies when the board changes |

## Identities

- Use `gh` as **`thatskiff33-agents` only**. Never act as `thatskiff33` (the owner),
  even if that login is present. Never write approval wording.
- Sign every GitHub comment `Sekreton lane (orchestrator)`, and open claims and
  checkpoints with the usual `CLAIM:` / `LANE-SYNC:` prefix
  ([`ISSUE_WORKFLOW.md`](ISSUE_WORKFLOW.md)). Other lanes tell this lane apart by that
  signature, not by the GitHub author.

## Owner decisions in force

Read each one at source. #4429 replaces the owner-decisions part of #4404's 26 Oct
record. Only #4404's parallel level still applies.

- Up to **3** Sekreton implementation tasks at once, on units that don't overlap.
  One writer per shared financial invariant. One heavy local job (typecheck, full
  suite, E2E, build) at a time on the host.
- Owner decisions are batched into two review windows a day (06:00 and 21:00 NZ).
  Everything else proceeds without the owner.
- AGENTS.md's 25% weekly usage reserve does not apply to this orchestrator (its
  "bar Sekreton's orchestrator" carve-out, #4429). An unreadable allowance is
  never a reason to stop starting units. Only a limit actually hit stops a pass
  ("Hard limits").
- A claim with no `LANE-SYNC:` or push for 72 hours is released automatically
  (owner decision, 28 Oct 2026, #4452). Run `pnpm run lanes:stale` on every pass
  and post the `RELEASE:` comments it lists.
- The bugs `parked-by-ledger` (#4451 group 2) stay parked until #4461's ledger work
  removes them, unless the owner overrides one by name.

## Where it runs

On the owner's WSL host, as systemd user timers. They run outside the repository, so no
tracked file holds credentials. Each timer runs `claude -p` headless under `flock`:

- `sekreton-pass.timer` runs a pass at :07 and :37 past every hour;
- `sekreton-digest.timer` runs the digest at 05:45 and 20:45.

The runner, its prompts and its `state/` folder (`HANDOFF.md`, `log.md`, the
`task_changes` cursor) live in `~/src/sekreton-orchestrator/`. An empty `state/PAUSE`
file skips every run until it is removed. Another host can run the same loop with any
scheduler. The contract is this page.

A claude.ai cloud session can run it instead, with Routines firing into that session
at :07 and :37, plus the digest. There, the handoff is a signed `LANE-SYNC:` on #4450
rather than `state/HANDOFF.md`. Each Routine's prompt names this page and says to run
"One pass" exactly as written. The prompt never lists its own focus issues: priorities
belong on this page and in the issues.

## One pass (runs every 30 minutes; a lock prevents overlap)

A pass **drives** work. A pass that only watches for events is a failed pass:
Sekreton tasks waiting in diff review, and backlog that could start, produce no
events.

1. **Read the whole board, not just the changes.**
   - Read `get_queue` and `list_tasks` for each status: diff review, failed, stopped,
     queued, running and backlog.
   - Read the open PRs and their checks on the exact head, and the open issues.
   - Read new `thatskiff33` comments since the last pass.
   - Run `pnpm run lanes:stale`.

   `task_changes` only adds what moved since the cursor. It is never the whole picture.
2. **Release stale claims.** Post a `RELEASE:` for each claim `lanes:stale` lists,
   after the push check COORDINATION.md describes (#4452).
3. **Unstick.** For each task that is failed, stopped, gates-failed, push-failed,
   conflicted, or quiet long enough to look stalled (`get_activity`): read why. Then
   retry, `request_changes` with a concrete fix, or finish the work locally. Exit 137
   or out-of-memory: don't blindly retry. Shrink the task or run that step locally.

   A task in diff review with an **empty diff** stopped at its eligibility check. Read
   its conversation, clear the named blocker, then file a fresh task with a brief
   that says so and close the old one:
   - a stale claim: release it;
   - a missing decision: queue it for the owner.
4. **Land PRs.** Take each Sekreton-lane PR through AGENTS.md "Per-issue pipeline"
   and "Completion and Merge" steps 1–6, exactly as written there. The local checks
   in the gap table above are the ones Sekreton's sandbox can't run. After the merge,
   close the Sekreton task.
5. **Fill slots.** Keep 3 units running whenever eligible work exists.
   - **Order:**
     1. MERGE-READY, FINISH-PR, BLOCKED-now-unblocked;
     2. then fresh builds in this priority: #4451 group 1, the #4450 waves in order,
        then every other open issue, oldest first.
   - **Pairing:** two money units may run together only if they write different
     invariants; a docs, ops, test or UX unit pairs with anything.
   - **Before starting:**
     - read the whole thread;
     - post the `CLAIM:` (signed as above);
     - check it held, as COORDINATION.md "Checking a claim held" describes.
   - Prefer a Sekreton task: approve its plan, or create it with a complete brief
     that says the eligibility is settled and why. Finish a released PR locally when
     only its existing branch can carry the work.
   - Close stale Sekreton tasks whose issue is already closed, with a reason.
6. **Decisions.** When work needs the owner:
   - **If the owner is in the session** (a person wrote in this conversation today),
     ask now with a decision pop-up, then record the answer on the issue in the
     same sitting. Every item that needs the owner becomes a pop-up as soon as it
     is found, batched up to four questions at a time. A status reply never ends
     with a "waiting on you" list instead (owner, 28 Oct 2026).
   - **Otherwise:**
     - write a `needs-decision` issue, or a section in the existing issue, with
       checkbox options, a **Recommended** default and plain-English stakes;
     - add it to the owner queue;
     - move on to other work.

   Act on a direct `thatskiff33` comment as the decision, record it in the issue body
   in the same sitting, and remove `needs-decision`.
7. **Idle check, then log.** Before ending, count the units in flight.
   - **Fewer than 3:** the log names every open issue that wasn't started, with its
     "Skip only for" reason. "Nothing changed" is not a reason.
   - **Log entry:** one line per action in `state/log.md`, or a signed `LANE-SYNC:`
     on #4450 in a cloud session. Keep it short; don't pad it.

### Skip only for

An open issue is not started this pass only when one of these is true:
- it carries `parked-by-ledger`, or the owner has reserved it by name;
- an owner decision on it is pending;
- another lane holds a live claim (under 72 hours);
- a recorded predecessor hasn't merged;
- it would make a second writer on a money invariant already in flight;
- 3 units are already running.

"Not on the focus list", "waiting for go-ahead" and "usage unreadable" are not
reasons.

## Owner queue digest (05:45 and 20:45 NZ)

This short list takes the place of decision pop-ups while the owner is away (#4429). When the owner is in the session, ask by pop-up instead (step 6). It
is a list of links, not a document to read.

Rewrite the pinned issue **"Owner queue (Sekreton orchestrator)"** with these sections:

- **Decisions needed:** link, one-line question, recommended option.
- **Needs you:** owner-only steps, such as production operations, deploys, and
  approvals a policy reserves for `thatskiff33`.
- **Shipped since the last digest:** PR, issue, one line each.
- **In flight:** each unit and its stage.
- **Blocked / risks.**

Email the owner a link to it, with the counts.

## Hard limits

- Never push to `main`, squash, rebase-merge or force-push.
- Never touch production, live Stripe/Xero/SES, real credentials or production data.
  Production operations are the owner's alone.
- Another lane's claim is handled under COORDINATION.md "Checking a claim held": the
  earlier claim on GitHub holds. Don't take issues the owner has explicitly reserved.
- Usage limits aren't a throttle (#4429). A pass that hits one stops cleanly:
  - commit work in progress, and push it only if the pre-push checks pass
    (COORDINATION.md "When the pre-push checks cannot pass");
  - post a `LANE-SYNC:` checkpoint on each unit's issue;
  - update `state/HANDOFF.md`, and log the limit.

  The owner resumes with another agent or plan.

## Resuming: any agent, any plan

All state lives on GitHub, in Sekreton, and in the runner's `state/` folder (see "Where it runs"). Nothing
depends on a chat session. Each pass rewrites `state/HANDOFF.md`, which holds:

- each unit in flight: issue, PR, branch, worktree, Sekreton task, stage, and next step;
- local work that hasn't been pushed (there should be none);
- background jobs that were running;
- the `task_changes` cursor.

To resume, a new agent reads, in order:

1. this page;
2. `state/HANDOFF.md`;
3. the last 40 lines of `state/log.md`;
4. the pinned "Owner queue" issue.

Then it runs a pass. A unit's stage can always be re-derived from GitHub (PR head,
checks, comments) and Sekreton (`get_task`), so a stale HANDOFF is safe. Verify
against those sources before acting.
