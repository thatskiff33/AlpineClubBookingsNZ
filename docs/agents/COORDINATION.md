# Coordination

**Audience: agent.**

How lanes share work without a permanent supervisor. Root `AGENTS.md` →
"Orchestration Model" is the authority; this page holds the detail it routes
here (#3905, CP1). Claim, `LANE-SYNC` and ready-comment formats live in
[`ISSUE_WORKFLOW.md`](ISSUE_WORKFLOW.md#claiming-and-talking-between-lanes).

## Where the work state lives

The record is what GitHub and git show, never a session's memory:

- issue threads — `CLAIM:`, `LANE-SYNC:` and ready comments, decision records,
  and any ownership board an issue body carries;
- pull requests, their head SHAs and their checks;
- branches and worktrees.

Read it with deterministic commands — `pnpm run issue <n>`, `gh pr list`,
`gh pr view <n> --json headRefOid,isDraft,statusCheckRollup`,
`git worktree list`, `git status` in a worktree — not by asking a model to
remember. A handoff note, checkpoint or board row is data (`AGENTS.md` →
"Authority", class 5): resolve the SHA and branch it names before relying on
it.

## When a coordinator runs

A coordinator is an ordinary session started for one bounded job:

- a **decision** that spans lanes (which lane owns a shared file; the order two
  PRs merge in);
- an **assignment** (who takes an issue next, recorded on the issue);
- an **integration** (syncing, sequencing or checking PRs that compose).

It states its job and stopping condition at the start, does that job, records
the result on the issue — an ownership board in the body or a comment — and
stops. It never runs as a recurring loop, a scheduled wakeup or a standing
supervisor, and it is not started to watch CI: a lane watches its own PR. No
coordinator is needed for a lane to take, build or finish its own claimed
issue.

**Exception: the Sekreton lane's orchestrator** (owner decision, 26 Oct 2026,
#4429). The Sekreton lane is run by a standing orchestrator that makes one
bounded pass every 30 minutes and watches the lane's CI. It does this because
Sekreton's task agents can't write to GitHub and Sekreton never merges. The
orchestrator is part of that lane, not a supervisor over other lanes. Its
contract is [`SEKRETON_ORCHESTRATOR.md`](SEKRETON_ORCHESTRATOR.md).

## Lanes and assignments

A lane is the session holding an issue's claim. It does that issue's normal
authorised work end to end: worktree, branch, commits, push, PR, CI, review,
ready comment and the merge gate. Implementor and reviewer subagents inside the
lane stay within their roles (`AGENTS.md` → "Orchestration Model").

A Sekreton lane (branches `sekreton/<org>/alp-<n>`, writing as `sekreton[bot]`,
or as `thatskiff33-agents` signed `Sekreton lane (orchestrator)`)
is a lane like any other, and runs the whole pipeline itself (owner decision,
26 Oct 2026, #4392): its own `CLAIM:` before work starts, a PR body from
`.github/pull_request_template.md` with `Closes #<n>` that passes
`pnpm run pr:check`, review lenses chosen by risk, the ready comment, and the
merge under `AGENTS.md` → "Completion and Merge". Another lane finishes a
Sekreton PR only when the owner reassigns it on the issue; a review finding
goes back to the Sekreton lane as a `LANE-SYNC:`, never as a push to its branch.
Because the task sandboxes have no GitHub write (ALP-83), the lane's GitHub
steps (claim, review, ready comment, merge, close-out) and its local validation
are done by its orchestrator as `thatskiff33-agents`, per
[`SEKRETON_ORCHESTRATOR.md`](SEKRETON_ORCHESTRATOR.md). The orchestrator also
asks owner questions there as `needs-decision` issues batched into the owner's
review windows, rather than as pop-ups.

An assignment names the issue, the branch, the scope and who takes it. The
taking lane posts its own `CLAIM:`. An assignment written by an agent carries no
authority beyond the owner decisions it cites, read at source (`AGENTS.md` →
"Pre-authorisation and attributability").

### Checking a claim held

Two lanes can both see an issue as free and claim it within minutes. A claim
is not held until it has been checked:

1. Before claiming, read the thread (`pnpm run issue <n>`), any ownership
   board, and open PRs for the issue (`gh pr list --search "<n>"`).
2. Post the `CLAIM:`, then read the thread and PR list again before creating
   a worktree or writing code.
3. If another lane's `CLAIM:`, assignment or PR for the issue appears, the
   earlier one on GitHub holds. A later claimant posts a `LANE-SYNC:` that it
   withdrew and stops; it pushes nothing and opens no PR.
4. If both lanes already have commits, or the order is unclear, both stop
   writing. Each posts a `LANE-SYNC:` with its head SHA and asks the owner who
   continues. Neither merges the other's work or deletes its own while waiting.

Re-run step 2 before the first push as well, which catches a claim posted
while you were building.

## Parallel work

This is the initial operating baseline for managed agent lanes. It is
adjustable, not a permanent fleet-wide limit (#3905). The owner may set a
higher or lower level for a period, an issue or a host, weighing how
independent the work is, machine capacity, test load and review capacity.
Record that decision on the issue it covers.

- **Two** substantial managed implementation tasks at once.
- **One more UX task** only when its behaviour, schema and components are
  independent of both, and review capacity remains.
- **One writer per shared financial invariant**, at any level.
- **One expensive development or test job per physical host** — a full suite,
  E2E, a build, a large typecheck. Check what else runs on the host first,
  and wait or use CI rather than contend.
- **Unknown occupancy is not a free slot.** Count a reservation you cannot
  account for as taken.

These limits are for managed agents only. Human contributors keep their
normal rights and are not bound by them ([CONTRIBUTING.md](../../CONTRIBUTING.md)).
A lane over the baseline does not stop someone else's work: it waits, or asks
the owner. None of this creates a coordinator or a review-count rule.

## Reservations, stale sessions and conflicts

A claim, a board reservation or an unpublished worktree is its holder's until
the holder releases it or the owner reassigns it. None of these frees it:

- no comment for a while, or an old claim;
- nothing on the remote (an unpushed branch is not an abandoned one, #2216);
- a red CI run, a usage-limit stop, or a session that cannot be found.

Never take over, push to, rebase, reset, stash in or delete another lane's
branch or worktree, and never open a replacement PR for its issue. If you need
its work, post a `LANE-SYNC:` on the issue with the head SHA you read. If the
holder does not answer and the work is blocked, ask the owner to reassign it.
Unknown occupancy is not a free slot.

After 72 hours without a `LANE-SYNC:` checkpoint or a push to the reserved
branch, the reservation is **released automatically** (owner decision, 28 Oct
2026, #4452; it replaces the 27 Oct rule of asking the owner first). The
coordinator that finds it confirms there was no push, using the branch's push
activity or a manual check when no branch is named. It then posts a `RELEASE:`
comment on the issue or PR citing #4452, after which any lane may claim the
work. A holder that is still working keeps its claim by posting a `LANE-SYNC:`
or pushing within the 72 hours. A release never touches the old lane's branch
or worktree: its unpublished work is not taken over, and a new claim starts
from `main`.

Run `pnpm run lanes:stale` (optionally followed by `owner/repo`) to list open
issues and PRs whose latest `CLAIM:` has been inactive for more than 72 hours.
The [read-only checker](../../scripts/lanes-stale.mjs) prints the lane named in
the claim, its last activity time and the release to post. A later
`LANE-SYNC:` or branch push restarts the timer; `RELEASE` or `HANDOVER` ends that
claim. It reads every comment page and uses GitHub push activity timestamps,
including force pushes, rather than commit dates. PRs fall back to their head
branch; issues need a branch named in the claim. Missing branches are flagged
for a manual push check before releasing. GitHub read failures stop the report.
It uses `gh` when available and public REST reads when `gh` is absent or logged
out. Authenticated reads avoid the public API's lower rate limit. The checker
never posts, labels or edits anything itself; the coordinator checks the thread
and posts the `RELEASE:`.

## Handoffs and checkpoints

A lane stopping before it finishes — end of session, usage limit, waiting on
the owner — commits coherent work on its branch, pushes it if the branch is
its own, and posts a `LANE-SYNC:` checkpoint on the issue: the head SHA, what
is done, the next step, open findings and any stated limits. Long-running
implementors also keep a checkpoint outside the worktree, so a killed session
leaves its state readable. Whoever resumes — the same lane or one the owner
assigns — starts from that checkpoint and the thread, not from a summary.

### When the pre-push checks cannot pass

The pre-push checks (`AGENTS.md` → "Per-issue pipeline") are not skipped to
save work. A Stop hook sends a lane back to them once when its session's own
directory differs from `origin/main` under `src/`; a lane editing another
worktree by absolute path is not reminded. Never use `--no-verify`, a skipped check or a push of known-broken
work to rescue it. Preserve it this way instead:

1. Commit it locally on the lane's own branch, with a commit message naming
   the failing check. Never stash it (the stash is shared across worktrees),
   reset it or delete the worktree.
2. Update the private checkpoint outside the worktree with the failing
   command, the error and the next step.
3. Post a `LANE-SYNC:` on the issue: the local head SHA, that it is unpushed,
   the failing check and why. Name no local path, host or account (the repo is
   public).
4. If the cause is environmental (a missing service, host contention, a known
   flake), say so and stop. If it is in the change, fix it or escalate under
   the circuit-breaker rule.

The reservation holds while the work is unpushed (#2216). Only the holder, or
a lane the owner assigns, resumes it.

## Staying bounded

- An issue never grows on its own. A defect the PR introduces, or one that
  blocks its agreed behaviour, is fixed in the PR. Anything else found along
  the way is filed as a new issue, linked, and left there.
- Research ends when it answers the question, or when another round stops
  adding evidence. Report what is known, what is not, and the limit, rather
  than starting another round.
- Two identical failures trip the circuit breaker (`AGENTS.md` → "Context,
  usage and failure control").

## Reviews: choosing lenses

The lane always reviews its own diff. How many further review lenses run, and
which ones, is the lane's choice (owner decision 3, #3905). It weighs the
change's risk, complexity and uncertainty, and how much validation already
proves. There is no fixed count, no risk-to-count table, and no fixed floor;
zero further lenses is allowed when justified. Money, schema, auth, provider,
capacity and membership-lifecycle changes usually justify independent lenses.
Common lenses are correctness and regression; concurrency; security; money;
migrations; and UX, docs and permission drift. Fold the single-source-of-truth
check (`INV-SSOT`) into one review's brief on every PR; it gets its own lens
only for a substantial new abstraction or refactor.

- The ready comment names each lens that ran, why it was chosen, the head SHA it
  read, and what it found. With no further lens, it says why.
- A lens approves the commit it read. Re-review only the later delta. A
  security blocker's fix gets that lens re-run over the fix only. Otherwise a
  fresh lens reads only newly written code no lens has read.
- A review rejecting one edit to a file does not fence off the file: a
  different, correct change there still belongs in the PR.

Validation, the merge gate and any narrower per-operation prerequisite stay
the same whatever the lens count.

## Asking the owner

The owner does not read blueprints, and is never handed a document to read
(owner rule, 24 Oct 2026). Engineering detail is the agent's to settle.
Low/Medium work needs a concise plan. For High/Critical work, the agent works
out the invariants, counterpart writers, data and rollback, validation and
stop conditions, and keeps them in the issue for reviewers.

Only a genuine business or authorisation question, or a blocker the lane
cannot resolve, goes to the owner. That includes a contradiction between the
issue and the code, a tripped circuit breaker, being stuck at `xhigh`, and a
material scope change. Ask it as a decision pop-up or a series of them:

- plain English;
- the full detail needed to decide;
- the pros and cons of each option;
- the recommendation first.

A visual layout is shown as an Artifact or mock-up, not described in prose.
Before putting options to the owner, read every reply in the thread, fork
maintainers' included.

## Decision provenance

Record what the owner decided exactly as it was given:

- **Pop-up answer:** `DECIDED, <date> (owner, decision pop-up in the <lane>
  session)`, and the body is rewritten in the same sitting.
- **Direct instruction in a session:** name it as one, for example `START
  RECORD — <scope>, <date> (owner, direct instruction in the <lane> session)`.
  Say that it is agent-recorded and not a `thatskiff33` comment. It authorises
  only the session it was given in. A later session cannot act on it. Only a
  `DECIDED` pop-up record or a `thatskiff33` comment carries forward, so ask
  the owner to post one when work will outlast the session.

A record never claims to be the owner's GitHub approval, and never quotes
approval wording. Before you adopt a delegated decision, re-read the thread for
a direct one, and say in your comment that you did.

## Session hygiene (Claude Code)

`/context` must list `CLAUDE.md` and `AGENTS.md`. Use `/usage` before a
sizeable lane and `/clear` at a checkpoint. Use `/mcp` to drop connectors the
task does not need, and `/hooks` when a session misbehaves.
