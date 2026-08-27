# Change the code

Audience: Developer, Agent

This is one of the repository's two documentation entry points: everything
needed to change the product safely. The other,
[Run this for your club](../adopters/README.md), is the adopter and operator
path — nothing on it is required reading to make a code change, and nothing here
is required reading to deploy the product.

## Start here

**Automated agents:** [`../../AGENTS.md`](../../AGENTS.md) is the contract and
the only entry point you need. It carries the always-read core, the routing
table that names what to read for the change you are about to make, the safety
rules, the orchestration model, and the merge gate. Read it first and let its
routing table bring you back here.
[`../../CLAUDE.md`](../../CLAUDE.md) is the compact Claude Code adapter over the
same contract.

**Humans:** read [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) for local
setup, the development rules and the pull-request contract, then
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) for the runtime shape — module
boundaries, the data model, integrations, cron jobs, and the mermaid maps.

Either way, [`../DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) is the index of
every rule the system must never break. Each rule has a permanent id
(`INV-CAP-021`, `INV-MONEY-004`), a one-line description, and the file it lives
in. Cite rules by id, never by line number.

## Domain and invariants

- [`../DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — the invariant index.
  The domain files it routes to live in [`../invariants/`](../invariants/):
  [money](../invariants/money.md),
  [payment and settlement](../invariants/payment-and-settlement.md),
  [booking dates and capacity](../invariants/booking-dates-and-capacity.md),
  [booking modifications](../invariants/booking-modifications.md),
  [booking requests](../invariants/booking-requests.md),
  [booking policy exceptions](../invariants/booking-policy-exceptions.md),
  [additional payment chasing](../invariants/additional-payment-chasing.md),
  [member-guest consent](../invariants/member-guest-consent.md),
  [adult member hosting](../invariants/adult-member-hosting.md),
  [membership lifecycle](../invariants/membership-lifecycle.md),
  [subscription lockout pricing](../invariants/subscription-lockout-pricing.md),
  [public content](../invariants/public-content.md),
  [analytics and privacy](../invariants/analytics-and-privacy.md),
  [integrations](../invariants/integrations.md),
  [operations](../invariants/operations.md),
  [product configuration](../invariants/product-configuration.md), and
  [single source of truth](../invariants/single-source-of-truth.md).
- [`../invariants/SCHEME.md`](../invariants/SCHEME.md) — how invariant ids are
  allocated and what an entry must contain.
- [`../invariants/_FOLLOW_UPS.md`](../invariants/_FOLLOW_UPS.md) — invariant work
  that is known and not yet done.
- [`../STATE_MACHINES.md`](../STATE_MACHINES.md) — every status lifecycle:
  booking, payment, membership, waitlist, bed allocation, email retry, Xero
  outbox, cron recovery, sign-in, and two dozen more.
- [`../CLUB_TIME_KERNEL.md`](../CLUB_TIME_KERNEL.md) — the one place dates and
  times turn into each other: the calendar-date / instant / club-local-scheduled
  distinction, where the club's zone comes from, and why a wall time may not
  exist or may exist twice.
- [`../CAPACITY_MODEL.md`](../CAPACITY_MODEL.md) — how each lodge's bookable
  capacity is decided in every configuration.
- [`../CONCURRENCY_AND_LOCKING.md`](../CONCURRENCY_AND_LOCKING.md) — the
  advisory-lock families (capacity, credit, member-night, single-domain), what
  each protects, and the ordering disciplines. Read before changing any lock key
  or any capacity or credit write path.
- [`../UX_FLOW_MAP.md`](../UX_FLOW_MAP.md) — the screen and navigation map used
  by issue work.
- [`../COVERAGE_MATRIX.md`](../COVERAGE_MATRIX.md) — every admin route area
  mapped to its documentation or its gap.

## Architecture and data

- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — the system design, and the
  binding statement of the canonical admin-settings edit pattern.
- [`../BLUE_GREEN_MIGRATION_POLICY.md`](../BLUE_GREEN_MIGRATION_POLICY.md) — how
  a migration must be structured for safe cutover, and the verification fixture
  a migration that rewrites existing club data must ship with it.
- [`../PUBLIC_PAGE_CONTENT_TOKENS.md`](../PUBLIC_PAGE_CONTENT_TOKENS.md) — the
  content-token contract behind the authoritative public blocks.
- [Dataset Reset inventory](../agents/DATASET_RESET_INVENTORY.md) — the included
  admin/finance datasets, their true defaults, what a reset preserves, and what
  it excludes.

## Testing

- [`../TESTING.md`](../TESTING.md) — the Vitest harness and the frozen test
  clock: every run has a fixed "today", how to write a date-bearing test, the
  counted opt-out, and the rollover canary. Read before adding any test that
  mentions a date.
- [`../END_TO_END_TEST_MATRIX.md`](../END_TO_END_TEST_MATRIX.md) — the journeys
  and their coverage.
- [`../E2E_PLAYWRIGHT.md`](../E2E_PLAYWRIGHT.md) — the Playwright browser suite
  driving the Critical journeys against the staging compose stack.
- [`../STAGING_ACCESSIBILITY.md`](../STAGING_ACCESSIBILITY.md) — the
  non-production browser and Lighthouse checks.
- [`../LOAD_TESTING.md`](../LOAD_TESTING.md) — the k6 HTTP load harness in
  [`../../load/`](../../load/README.md), its thresholds, and its safety rails.

## Security

- [`../SECURITY.md`](../SECURITY.md) — the in-repository security notes.
- [`../SECURITY-ATTACK-SURFACE.md`](../SECURITY-ATTACK-SURFACE.md) — the
  attack-surface map.
- [`../TOKEN_HASHING.md`](../TOKEN_HASHING.md) — the current hash-at-rest token
  design.
- [`../../SECURITY.md`](../../SECURITY.md) — the public disclosure policy.
  Report a suspected vulnerability privately, never in an issue or pull request.
- [`../../REVIEW.md`](../../REVIEW.md) — a **historical** record: the
  production-hardening review of 15 July 2026, written at remediation altitude
  against `origin/main @ 297216a7`. It is a point-in-time report, not a live
  list of open defects; each finding names the issue that tracks it, and that
  issue is where the current status lives.

## Writing documentation

- [`../STYLE_GUIDE.md`](../STYLE_GUIDE.md) — documentation style, the audience
  labels, the pinned locations for operator and member guides, the guide
  skeleton, and the screenshot, mermaid and linking conventions. Follow it
  whenever you add or change a page.
- [`../images/README.md`](../images/README.md) — the deterministic screenshot
  capture harness.
- [`../../changelog.d/README.md`](../../changelog.d/README.md) — the changelog
  fragment house style, and the no-entry marker for a change that genuinely
  needs none.

## Agent workflow

- [`../../AGENTS.md`](../../AGENTS.md) — the contract. Everything below is
  routed from it.
- [`../agents/SCOPED_CONTEXT.md`](../agents/SCOPED_CONTEXT.md) — the
  tracked-only, bounded code/import/Prisma context locator shared by Codex and
  Claude Code.
- [`../agents/CODEX_WORKFLOW.md`](../agents/CODEX_WORKFLOW.md) — the operating
  guide for Codex agents, including the Windows worktree runtime and
  dependency preflight, and lane-owned Docker teardown with the report-only
  `npm run stale-containers` debris check.
- [`../agents/ISSUE_WORKFLOW.md`](../agents/ISSUE_WORKFLOW.md) — issue
  contracts: the human-first issue-body order, the four-question test for
  whether work is an atomic epic at all (and how an epic differs from a
  programme, a standalone issue and a GitHub Project), how an epic ships from
  its integration branch, claiming, recording a decision, and what never goes
  in a public artifact.
- [`../agents/CODEX_PROMPTS.md`](../agents/CODEX_PROMPTS.md) — invocation
  prompts, and the [skill definitions](../agents/codex/skills/README.md) they
  draw on.
- [`../agents/PROFILE_GUIDE.md`](../agents/PROFILE_GUIDE.md) — execution
  profiles, and the [profile definitions](../agents/codex/profiles/README.md).
- [`../agents/SUBAGENT_GUIDE.md`](../agents/SUBAGENT_GUIDE.md) — when to spawn a
  subagent and how to brief one.
- [`../agents/REVIEW_SEVERITY.md`](../agents/REVIEW_SEVERITY.md) — the review
  severity scale.
- [`../agents/PROMPT_INJECTION_GUIDE.md`](../agents/PROMPT_INJECTION_GUIDE.md) —
  handling untrusted issue, pull-request and provider text.

## Feature hubs

Larger subsystems keep their own hub, and each links back here.

- **Operational Xero** — [`../xero/ARCHITECTURE.md`](../xero/ARCHITECTURE.md):
  the module map, the reconciliation-ledger data model, and sequence diagrams
  for the outbound, inbound and repair flows.
- **Finance dashboard** —
  [`../finance-dashboard/README.md`](../finance-dashboard/README.md): reporting
  contracts, architecture decisions, data contracts, and the test plan.
- **Multi-lodge support** — [`../multi-lodge/README.md`](../multi-lodge/README.md):
  the scoping contract, implementation plan, and test plan for more than one
  lodge property. Update
  [`../multi-lodge/lodge-scoping-contract.md`](../multi-lodge/lodge-scoping-contract.md)
  **before** changing the scoping of any model, not after.
- **Lobby display** — [`../lobby-display/README.md`](../lobby-display/README.md):
  the subsystem brief, design, ADRs, and the
  [operating guide](../lobby-display/operating.md).
- **AI Diagnostics** — [`../ai-diagnostics/README.md`](../ai-diagnostics/README.md):
  the admin-only, read-only diagnostics assistant. Its
  [architecture](../ai-diagnostics/architecture.md), the
  [security verification matrix](../ai-diagnostics/e2e-matrix.md), the
  [typed page context](../ai-diagnostics/page-context.md), the
  [SELECT-only tool substrate](../ai-diagnostics/tools.md), the tool packs, the
  [threat model](../ai-diagnostics/threat-model.md) and the ADRs. Off by
  default, and separate from the member-facing
  [AI Help Assistant](../guides/ai-help.md).
- **Deployed-code knowledge bundle** —
  [`../diagnostics/KNOWLEDGE_BUNDLE.md`](../diagnostics/KNOWLEDGE_BUNDLE.md):
  the deterministic, fail-closed bundle that lets AI Diagnostics answer
  code/docs/schema questions from the running artifact.
- **Configuration export & import** —
  [`../config-transfer/README.md`](../config-transfer/README.md): decision
  records for the portable configuration/content/lodge-setup tool.
- **Exclusive whole-lodge hold** —
  [`../exclusive-booking/decisions/ADR-001-exclusive-whole-lodge-hold.md`](../exclusive-booking/decisions/ADR-001-exclusive-whole-lodge-hold.md).
- **Member photos** —
  [`../member-photos/decisions/ADR-001-member-photos.md`](../member-photos/decisions/ADR-001-member-photos.md):
  storage, visibility, and what a member merge does to a photo.

**Authoritative in-code references.** Some contracts live in TypeScript rather
than in a document, and the code is the source of truth: the admin-editable
outbound email templates, their approved tokens and their subject/body safety
rules are catalogued in
[`../../src/lib/email-message-registry.ts`](../../src/lib/email-message-registry.ts);
the module list is [`../../src/config/modules.ts`](../../src/config/modules.ts);
the audit-category taxonomy is
[`../../src/lib/audit-categories.ts`](../../src/lib/audit-categories.ts).

## When you need the other path

Some questions are answered on the adopter side, and it is correct to go there
rather than to duplicate the answer here:

- *Should this be a module, a setting, a seed default, or code?* —
  [Configure, don't fork](../adopters/configure-or-fork.md).
- *How does a change reach a deployment, and what belongs in a fork?* —
  [Contribute a change upstream](../adopters/upstream-contributions.md).
- *What does this admin screen do?* — the
  [operator guides](../adopters/README.md#operating-a-live-club).
- *What environment variable controls this?* —
  [`../../CONFIGURATION.md`](../../CONFIGURATION.md).
- *What does a release require of an operator?* —
  [`../UPGRADING.md`](../UPGRADING.md) and
  [`../PRODUCTION_UPGRADE_RUNBOOK.md`](../PRODUCTION_UPGRADE_RUNBOOK.md).
