# Claude Code Guidance

Claude Code agents follow the same contract as every other automated agent in
this repository. **Read [`AGENTS.md`](AGENTS.md) first** and treat it as the
source of truth; this file only highlights the parts that matter most for an
interactive Claude Code session and never overrides `AGENTS.md`.

## Read First

`AGENTS.md` → "Read First" is now a small always-read core plus a routing table
(#2691). The core is `AGENTS.md`, this file, and `docs/DOMAIN_INVARIANTS.md` —
the invariant **index**, where every rule the system must never break carries a
permanent id (`INV-CAP-021`) with one line saying what it covers and which file
under `docs/invariants/` holds it.

Everything else is routed: before you change something, find the row in that
table that matches it and read what the row names. The nine documents that used
to be mandatory are all still authoritative and all still in the table — reading
the row that applies to you is not optional. Cite rules by id, never by line
number.

## Finish the job: Completion and Merge

At the successful end of a meaningful piece of work, do not stop at "code
written." Follow `AGENTS.md` → "Completion and Merge":

1. Push the branch and open a PR using `.github/pull_request_template.md`.
2. Monitor CI to green. Fix any failure — lint, typecheck, `npm test`, build,
   migration-drift, dependency/secret/static scans — and push until every
   required check passes. `main` is now branch-protected (the `verify`,
   `Migration drift check`, `Playwright E2E`, `E2E multi-lodge`, and
   `Static analysis gate` checks
   must pass to merge, and force-pushes/deletions are blocked), but because
   `enforce_admins` is off and no review approval is required, an admin merge can
   still occasionally land `main` red, so keep comparing against `main`'s own
   latest CI before assuming a failure is yours.
3. Apply the risk gate:
   - **Auto-merge eligible:** docs, agent workflow, admin/public UI copy, labels,
     help text, and other Low/Medium-risk work that does not touch money,
     booking capacity, membership/family lifecycle, schema/migrations,
     auth/security/privacy, or live providers (Xero/Stripe/SES/Sentry).
   - **Owner approval required:** every Critical/High-risk change in those areas.
     Hand off with full evidence and wait.
4. Merge eligible PRs with a **merge commit** — never squash, rebase-merge, or
   force-push. Close a linked issue only when its PR is eligible and merged.
5. Close the linked issue at merge time with a plain-English close-out comment:
   what shipped, the delivering PR, what the reviews found and how it was
   fixed, and any follow-up issues by number. A follow-up named anywhere must
   exist as a filed issue before merge — never as comment prose only.
6. Delete the merged branch and confirm `main` CI stays green.

## Orchestrate with subagents

Follow `AGENTS.md` → "Orchestration Model": the interactive session acts as
orchestrator (claims, worktrees, GitHub, PRs, CI, merges) and delegates bulk
implementation to implementor subagents working in per-issue worktrees, then
runs adversarial-review subagents over the diff before opening the PR. Scale
subagent model/effort to task complexity, and run independent issues as
parallel lanes only when their code surfaces do not clash.

For an epic broken into child issues, or any run of several related issues at
once, follow `AGENTS.md` → "Wave Orchestration Playbook" in full. The essentials
for an interactive Claude Code session:

- **Plan as epic + child issues first.** One issue = one branch = one PR. Each
  child issue carries a plain-English explainer, scope, acceptance criteria, and
  re-verified `file:line` anchors; cross-review the plan adversarially and fold
  the findings + binding owner decisions back into the issue bodies before
  coding. The epic body lists the children in **lanes with a merge order** and
  the cross-lane watchpoints.
- **Read every issue with `npm run issue -- <n>`**, never `gh issue view` — it
  prints the body, every comment, and a loud warning when the body still shows
  unticked options that a comment has already settled. **And when you record a
  decision, rewrite that issue's body in the same sitting** (decision at the top,
  options struck through, link to the deciding comment): the body is what people
  read, so the body must carry the answer. Both rules are binding and both live
  in full in
  [`docs/agents/ISSUE_WORKFLOW.md`](docs/agents/ISSUE_WORKFLOW.md#recording-a-decision-the-body-must-carry-the-answer).
- **Claim each issue** as you start it: assign the owner and post a CLAIM comment
  per [the convention](docs/agents/ISSUE_WORKFLOW.md#claiming-and-talking-between-lanes).
  Comment again when the reviewed, fixed, CI-green PR is
  ready — the issue thread is the audit trail.
- **One worktree per lane**; stack dependent issues (PR base = parent branch).
  Because CI only runs on `main`-based PRs, validate a stacked PR via a
  throwaway draft "CI probe" PR of the same commit against `main`.
  Follow `docs/agents/CODEX_WORKFLOW.md` → "Windows worktree runtime and
  dependency preflight": each branch keeps a physical, isolated `node_modules`
  and shares only npm's cache, never a dependency junction or generated Prisma
  Client.
- **Delegate deliberately.** Every subagent re-establishes context, re-explores,
  and reports back, and the orchestrator then re-reads that report — so the
  payoff has to exceed that overhead. Do not spawn one for work you could finish
  in a handful of tool calls, do not split one modest job across several, and
  keep routine verification in the orchestrator loop rather than delegating it.
  Reserve subagents for genuinely independent, sizeable tracks: per-issue
  implementation lanes, wide multi-file investigations, and the review lenses
  below.
- **Orchestrator picks the review angle and reviewer count, scaled to risk:**
  3 distinct adversarial lenses for Critical issues (money / schema / auth /
  Xero / capacity / lifecycle), 2 for standard issues. Reviewers try to refute
  each finding before reporting; a fix subagent then resolves confirmed findings.
  **Re-run the lens only for security blockers**, where the fix itself can reopen
  a symmetric hole — elsewhere stop after the fix rather than paying a third pass
  over ground two agents already covered.
- **Prefer Opus subagents;** escalate to the top Mythos-class tier (Fable) only
  for genuinely frontier-complexity Critical work (deep Xero idempotency,
  immutable-charge backfill, irreversible merge / DMMF reasoning). Scale model
  *and* reasoning effort to the task.
- **Never route security work to Fable — keep it on Opus at `xhigh` effort.**
  Fable's safety classifiers target cyber content, so a security review can come
  back refused as `stop_reason: "refusal"` on an HTTP 200 — it reads like a clean
  pass, not an error — and Fable's bug-finding gains explicitly exclude security
  analysis. Opus refuses far less here, and falls back rather than stopping
  outright.
- **`xhigh` is the effort ceiling — never `max`, on any lane** (owner directive,
  10 Aug 2026): `max` overthinks and produces worse outcomes; `xhigh` is
  sufficient for the hardest security and Critical work.
- **Split fast local checks from full CI gates.** Locally generate Prisma, lint,
  typecheck, run focused touched/adjacent tests, mutation-test new guards, and
  run docs linkcheck or knip when their surfaces change. Then push the draft PR:
  PR CI owns the full test, build, migration-drift, E2E, scan, and container
  gates. Run a full suite locally only to diagnose CI or when CI is unavailable,
  and record why.
- **PRs open as drafts and stay draft** until fully reviewed, fixed, and
  CI-green; then flip to ready and post an owner-addressed "merge ready" comment
  covering what was built, review findings, fixes, decisions, and carry-forward.
- **Residual risks are resolved in the PR — never just noted** (owner
  directive, 30 Jul 2026; full rule in `AGENTS.md` §6): ideally iterate the PR
  until zero residuals remain, and flip to ready only then. An owner-decision
  residual holds the PR draft while the question is put to the owner, with the
  fix landing in the same PR. Carrying one into a new issue is acceptable when
  justified (overnight run, needs a full planning pass) — filed immediately and
  linked, never left as prose — but in-PR resolution is always the ideal.

## Keep docs in lockstep

Whenever a feature is added, changed, or removed, update everything it touches in
the same PR: `README.md`, the relevant `docs/` guides, and any implementation or
operator notes. Keep code, tests, and docs aligned. Skip doc churn only for
incidental internal refactors that change no contract or behavior.

Ship the changelog entry as a **new `changelog.d/<pr-number>-<slug>.md`
fragment** in the same PR — never by editing `CHANGELOG.md`'s `## Unreleased`
list, which is what made concurrent lanes conflict daily (#2452).
`changelog.d/README.md` documents the house entry style, the
`changelog: none — <reason>` marker for a change that genuinely needs no entry,
and the release-time compile. This is the one item on the lockstep list that CI
enforces — see "Local validation" below.

## Safety (see `AGENTS.md` for the full list)

- No production credentials, databases, backups, or live providers (Stripe,
  Xero, SES, Sentry, webhooks) for exploratory work.
- Money stays in integer cents; booking dates stay NZ date-only lodge nights.
- Webhooks and cron jobs stay idempotent; keep external provider calls outside
  long database transactions.
- Security, payment, booking, membership, Xero, and Stripe work needs high or
  xhigh reasoning effort and owner review before merge.

## Local validation

Tests need `DATABASE_URL` pointed at an unreachable dummy (do not point at a live
seeded database). First run the Windows runtime and isolated-dependency preflight
in `docs/agents/CODEX_WORKFLOW.md`. The normal fast local gate before pushing a
draft PR is:

```bash
npm run db:generate
npm run lint
npm run typecheck
npm test -- src/path/to/touched.test.ts # replace with focused test paths
npm run docs:linkcheck  # when docs change
npm run docs:indexcheck # when docs change, or when you cite an INV-* id
npm run knip            # when files or exports change
```

GitHub Actions runs the full `npm test`, build, migration-drift, E2E,
static/secret/dependency, and container gates. Do not duplicate them locally
before push unless diagnosing a CI failure or CI is unavailable.

Two `verify` gates read the PR itself rather than the code, so a lint-clean,
typecheck-clean PR can still fail on them:

- **Changelog entry** — fails a PR that changes a non-test file under `src/` or
  `prisma/` and carries neither a `changelog.d/` fragment nor the
  `changelog: none — <reason>` marker in the PR body.
- **Concurrency declaration** — keyed entirely on the diff. The
  `## Concurrency And Lock Impact` section is **required, and cannot be `N/A`**,
  when the diff touches a non-test file on a sensitive path (money, capacity,
  lifecycle, webhook/cron, Xero or Stripe modules, `prisma/schema.prisma`,
  `prisma/migrations/`) — even for a read-only change. When the diff touches no
  such file the section is not asked for at all and may be omitted (#2726),
  which is how a Dependabot PR passes without the template. Fill the template in
  anyway; the gate is a floor, not the standard.

Both parse the PR body, so **editing the body alone does not re-run Actions** —
push an empty commit after fixing one. That makes a wrong body expensive: each
attempt costs a full CI cycle and each gate reports only its FIRST failure, so a
body with three format problems takes three cycles to discover them.

**Write the body to a file and check it before you open the PR:**

```bash
npm run pr:check -- /path/to/body.md      # runs BOTH gates offline, in ~1s
gh pr create --body-file /path/to/body.md # same file, once it passes
```

It calls the same exported validators the `verify` job runs, reports both gates
rather than stopping at the first, and needs no network or PR to exist. Two rules
cause nearly every failure: the headings and field labels are matched **exactly**
(copy them from `.github/pull_request_template.md`, do not reword), and each
field's value must sit on the **same line as its label** — a value wrapped onto
the next line reads as empty.

It does need to be able to read the diff, because that is what both gates key
on. If it cannot resolve the base — an unfetched `origin/main`, a `--base` ref
that does not exist — it reports failure instead of a green it cannot stand
behind, and refuses a ticked `N/A` on the same grounds. Run `git fetch origin
main` (or pass `--base <ref>`) and check again.
