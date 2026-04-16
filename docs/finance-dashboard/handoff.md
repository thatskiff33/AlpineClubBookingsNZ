# Finance Dashboard Handoff

Last updated: 2026-04-16

## Current State

- Planning scaffold created
- ADR baseline created
- Phase plan documented
- Agent runbook documented
- GitHub issue and PR templates added
- GitHub milestone created: `Finance Dashboard Integration`
- GitHub status labels added: `status: ready`, `status: in-progress`, `status: blocked`
- Epic created: `#92`
- Phase issues created: `#93` through `#100`
- First execution task created: `#101`
- Current active task is `#101` with PR `#102`
- Merge review run for `#101` and PR `#102`

## Decisions Already Locked

- Native TACBookings implementation, not embedded Streamlit
- Separate finance Xero OAuth boundary
- Dedicated finance access model instead of broadening `ADMIN`
- Postgres-backed finance snapshots instead of CSV files

## Immediate Next Step

Done:
- Ran the merge-review stage for task `#101` and PR `#102`

Validation:
- GitHub `verify` check passed on PR `#102`
- PR `#102` merge state is clean with no review blockers
- Branch `finance/issue-101-access-scaffold` is up to date with `main`

Next:
- Narrow PR `#102` so it contains only task `#101` work, or split the planning scaffold into a separate task and PR
- Re-run the merge-review stage after the diff is scoped cleanly to `#101`

Blockers:
- PR `#102` still includes finance planning scaffold and workflow-doc changes beyond task `#101` acceptance criteria, so the one-task/one-PR merge gate fails

## Next Prompt

```text
Use the GitHub workflow for TACBookings finance epic #92.

Work on exactly one task issue only.

1. Read only these sources first:
- docs/finance-dashboard/README.md
- docs/finance-dashboard/handoff.md
- phase issue #93
- task issue #101
- PR #102

2. Narrow the scope of PR #102 so it matches task #101 only:
- keep the dedicated finance access field on `Member`
- keep the finance auth helpers
- keep the `/finance` route scaffold
- keep only the minimal handoff/doc updates needed for the implemented guard strategy
- remove or split the broader finance planning scaffold, issue templates, PR template, and workflow-runbook changes from PR #102

3. If the broader planning scaffold must ship, create a separate finance task issue for that work and move it to a separate branch/PR instead of merging it through #101.

4. Re-run the smallest sufficient validation for the resulting #101 diff. If schema, auth, routing, or Prisma-sensitive files remain, run full build again.

5. Update PR #102 so it reflects only the #101 scope, then rerun the merge-review stage if all merge gates pass.

6. Update handoff with the next exact Next Prompt block before ending the session.
```

## Open Questions

- exact member/admin list for initial finance viewer rollout
- exact member/admin list for initial finance manager rollout
- whether finance reporting needs a new explicit booking type model
- whether any legacy dashboard outputs should remain exportable during transition

## Session Start Checklist

1. Read `README.md`, `agent-runbook.md`, and this file.
2. Read the linked GitHub issue and current PR, if any.
3. Execute the `Next Prompt` block if it exists.
4. Update this file before ending the session if state changed.
