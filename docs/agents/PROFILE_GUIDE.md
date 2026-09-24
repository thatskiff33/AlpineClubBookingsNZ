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

The profiles exist for their sandbox, network and approval settings. The
effort in each name is only a starting point: choose the effort for the task in
front of you as `AGENTS.md` → "Model selection" describes, and override it at
launch with `-c model_reasoning_effort=<level>` when the task calls for a
different one.

High and critical risk issues are not unattended coding candidates even if a
profile permits workspace writes.
