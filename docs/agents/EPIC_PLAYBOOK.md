# Epic and Wave Playbook

**Audience: agent.** Read this when deciding whether work is an epic, or when
running an epic or any multi-issue wave. The always-read rules — roles,
reviews, the per-issue pipeline and the merge gate — are in
[`AGENTS.md`](../../AGENTS.md) and are not restated here. Reading, claiming and
writing issues is [`ISSUE_WORKFLOW.md`](ISSUE_WORKFLOW.md); what is running
right now is on the generated status board
([`COORDINATION.md`](COORDINATION.md#the-status-board)).

## What qualifies as an epic

This section governs **whether the work is an epic at all** — the question that
gets skipped, because by the time anybody reads the shipping rule the label is
already applied. Getting it wrong costs more in one direction: an epic that
should have been three issues holds finished, useful work behind unrelated
work, while three issues that should have been an epic cost a sequencing
mistake, which is visible and fixable.

**An epic is one atomic release outcome**: a coherent thing a club gets, whose
intermediate states should not reach a downstream installation on their own. It
is not a folder, a theme, or somewhere to put everything one walkthrough found.

### The four questions

Before creating an epic — or keeping one that exists — answer all four:

1. **Could a downstream club upgrade after this epic and sensibly remain
   there?**
2. **Can its release note describe a complete useful outcome without saying
   "foundation for the next epic"?**
3. **Does anything user-visible become confusing or incomplete until another
   planned epic lands?**
4. **Will another planned epic soon need to materially change the data model or
   behaviour this one establishes?**

One and two are the positive test and both must be yes: an epic that leaves a
club somewhere they would not want to sit, or whose release note can only
promise a later one, is a stage of something bigger. Three and four are the
negative test and both must be no: a yes to three means the boundary is in the
wrong place, and a yes to four means the epic would establish a contract
already planned to be broken, so the honest unit is the whole of it or a
smaller piece that survives the change. A no on one or two is not automatically
an instruction to make the epic bigger: first ask whether the pieces are
independently shippable, because then the answer is not an epic.

Write the answers into the epic body — the "why this must ship atomically" part
of the issue order in [`ISSUE_WORKFLOW.md`](ISSUE_WORKFLOW.md#writing-an-issue-the-human-explanation-then-the-execution-contract).
A body that cannot answer them is a programme.

### What does not make an epic

None of these, alone or together, is evidence that work belongs in one atomic
epic:

- **Related subject matter.** Reading changes together is not shipping them
  together.
- **A dependency.** B needing A is an ordering fact; if A is complete and safe
  alone, A ships and B follows.
- **Touching the same files.** That is a merge-conflict question, answered by
  sequencing the lanes and naming who rebases, not by a shared branch.
- **Having been found in the same audit, walkthrough or review round.** How work
  was discovered says nothing about how it should be delivered; this is what
  produces wrapper epics.
- **Sharing a technical or domain theme.** "The Xero work" is a portfolio
  grouping: put it in a Project.

**If an issue is independently complete and safe to release, prefer a normal
issue and a normal pull request to `main`**, even when it is related to, or
strictly prior to, other planned work.

### Epic, programme, standalone issue, GitHub Project

| Unit | What it is | How it ships |
| --- | --- | --- |
| **Epic** | One atomic release outcome. Its intermediate child states should not reach downstream installations independently. | Children merge to `main` behind a flag or as inert modules; the last child switches the outcome on ("How multi-step work ships"). |
| **Programme** | Related or ordered work whose stages can each be released safely on their own. | Each stage is a normal issue with its own pull request to `main`, in order. The programme is the plan, not a branch. |
| **Standalone issue** | An independently useful, independently correct fix or feature. | One issue, one branch, one pull request to `main`. |
| **GitHub Project** | A portfolio view of epics, programmes, standalone fixes, blocked work and ownership. | It ships nothing and is not a release boundary. |

**A programme is the right answer far more often than an epic.** Write it as a
tracking issue that lists its stages in order and says in as many words that
each ships on its own; otherwise the next reader sees a parent with children and
reaches for epic machinery. **Project membership is a visibility fact only** and
is never evidence that items should share an integration branch, a migration
batch, an atomic release or one final pull request: two items in one column were
grouped by whoever was looking that morning.

## How multi-step work ships: on `main`, behind a flag or inert

**Owner decision, 27 Oct 2026 (#4464): multi-step work is built on `main`
behind flags or inert modules by default. Integration branches are kept only by
exception, below.** It replaces the 23 Aug 2026 rule that every epic child
targets an `epic/**` branch. The cost of that rule was measured: 212 "Sync main
into epic" pull requests in one month (16% of October's merges), and a money bug
introduced while resolving a sync conflict.

Every child of an epic, and every stage of a programme, is a normal issue with
its own pull request to `main`, and each child is one of:

- **Behind a flag.** The behaviour is switched off by a module, setting or seed
  default (`AGENTS.md` → "Generic product"), so a club or fork that pulls `main`
  sees no change. Test the off state, so "off" is proven rather than assumed.
- **An inert module.** It changes nothing a member or operator sees, and nothing
  reads it yet. Inert means *measurably* inert, not "small". Epic #2988's CT-1
  (#2989) is the worked example: it recorded the club timezone while the old
  environment variable still drove every displayed time.

**Only the compose-and-review child (below) flips the switch** — the default, the
module's wiring — and only after its review. That flip is the release; no other
child makes it. Downstream forks do see the half-built code on `main`: that is
the accepted price, and why it must be inert or off.

**Schema.** Expand migrations are ordinary children, each old-code compatible
against the deployed release ([`BLUE_GREEN_MIGRATION_POLICY.md`](../BLUE_GREEN_MIGRATION_POLICY.md)).
A contract step ships when that policy allows it, in a release after the one that
drained its readers; one that cannot be made inert is the exception below.

**The epic body** lists the children in merge order, the flag or module each one
hides behind, reserved migration prefixes, cross-lane watchpoints (files two
issues touch, and who rebases) and frozen contracts (such as "do not change this
Xero reference string"). It ends with the compose-and-review child below.

### The final compose-and-review child — mandatory, and created with the others

**Every epic carries one last child issue: compose, then review, then switch the
outcome on.** It is the final entry in the child list, created with the others
rather than remembered at the end, and the epic is not complete without it.
Owner decision, 13 Sep 2026 (#3374). Declined: a pull-request-template checklist
line, which has no acceptance criteria or evidence trail; and leaving it to
orchestrator judgement, which is what produced the gap.

Nothing else reviews the epic: every lens read one child's diff, so what the
children only produce in combination goes unread. The child covers exactly:

1. **The composition**, read on `main` rather than in any one child: a guard an
   early child added that a later move or rename disarmed (still green, matching
   nothing); a tree-wide census figure several children re-measured; an ordering
   the epic declared binding; an `INV-*` id minted twice; two children solving
   one problem in ways that now disagree.
2. **Every census or contract suite that reads the tree from disk**, run by name
   with `pnpm run test:named`, selected per [`TESTING.md`](../TESTING.md) →
   "Selecting the censuses a change can reach" over the epic's whole diff — against
   the `main` commit before the first child merged — never from memory. The module graph cannot reach that class, so
   `vitest related` never selects it, and it is the class that catches a
   disarmed guard.
3. **Every conflict resolution an orchestrator wrote**, with each sync's diff as
   evidence and a differential proof wherever a resolution changed
   behaviour-bearing code. This applies only to an epic on an integration
   branch.

It is deliberately not a re-review of the epic diff: nobody reads a 751-file diff
(MEP #2680), and a review claiming to have is worse than a scoped one that says
what it covered. It runs after the last other child merges, then flips the
switch. A review approves the commit it read (`AGENTS.md` → "Orchestration
Model"), so a later merge re-opens it over the delta only.

The worked example is MEP #2680, which absorbed eleven syncs. On the fourth, the
orchestrator resolved a conflict by assuming a provenance vector and a price
vector are always the same length; no local gate caught it, and 22 tests then
returned 400 instead of 200. The fifth sync's three money-path resolutions were
unreviewed when the epic was called ready, until the owner asked.

## The exception: an integration branch

An epic may use an integration branch, `epic/<issue>-<slug>`, only where a schema
**contract** step cannot be made inert. That means a *contract* in the blue/green
sense — it removes or tightens something the previously deployed release reads
or writes — that the epic's switch-on depends on. A migration runs whether or not
a flag is on, so it cannot reach production on `main` ahead of the switch-on. It
is not the contract half of an expand/contract pair the epic itself introduced:
that half still waits for a release after the epic merges (below), and every
migration must be old-code compatible against the pre-epic release or be a
windowed migration the policy allows. **The epic body must name the step and why
it cannot be made inert, or the exception does not apply.** A related theme,
shared files, hiding work from forks, or convenience are not grounds: flags exist
for those. Children then target that branch and it reaches `main` as one merge
once complete. Everything else in this playbook applies to such an epic.

**Merge authority.** A child merging into the branch needs review and green CI,
and the orchestrator may merge it: nothing has reached `main`. The `epic/…` →
`main` pull request follows the merge gate in
`AGENTS.md` → "Completion and Merge" (the one statement of that rule), applied to
the union of the epic. It is an **integration review**, not a re-review: it
carries the migration sequencing, the deploy rehearsal below, each child's review
evidence and the compose-and-review child's findings.

What the branch costs, each handled by whoever runs it:

- **CI.** `ci.yml` and `e2e.yml` trigger on `epic/**` for `pull_request` and
  `push`, so a child gets the real checks on the commit that will merge. A
  throwaway probe pull request against `main` tests a commit outside its stack
  and can pass while the stacked integration is broken.
- **Drift.** Merge `origin/main` into the branch regularly — a merge commit,
  never a force-push; a branch that reconciles only at the end reconciles once,
  badly (#2979's ceiling, and the `CHANGELOG.md` churn #2452 ended).
  `.github/workflows/epic-branch-sync.yml` runs every six hours (00:20, 06:20,
  12:20, 18:20 UTC): one long-lived `main` → `epic/**` pull request per branch,
  merged at once when `pnpm run ci:fast-censuses --base <exact-epic-sha>` passes
  on the locally composed tree and GitHub reports `CLEAN` (#3513, owner decision
  "Cheap narrow check", 6 Oct 2026). Other states wait for the next run or a
  human. The result is a correctness signal from the tree's own censuses, not a
  security verdict, and deliberately not the full nine checks. **A red sync pull
  request is the branch telling you `main` and the epic no longer compose**:
  read it, resolve by hand on a merge branch, never force-push a shared branch
  and never let a merge tool pick a side unread. Its description carries a
  complete `## Concurrency And Lock Impact` section that says the workflow wrote
  it (#3142); it does not cover `main` taking lock A then B while the epic takes
  B then A, which belongs to the `epic/…` → `main` pull request.
- **A hand sync.** `epic/**` takes no direct push, so make a merge branch from
  `origin/epic/…`, run `git merge origin/main`, resolve, run
  `pnpm run ci:fast-censuses --base origin/epic/<n>-<slug>`, then
  `pnpm run epic:sync-body -- --branch epic/<n>-<slug> --out body.md`, check it
  with `pnpm run pr:check body.md --base origin/epic/<n>-<slug>` and open the
  pull request with `--body-file body.md`. The command reads the merge commit,
  names both parents, lists every conflicted or differing file, and refuses when
  one is concurrency-sensitive; then you write that declaration yourself.
  Hand-typing it is how #3718 failed the gate in 23 seconds (#3721).
- **Every migration lands in ONE deploy**, so no child may pair an expand with its
  own contract: the contract half waits for a release after the epic merges,
  because `previous_expand_release` must name something that has drained. Each
  migration needs its own ledger row and must be old-code compatible against the
  **pre-epic** release, not just its sibling
  ([`BLUE_GREEN_MIGRATION_POLICY.md`](../BLUE_GREEN_MIGRATION_POLICY.md)).
  `check-migration-safety-coverage.sh` enforces the expand/contract half.
- **Rehearse the deploy on the epic pull request and paste the transcript.**
  `pnpm run db:rehearse-epic --database-url <throwaway>` applies the base ref's
  migrations, then the epic's, then reads every model with a client generated
  from the **base ref's** schema. What a green run does *not* prove is in the
  policy's "Rehearsing an epic's deploy"; read it before quoting the result.
- **Migration prefixes** are reserved per child in the epic body, and the
  duplicate-prefix check re-runs on every merge into the branch.
- **`pnpm run pr:check` needs `--base`** (`--base origin/epic/<issue>-<slug>`). It
  defaults to `origin/main`, so on a child it sees every earlier child's diff:
  CT-2 (#3004) was judged against 101 changed files rather than its own 35 and
  refused for a concurrency declaration about a schema it never touched.
- **Nothing in the epic ships until all of it ships.** Inherent; the levers are
  small epics and the flag-or-inert default.

### Protecting an integration branch — one-off setup, and the order matters

`epic/**` is **not** covered by `main`'s protection. Somebody with `admin` adds
it once and it covers every future epic; an agent session cannot (the machine
account holds `push`, and that endpoint's `404` means "not permitted", never
"not protected"). **Do it AFTER the workflow triggers include `epic/**`**:
required checks that never reported on a branch wait on "Expected" forever. That
is [`CONTRIBUTING.md`](../../CONTRIBUTING.md#branch-protection)'s three-step
order for any new required context.

Use **classic branch protection**, not a ruleset (rulesets never appear at the
branch-protection endpoint, and this repository carries a disabled one). Pattern
`epic/**`: the same required checks as `main` — the list in
[`CONTRIBUTING.md`](../../CONTRIBUTING.md#required-checks-applied-today) — plus
`strict: false` (up-to-date branches serialise every child), `enforce_admins:
false`, deletions allowed and force pushes blocked. Verify with `gh api
repos/<owner>/<repo>/branches/epic%2F<branch>/protection` (note the `%2F`), check
`rules/branches/<branch>` returns `[]`, and confirm the pattern with `--jq
.protected` on the branch, which needs only read access; a mismatched pattern is
the likeliest mistake. Required checks gate **pushes**, which is why the sync
opens a pull request rather than pushing a merge commit. There are no required
reviews on an integration branch (the code-owner rule was retired 7 Oct 2026,
#3959); its integration gate is the `epic → main` merge.

## Running a wave

A wave is several issues — an epic's children or a programme's stages — run in
parallel lanes and left for owner review. It codifies the model that produced
epic #1926.

### Plan first: the epic and its children are the source of truth

- **First check the epic is an epic** (the four questions). Independently
  shippable items are a programme of normal issues, run as a wave by this same
  playbook.
- Break the work into **topic-sized child issues, one issue = one branch = one
  PR**. Each body follows the human-first order in `ISSUE_WORKFLOW.md`, then
  scope, acceptance criteria, risks and **re-verified `file:line` anchors**.
- Run an adversarial **cross-review of the plan itself** before coding: reviewers
  attack each issue's scope against current `main`, the findings go back into the
  issue bodies, and binding **owner decisions** are recorded in the epic body
  (labelled, e.g. `D-R1..D-Rn`). The refreshed bodies supersede any earlier plan.
- The epic body carries the source items, the owner decisions, the child list
  grouped into **lanes** with an explicit **merge order** ending in the
  compose-and-review child, the watchpoints and frozen contracts above.

### Lanes, worktrees and stacking

- Run up to ~4 **parallel lanes**, each in its own **git worktree** (never share
  a checkout — parallel branches entangle HEAD), one lane per group of issues
  whose code surfaces do not clash.
- Each lane keeps a physical, isolated `node_modules`; sharing only pnpm's store
  lets installs reuse downloads without sharing generated Prisma state. Run the
  preflight in [`CODEX_WORKFLOW.md`](CODEX_WORKFLOW.md) before delegating
  validation.
- Children branch off `main` and target `main` (an exception epic's children
  target its `epic/<issue>-<slug>` branch). Within a lane, stack dependent issues
  on the parent branch and state the base and merge order in the PR body.
- Before removing a merged worktree, inspect its `node_modules` entry: a legacy
  junction must be verified and unlinked non-recursively first. Remove a pnpm
  worktree with `pnpm run worktree:remove <path>` from outside it, because
  `git worktree remove` alone fails half-way on pnpm's junctions and follows any
  other link it meets (#3673). Follow the fail-closed cleanup in
  `CODEX_WORKFLOW.md`.

### Price the delay

Every hour a PR sits unready, `main` moves under it: a shared doc, test matrix or
workflow hunk two lanes both edited, or on a schema lane a migration-timestamp
collision that fails `Migration drift check` and `verify` together, each costing
a re-resolve plus a full CI cycle. Optimise **time-to-ready**, and get sibling
PRs ready in the same window, since each merge re-conflicts every branch still
open behind it.

### Priorities if time runs short

Finish **whole lanes** to their last CI-green PR rather than starting everything
and leaving broken stubs. If a deployment-coupled lane must stop early, say so
prominently in the handoff so the owner can decide on any shim. Drop the
newest or lowest-value additions first.

### Morning handoff

End the run with a summary comment on the epic and a final message to the owner:
per-lane PR list in merge order, CI status of each, **owner decisions needed**
(flag the gated ones), anything unfinished and why, and exact merge-order
instructions (merge-commit only).
