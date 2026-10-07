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

Profiles are named by purpose and set sandbox, network and approval only.

- `alpine-plan`: read-only planning for broad reviews and issue splitting.
- `alpine-review`: read-only final review for high-risk diffs.
- `alpine-fix`: workspace-write, no network, for supervised fixes.
- `alpine-docs`: workspace-write, no network, for docs-only work.
- `alpine-ui`: workspace-write, no network, for UI-only changes.
- `alpine-autonomous`: workspace-write, no network, for low/medium risk issue
  work only after a human accepts the prompt and scope.

## Model and effort

Profiles set sandbox/network/approval only; choose model and effort at launch
per `AGENTS.md` → "Model selection" and [`MODELS.md`](MODELS.md), for example
`codex --profile alpine-fix -c model_reasoning_effort=high`.

High and critical risk issues are not unattended coding candidates even if a
profile permits workspace writes.
