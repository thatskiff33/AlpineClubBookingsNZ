# ADR-006: Deployment, Provider Disclosure, Private Overlay, and Config Non-Travel

## Status

Accepted — 2 August 2026. Foundation decision for epic #2369 (AI Diagnostics).
The owner ratified the config-travel default in §6 on issue #2370: no
Diagnostics configuration travels between deployments — every fork/deployment
configures its own Diagnostics locally (AID-2 #2371 is already built to this
non-travelling default).

**Governance:** no implementation child (#2371–#2379) may weaken the contract in
this ADR without an owner decision recorded on-repo.

**§4 built (14 August 2026, #2861).** The generic private knowledge overlay supply
mechanism described in §4 is implemented: a deployment populates a configured
location (`config/diagnostics-knowledge.json` by default, overridable via
`DIAGNOSTICS_KNOWLEDGE_CONFIG_PATH`) with a typed `knowledge` section, whose entries
are secret-scanned, bounded, cited, defused, and merged into the single bundle
integrity digest — optional, and with no deployment-specific path or content in
public code. See
[`docs/ai-diagnostics/deployment.md`](../deployment.md#the-private-knowledge-overlay-adr-006-4)
and [`docs/diagnostics/KNOWLEDGE_BUNDLE.md`](../../diagnostics/KNOWLEDGE_BUNDLE.md).

## Context

AlpineClubBookingsNZ is open-source and forked per club; a private production
deployment (Tokoroa) tracks the public repo. Two rules already shape this
codebase: public code must never mandate a private deployment's paths or contents
(`docs/adopters/upstream-contributions.md`), and secrets/config are deployment-local
rather than travelling in the config-transfer bundle
(`docs/config-transfer/README.md` deliberately keeps credentials out). Diagnostics
adds a third-party model provider and an optional private knowledge overlay, so
its deployment and fork contract must be explicit — especially because getting it
wrong either leaks a private deployment's internals into public code or ships a
diagnostics config that silently follows a bundle onto the wrong instance.

## Decision

### 1. Default off, deployment-local configuration

Diagnostics ships **off by default**. Its enablement, credential, budget, rate
limits, loop bounds, and provider posture are **deployment-local** configuration,
reached through a documented admin surface. A fork that never enables it carries
no obligation and no cost.

### 2. Provider and data-residency disclosure

> **Built — 21 November 2026 (#5243).** The Modules page shows the statement on
> the AI Diagnostics card and needs a tick before a save switches it on; the
> modules route refuses an unacknowledged switch-on and records an
> `AI_DIAGNOSTICS_DISCLOSURE_ACKNOWLEDGED` audit entry; the AI Diagnostics page
> repeats the statement. See the operator guide.

The operator documentation and the admin configuration surface must **disclose**
that enabling Diagnostics sends bounded operational excerpts (ADR-003) to a
third-party model provider (Anthropic), where they are processed outside New
Zealand, and that personal data may be included when an operator opts a record in
(ADR-004). Disclosure is a shipped contract, not a footnote: an operator must be
able to make an informed data-governance decision before enabling it.

### 3. Optional zero-retention / no-training posture

> **Not built — owner decision, 20 November 2026 (#5243).** Anthropic offers no
> per-request retention control the application could enforce, so there is no
> setting. The application sends no retention instruction; retention, including
> zero retention, is arranged between the club and Anthropic on the account
> behind the Diagnostics key, and the product and operator guide say so. The
> paragraph below is the original proposal, kept for the record.

The deployment can require a **zero-retention** provider posture (the provider's
no-retention / no-training option) as a configuration choice. When set, it is
part of the disclosed posture and is honoured on every provider call. This lets a
privacy-sensitive club use Diagnostics without provider-side retention of its
excerpts.

### 4. A generic, deployment-owned private-overlay supply contract

> **Built — 14 August 2026 (#2861).** Implemented as a `knowledge` section in the
> configured `config/diagnostics-knowledge.json` slot (overridable via
> `DIAGNOSTICS_KNOWLEDGE_CONFIG_PATH`), validated against a typed shape,
> secret-scanned + defused + bounded as untrusted evidence, namespaced under
> `overlay/`, and merged into the single bundle integrity digest. Absent ⇒ the
> public bundle is byte-identical. See the operator guide and KNOWLEDGE_BUNDLE doc.

A deployment may supply an **optional private knowledge overlay** — extra,
deployment-specific diagnostic knowledge layered on top of the public deployed
bundle (#2372). The contract is **generic**:

- public code defines only a documented, generic *mechanism* for supplying an
  overlay (for example a configured location/handle a deployment populates) and a
  typed shape it must satisfy;
- public code **never** names, mandates, or embeds a Tokoroa-specific (or any
  specific deployment's) path, filename, or content;
- the overlay is **optional**: with none supplied, Diagnostics is fully
  functional on the public bundle alone;
- overlay content is evidence and is therefore untrusted, bounded, and cited
  exactly like every other class (ADR-003).

This keeps a private deployment's internals in that deployment, and keeps the
public repo free of private assumptions.

### 5. Module and config reachability

The module flag and configuration must be **reachable** in a standard deployment
(a documented admin route and module toggle), and the readiness/health surface
must be able to report Diagnostics' configured/degraded state — without exposing
the credential (ADR-001, metadata-only, as `getAiAssistantSetupState` does for
Page help).

### 6. Diagnostics config does not travel between deployments

> **Owner-ratified (2 August 2026, #2370): Diagnostics config does NOT travel.**
> No Diagnostics configuration transfers between deployments via the
> config-transfer bundle — it is deployment-local and non-travelling.
> Its credential is already excluded (credentials never travel),
> and its budget, enablement, rate limits, and provider/residency posture are
> environment- and governance-specific decisions that should be made explicitly
> per deployment, not inherited from whichever instance produced a bundle. A
> bundle that quietly enabled a paid provider, or carried one club's spend cap and
> retention posture onto another, would be a governance footgun. Recorded for the
> owner on #2370; if the owner wants a subset (say, non-secret loop bounds) to
> travel, that is an additive, opt-in category in AID-2 (#2371), never a default.

## Consequences

### Positive

- A fork can adopt the public code without inheriting Tokoroa's private knowledge
  or any obligation to configure a paid provider.
- Enabling Diagnostics is an informed, per-deployment governance decision with
  disclosed data residency; retention is arranged with the provider on the
  club's own account.
- Config cannot silently follow a bundle onto an instance whose owner never chose
  to enable a third-party AI provider.

### Negative

- A multi-instance operator configures Diagnostics per deployment rather than
  once — deliberate, and small next to the governance risk it removes.
- The private overlay's generic mechanism is slightly more abstract to build than
  a hard-coded path would be (the abstraction is the requirement).

## Related

- ADR-001 (separate credential/budget; metadata-only status)
- ADR-003 (overlay content is untrusted evidence)
- ADR-004 (retention; what the provider posture governs)
- ADR-005 (the budget/limits this ADR says are deployment-local)
- [`docs/adopters/upstream-contributions.md`](../../adopters/upstream-contributions.md)
- [`docs/config-transfer/README.md`](../../config-transfer/README.md)
- [Threat model](../threat-model.md) — "Deployment / fork" trust boundary.
