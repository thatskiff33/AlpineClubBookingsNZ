# Epic and Wave Playbook

**Audience: agent.** Read this when deciding whether work is an epic, or when
running an epic or any multi-issue wave. The always-read rules — roles,
reviews, the per-issue pipeline and the merge gate — are in
[`AGENTS.md`](../../AGENTS.md) and are not restated here. Reading, claiming and
writing issues is [`ISSUE_WORKFLOW.md`](ISSUE_WORKFLOW.md).

## What qualifies as an epic

"An epic reaches `main` as ONE merge, from an integration branch" below governs
**how** an epic ships. This section governs **whether the work is an epic at
all** — the question that gets skipped, because by the time anybody reads the
shipping rule the label has already been applied.

It is worth getting right in one direction more than the other. An epic that
should have been three issues holds finished, independently useful work off
`main` behind unrelated work, and hands downstream forks nothing at all until
the whole bundle lands. Three issues that should have been an epic cost a
sequencing mistake, which is visible and fixable.

**An epic is one atomic release outcome**: a coherent thing a club gets, whose
intermediate states should not reach a downstream installation on their own. It
is not a folder, a theme, or somewhere to put everything one walkthrough found.

### The four questions

Before creating an epic — or keeping one that already exists — answer all four:

1. **Could a downstream club upgrade after this epic and sensibly remain
   there?**
2. **Can its release note describe a complete useful outcome without saying
   "foundation for the next epic"?**
3. **Does anything user-visible become confusing or incomplete until another
   planned epic lands?**
4. **Will another planned epic soon need to materially change the data model or
   behaviour this one establishes?**

**How to read the answers.** One and two are the positive test and both have to
be yes. An epic that leaves a club somewhere they would not want to sit, or
whose release note can only promise a later one, is a stage of something bigger
rather than a release outcome of its own. Three and four are the negative test
and both have to be no. A yes to three means the boundary is drawn in the wrong
place, because part of the outcome is on the other side of it. A yes to four
means the epic would establish a contract that is already planned to be broken,
so the honest unit is either the whole of it or a smaller piece that survives
the change.

A no on one or two is not automatically an instruction to make the epic bigger.
Ask first whether the pieces are independently shippable, because then the
answer is not an epic at all.

Write the answers into the epic body — the "why this must ship atomically" part
of the issue order in [`ISSUE_WORKFLOW.md`](ISSUE_WORKFLOW.md#writing-an-issue-the-human-explanation-then-the-execution-contract) exists for exactly that. An epic body that cannot
answer these four is the clearest signal available that the work is a
programme. Once it has passed, the child list that body carries ends with the
final compose-and-review child, created alongside the rest — see "The final
compose-and-review child" under the shipping rule below.

### What does not make an epic

None of the following, alone or in combination, is evidence that work belongs in
one atomic epic:

- **Related subject matter.** Two changes being about the same feature is a
  reason to read them together. It is not a reason to ship them together.
- **A dependency.** B needing A is an ordering fact. If A is complete and safe
  on its own, A ships and B follows it.
- **Touching the same files.** That is a merge-conflict question, answered by
  sequencing the lanes and naming who rebases — not by a shared branch.
- **Having been found in the same audit, walkthrough or review round.** How work
  was discovered says nothing about how it should be delivered. This is the one
  that produces wrapper epics, because a review round naturally hands you a list
  and a list looks like a plan.
- **Sharing a technical or domain theme.** "The Xero work" or "the timezone
  work" is a portfolio grouping. Put it in a Project.

**If an issue is independently complete and safe to release, prefer a normal
issue and a normal pull request to `main`** — even when it is related to, or
strictly prior to, other planned work. The standalone issue is the default; an
epic is the exception, and it is the exception that has to argue for itself.

### Epic, programme, standalone issue, GitHub Project

| Unit | What it is | How it ships |
| --- | --- | --- |
| **Epic** | One atomic release outcome. Its intermediate child states should not reach downstream installations independently. | Children target `epic/<issue>-<slug>`; that branch reaches `main` as one gated merge. |
| **Programme** | Related or ordered work whose stages can each be released safely on their own. | Each stage is a normal issue with its own pull request to `main`, in order. The programme is the plan, not a branch. |
| **Standalone issue** | An independently useful, independently correct fix or feature. | One issue, one branch, one pull request to `main`. |
| **GitHub Project** | A portfolio view: active epics, planned epics, programmes, standalone fixes, blocked work, and work owned by a particular maintainer or lane. | It ships nothing. It is not a release boundary. |

**A programme is the right answer far more often than an epic**, and it costs
nothing to choose: the ordering and the shared plan get written down without
holding finished work back. Write it as a tracking issue that lists its stages
in order and says in as many words that each stage ships on its own — otherwise
the next reader sees a parent issue with children and reaches for the epic
machinery.

### GitHub Projects group work; they do not bound a release

A GitHub Project is the recommended place to see the portfolio: active epics,
epics that are planned but not started, programmes and their stages, standalone
fixes, work that is blocked and on what, and work owned by a particular
maintainer or agent lane. Grouping there is cheap, reversible, and touches no
branch.

**Project membership is a planning and visibility fact only. It is never
evidence that items should share:**

- an integration branch,
- a migration batch,
- an atomic release,
- or one final pull request.

Two items sitting in the same Project column were grouped by whoever was looking
at the board that morning. That was not a release decision, and reading one out
of it is how a portfolio tidy-up turns into a branch nobody can land.

## An epic reaches `main` as ONE merge, from an integration branch

**This applies only once the work has passed the four-question test above.** The
default remains one issue, one branch, one pull request to `main`; everything in
this section is the extra machinery a genuine atomic epic needs, and putting
work that did not qualify onto an integration branch buys all of the cost below
and none of the reason for it.

**A child of an epic does not open its pull request against `main`.** Each epic
gets an integration branch, `epic/<issue>-<slug>`; its children target that
branch; and the branch reaches `main` as a single merge once the epic is
complete. Owner decision, 23 Aug 2026.

The reason is downstream forks. They pull `main` rather than upgrading
tag-to-tag as [`UPGRADING.md`](../UPGRADING.md) asks, so a half-built epic on
`main` reaches them mid-build — and an epic is the one unit of work whose
intermediate states are routinely incoherent to a user, because a later child
is what switches the product onto what an earlier one built.

**The narrow exception, which must be written in the epic body or it does not
apply:** a child that is genuinely *inert* — it changes nothing a member or
operator sees, and later children depend on its API — may merge to `main`
directly. Epic #2988's CT-1 (#2989) is the worked example: it recorded the club
timezone while the previous environment variable still drove every displayed
time, so a fork pulling `main` got a dormant subsystem and no behaviour change.
Inert means *measurably* inert, not "small".

**Merge authority.** A child merging into the integration branch needs review
and green CI, and the orchestrator may merge it: nothing has reached `main`, a
fork or production. The **`epic/… ` → `main`** pull request is the single gated
merge, and it needs an explicit owner approval comment whatever the children
touched — the risk gate in `AGENTS.md` → "Completion and Merge" — the one statement of
this rule — applies to the union of the epic, not to each child separately.

**That last pull request is an INTEGRATION review, not a re-review.** Each child
was already reviewed into the branch by the normal adversarial lenses at its own
small size. The epic pull request carries the migration sequencing, the deploy
rehearsal below, a link to each child's review evidence, and the findings of the
final compose-and-review child — the one review that reads what the children
only produce in combination. What that child covers, and when it runs, is the
next subsection; it is stated there once.

### The final compose-and-review child — mandatory, and created with the others

**Every epic carries one last child issue: compose, then review, then open the
epic's pull request.** It is the final entry in the child list, it is created
when the other children are created rather than remembered at the end, and the
epic does not go to `main` without it. Owner decision, 13 Sep 2026 (#3374).
Declined: a checklist line in the epic pull-request template, which has no
acceptance criteria, no state and no evidence trail; and leaving it to
orchestrator judgement, which is what produced the gap.

The reason is that nothing else reviews the epic. Every lens that ran read one
child's diff, so two things reach the gated merge unread:

- **the composition** — a guard an early child added that a later child's move
  or rename silently disarmed (still green, matching nothing); a tree-wide
  census figure that several children and every `main` sync each re-measured;
  an ordering the epic declared binding; an `INV-*` id an epic minted while
  `main` was minting the same one; and two children solving one problem in ways
  that now disagree;
- **the orchestrator's own conflict resolutions**, across every `main` sync the
  epic absorbed — the only code on the branch written by the same party that
  decides what gets reviewed, often in lines neither side's author would
  recognise.

So the child covers exactly those, and nothing else:

1. **The composition**, as listed above, read on the composed branch rather than
   in any one child.
2. **Every conflict resolution the orchestrator wrote**, with each sync's diff as
   the evidence and a differential proof wherever a resolution changed
   behaviour-bearing code rather than only its shape.
3. **Every census or contract suite that reads the tree from disk, run by
   name with `pnpm run test:named`.** Select them per
   [`TESTING.md`](../TESTING.md) → "Selecting the censuses a change can reach",
   over the epic's whole diff against `main`, never from memory: that is the
   class the module graph cannot reach — so `vitest related` never selects
   it — and the class that catches a disarmed guard.

**It is deliberately not a re-review of the epic diff.** Nobody reads a
751-file diff — MEP #2680's size — and a review that claims to have is worse
than a scoped one that says what it covered.

**Timing is part of the contract.** It runs *after* the final `main` sync and
*before* the epic's pull request is marked ready. A review approves the commit
it read (`AGENTS.md` → "Orchestration Model"): a sync landing
afterwards re-opens the child over the delta only — the
new sync's resolutions and any census the sync re-measured — never a fresh pass
over the whole branch.

The worked example is MEP #2680, which absorbed eleven syncs. On the fourth, the
orchestrator resolved a conflict by assuming a provenance vector and a price
vector are always the same length; no local gate caught it, and it surfaced as
22 tests returning 400 instead of 200. The lens dispatched at that resolution
after the fact found the corrected version sound by differential probe and a
second defect beside it — and the fifth sync's three money-path resolutions were
still unreviewed when the epic was called ready. They were reviewed only because
the owner asked.

### What this costs, and what to do about each

Written down here once, because every one of these has to be handled by whoever
runs the next epic.

- **CI.** `ci.yml` and `e2e.yml` trigger on `epic/**` as well as `main`, for both
  `pull_request` and `push`, so a child gets the real nine checks on the commit
  that will actually merge, and the integration branch is re-checked after each
  child lands. Before that trigger existed the workaround was a throwaway draft
  probe pull request of the same commit against `main` — keep that in mind for a
  fork whose workflows predate it, and note why it was only ever second best: a
  probe tests the commit *outside* its stack, so it can pass while the stacked
  integration is broken.
- **Drift.** Merge `origin/main` into the integration branch regularly — a merge
  commit, never a force-push. A branch that only reconciles at the end reconciles
  once, badly; this repository has twice shipped a *wrong* value out of a
  hand-resolved long-lived conflict (#2979's ceiling, and the `CHANGELOG.md`
  churn that #2452 ended).

  `.github/workflows/epic-branch-sync.yml` does this for you every six hours
  (00:20, 06:20, 12:20 and 18:20 UTC):
  one long-lived `main` → `epic/**` pull request per live integration branch,
  auto-merge armed, so a clean sync needs nobody and a conflicted one waits for a
  human — which is the correct division. **A red sync pull request is the branch
  telling you `main` and the epic no longer compose**, so read it rather than
  re-running it. Resolve a conflict by hand on a merge branch, opened as a
  hand sync (below), never by force-pushing a shared branch and never by
  letting a merge tool pick a side unread.

  The description that workflow writes carries a complete
  `## Concurrency And Lock Impact` section, and says in its own words that the
  workflow wrote it. That is not ceremony: the gate is the FIRST step of
  `verify`, a sync diff always holds concurrency-sensitive paths, and while the
  section was missing every sync pull request failed in under half a minute with
  lint, typecheck, knip, the suite and the build all skipped — so the sync
  measured nothing at all (#3142). What it does **not** cover is the one lock
  question a merge really raises: `main` taking lock A then B while the epic
  takes B then A. That belongs to the `epic/…` → `main` pull request, where a
  person writes a real declaration over the epic's real diff.

  **A sync you open by hand gets the same description from a command.** Because
  `epic/**` takes no direct push, a hand sync is a merge branch: make it from
  `origin/epic/…`, run `git merge origin/main`, resolve and commit, then run
  `pnpm run epic:sync-body -- --branch epic/<n>-<slug> --out body.md`, check it
  with `pnpm run pr:check body.md --base origin/epic/<n>-<slug>`, and open the
  pull request with `--body-file body.md`. The command reads the merge commit
  rather than your account of it. It names both parents, lists every file git
  reported as conflicted or that differs from its automatic merge, and refuses
  when one of those is concurrency-sensitive. In that case you write the declaration yourself.
  Hand-typing the description is how #3718 failed the gate in 23 seconds (#3721).
- **Every migration in the epic lands in ONE deploy.** So **no child may pair an
  expand with its own contract.** A contract half waits for a release *after* the
  epic merges, because `previous_expand_release` has to name something that has
  actually drained. Each migration still needs its own ledger row, and each must
  be old-code compatible against the **pre-epic** release rather than merely
  against its sibling. See
  [`BLUE_GREEN_MIGRATION_POLICY.md`](../BLUE_GREEN_MIGRATION_POLICY.md).
- **Rehearse the deploy on the epic pull request, and paste the transcript into
  it.** `pnpm run db:rehearse-epic --database-url <throwaway>` applies the base
  ref's migrations, then the epic's, then reads every model with a client
  generated from the **base ref's** schema. That is how the two `windowed` drops
  were verified rather than asserted, and with a whole epic's migrations arriving
  at once it is the only way to prove the claim. The transcript is part of the
  epic pull request's evidence, alongside the per-child review links — an
  unrehearsed epic merge is asserting old-code compatibility for a set of
  migrations no one has run together. What a green run does *not* prove is in
  [`BLUE_GREEN_MIGRATION_POLICY.md`](../BLUE_GREEN_MIGRATION_POLICY.md) →
  "Rehearsing an epic's deploy"; read it before quoting the result.
  The expand/contract half of this rule is enforced by
  `check-migration-safety-coverage.sh` rather than left to care.
- **Migration prefixes.** Reserve one per child in the epic body up front, so
  queued children cannot collide, and re-run the duplicate-prefix check on every
  merge into the branch rather than only at pull-request time.
- **The child list ends with the compose-and-review child.** Create it in the
  same sitting as the other children and write it into the epic body as the
  last entry in the merge order, per the subsection above. A step that depends
  on somebody remembering it at the end is a step that is sometimes skipped,
  and the epic merge is the worst place for that.
- **Branch protection does not reach an integration branch** unless somebody with
  admin adds it. An agent session cannot: the machine account holds `push`, not
  `admin`, and that endpoint's 404 means "not permitted", never "not protected".
- **`pnpm run pr:check` needs `--base`, and silently misjudges a child without
  it.** It defaults to `origin/main`, so on a child of an epic it sees every
  earlier child's diff as well: CT-2 (#3004) was judged against 101 changed files
  rather than its own 35, and refused for want of a concurrency declaration
  covering a schema and a migration it never touched. Run
  `pnpm run pr:check <body-file> --base origin/epic/<issue>-<slug>`. Both gates
  decide what they ask for from the diff, so the wrong base asks the wrong
  question — and it fails in the safe direction only by luck.
- **Nothing in the epic ships until all of it ships.** Inherent, not an
  oversight. The levers are keeping epics small and using the inert-child
  exception for foundations.

### Protecting an integration branch — one-off setup, and the order matters

An `epic/**` branch is **not** covered by `main`'s protection. Somebody with
`admin` adds it once and it covers every future epic. An agent session cannot:
the machine account holds `push`, and that endpoint's `404` means "not
permitted", never "not protected" — confirm by asking it about `main`, which *is*
protected and returns the identical `404` to a non-admin.

**Do it AFTER the workflow triggers include `epic/**`, never before.** Required
checks that have never reported on a branch sit on *"Expected — waiting for
status"* forever, so protecting first blocks every epic pull request until the
trigger change lands. This is the same three-step order [`CONTRIBUTING.md`](../../CONTRIBUTING.md#branch-protection) gives for adding any required context: merge the workflow change, then
add the protection, then rebase anything already open.

Use **classic branch protection**, not a ruleset. Rulesets never appear at the
branch-protection endpoint, so one can be edited to no effect while appearing to
work — this repository already carries a disabled ruleset that does nothing, and
`main` is protected the classic way, so matching it keeps both readable from the
same command.

Pattern `epic/**`, and the settings that matter, as applied on 23 Aug 2026:

```json
{
  "checks": ["verify", "Migration drift check", "Data migration verification",
             "Static analysis gate", "Playwright E2E", "E2E multi-lodge",
             "Secret scan (gitleaks)", "Image security gate (Trivy CRITICAL)",
             "Dependency audit"],
  "strict": false,          // requiring up-to-date serialises every child
  "enforce_admins": false,  // matches main; an owner can unblock themselves
  "deletions": true,        // or the branch cannot be deleted after the epic merges
  "force_pushes": false
}
```

Verify with `gh api repos/<owner>/<repo>/branches/epic%2F<branch>/protection`
(note the `%2F`), and check `rules/branches/<branch>` returns `[]` to confirm no
ruleset is quietly involved. A non-admin can still confirm the *pattern* matches
with `gh api repos/<owner>/<repo>/branches/epic%2F<branch> --jq .protected`,
which needs only read access — that is the check most worth running, because a
mismatched pattern is the likeliest mistake and it reports `false`.

**Two consequences of that configuration, both load-bearing.** Required status
checks gate **pushes**, not only merges, so nothing lands on an integration branch
without the nine checks — which is why the sync opens a pull request from
`main` rather than pushing a merge commit it has just created. And
`required_pull_request_reviews` is deliberately absent (`main` has it with a count
of `0`, plus the code-owner rule applied on 2 Oct 2026 — `AGENTS.md` →
"Pre-authorisation and attributability"); on an
integration branch the pull request arrives from the workflow model rather than
from enforcement, and the owner's gate is the `epic → main` merge.

## Running a wave

A wave is several issues — an epic's children or a programme's stages — run
in parallel lanes and left for owner review. It codifies the model that
produced epic #1926.

### Plan first: the epic and its children are the source of truth

- **First check the epic is an epic** — the four-question test above. A review
  round hands you a list, and a list looks like a plan; independently shippable
  items are a programme of normal issues, run as a wave by this same playbook.
- Break the work into **topic-sized child issues, one issue = one branch = one
  PR**. Each child issue body follows the human-first order in `ISSUE_WORKFLOW.md`, then scope,
  acceptance criteria, risks, and **re-verified `file:line` anchors**.
- Run an adversarial **cross-review of the plan itself** before coding: have
  reviewers attack each issue's scope against the current `main`, integrate the
  findings back into the issue bodies, and record binding **owner decisions**
  (label them, e.g. `D-R1..D-Rn`) in the epic body. The refreshed issue bodies
  then supersede any earlier plan document.
- The epic body carries: the source items, the owner decisions, the child list
  grouped into **lanes** with an explicit **morning merge order** ending in the
  compose-and-review child (above), cross-lane
  **watchpoints** (files touched by more than one issue, and who rebases), and
  any frozen contracts (e.g. "do not change this Xero reference string").

### Lanes, worktrees and stacking

- Run up to ~4 **parallel lanes**, each in its own **git worktree** (never share
  a checkout — parallel branches entangle HEAD). One lane per group of issues
  whose code surfaces do not clash.
- Each lane keeps a physical, isolated `node_modules`; sharing only pnpm's store
  lets installs reuse downloaded packages without sharing generated Prisma
  state. Run the runtime/dependency preflight in
  [`CODEX_WORKFLOW.md`](CODEX_WORKFLOW.md) before delegating validation.
- Epic children target `epic/<issue>-<slug>`; it reaches `main` as one merge, so
  no fork pulling `main` catches an epic half-built. Rule, merge authority, costs
  and the inert-child exception (which the epic body must claim) are in "An epic
  reaches `main` as ONE merge" above. CI runs on `epic/**`.
- Non-epic issues branch off `main`. Within a lane, stack dependent issues on the
  parent branch and state the base + merge order in the PR body.
- Before removing a merged worktree, inspect its `node_modules` entry. A legacy
  junction must be verified and unlinked non-recursively before `git worktree
  remove`; otherwise Windows cleanup can traverse the junction and erase its
  shared target. A pnpm worktree is removed with `pnpm run worktree:remove
  <path>` from outside it, because `git worktree remove` alone fails half-way on
  pnpm's junctions and follows any other link it meets (#3673). Follow the fail-closed cleanup in `CODEX_WORKFLOW.md`.

### Price the delay

Every hour a PR sits unready, `main` moves under it. The changelog no longer contributes (#2452, #2451).
What is left still costs — a shared doc, test matrix or workflow hunk two
lanes both edited, and on a schema lane a migration-timestamp collision that
fails `Migration drift check` and `verify` together, each costing a re-resolve
plus a full CI cycle. Optimise
**time-to-ready**, and get sibling PRs ready in the same window rather than
serially, since each merge re-conflicts every branch still open behind it.


### Priorities if time runs short

Finish **whole lanes** to their last CI-green PR rather than starting everything
and leaving broken stubs. A lane's later issues are worthless half-done. If a
deployment-coupled lane must stop early, say so prominently in the handoff so the
owner can decide on any shim. Drop the newest/lowest-value additions first.

### Morning handoff

End the run with a summary comment on the epic and a final message to the owner:
per-lane PR list in merge order, CI status of each, **owner decisions needed**
(flag the gated ones explicitly), anything unfinished and why, and exact
merge-order instructions (merge-commit only; GitHub retargets stacked PRs as
parents merge and branches delete).
