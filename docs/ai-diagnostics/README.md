# AI Diagnostics

> Part of the [documentation hub](../README.md).

AI Diagnostics is a **separate, admin-only** assistant that helps an operator
understand why the *deployed* system behaves as it does. It can retrieve bounded,
typed, permission-scoped **read-only** evidence — deployed source/docs/schema,
typed structured page context, and the results of SELECT-only database tools — and
explain it with citations.

It is **not** an expansion of the member-facing Page help assistant
(`/api/help/chat`). Page help is powerless by design (no tools, no data, member
-level access); Diagnostics has tools and data and is therefore admin-only,
read-only, budgeted, and audited. Keeping the two products' security models
separate is the reason this subsystem exists — see
[ADR-001](decisions/ADR-001-separate-admin-only-diagnostics-product.md).

**Status:** design/foundation. This hub, the ADRs, and the
[threat model](threat-model.md) are the security/privacy/authority/evidence
contracts, written under issue #2370 (AID-1) **before** the nine implementation
children of epic #2369 are built. The subsystem is **off by default** and
deployment-local. **AID-2 (#2371) is the first implementation child to land** —
the capability, configuration, metering, and rate-limit foundation described in
[the delivered-capability section](#delivered-capability-budget-metering-rate-limits-and-configuration-aid-2-2371)
below. **AID-4 (#2373) has since landed the
[typed structured page context](page-context.md)** — the typed selector,
route registry, permission-checked server re-fetch, and evidence render for the
page an admin is looking at. **AID-5 (#2374) has since landed the
[SELECT-only tool substrate](tools.md)** — the server-owned typed tool registry and
the dedicated least-privilege database credential it reads through, with its
operator setup in [deployment.md](deployment.md). **AID-6A (#2375) has since landed
the [support tool pack](tool-pack-support.md)** — deployment, configuration and
readiness evidence behind `support:view`, bounded sanitized audit correlation behind
`support:view` **and** the affected domain's own `area:view`, one column-restricted
`AuditLog` grant, and the shared evidence-state and diagnostic-case contracts.
**AID-6B (#2376) and AID-6C (#2377) are now delivered too:** the booking and
membership pack and the finance/Xero pack are documented below. The product
shell/answer workflow remains a later implementation child.

## Governance: these contracts are binding

The ADRs in [`decisions/`](decisions/) and the [threat model](threat-model.md)
set the contracts every implementation child (#2371–#2379) is built against.

> **No implementation child may weaken any contract in this hub without an owner
> decision recorded on-repo** (a comment or a superseding ADR on the relevant
> issue). A pull request that would relax an admission rule, a prohibition, an
> evidence boundary, a retention/redaction rule, a budget/limit, the database
> least-privilege contract, or the answer-render/CSP contract is Critical/High
> security work — it is never auto-merge eligible and requires owner review.

## Frozen product boundaries (at a glance)

- **Admission is any-admin; every tool re-checks its own `area:view` fresh on
  every call.** Opening the shell reveals nothing (ADR-002).
- **Read-only means no domain mutation.** No mutation tools, no model-generated
  SQL, no DOM scraping, no screenshots, no raw credentials, no unrestricted PII,
  no raw provider payloads. The only writes are isolated metering/audit/rate-limit
  metadata (ADR-001).
- **All evidence is untrusted, prompt-injection-capable data** — it never carries
  system authority and never authorizes a tool (ADR-003).
- **Sensitive record context is opt-in; only approved metadata is retained**
  (tool id, auth outcome, row/count/byte/timing/hash) — never prompts, answers,
  args, results, payloads, credentials, or unrestricted identifiers (ADR-004).
- **A dedicated fail-closed control plane:** own monthly integer-cent budget,
  per-round-trip reserve, bounded tool loop, per-IP/per-admin/global rate limits
  (ADR-005).
- **Deployment-local and fork-safe:** provider/data-residency disclosure, optional
  zero-retention, a generic deployment-owned private overlay (never Tokoroa
  paths), config that does not travel between deployments (ADR-006).
- **A dedicated non-superuser SELECT-only database credential** — never the app's
  superuser `DATABASE_URL` (ADR-007).
- **The rendered answer is inert text under a strict CSP.** The model's answer is
  untrusted *output*: the shell renders no auto-loaded images, arbitrary
  hyperlinks, or `data:` URIs, and an `img-src`/`connect-src` CSP blocks egress, so
  an injection cannot beacon in-scope data out of the admin's browser (ADR-008).

## Permission matrix (summary)

Each tool declares the admin area that already governs its data in the admin UI,
re-checked at `view` on every call. Authoritative version and semantics (any-admin
admission, AND across cross-area tools, fail-closed) in
[ADR-002](decisions/ADR-002-admission-and-per-tool-authorization-lattice.md).

| Tool pack / child | Required (fresh) permission |
| --- | --- |
| Config/readiness + sanitized correlation (AID-6A, #2375) | `support:view` |
| Booking search, booking summary/link/party/request/audit evidence, per-night capacity (AID-6B, #2376) | `bookings:view` |
| Booking bed-allocation and double-bed-sharing state (AID-6B, #2376) | `bookings:view` **and** `membership:view` |
| Member search, per-member evidence, member eligibility (AID-6B, #2376) | `membership:view` |
| A member's booking involvement (AID-6B, #2376) | `membership:view` **and** `bookings:view` |
| Authoritative booking block state (AID-6B, #2376) | `bookings:view` **and** `membership:view` |
| Finance & Xero-linkage tools (AID-6C, #2377) | `finance:view` |
| Member↔Xero contact linkage (AID-6C, #2377) | `finance:view` **and** `membership:view` |
| Authoritative booking-finance state (AID-6C, #2377) | `finance:view` **and** `bookings:view` |

**AID-6B permission split: 7 booking-only, 6 membership-only, 3 combined.**
`booking_bed_allocation_state` is combined: it requires `bookings:view` and
`membership:view` because its double-bed verdict reads live membership and partner
facts for both occupants.

AID-6C is delivered: see [tool-pack-finance.md](tool-pack-finance.md) for its ten
entries, the twelve relation grants they argue for, and the finance questions this
platform stores no evidence to answer.

AID-6B is delivered: see
[tool-pack-booking-membership.md](tool-pack-booking-membership.md) for its sixteen
entries, thirteen further relation grants plus the widened `Member`, and the
booking and membership questions this schema cannot answer — including the member
number it does not store. **No entry in that pack requires `support:view`**.
Single-area tools stay available under their own area; the three cross-domain
entries require both of their named domain permissions.

## Architecture decision records

- [ADR-001: Separate, admin-only, read-only product](decisions/ADR-001-separate-admin-only-diagnostics-product.md)
- [ADR-002: Admission and per-tool authorization lattice](decisions/ADR-002-admission-and-per-tool-authorization-lattice.md)
- [ADR-003: All evidence is untrusted, prompt-injection-capable](decisions/ADR-003-untrusted-evidence-classes.md)
- [ADR-004: Sensitive context, retention, redaction, audit metadata](decisions/ADR-004-sensitive-context-retention-redaction-audit-metadata.md)
- [ADR-005: Budget, rate limits, tool-loop bounds, fail-closed control plane](decisions/ADR-005-budget-rate-limits-tool-loop-fail-closed.md)
- [ADR-006: Deployment, provider disclosure, private overlay, config non-travel](decisions/ADR-006-deployment-provider-disclosure-private-overlay-config-non-travel.md)
- [ADR-007: Dedicated least-privilege SELECT-only database credential](decisions/ADR-007-least-privilege-select-only-database-credential.md)
- [ADR-008: Answer output channel — inert render, strict CSP, untrusted model output](decisions/ADR-008-answer-output-channel-inert-render-csp.md)

## Threat model

The [STRIDE-style threat model](threat-model.md) enumerates the trust boundaries,
data flows, abuse cases, per-boundary threats and mitigations, and the fail-closed
control matrix. Each mitigation is fixed by one of the ADRs above.

## Documentation plan

The subsystem's documentation is delivered with its implementation children. This
hub is the index; each child adds or extends the documents below and links them
here as it lands, so this hub stays the single reachable entry point. Planned
subsystem documents (not yet written) are named in `code font` with their owning
child; the existing repository-wide documents they extend are linked.

| Area | Planned subsystem doc (owner) | Existing docs it extends |
| --- | --- | --- |
| **Architecture** | `docs/ai-diagnostics/architecture.md` — runtime shape, the deployed-knowledge bundle, and end-to-end data flows (AID-2 #2371). The tool substrate's own shape is now documented in [`tools.md`](tools.md) | [`ARCHITECTURE.md`](../ARCHITECTURE.md), [`DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) |
| **Tool substrate** | [`tools.md`](tools.md) — the server-owned typed registry, the ten fail-closed gates, per-invocation authorization, bounds, untrusted-evidence render, approved audit metadata, and the rules for adding a tool (AID-5 #2374, **delivered**) | [ADR-001](decisions/ADR-001-separate-admin-only-diagnostics-product.md), [ADR-002](decisions/ADR-002-admission-and-per-tool-authorization-lattice.md), [ADR-004](decisions/ADR-004-sensitive-context-retention-redaction-audit-metadata.md), [ADR-007](decisions/ADR-007-least-privilege-select-only-database-credential.md) |
| **Page context** | [`page-context.md`](page-context.md) — the typed selector, the route registry, the permission-checked server re-fetch, the personal-detail opt-in, and the evidence block (AID-4 #2373, **delivered**) | [ADR-002](decisions/ADR-002-admission-and-per-tool-authorization-lattice.md), [ADR-003](decisions/ADR-003-untrusted-evidence-classes.md), [ADR-004](decisions/ADR-004-sensitive-context-retention-redaction-audit-metadata.md) |
| **Security / privacy** | This hub's [threat model](threat-model.md) and [ADRs](decisions/) (AID-1, this issue); release hardening notes (AID-8 #2379) | [`SECURITY.md`](../SECURITY.md), [`SECURITY-ATTACK-SURFACE.md`](../SECURITY-ATTACK-SURFACE.md), [`agents/PROMPT_INJECTION_GUIDE.md`](../agents/PROMPT_INJECTION_GUIDE.md) |
| **Deployment / operator** | [`deployment.md`](deployment.md) — setup order, provisioning and rotating the SELECT-only DB role, the credential, budget/limits, and reading readiness (AID-2 #2371 / AID-5 #2374, **delivered**); provider disclosure, zero-retention, and the private overlay still to come (AID-8 #2379) | [`../../DEPLOYMENT.md`](../../DEPLOYMENT.md), [`ONGOING_DEVELOPMENT_WORKFLOW.md`](../ONGOING_DEVELOPMENT_WORKFLOW.md) |
| **UX** | `docs/ai-diagnostics/ux.md` — the Diagnostics shell, inert-text answer render + strict CSP (ADR-008), evidence citations, permission-scoped answers, fallbacks (AID-7 #2378) | [`UX_FLOW_MAP.md`](../UX_FLOW_MAP.md) |
| **E2E test matrix** | `docs/ai-diagnostics/e2e-matrix.md` — admission, per-tool auth, injection inertness, output-channel egress (inert render + CSP, ADR-008), budget/limit fail-closed, redaction (AID-8 #2379) | [`END_TO_END_TEST_MATRIX.md`](../END_TO_END_TEST_MATRIX.md) |
| **Operator help** | Operator guidance for the Diagnostics surface (AID-7 #2378 / AID-8 #2379) | [`guides/ai-help.md`](../guides/ai-help.md) |

## Delivered capability: budget, metering, rate limits, and configuration (AID-2, #2371)

AID-2 is the first implementation child of epic #2369 to land. It builds the
**fail-closed capability, configuration, metering, and rate-limit foundation**
the later children (AID-3…AID-8) build the diagnostics product on — the
deployed-knowledge bundle, typed structured page context, SELECT-only tool
substrate, tool packs, and UI all arrive in those children. AID-2 shares nothing
with the page-help assistant at the credential, budget, or metering layer
(ADR-001). All money is NZD integer cents.

### What AID-2 delivers

- A **separate module/capability** — `aiDiagnostics` in `src/config/modules.ts`
  (default OFF), with its column on `ClubModuleSettings`.
- A **dedicated Anthropic credential** — provider `anthropic-diagnostics`, key
  `api_key`, in the encrypted `IntegrationCredential` store. NEVER the page-help
  `anthropic` key, and no fallback to it.
- A **deployment-local monthly budget** in NZ integer cents
  (`DiagnosticsSettings`, ships at **NZ$0 = hard-off**).
- **Concurrency-safe budget reservation** that reserves per provider roundtrip
  and bounds the multi-tool loop.
- **Fail-closed metering** with a circuit breaker.
- **Auth-sensitive rate limits** — per-admin, per-IP, and a global backstop.
- A **readiness** surface and **Full-Admin** credential/config management.

### The two foundational decisions are owner-ratified — how AID-2 implements them

Both decisions AID-2 was built against are now **owner-ratified in the ADRs
above**; AID-2 implements them as follows.

1. **Dedicated Anthropic credential (ratified in
   [ADR-001 §4](decisions/ADR-001-separate-admin-only-diagnostics-product.md)).**
   Diagnostics uses its own Anthropic key under provider `anthropic-diagnostics`
   — a physically distinct `IntegrationCredential` slot, never the page-help
   `anthropic` key and no fallback to it. This lets a deployment point
   diagnostics at a separate Anthropic workspace/key (separate billing, spend
   limits, and zero-retention posture) and rotate or revoke it without touching
   member-facing Page help, and guarantees a page-help key can never silently
   authorise diagnostics spend.

2. **Config non-travel (ratified in
   [ADR-006 §6](decisions/ADR-006-deployment-provider-disclosure-private-overlay-config-non-travel.md)).**
   Diagnostics configuration does **not** ride config-transfer bundles between
   deployments. AID-2 implements this as:
   - the `aiDiagnostics` module flag is **excluded** from the travelling module
     set (like `magicLink`/`googleLogin`) — enabling a paid, separately-keyed
     product is a per-deployment decision;
   - `DiagnosticsSettings` (the budget) is **not registered** as a travelling
     singleton (mirrors `AiAssistantSettings`, and stricter — the NZ$0 default
     means an import can never plant a spend cap a target did not choose);
   - the three usage tables are runtime metering, never configuration;
   - the dedicated credential lives in the encrypted credential store, which is
     outside config-transfer entirely (secrets never travel).

   Pinned by `config-transfer-club-settings.test.ts`.

### Module-off configuration reachability

Deliberate, and explicit (ADR-006 §5 requires the module and its
readiness/health surface stay reachable without exposing the credential):

- The **dedicated Anthropic key** is written/read on the shared, **ungated**
  `/api/admin/integrations/credentials` route (provider `anthropic-diagnostics`),
  so the highest-privilege secret can be entered **before** the module is on.
  Full-Admin only to write; any admin may read metadata-only status.
- The **readiness** endpoint `GET /api/admin/ai-diagnostics/readiness` is
  **exempt** from the module gate (same mechanism as the Lobby Display setup
  wizard), so an admin can see what is still missing — *module off*, *no
  dedicated key*, *no budget* — and finish setup before enabling. It spends
  nothing and exposes no secret value.
- The operational **budget settings** route `/api/admin/ai-diagnostics/settings`
  **hard-gates** on the module flag (exactly like
  `/api/admin/ai-assistant/settings`): a spend budget is meaningful only once the
  club has opted into the product by enabling the module, and enabling it alone
  authorises no spend (fail-closed readiness gates every paid call).

Route area: both `/admin/ai-diagnostics` and `/api/admin/ai-diagnostics` resolve
to the **`support`** admin permission area (`admin-permissions.ts`) — `view` =
readiness/status, `edit` = budget change; the dedicated key write stays Full-Admin
on the credentials route regardless of area level.

### Cost math

The concrete price table and reserve/loop numbers realise the fail-closed budget
contract of [ADR-005](decisions/ADR-005-budget-rate-limits-tool-loop-fail-closed.md)
(§1–§3 fix that they exist, are finite, over-count, and live in this capability
layer). The price table
(`AI_DIAGNOSTICS_PRICE_TABLE_NZ_CENTS_PER_MTOK` in `ai-diagnostics-usage.ts`) is
Anthropic's USD list prices × a deliberately conservative **FX of 1.8 NZD/USD**
(the same FX as page-help), so the estimate over-counts the true bill and the cap
trips early:

| Model | USD in/out/cache-write/cache-read per MTok | NZ cents in/out/cw/cr per MTok |
|---|---|---|
| `claude-opus-5` | $5.00 / $25.00 / $6.25 / $0.50 | 900 / 4500 / 1125 / 90 |
| `claude-sonnet-5` | $3.00 / $15.00 / $3.75 / $0.30 | 540 / 2700 / 675 / 54 |
| `claude-haiku-4-5` | $1.00 / $5.00 / $1.25 / $0.10 | 180 / 900 / 225 / 18 |

An **unknown** model is priced at the highest known row (fail-expensive), so a
model swap by a later child never silently under-counts. `estimateDiagnosticsCostCents`
`Math.ceil`s the summed per-token cost and bills at least 1 cent whenever any
usage is present (0 only for a token-free error). **UPDATE THIS TABLE** whenever
Anthropic changes prices or the FX drifts materially.

#### Reservation size and the multi-tool loop

- `WORST_CASE_ROUNDTRIP_CENTS` (derived by `computeWorstCaseRoundtripCents`) is
  the amount reserved before **each** provider roundtrip. It prices
  `DIAGNOSTICS_MAX_INPUT_TOKENS_PER_ROUNDTRIP` (32k) input tokens at the more
  expensive of the plain-input and cache-write rates, plus
  `DIAGNOSTICS_MAX_OUTPUT_TOKENS_PER_ROUNDTRIP` (8k) output tokens, at the
  highest-priced model. With the table above that is **72 cents**.
- `DIAGNOSTICS_MAX_TOOL_ROUNDS` (8) bounds the loop, so a single session's
  worst-case spend is `rounds × worst-case-roundtrip` (~NZ$5.76), and the monthly
  budget bounds the sum across all sessions.
- The reservation is a pre-call ceiling; **post-call metering reconciles the
  actual (usually far smaller) cost** into `DiagnosticsUsageMonthly.settledCents`.

### Concurrency

The budget reserve is a **guarded claim under a per-month advisory lock** — see
[`docs/CONCURRENCY_AND_LOCKING.md`](../CONCURRENCY_AND_LOCKING.md) → *Diagnostics
budget reserve* for the full argument. In short: `reserveDiagnosticsBudget` takes
`pg_advisory_xact_lock(hashtext('diagnostics-budget-reserve'), hashtext(<month>))`,
reclaims expired reservations, sums live reservations + settled spend, and
inserts a reservation only if the total stays within budget — all atomic against
concurrent reservers, so a burst cannot overspend the budget. The provider call
runs outside the transaction; `settleDiagnosticsRoundtrip` releases the
reservation and books the real cost afterwards, taking the **same** per-month
lock as its first statement so its reservation-delete + settled increment cannot
commit mid-reserve and under-count committed spend (reserve and settle mutually
exclude per month; each takes only this one key, so there is no lock-ordering
cycle); `expiresAt` reclaims a leaked reservation from a crashed call.

### Fail-closed points

Every gate denies the paid call on doubt — the concrete realisation of ADR-005 §5:

- **Reserve** returns `metering_unavailable` on a missing delegate (blue/green
  old colour), a lock/read fault, or any thrown error — can't-prove-under-budget
  ⇒ don't-spend.
- **Metering circuit breaker** (`isDiagnosticsMeteringHealthy`) opens after
  `DIAGNOSTICS_METERING_FAILURE_THRESHOLD` (3) consecutive settle failures; the
  product route checks it BEFORE spending — can't-meter ⇒ don't-spend.
- **Readiness** (`getDiagnosticsReadiness`) returns `ready: false` with a
  `resolve_error` blocker on any DB fault rather than throwing.
- **Budget** defaults to NZ$0, so enabling the module alone authorises nothing.
- The **rate limiters** are all `authSensitive`, so a degraded shared-store
  fallback runs at limit/4 — a store outage tightens, never loosens, the
  paid-call backstop.

### Approved audit metadata only

The concrete schema realises the retention/redaction contract of
[ADR-004](decisions/ADR-004-sensitive-context-retention-redaction-audit-metadata.md).
`DiagnosticsUsageEvent` stores **only** approved metadata: month, acting
`adminMemberId` (plain string, no FK), surface, model, roundtrip index,
success/error metadata, token counts, cost, and a **redacted + truncated**
provider error message. It stores **NO** raw prompts, answers, tool
args/results, provider payloads, credentials, or unrestricted identifiers (epic
#2369 boundary). `DiagnosticsBudgetReservation`, `DiagnosticsUsageMonthly`, and
`DiagnosticsSettings` carry no member content at all.

### Data model & migration

Migration `20260802200000_add_ai_diagnostics_capability` (additive, blue/green
EXPAND — see the ledger row in
[`docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`](../BLUE_GREEN_MIGRATION_SAFETY.tsv)):

- `ClubModuleSettings.aiDiagnostics BOOLEAN NOT NULL DEFAULT false`
- `DiagnosticsSettings` (budget singleton, id `default`, budget default 0)
- `DiagnosticsUsageMonthly` (settled rollup, unique `month`)
- `DiagnosticsBudgetReservation` (live per-roundtrip reservations, `expiresAt`)
- `DiagnosticsUsageEvent` (approved-metadata event log)

No foreign keys (metering must never block a `Member` change), no seeded rows
(the settings singleton is created on first write, and a positive budget is a
deliberate act).

### Concurrency proof

The money-safety invariant — that no burst of concurrent reservers can push
`settled + reserved` over the monthly budget — is proven at three levels:

- **Unit / mutation:** `decideReservation` (the pure admission guard) is
  exhaustively unit- and mutation-tested without a database (one-cent-over deny,
  exact-fit allow, budget-0 deny, reserve>budget deny).
- **Wiring:** `ai-diagnostics-usage.test.ts` proves the reserve path takes the
  advisory lock FIRST, then reads live reservations + settled spend, then makes a
  guarded insert, and inserts nothing on a lost claim.
- **Real PostgreSQL race (#2532):** `ai-diagnostics-budget-race.realdb.test.ts`
  drives the production `reserveDiagnosticsBudget` from two to five genuinely
  concurrent callers against a real Postgres and asserts exactly the budgeted
  number of reservations win and the live-reservation sum never exceeds the
  budget. It is off by default and runs in CI's `Migration drift check` job via
  the guarded `concurrency-lock-races.realdb.test.ts` harness (opt-in
  `RUN_CONCURRENCY_RACE_TESTS=1`, dedicated loopback database), so ordinary
  `npm test` never needs a live database.

  The lead test does not *hope* for the dangerous interleaving, it **forces**
  it. A third connection takes the same per-month advisory lock and holds it
  open; the two reservers are started and the test then waits on a barrier —
  PostgreSQL's own `pg_locks` reporting both of them queued on exactly that
  advisory key, and `pg_stat_activity` reporting that neither has yet been
  assigned a transaction id, i.e. that both reached the lock *before* writing
  anything. Only then is the holder released, and exactly one reserver claims
  the budget. There is no `setTimeout` standing in for the race, so the proof
  neither flakes when CI is slow nor passes vacuously when it is fast.

  The `backend_xid IS NULL` half of that barrier is the part that carries the
  weight, and it is worth knowing why the obvious alternative does not. Counting
  reservation rows from a separate connection while the lock is held proves
  nothing: under READ COMMITTED an uncommitted insert made by a blocked reserver
  is invisible to every other backend, so the count is zero whether the lock
  comes first or last. PostgreSQL assigns a transaction id lazily at a backend's
  first write, so "queued *and* still xid-less" is the signal that actually
  distinguishes the correct ordering from a lock taken too late.

  Verified to actually catch the regression it exists for, against a throwaway
  Postgres: **deleting** the `pg_advisory_xact_lock` line fails the barrier with
  a named diagnostic (the reservers never queue); **moving** it to after the
  budget reads passes the queue check but then admits two 40c reservations
  against a 50c budget; and **moving** it to after the guarded insert is
  rejected by the xid clause with a diagnostic naming the write-before-lock
  ordering. Each was reproduced three times, with no flaky pass.

  `ai-diagnostics-usage.test.ts` additionally pins the wiring itself: the
  harness import, the CI step that runs it, and the barrier — because the race
  suite skips itself without the opt-in flag, so an unnoticed unwiring would
  leave every suite green with the money-safety proof no longer running.

## Delivered capability: the SELECT-only tool substrate (AID-5, #2374)

AID-5 builds the **typed, server-owned, read-only tool substrate** and the
dedicated least-privilege database identity it reads through. Full reference:
[`tools.md`](tools.md). Operator setup: [`deployment.md`](deployment.md).

The headline is a negative capability: **the model never supplies SQL.** A tool is a
server-owned record pairing a fixed statement, a fixed parameter binding, a fixed
projection, fixed row/byte ceilings and a fixed permission requirement. The model
chooses an entry by id and supplies arguments a `.strict()` schema has already
accepted; those become positional parameters and nothing else.

- **A separate database identity, verified not assumed.** Reads run as
  `AI_DIAGNOSTICS_DATABASE_URL` — a non-superuser role with an empty `SELECT`
  allowlist today — inside `BEGIN READ ONLY` under a statement timeout. The
  application asks the **server** what privileges the role holds and refuses every
  tool call unless superuser, `CREATEDB`, `CREATEROLE`, `REPLICATION`, `BYPASSRLS`,
  database `TEMPORARY`/`CREATE`, schema `CREATE`, `pg_read_file` execute, any write or
  undeclared read privilege, and membership in **any** other role are all absent.
  There is no fallback to `DATABASE_URL`, and a URL naming the application's own role
  is refused outright.
- **Ten ordered fail-closed gates**, every one returning no rows: registry, loop
  budget, fresh authorization, arguments, metering, credential, read, projection,
  size, audit. Authorization runs **before** argument parsing so the difference
  between "invalid arguments" and "permission denied" cannot be used as an oracle,
  and the audit row is written **before** any evidence is returned.
- **Authorization is per invocation, and withholding is not authorization.** Tool
  definitions are hidden from the model when the caller lacks the area — a usability
  courtesy — while the server re-reads the caller's matrix from the database and
  denies on every invocation regardless.
- **Bounded everywhere:** the executor imposes its own outermost SQL `LIMIT`, an
  over-size result is a refusal rather than a silent trim, and per-round and
  per-session tool-call counters live on an explicit per-question session object
  whose limits can only be clamped downwards.
- **Approved audit metadata only:** one `AuditLog` row per invocation carrying tool
  id, areas checked, auth outcome, failure reason, non-reversible hashes of the
  accepted arguments and of the result, and row/byte/timing counts — never raw
  arguments or raw results.
- **No domain tool.** The single registered entry reads no relation: it is a
  readiness probe that reports whether the transaction is read-only and what
  timeout is in force. AID-6A/B/C (#2375–#2377) add the tool packs, each with its
  own permission review and its own table grant.
- **Readiness now verifies the role.** `GET /api/admin/ai-diagnostics/readiness`
  reports a `databaseState` of `not_configured`, `misconfigured`, `unverified`,
  `over_privileged`, `under_provisioned`, or `verified`, and anything but
  `verified` blocks readiness. Missing declared grants are reported separately
  from excess privilege so the re-provision action is explicit.
  It never returns the connection string, the password, or the role name.

### Privilege proof

ADR-007's claims are claims about PostgreSQL's own behaviour, so a mock cannot
establish any of them. `ai-diagnostics-select-only-role.realdb.test.ts` provisions
the role by running the **shipped** statements from `provision-role.ts`, connects as
that role against a real PostgreSQL, and proves that `INSERT`/`UPDATE`/`DELETE`/
`TRUNCATE`, nine forms of DDL including `CREATE TEMP TABLE` and
`ALTER ROLE … SUPERUSER`, reads of `IntegrationCredential` and every un-granted
table, and self-granting all fail; that a granted `INSERT` is still refused by the
read-only transaction; that the runtime self-check **refuses a real superuser
credential**; and that a long query is cancelled at the statement timeout. It is
off by default (opt-in `RUN_CONCURRENCY_RACE_TESTS=1`, loopback-only high-port
dedicated database) and its CI step, environment, and ordering are pinned by
`review-findings-contracts.test.ts` so the proof cannot be silently unplugged.

## Delivered capability: the booking and membership tool pack (AID-6B, #2376)

AID-6B adds the third tool pack on the SELECT-only substrate: **bounded booking and
member selection, per-record booking and membership evidence, and three of the
application's own authoritative calculations.** Sixteen entries. Full reference:
[`tool-pack-booking-membership.md`](tool-pack-booking-membership.md).

- **Selection comes first.** Two searches are the only way in, and fourteen of the
  sixteen entries take an exact record id. `{}` parses for none of them, there is
  no listing tool, no paging and no `COUNT`, and every predicate is an equality
  except one member-name prefix, which uses `starts_with` over a literal prefix —
  there is no `LIKE`, no regex and no wildcard character anywhere in the pack.
- **Its own areas, and nothing borrowed.** AID-6B permission split: 7 booking-only,
  6 membership-only, 3 combined. The combined entries are a member's booking
  summary, authoritative booking block state, and booking bed-allocation state.
  `booking_bed_allocation_state` is combined: it requires `bookings:view` and
  `membership:view` because the double-bed verdict reads live member and partner
  facts for both occupants. **None requires `support:view`** — #2376's owner
  decision — and no argument can move a call between permission sets, because
  `requiredAreas` is fixed on the entry and authorization runs before argument
  parsing.
- **Three authoritative answers rather than a second reading of the columns.**
  `booking_block_state`, `booking_capacity_by_night` and `member_eligibility_state`
  run the platform's own soft-policy evaluator, review-reason derivation, capacity
  engine, member-night conflict scan, edit-window classifier, lifecycle resolver,
  subscription-settlement rule and adult-member-host predicate. **Two of the three**
  — `booking_block_state` and `member_eligibility_state` — return stable codes in an
  argued priority order, and every code's operator sentence travels to the model
  inside the entry's own **description**, with the scope repeating that the
  description holds the exact meanings and that they must not be paraphrased.
  That placement is deliberate and it is also a MEASURED constraint rather than a
  preference: a description is always sent with the tool definition while
  `evidenceScope` is attached to a RESULT, so a model has to have the meanings in
  order to decide whether to ask for the tool at all — and the scope is spent out of
  the same 8,000-character rendered evidence block the rows need. AID-6B put a
  3,101-character catalogue in one scope and the empty block came to 7,545 of 8,000;
  `tools.md` → "Adding an entry" records the measurement and the ceiling test that
  now bounds it. `booking_capacity_by_night` deliberately has **no** code catalogue:
  it is a per-night measurement, not a diagnosis, so there is no priority-ordered
  list to place anywhere. Do not give a new multi-row entry a static catalogue in its
  scope on the strength of this bullet.

  All three run their whole read graph inside one `REPEATABLE READ` read-only
  transaction, so the facts on a row are consistent with each other;
  `observedAtUtc` is still assembly completion rather than the snapshot's own
  timestamp, and their scopes require a rerun before action or a definitive
  conclusion. "Whole read graph" includes the settings reads a canonical rule
  consults on its own way to a verdict: the one collaborator that took no client —
  the cached age-tier reader inside `loadMemberSubscriptionSettlements` — now takes
  a reader instead, and the pack passes a strict one bound to its transaction. The
  pack doc records why an unthreaded settings read is not a small caveat but a
  fabricated finding about a named member.
- **Thirteen more relation grants, plus the widened `Member`.** The allowlist now
  names **twenty-six** relations, all by column. `Member` goes from two columns to
  twenty-three — the most scrutinised change the allowlist has had — while the birth
  date, the address, the credentials, the two-factor state and every free-text
  column stay refused by PostgreSQL itself. The runtime refuses missing declared
  grants as under-provisioned and rejects table-wide SELECT on every column
  declaration as over-privileged, even when it would expose no extra column today.
- **A presence boolean is not a cheaper grant.** A column privilege covers every
  reference to the column, `notes IS NOT NULL` included, so six presence booleans
  and one predicate-only grant were dropped rather than trade the property that a
  withheld column is refused by the server.
- **NZ date-only lodge nights throughout.** No date in the pack is ever converted,
  given a time, or compared against `now()`: a date argument travels as text and is
  cast `::date`, and `to_char` on a `date` column is timezone-independent by
  construction.
- **What it cannot answer is documented as loudly as what it can.** There is no
  member number in this schema, induction gates no booking path in this release, a
  new-booking exception request has no booking id to be found by, `FamilyGroupMember`
  has no role column, bed allocation is not capacity, a booking's money is the
  finance pack's, and an empty audit result is not evidence that nothing happened.

### ADR-004's per-invocation opt-in is declared, not enforced

Fourteen of the sixteen entries set `surfacesPersonalData: true` truthfully, but
**nothing in the shipped code implements a per-invocation operator consent**. The
flag records that a row can identify a person; it does not gate the entry, and it
must not be described as a control. Implementing the opt-in is a prerequisite
recorded on AID-7 (#2378). What actually bounds the pack today is the fresh AND-ed
area check, the exact-identifier argument shapes, the fixed projections, the column
grants, the row/byte/field ceilings, the 16-call-per-session ceiling and the audit
row.

## Maintenance rules

- Do not point Diagnostics tools at the application's `DATABASE_URL`; update
  ADR-007 first if the least-privilege database contract changes.
- Do not add a tool that mutates, generates SQL, scrapes the DOM, or returns raw
  credentials/PII/provider payloads; ADR-001 forbids it.
- Do not widen admission or drop a tool's fresh `area:view` re-check; ADR-002 is
  the contract.
- Do not render a Diagnostics answer as active content (auto-loaded images,
  arbitrary hyperlinks, `data:` URIs, raw HTML) or relax the Diagnostics
  `img-src`/`connect-src` CSP; ADR-008 is the contract and AID-7 (#2378)
  implements it.
- Keep Diagnostics config deployment-local and out of config-transfer bundles
  unless ADR-006 is superseded by an owner decision.
- Do not add a page-context route whose `requiredAreas` are weaker than the
  admin route lattice's own requirement for that path, and do not widen a
  route's token allowlists without a reason — see
  [page context](page-context.md); `registry.test.ts` enforces the first.
- A new diagnostics tool ships its `GRANT SELECT` in `provision-role.ts` in the
  **same** pull request, never a blanket `ALL TABLES IN SCHEMA` grant, and the
  release note tells operators to re-run `npm run diagnostics:provision-role` —
  see [tool substrate](tools.md).
- Do not add a runtime seam that lets a caller inject an authorizer, an auditor, or
  SQL into `invokeDiagnosticsTool`, and do not relax the privilege self-check in
  `database.ts` into a configuration-only check; ADR-007 requires the server to be
  asked.
- When a child ships a subsystem document from the plan above, replace its
  `code-font` placeholder with a real link in the same PR.
