# Profile Guide

Codex profile examples live in
[`docs/agents/codex/profiles`](codex/profiles/README.md). They are repository examples,
not installed configuration. Codex local profiles are loaded from
`~/.codex/<profile-name>.config.toml` when selected with
`codex --profile <profile-name>`.

Install examples manually or run:

```bash
scripts/codex/install-local-profiles.sh --install
```

Review the files before installing. Do not add API keys, provider credentials,
or production environment values to profile TOML.

## Suggested Profiles

- `alpine-plan-xhigh`: read-only planning for broad reviews and issue splitting.
- `alpine-review-xhigh`: read-only final review for high-risk diffs.
- `alpine-fix-high`: workspace-write, no network, for supervised fixes.
- `alpine-docs-medium`: workspace-write, no network, for docs-only work.
- `alpine-ui-medium`: workspace-write, no network, for UI-only changes.
- `alpine-autonomous-high`: workspace-write, no network, for low/medium risk
  issue work only after a human accepts the prompt and scope.

## Effort Selection

Effort follows the shape in `AGENTS.md` → "Model selection" and the dated
table in `docs/agents/SUBAGENT_GUIDE.md` → "Model routing table"; this list
only maps the Codex profiles onto it and defines nothing of its own.

- `xhigh`: anything security-shaped, and the reasoning-frontier items the shape
  names.
- `high`: gated areas — money, capacity, membership lifecycle, schema, live
  providers — and broad reviews.
- `medium`: routine Low/Medium implementation, docs, UI copy, small test
  additions, routine issue grooming.
- `low`: trivial formatting, simple file moves, or narrow non-code cleanup.

High and critical risk issues are not unattended coding candidates even if a
profile permits workspace writes.
