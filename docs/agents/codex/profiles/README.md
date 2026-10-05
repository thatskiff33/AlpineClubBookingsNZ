# Codex Profile Examples

These TOML files are examples for local Codex profiles. They are not installed
automatically and contain no secrets.

Codex local profiles are selected with:

```bash
codex --profile alpine-plan -c model_reasoning_effort=<level>
```

For current Codex releases, profile files live in:

```text
~/.codex/<profile-name>.config.toml
```

Install these examples only after reviewing them:

```bash
scripts/codex/install-local-profiles.sh --install
```

Profiles set sandbox, network and approval only; choose the model and effort at
launch. Use `docs/agents/PROFILE_GUIDE.md` to choose a profile. Do not use production
credentials, production data, live providers, or live webhooks in any profile.
