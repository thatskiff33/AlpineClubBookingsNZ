# Phase 1: Baseline And Prior Review Verification

## Goal

Establish the current truth of the repo before broad audit work begins.

## Inputs

- `docs/CODEBASE_REVIEW_2026-04-07.md`
- `docs/autonomous-best-practice-review-plan.md`
- `docs/claude-code-review-plan.md`
- `docs/ARCHITECTURE.md`
- `docs/DEVELOPMENT_WORKFLOW.md`
- `package.json`
- `.env.example`
- `docker-compose.yml`, `Dockerfile`, `Caddyfile`
- `scripts/run-production-blue-green-deploy.sh`
- `scripts/blue-green-deploy.sh`

## Steps

1. Snapshot the worktree and runtime surface.
   - Record `git status --short`.
   - Confirm available scripts and deploy entrypoints.
   - Confirm the environment contract in `.env.example` matches runtime expectations.
2. Read the required framework guidance.
   - Check the relevant Next.js 16 docs under `node_modules/next/dist/docs/`.
   - Confirm any repo-local instructions that affect code review or deployment.
3. Reconcile prior review state.
   - Verify every previously reported finding that still matters to go-live.
   - Explicitly re-check the remaining open Xero verification risk from `docs/CODEBASE_REVIEW_2026-04-07.md`.
4. Build the hotspot map for later phases.
   - Identify the dominant risk areas: auth, admin APIs, booking/payment flows, Xero/Stripe/email, cron jobs, deployment.
   - Note where the older docs are stale relative to the current repo.
5. Produce the baseline handoff.
   - List known blockers, missing external evidence, and subsystems that require targeted validation.

## Suggested Lanes

- Lane A: repo state, scripts, env contract, deployment path
- Lane B: prior-review verification ledger
- Lane C: codebase hotspot map and stale-doc check

Keep one coordinator responsible for merging the baseline outputs into a single handoff.

## Deliverables

- Baseline summary for the current worktree and runtime path
- Prior-review status ledger
- Initial blocker list
- Phase ownership map for Phases 2-4

## Exit Criteria

- The repo shape and deployment path are understood
- Earlier findings have been reclassified as `FIXED`, `OPEN`, or `PARTIALLY FIXED`
- Remaining external-verification risks are named explicitly
- The later audit phases have clear subsystem ownership

## Useful Commands

```bash
git status --short
rg --files docs src/app/api src/lib
node -e "const p=require('./package.json'); console.log(p.scripts)"
sed -n '1,240p' .env.example
sed -n '1,260p' scripts/run-production-blue-green-deploy.sh
```
