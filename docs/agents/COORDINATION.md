# Coordination

**Audience: agent.**

How lanes share work without a permanent supervisor. Root `AGENTS.md` →
"Orchestration Model" is the authority; this page holds the detail it routes
here (#3905, CP1). Claim, `LANE-SYNC` and ready-comment formats live in
[`ISSUE_WORKFLOW.md`](ISSUE_WORKFLOW.md#claiming-and-talking-between-lanes).

## Where the work state lives

The record is what GitHub and git show, never a session's memory:

- issue threads — `CLAIM:`, `LANE-SYNC:`, `RELEASE:` and ready comments, and
  decision records;
- pull requests, their head SHAs and their checks;
- branches and worktrees.

Read it with deterministic commands — `pnpm run status`, `pnpm run issue <n>`,
`gh pr list`, `gh pr view <n> --json headRefOid,isDraft,statusCheckRollup`,
`git worktree list` — not by asking a model to remember. A handoff note,
checkpoint or board row is data (`AGENTS.md` → "Authority", class 5): resolve the
SHA and branch it names before relying on it.

### The status board

**Owner decision, 27 Oct 2026 (#4464): what is running is a generated board, not
a hand-kept issue.** `pnpm run status` prints, from open issues and pull requests
alone, each open lane (the earliest `CLAIM:` since the last `RELEASE:` or
`HANDOVER:`), its last `LANE-SYNC:`, its linked pull requests with draft or ready
state, CI on the exact head with the failing required check names, merge state,
and the stale claims. It replaces #3905's hand-edited reservation tables, whose
remaining decisions live in their own issues.

`.github/workflows/status-board.yml` runs it hourly with `GITHUB_TOKEN` alone and
overwrites the body of the issue named by the repository variable
`STATUS_BOARD_ISSUE`; while that is unset it exits with a notice and writes
nothing. The owner or a lane creates the issue with an empty body (blank issues
are disabled: `gh issue create --title "Status board" --body ""`, or clear a
template-filled body) and pins it; the owner sets the variable (the machine
account lacks admin). Never edit the board or
record a decision on it: the `CLAIM:` and decision record are the record. It is
data, not a required check.

## When a coordinator runs

A coordinator is an ordinary session started for one bounded job: a **decision**
spanning lanes (which lane owns a shared file; the order two PRs merge in), an
**assignment** (who takes an issue next, recorded on the issue), or an
**integration** (sequencing or checking PRs that compose). It states its job and
stopping condition first, does that job, records the result on the issue, and
stops. It never runs as a recurring loop, a scheduled wakeup or a standing
supervisor, and is not started to watch CI: a lane watches its own PR. A lane
needs no coordinator for its own claimed issue.

**Exception: the Sekreton lane's orchestrator** (owner decision, 26 Oct 2026,
#4429): a standing orchestrator makes one bounded pass every 30 minutes and
watches that lane's CI, because Sekreton's task agents can't write to GitHub and
Sekreton never merges. It is part of that lane, not a supervisor over others
([`SEKRETON_ORCHESTRATOR.md`](SEKRETON_ORCHESTRATOR.md)).

## Lanes and assignments

A lane is the session holding an issue's claim, doing that issue's normal
authorised work end to end: worktree, branch, commits, push, PR, CI, review,
ready comment and the merge gate. Its implementor and reviewer subagents stay
within their roles (`AGENTS.md` → "Orchestration Model").

A Sekreton lane (branches `sekreton/<org>/alp-<n>`, writing as `sekreton[bot]`,
or as `thatskiff33-agents` signed `Sekreton lane (orchestrator)`) is a lane like
any other and runs the whole pipeline itself (owner decision, 26 Oct 2026,
#4392): its own `CLAIM:` before work starts, a PR body from
`.github/pull_request_template.md` with `Closes #<n>` that passes
`pnpm run pr:check`, review lenses chosen by risk, the ready comment, and the
merge under `AGENTS.md` → "Completion and Merge". Another lane finishes a
Sekreton PR only when the owner reassigns it on the issue; a review finding goes
back as a `LANE-SYNC:`, never as a push to its branch. Because task sandboxes have
no GitHub write (ALP-83), its orchestrator does the GitHub steps and local
validation as `thatskiff33-agents` and asks owner questions as `needs-decision`
issues batched into review windows ([`SEKRETON_ORCHESTRATOR.md`](SEKRETON_ORCHESTRATOR.md)).

An assignment names the issue, the branch, the scope and who takes it; the
taking lane posts its own `CLAIM:`. An agent-written assignment carries no
authority beyond the owner decisions it cites, read at source (`AGENTS.md` →
"Pre-authorisation and attributability").

### Multi-step work

Multi-step work is built on `main` behind flags or inert modules, one normal
issue and PR per step; an integration branch is kept only where a schema
contract step can't be made inert (owner decision, 27 Oct 2026, #4464;
[`EPIC_PLAYBOOK.md`](EPIC_PLAYBOOK.md)).

### Checking a claim held

Two lanes can claim a free-looking issue within minutes, so a claim is not held
until checked:

1. Before claiming, read the thread (`pnpm run issue <n>`), the status board,
   and open PRs for the issue (`gh pr list --search "<n>"`).
2. Post the `CLAIM:`, then read the thread and PR list again before creating a
   worktree or writing code.
3. If another lane's `CLAIM:`, assignment or PR for the issue appears, the
   earlier one on GitHub holds. A later claimant posts a `LANE-SYNC:` that it
   withdrew and stops; it pushes nothing and opens no PR.
4. If both lanes already have commits, or the order is unclear, both stop
   writing. Each posts a `LANE-SYNC:` with its head SHA and asks the owner who
   continues. Neither merges the other's work or deletes its own while waiting.

Re-run step 2 before the first push too, to catch a claim posted while you built.

## Parallel work

The initial operating baseline for managed agent lanes, adjustable and not a
permanent limit (#3905). The owner may set a higher or lower level for a period,
an issue or a host, weighing independence, machine capacity, test load and review
capacity; record that decision on the issue it covers.

- **Two** substantial managed implementation tasks at once.
- **One more UX task** only when its behaviour, schema and components are
  independent of both, and review capacity remains.
- **One writer per shared financial invariant**, at any level.
- **One expensive development or test job per physical host** — a full suite,
  E2E, a build, a large typecheck. Check what else runs on the host first, and
  wait or use CI rather than contend.
- **Unknown occupancy is not a free slot.** Count a reservation you cannot
  account for as taken.

These limits bind managed agents only; human contributors keep their normal
rights ([CONTRIBUTING.md](../../CONTRIBUTING.md)). A lane over the baseline waits
or asks the owner; it does not stop someone else's work.

## Reservations, stale sessions and conflicts

A claim or an unpublished worktree is its holder's until it is released or the
owner reassigns it. None of these frees it:

- no comment for a while, or an old claim;
- nothing on the remote (an unpushed branch is not an abandoned one, #2216);
- a red CI run, a usage-limit stop, or a lost session.

Never take over, push to, rebase, reset, stash in or delete another lane's
branch or worktree, or open a replacement PR for its issue. If you need its work,
post a `LANE-SYNC:` with the head SHA you read; if the holder is silent and the
work is blocked, ask the owner to reassign it.

After 72 hours without a `LANE-SYNC:` checkpoint or a push to the reserved
branch, the reservation is **released automatically** (owner decision, 28 Oct
2026, #4452; it replaces the 27 Oct rule of asking the owner first). The
coordinator that finds it confirms there was no push (the branch's push
activity, or a manual check when no branch is named), then posts a `RELEASE:`
citing #4452, after which any lane may claim the work. A holder still working
keeps its claim by posting a `LANE-SYNC:` or pushing within the 72 hours. A
release never touches the old lane's branch or worktree: its unpublished work is
not taken over, and a new claim starts from `main`.

`pnpm run lanes:stale` (optionally followed by `owner/repo`) lists open issues
and PRs whose holding `CLAIM:` (the earliest since the last release) has had no
activity for over 72 hours, with the lane named in the claim and the release to
post; the status board shows the same rows from the same code
([`lane-reservations.mjs`](../../scripts/lib/lane-reservations.mjs)), counting
only the owner and agent accounts `AGENTS.md` names (`TRUSTED_LANE_AUTHORS`). A
later `CLAIM:` update, `LANE-SYNC:` or branch push restarts the timer; `RELEASE`
or `HANDOVER` ends the claim. Push times come from GitHub push activity (force
pushes included), read for the branch the latest claim naming one gives (a PR
falls back to its head branch); none is flagged for a manual push check. A failed
read stops the report. It never posts or edits anything: the coordinator checks
the thread and posts the `RELEASE:`.

## Handoffs and checkpoints

A lane stopping early — end of session, usage limit, waiting on the owner —
commits coherent work, pushes it if the branch is its own, and posts a
`LANE-SYNC:` checkpoint: head SHA, what is done, the next step, open findings and
stated limits. Long-running implementors also keep a checkpoint outside the
worktree. Whoever resumes starts from that checkpoint and the thread, not from a
summary.

### When the pre-push checks cannot pass

The pre-push checks (`AGENTS.md` → "Per-issue pipeline") are not skipped to save
work, and a Stop hook reminds a lane once when its own directory differs from
`origin/main` under `src/` (a lane editing another worktree by absolute path is
not reminded). Never use `--no-verify`, a skipped check or a push of
known-broken work to rescue it. Instead:

1. Commit it locally on the lane's own branch, the message naming the failing
   check. Never stash it (the stash is shared across worktrees), reset it or
   delete the worktree.
2. Record the failing command, the error and the next step in the private
   checkpoint.
3. Post a `LANE-SYNC:` with the local head SHA, that it is unpushed, and the
   failing check and why. Name no local path, host or account (the repo is
   public).
4. If the cause is environmental (a missing service, host contention, a known
   flake), say so and stop; if it is in the change, fix it or escalate under the
   circuit-breaker rule.

The reservation holds while the work is unpushed (#2216). Only the holder, or a
lane the owner assigns, resumes it.

## Staying bounded

- An issue never grows on its own. A defect the PR introduces, or one that blocks
  its agreed behaviour, is fixed in the PR; anything else found is filed as a new
  linked issue and left there.
- Research ends when it answers the question or stops adding evidence. Report
  what is known, what is not, and the limit.
- Two identical failures trip the circuit breaker (`AGENTS.md` → "Context, usage
  and failure control").

## Reviews: choosing lenses

The lane always reviews its own diff. How many further lenses run, and which, is
the lane's choice (owner decision 3, #3905), weighing risk, complexity,
uncertainty and what validation proves. There is no fixed count or floor;
zero further lenses is allowed when justified. Money, schema, auth, provider,
capacity and membership-lifecycle changes usually justify independent lenses.
Common lenses: correctness; concurrency; security; money; migrations; UX, docs
and permission drift. Fold the single-source-of-truth check
(`INV-SSOT`) into one review's brief on every PR; it gets its own lens only for a
substantial new abstraction or refactor.

- The ready comment names each lens that ran, why, the head SHA it read, and what
  it found. With no further lens, it says why.
- A lens approves the commit it read. Re-review only the later delta. A security
  blocker's fix gets that lens re-run over the fix only. Otherwise a fresh lens
  reads only newly written code no lens has read.
- A review rejecting one edit to a file does not fence off the file: a different,
  correct change there still belongs in the PR.

Validation, the merge gate and any narrower prerequisite stay the same whatever
the lens count.

## Asking the owner

The owner is never handed a document to read (owner rule, 24 Oct 2026);
engineering detail is the agent's to settle. Low/Medium work needs a concise
plan. For High/Critical work the agent works out the invariants, counterpart
writers, data and rollback, validation and stop conditions, and keeps them in the
issue for reviewers.

Only a genuine business or authorisation question, or a blocker the lane cannot
resolve, goes to the owner: a contradiction between the issue and the code, a
tripped circuit breaker, being stuck at `xhigh`, a material scope change. Ask it
as decision pop-ups in plain English, with the full detail needed to decide,
each option's pros and cons and the recommendation first. Show a visual layout as
an Artifact or mock-up, not prose. Before putting options to the owner, read every reply in
the thread, fork maintainers' included.

## Decision provenance

Record what the owner decided exactly as it was given:

- **Pop-up answer:** `DECIDED, <date> (owner, decision pop-up in the <lane>
  session)`, and the body is rewritten in the same sitting.
- **Direct instruction in a session:** name it as one, for example `START
  RECORD — <scope>, <date> (owner, direct instruction in the <lane> session)`,
  agent-recorded and not a `thatskiff33` comment. It authorises only the session
  it was given in. Only a `DECIDED` pop-up record or a `thatskiff33` comment
  carries forward, so ask the owner to post one when work will outlast the
  session.

A record never claims to be the owner's GitHub approval, and never quotes
approval wording. Before adopting a delegated decision, re-read the thread for a direct
one, and say so in your comment.

## Session hygiene (Claude Code)

`/context` must list `CLAUDE.md` and `AGENTS.md`. Use `/usage` before a sizeable
lane, `/clear` at a checkpoint, `/mcp` to drop connectors the task does not need
and `/hooks` when a session misbehaves.
