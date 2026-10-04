# Models and Effort

**Audience: agent.** Last reviewed **5 Oct 2026**. Re-check this page when a
new model ships; if it is more than three months old, treat the names below as
possibly stale and say so in your brief.

[`AGENTS.md`](../../AGENTS.md) → "Model selection" is the policy: the
orchestrator chooses model and effort per task, preferring the least costly
combination expected to meet the quality bar, and `xhigh` is the ceiling. This
page names the current models so that policy can be applied. It is a default,
not a routing table — depart from it with a one-line reason in the brief.

## Why the defaults are the cheaper flagship

Opus 5.5 and GPT-6.1 Sol are at or near the top tier on agentic coding at a
fraction of the usage of Fable 5.1 and Astra, which consume the shared
allowance several times faster. Where the expensive model's lead is small or
unmeasured, the usage saving wins.

| Comparison | Where the default is as good or better | Where it falls short |
| --- | --- | --- |
| Opus 5.5 vs Fable 5.1 | Agentic coding (Anthropic: SWE-bench Pro 92.8% at `medium` vs 92.3%, about 1/5 the cost per solved task); terminal and repository tasks; faster | The hardest novel reasoning and long-horizon research, where Anthropic recommends Fable when Opus at higher effort still falls short; third-party reports of a lead on security-sensitive code generation (unverified) |
| Sol 6.1 vs Astra | Repository coding (DeepSWE v1.1 roughly level) at about 1/5 the cost; professional document work close | Computer use (Astra slightly ahead); difficult scientific work; no published head-to-head for code or security review |

Token prices are 2.5× (Fable over Opus) and 5× (Astra over Sol); subscription
usage is not a direct conversion, and retries, context and effort all count.

## Defaults

| Work | Claude Code | Codex | Effort |
| --- | --- | --- | --- |
| Orchestrator | Opus 5.5 | Sol 6.1 | `medium`; `high` for a gated wave; `xhigh` for long unattended Critical runs |
| Implementor — gated area (money, capacity, lifecycle, schema, auth, providers) | Opus 5.5 | Sol 6.1 | `high` |
| Implementor — well-specified Low/Medium work, docs, UI copy | Sonnet 5.5 | Sol 6.1 | `medium` |
| Review lens — correctness, invariants, concurrency, security, money | Opus 5.5 | Sol 6.1 | `high`; `xhigh` for a Critical security or money lens |
| Review lens — UX, docs, drift | Sonnet 5.5 | Sol 6.1 | `medium` |
| Search, extraction, mechanical checks with checkable output | Haiku 4.5 or Sonnet 5.5 | Luna | `low` |
| Planning and blueprints for High/Critical work | Opus 5.5 | Sol 6.1 | `high`–`xhigh` |

Terra (`gpt-5.6-terra`) is a previous generation; prefer Luna for cheap
bounded work. Haiku 4.5 has no effort setting and falls well behind on long
coding loops, so keep it to bounded, verifiable tasks.

## Escalating to Fable 5.1 or Astra

Escalate only when one of these is true, and say which in the brief:

- the default at `xhigh` has produced a wrong answer on this task twice, after
  context and instructions were checked;
- the task is in a category in the "falls short" column above and the result
  cannot be cheaply verified.

Never escalate silently, never as a fallback when a model is unavailable, and
never above `xhigh`.

## Setting model and effort

- **Claude Code.** The `Agent` tool takes a `model`; effort comes from the role
  definition or is inherited. The repository's role definitions in
  [`.claude/agents/`](../../.claude/agents/) set both — `implementor`,
  `reviewer` and `explorer` — and a per-call `model` overrides the role's.
  Per-model effort defaults live in each user's `settings.json`
  (`modelSettings`).
- **Codex.** [`.codex/config.toml`](../../.codex/config.toml) sets the
  subagent default, and [`.codex/agents/`](../../.codex/agents/) holds the
  same three roles. Override at launch with `-m <model>` and
  `-c model_reasoning_effort=<level>`. The profiles in
  [`codex/profiles`](codex/profiles/README.md) set only sandbox, network and
  approval.
- Check the effective model where the runtime shows it, and report any
  substitution.

## Sources

- Anthropic, [Prompting Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5)
  and [Optimizing for cost and intelligence](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence).
- OpenAI, [GPT-6.1 Sol](https://openai.com/index/introducing-gpt-6-1-sol/) and
  the [model catalogue](https://developers.openai.com/api/docs/models).
- Vendor benchmarks, not measurements of this repository.
