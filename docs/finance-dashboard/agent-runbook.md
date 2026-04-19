# Finance Agent Runbook

Use this runbook for all future finance-dashboard agent sessions.

## Entry Rule

Start every session by reading `docs/finance-dashboard/handoff.md` and looking for the `Next Prompt` section.

- If `Next Prompt` exists, execute that prompt literally.
- If `Next Prompt` is missing or stale, fall back to the control loop in this file.
- End every session by rewriting `Next Prompt` for the next agent.

## Minimal Context

Read only these sources first:

1. `docs/finance-dashboard/README.md`
2. `docs/finance-dashboard/handoff.md`
3. the current finance phase issue
4. the selected finance task issue
5. the open PR for that task, if one exists

Read `docs/XERO_HANDOFF.md` only if the selected task could overlap Xero boundary work or the current handoff explicitly tells you to.

Read `data-contracts.md` only if the task changes metric definitions.

Read ADRs only if the task changes architecture, access control, Xero boundaries, or storage decisions.

Do not read old chat history or unrelated issues by default.

## GitHub Status Labels

- `status: ready`: the next task an agent should pick up
- `status: in-progress`: active task with ongoing implementation or an open PR
- `status: blocked`: task cannot proceed without an external decision or prerequisite

Keep only one finance task issue in `status: ready` at a time.

## Control Loop

1. If there is an open finance PR, continue that PR first.
2. Otherwise find the single `status: ready` finance task under the earliest incomplete phase.
3. If no ready task exists, create one narrow task under the earliest incomplete phase, then work it.
4. Work exactly one task issue only.
5. Keep the diff scoped to that issue.
6. Update repo docs only if architecture, contracts, or handoff state changed.

## Prompt Model

Use two prompts, not one:

- `Build Prompt`: create or continue implementation on a single task issue and maintain a draft PR
- `Merge Prompt`: review the active PR, merge only if safe, then clean up and set the next task

The next agent should not choose between them from memory. The current agent must write the exact next one into `handoff.md`.

## Branch and PR Rules

- Branch naming: `finance/issue-<issue-number>-<short-slug>`
- One task issue = one branch = one PR
- Open draft PRs by default
- Reuse the existing PR if one already exists for the task
- For finance-only PRs, use the finance PR template at `.github/PULL_REQUEST_TEMPLATE/finance.md`

## Validation Rules

- Run the smallest sufficient validation for the files changed.
- Docs/templates-only changes usually need `git diff --check` plus a manual readability/render pass.
- If routing, schema, auth, Prisma, or build-sensitive files changed, run full build-sensitive validation.

## Merge Gates

Merge only if all of these are true:

- task acceptance criteria are complete
- local validation passed
- PR checks are green
- no unresolved blocker comments or requested changes remain
- branch is up to date with `main`
- diff is still scoped to the task issue

If any gate fails, do not merge. Leave the PR open and record the blocker.

## After Merge

1. squash merge to `main`
2. delete the remote branch
3. sync local:
   - `git checkout main`
   - `git pull --ff-only`
   - `git branch -d <branch>`
4. close the task issue with a short completion comment
5. add a short progress comment to the parent phase issue
6. update `docs/finance-dashboard/handoff.md`

## Handoff Format

Use this exact minimal structure in issue comments and handoff notes:

```text
Done:
- ...

Validation:
- ...

Next:
- ...

Blockers:
- ...
```

Do not paste long logs or repeat broad project summaries.

## Dispatcher Prompt

```text
Use the GitHub workflow for TACBookings finance epic #92.

Read docs/finance-dashboard/handoff.md first.

If a Next Prompt block exists there, execute it literally.

If no Next Prompt block exists, use the control loop in docs/finance-dashboard/agent-runbook.md to determine whether to run the Build Prompt or Merge Prompt.
```

## Build Prompt

```text
Use the GitHub workflow for TACBookings finance epic #92.

Work on exactly one task issue only.

1. Read only these sources first:
- docs/finance-dashboard/README.md
- docs/finance-dashboard/handoff.md
- the current finance phase issue
- the selected finance task issue
- the open PR for that task, if one exists

Read docs/XERO_HANDOFF.md only if the selected task could overlap Xero boundary work or the current handoff tells you to.
Read docs/finance-dashboard/data-contracts.md only if the selected task changes metric definitions.
Read ADRs only if the selected task changes architecture, permissions, Xero boundaries, or storage decisions.

2. Find the next step:
- If there is an open finance PR, continue that PR first.
- Else find the single open finance task issue labeled status: ready under the earliest incomplete finance phase.
- If no ready task exists, create one narrow finance task issue under the earliest incomplete phase with acceptance criteria, validation requirements, and likely files, then work that issue.

3. Keep scope tight:
- Do only the selected task issue.
- Do not broaden scope.
- Do not read unrelated docs, old chat history, or unrelated issues.
- Do not touch unrelated files.

4. Branch and implementation:
- Branch from main as finance/issue-<issue-number>-<short-slug>.
- Implement the task.
- Update repo docs only if architecture, contracts, or handoff state changed.
- Run the smallest sufficient validation. For docs/templates-only work, use `git diff --check` plus manual readability review.

5. PR workflow:
- If no PR exists, open a draft PR linked to the task issue.
- If a PR exists, update it instead of opening another one.
- Finance-only PRs should use `.github/PULL_REQUEST_TEMPLATE/finance.md`.
- PR body must include:
  - what changed
  - why
  - validation run
  - exact next step

6. Merge safety:
- Only merge if all of these are true:
  - task acceptance criteria are complete
  - local validation passed
  - PR checks are green
  - no open blocker comments or unresolved requested changes
  - branch is up to date with main
  - diff is scoped to the task issue
- If any gate fails, do not merge. Leave the PR open with a short blocker note.

7. If safe to merge:
- squash merge to main
- delete the remote branch
- sync local:
  - git checkout main
  - git pull --ff-only
  - git branch -d <branch>

8. Update GitHub and repo for the next agent:
- close the task issue with a short completion comment
- update the parent phase issue with one short progress comment
- update docs/finance-dashboard/handoff.md with:
  - current state
  - what was just completed
  - exact next recommended task
  - blockers, if any

9. Keep handoff minimal.
Use this exact structure in issue comments and handoff:

Done:
- ...

Validation:
- ...

Next:
- ...

Blockers:
- ...

Do not paste long logs. Do not write long summaries.
```

## Merge Prompt

```text
Use the GitHub workflow for TACBookings finance epic #92.

Run the merge-review stage for the current active finance PR only.

1. Read only these sources first:
- docs/finance-dashboard/README.md
- docs/finance-dashboard/handoff.md
- the current finance phase issue
- the current finance task issue
- the active finance PR

Read docs/XERO_HANDOFF.md only if the current handoff or task scope could overlap Xero boundary work.

2. Verify all merge gates:
- task acceptance criteria are complete
- local validation passed or has been rerun if needed
- PR checks are green
- no unresolved blocker comments or requested changes remain
- branch is up to date with main
- diff is scoped to the task issue

3. If any gate fails:
- do not merge
- leave a short blocker note on the PR or task issue if needed
- update docs/finance-dashboard/handoff.md
- write the next exact Next Prompt block for the next agent

4. If all gates pass:
- squash merge the PR to main
- delete the remote branch
- sync local:
  - git checkout main
  - git pull --ff-only
  - git branch -d <branch>
- close the task issue with a short completion comment
- add a short progress comment to the parent phase issue
- set the next narrow finance task to status: ready, if one exists
- update docs/finance-dashboard/handoff.md
- write the next exact Next Prompt block for the next agent

5. Keep the handoff minimal:

Done:
- ...

Validation:
- ...

Next:
- ...

Blockers:
- ...

Next Prompt:
~~~text
...
~~~
```
