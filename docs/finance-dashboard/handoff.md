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

## Decisions Already Locked

- Native TACBookings implementation, not embedded Streamlit
- Separate finance Xero OAuth boundary
- Dedicated finance access model instead of broadening `ADMIN`
- Postgres-backed finance snapshots instead of CSV files

## Immediate Next Step

Done:
- Added the agent runbook and GitHub status-label workflow
- Marked `#101` as the current in-progress task

Validation:
- Repo docs updated
- GitHub labels created

Next:
- Review and merge PR `#102` if checks and diff remain clean
- After merge, create the next narrow `status: ready` task under the earliest incomplete phase

Blockers:
- None

## Next Prompt

```text
Use the GitHub workflow for TACBookings finance epic #92.

Run the merge-review stage for task #101 and PR #102 only.

1. Read only these sources first:
- docs/finance-dashboard/README.md
- docs/finance-dashboard/handoff.md
- phase issue #93
- task issue #101
- PR #102

2. Verify all merge gates:
- task acceptance criteria for #101 are complete
- local validation in PR #102 is still valid for the current diff
- PR checks are green
- no unresolved blocker comments or requested changes remain
- branch is up to date with main
- diff is scoped to #101

3. If any gate fails:
- do not merge
- leave the PR open
- update handoff with blockers and write the next exact Next Prompt block

4. If all gates pass:
- squash merge PR #102 to main
- delete the remote branch
- sync local main
- close #101 with a short completion comment
- add a short progress comment to #93
- create or identify the next narrow finance task under the earliest incomplete phase
- mark that next task as status: ready
- update handoff with the next exact Next Prompt block
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
