# Claude Code Guidance

Claude Code agents follow the same contract as every other automated agent in
this repository. **Read [`AGENTS.md`](AGENTS.md) first** and treat it as the
source of truth; this file only highlights the parts that matter most for an
interactive Claude Code session and never overrides `AGENTS.md`.

## Read First

Start with the ordered reading list in `AGENTS.md` ("Read First"):
`README.md`, `CONFIGURATION.md`, `docs/README.md`, `docs/ARCHITECTURE.md`,
`docs/agents/CODEX_WORKFLOW.md`, `docs/DOMAIN_INVARIANTS.md`,
`docs/STATE_MACHINES.md`, `docs/END_TO_END_TEST_MATRIX.md`, and
`docs/UX_FLOW_MAP.md`.

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
5. Delete the merged branch and confirm `main` CI stays green.

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
- **Claim each issue** as you start it: assign the owner and post a CLAIM comment
  per repo convention. Comment again when the reviewed, fixed, CI-green PR is
  ready — the issue thread is the audit trail.
- **One worktree per lane**; stack dependent issues (PR base = parent branch).
  Because CI only runs on `main`-based PRs, validate a stacked PR via a
  throwaway draft "CI probe" PR of the same commit against `main`.
- **Orchestrator picks the review angle and reviewer count, scaled to risk:**
  3 distinct adversarial lenses for Critical issues (money / schema / auth /
  Xero / capacity / lifecycle), 2 for standard issues. Reviewers try to refute
  each finding before reporting; a fix subagent resolves confirmed findings and
  the orchestrator re-runs the lens to verify (especially security blockers).
- **Prefer Opus subagents;** escalate to the top Mythos-class tier (Fable) only
  for genuinely frontier-complexity Critical work (deep Xero idempotency,
  immutable-charge backfill, irreversible merge / DMMF reasoning, an uncertain
  security blocker). Scale model *and* reasoning effort to the task.
- **Run the full `npm test` before opening a PR**, not just the targeted subset —
  a subagent's targeted run routinely misses regressions its diff caused in
  adjacent suites (frozen snapshots, mocks a new call needs, route-area
  matrices, knip, the blue/green migration ledger). Separate real regressions
  from the repo's known-environmental failures by comparing against `main`'s CI.
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
seeded database). Typical gate before opening a PR:

```bash
npm run lint
npm run db:generate
npm run typecheck
npm test
npm run build
```

Run `npm run db:check-drift` against a shadow database whenever you touch
`prisma/schema.prisma`.
