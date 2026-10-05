# Codex Helper Scripts

These scripts support the repo-native Codex workflow. They are intentionally
conservative.

## Safety Defaults

- No script uses production credentials, production databases, production
  backups, live Stripe, live Xero, live SES, live Sentry, or live webhooks.
- No script auto-merges PRs or auto-closes GitHub Issues.
- Scripts that write to local Codex or skill locations require `--install`.
- `run-next-issue.sh` selects at most one issue and defaults to prompt-only.
- High and critical risk issues require explicit override before execution.

## Scripts

```bash
node scripts/codex/create-review-issues.mjs
node scripts/codex/create-review-issues.mjs --create --repo thatskiff33/AlpineClubBookingsNZ --input review-issues.json

node scripts/codex/issue-to-prompt.mjs 123 --repo thatskiff33/AlpineClubBookingsNZ

scripts/codex/run-next-issue.sh --repo thatskiff33/AlpineClubBookingsNZ
scripts/codex/run-next-issue.sh --repo thatskiff33/AlpineClubBookingsNZ --execute

scripts/codex/validate-after-issue.sh
scripts/codex/validate-after-issue.sh --include-lint

scripts/codex/install-local-profiles.sh
scripts/codex/install-local-profiles.sh --install

scripts/codex/install-local-skills.sh
scripts/codex/install-local-skills.sh --install --target repo
```

Codex workflow and label examples live in `docs/agents/examples/`, not
`.github/workflows/` or `.github/labels/`, so GitHub will not load them until a
human copies or renames one into the active GitHub configuration directories.

## Review Issue Input Format

`create-review-issues.mjs --input` accepts JSON shaped as either an array of
issues or `{ "issues": [...] }`.

Each issue can include:

```json
{
  "title": "[Security] Review route guards",
  "body": "Issue body...",
  "labels": ["workstream:security", "risk:high"]
}
```

Creating a proposed issue does not authorise implementation. Leave `agent-ready`
out of draft issue input; the owner applies it by hand after reviewing the issue
and recording the decision under [the issue workflow](../../docs/agents/ISSUE_WORKFLOW.md#recording-a-decision-the-body-must-carry-the-answer).
The label selects work; authorisation and attribution still follow
[`AGENTS.md`](../../AGENTS.md#pre-authorisation-and-attributability).
