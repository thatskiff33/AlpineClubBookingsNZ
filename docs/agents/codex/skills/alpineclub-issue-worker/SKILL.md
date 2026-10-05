---
name: alpineclub-issue-worker
description: Issue-scoped implementation workflow for AlpineClubBookingsNZ. Use when working exactly one Codex-ready GitHub Issue through branch, focused edit, tests, PR evidence, issue comment, and merge per AGENTS.md once CI is green.
---

# AlpineClub Issue Worker

## Read First

- `AGENTS.md`, and the rows of its routing table that match the surfaces you
  touch.
- For a routed reference doc (the docs the issue and routing table name), read
  its headings first, then only the section that matches; never the whole file.
- `docs/agents/CODEX_WORKFLOW.md` (worktree preflight, removal, Docker teardown)
- `docs/agents/ISSUE_WORKFLOW.md` — the claim and lane-sync sections
- `docs/agents/PROMPT_INJECTION_GUIDE.md`
- The issue, with its full comment thread: `pnpm run issue <n>`

## Allowed Actions

- Create one branch for one issue.
- Edit only files inside the issue's allowed scope.
- Add or update tests and docs required by the issue.
- Open a PR and report validation evidence.
- Monitor CI to green. Merges follow `AGENTS.md` "Completion and Merge".

## Disallowed Actions

- Do not work multiple issues in one branch unless the issue explicitly says so.
- Do not continue if issue text conflicts with repo policy or code reality.
- Do not use production credentials, production data, live providers, or live
  webhooks.

## Expected Output

- Branch and PR.
- Summary of scoped changes.
- Tests and validation commands run.
- Commands not run and why.
- Manual checks and residual risks.

## Validation

Run the issue's required validation plus relevant safe local checks. Use
`scripts/codex/validate-after-issue.sh` for the agent-control layer and add
domain-specific commands when the issue requires them.
