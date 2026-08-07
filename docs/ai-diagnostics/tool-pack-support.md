# AI Diagnostics support tool pack (AID-6A)

The first tool pack on the [SELECT-only substrate](tools.md): deployment,
configuration and readiness evidence, plus bounded, sanitized audit correlation.
Delivered under issue #2375 of epic #2369.

Read [tools.md](tools.md) first. This page covers only what this pack adds — its
permissions, its evidence sources, its projections, its bounds, and the one table
grant it argues for.

## What an administrator can ask it

| Question | Tool | Needs |
| --- | --- | --- |
| Why is AI Diagnostics unavailable, degraded, or refusing to run tools? | `diagnostics.readiness` | `support:view` |
| Which release is running, and why can it not explain code? | `diagnostics.deployment_evidence` | `support:view` |
| What is Diagnostics costing this month, and why was a request refused on budget? | `diagnostics.usage_health` | `support:view` |
| Is a scheduled job late or failing? | `diagnostics.background_job_health` | `support:view` |
| What did the platform record around this incident? | `diagnostics.system_event_correlation` | `support:view` |
| …around this booking problem? | `diagnostics.booking_event_correlation` | `support:view` **and** `bookings:view` |
| …around this membership problem? | `diagnostics.membership_event_correlation` | `support:view` **and** `membership:view` |
| …around this payment or Xero problem? | `diagnostics.finance_event_correlation` | `support:view` **and** `finance:view` |
| …around this rosters/chores/work-party problem? | `diagnostics.lodge_event_correlation` | `support:view` **and** `lodge:view` |

Everything here is **read-only**. Nothing in this pack can create, modify, approve,
refuse, refund, reconcile or configure anything, and no tool calls Stripe, Xero, a
bank or an email provider.

## Permissions, and why they are shaped this way

`support:view` is the area that already governs Admin > Support & System — setup,
modules, health, deliverability, audit, issue reports and operational diagnostics —
and `/admin/ai-diagnostics` itself. It is required for **general system evidence
only**.

It is deliberately **not** required for ordinary domain diagnostics. A Booking
Officer investigating a booking does not need a support permission to do their own
job, so the booking tools in AID-6B (#2376) will require `bookings:view` and not
`support:view`. The same holds for membership (#2376) and finance (#2377).

Correlation is the case that needs both, because it reads the platform's audit
trail — a support/system surface — filtered to one business domain. So each
correlation entry declares `support:view` **and** that domain's own area, AND-ed and
re-read from the database on every invocation.

There is deliberately **no `domain` argument**. The substrate authorizes before it
parses arguments (see [tools.md](tools.md) → "The gates, in order"), so an argument
cannot decide an authorization rule. Five fixed entries with five fixed permission
sets is the shape that keeps the two in step.

### One deliberate reading of a requirement, recorded so it is reviewable

#2375 is internally inconsistent on this point, so the choice is stated here rather
than left to inference. Its correlation section says "booking-event correlation
requires `bookings:view`"; its examples say combined system and booking evidence
requires "both `support:view` and `bookings:view`"; and its acceptance criterion 4
says domain diagnostics must use their domain permission "without also requiring
`support:view`".

This pack follows the **stricter** reading: `support` **and** the domain, for
correlation only. The reasoning is above — correlation reads the audit trail, and the
audit trail is a `support` surface. Acceptance criterion 4 is honoured where it plainly
applies: the domain tools AID-6B and AID-6C add will require their domain area alone.

What the strict reading costs, stated plainly. A club-defined access role granting only
`bookings:view` — which the access-roles UI permits — gets **no** booking correlation,
and the operator is told they need Support & System. The built-in bundles hide this,
because `ADMIN_BOOKINGS` and `ADMIN_MEMBERSHIP` both already include `support: "view"`,
so it can only appear on a hand-built custom role. The failure is closed and legible (a
named missing area, not a silent empty result), which is why it ships this way rather
than being loosened on the spot. If the owner prefers the literal AC4 reading, the
change is one line per entry in `support-correlation.ts` plus its permission contract
test, and it widens who can read the audit trail — which is why it is the owner's call
and not a reviewer's.

### What a missing permission looks like

A caller who lacks an area is not offered that tool, and an invocation naming it
anyway is denied server-side with `permission_denied` and the missing area named.
Nothing infers the answer from elsewhere: the category filters are **disjoint** and an
audit row carries **at most one** category, so the tool a caller *can* run cannot
return the rows the denied one would have. A support-only administrator asking a
finance question gets a denial that says `finance:view` is required. A contract test
pins the disjointness.

"At most one" is exact, and an earlier revision of this page said "exactly one", which was
wrong and hid a coverage gap — see [A row with no category is invisible to
correlation](#a-row-with-no-category-is-invisible-to-correlation). It does not weaken the
denial argument: a row no entry can reach is not a way around a denial.

One qualification, because the stronger claim would be untrue. `support:view` alone
does reach **administrator-initiated** events in every domain, because that is what
the `admin` audit category is — see the mapping table below. That is not an
escalation: `support` is already the area that governs Admin > Audit Log, where the
same administrator reads those same rows in full, with the summary, the metadata and
the IP address this projection withholds. What the domain permission buys is the
domain's **own** events: the payment, the booking, the member's own account change.

### Audit categories are not the permission areas

The audit `category` on a row is an older, coarser taxonomy than the admin permission
areas, and the two do not line up. This matters twice — for reading an empty result
correctly, and for anyone extending the taxonomy in AID-6B or AID-6C.

| Category | Correlation entry | Reader needs | What actually records there |
| --- | --- | --- | --- |
| `system`, `security` | System | `support:view` | Setup, credentials, password/magic-link policy, backups, auth events and auth bounces, PIN login |
| `admin` | System | `support:view` | **The cross-domain catch-all** — the largest category in the codebase (117 write sites). Member merge, member-lifecycle delete/archive, member import, lodge-access changes, seasonal membership assignments, internet-banking **payment settings**, booking-request **settings**, chores, lockers, rooms, bed allocation, lodge settings, access roles, modules |
| `booking` | Booking | `support:view` + `bookings:view` | Member-facing and system booking events. Not booking *settings* — those are `admin` |
| `account` | Membership | `support:view` + `membership:view` | Member self-service: profile edits, notification preferences, post-login landing, membership cancellation, member photos, membership applications and nomination |
| `family` | Membership | `support:view` + `membership:view` | Family groups, partner links, login-holder changes, dependents |
| `communication` | Membership | `support:view` + `membership:view` | Bulk email, notices, delivery suppressions, credential-email reissues, age-up parent handoffs |
| `privacy` | Membership | `support:view` + `membership:view` | Deletion requests, member export, member-guest resolution, **admin issue reports** — even though Issue Reports is a `support` screen |
| `payment`, `xero` | Finance | `support:view` + `finance:view` | Payments, refunds, reconciliation, Xero sync. Not payment *settings* — those are `admin` |
| `lodge` | Lodge | `support:view` + `lodge:view` | Rosters, guest arrival/departure, bed-allocation lifecycle, display built-ins, and **induction** — even though Induction is a `membership` screen |

That table is **derived from one map**, not maintained here by hand:
`AUDIT_CATEGORY_CORRELATION_DOMAIN` in `src/lib/audit-categories.ts` sends every
canonical category to exactly one entry, and each entry builds its own filter from it.
Disjointness and total coverage are therefore properties of the type rather than
assertions checked afterwards. Two rows changed in #2581 and both are behaviour changes,
not tidying:

- **`communication` moved from the System entry to Membership.** Bulk-email and
  notice-delivery evidence needs `membership:view` now. A support-only operator who could
  correlate those events **can no longer**. That is deliberate: those payloads carry
  recipient email addresses, and communications is membership work.
- **`family` joined Membership**, having previously been in **no** entry at all. 27
  production write sites' evidence was invisible to every correlation tool and is now
  readable with `support:view` plus `membership:view`.

The consequence to keep in mind: a correlation tool answering "nothing matched" is
answering about **its own categories**, not about the domain. A Membership Officer
asking what happened around a member merge gets zero rows from the membership entry,
because a merge is `admin`. Three things stop that reading as "it never happened":

- each entry's **`scope:` line** in the evidence block names the categories it
  searched and says in as many words that nothing matched means nothing matched in
  those categories;
- each entry's **model-facing description** names its categories and names the traps
  above explicitly ("member merges are recorded under admin", "induction is recorded
  under lodge"), so the model can pick the right entry in the first place; and
- contract tests pin both.

Re-mapping is not on the table: a row's category is a single string that does not say
which screen wrote it, so `admin` cannot be split by category, and adding it to all
four domain entries would destroy the disjointness that makes a denial impossible to
work around.

### A row with no category is invisible to correlation

The table above covers all eleven **named** categories, and since #2581 every one of
them is claimed by exactly one entry. There is a twelfth case, and no correlation entry
covers it: the column is optional.

`AuditLog.category` is `String?` with no default, and the audit writer sets it only when
the caller supplies one. The **executable census** — `npm run audit:census`, pinned by
`src/lib/__tests__/audit-writer-census.test.ts` — counts **419 production audit write
sites, of which 82 pass no category**: 69 through `logAudit`, 11 through
`createAuditLog`, 2 hand-built Prisma writes, and none through
`createStructuredAuditLog`. Some are money-adjacent: subscription-billing settings, retry,
mark/unmark family, reconcile; the subscription charge confirm; all three member-credit
adjustment steps; fee configuration; the saved-card charge results. Others are ordinary
but relevant: booking-policy, season and promotional-code edits; Xero settings and
retries; lodge display configuration; family-group, login-holder and dependent changes;
membership applications; bulk communications; deletion-request decisions.

Those figures used to be quoted here as "81 of about 350", which was a hand count and was
stale. They are measured on every CI run now, and a **new** uncategorised audit writer
fails the census contract with its own symbol named — the mechanism that stops this
population growing again while it is being drained.

The census covers all four TypeScript writer forms (`logAudit`, `createAuditLog`,
`createStructuredAuditLog`, and a direct `auditLog.create`), the fourteen wrapper helpers
that write on a caller's behalf, and — because a TypeScript-only census would have claimed
`prisma/` was clean when it is not — the **raw SQL** in committed migrations. Two
migrations write `"AuditLog"` directly, bypassing the audit boundary's sanitisation and
retention derivation; both are pinned with a reason, and a migration that `INSERT`s audit
rows without naming `"category"` fails the same contract. It parses rather than greps, so a
sink named inside a comment is not counted — the phantom `createStructuredAuditLog`
omission preserved in the issue's own title was exactly that.

One consequence worth stating because it is not obvious: all 82 also pass no `severity`
and no `retentionClass`, and the writer derives a retention class only when one of those
three is present. So every one of those rows is stored today with **no expiry at all** —
never archived, never pruned. Giving them a category is therefore also a retention change,
not a metadata tidy-up.

The shared statement filters on `"category" = ANY (…)`, which is NULL — not true — for a
row with no category, so **such a row is returned by none of the five entries.** It is not
a containment problem (a row nobody can reach is not a way around a denial); it is an
honesty problem, and the one the epic treats as Critical. Untreated, a Finance Officer
asking "what did the platform record around this subscription reconcile?" gets zero rows,
the state `not_found` — *"Nothing matched, so there is no evidence of this to report"* —
and prose steering them to the other four entries, none of which can see the row either.
After all five, an authoritative absence for an event the platform did record.

What ships instead is the same remedy the mismatch class gets, one step further out: every
entry's `scope:` line says *"a row recorded with NO category is matched by no correlation
tool at all, so an empty result does not rule that out either"*, and every description says
the same and points at **Admin > Audit Log**, which does list those rows (its own category
filter matches uncategorised rows against a table of legacy action patterns, and it infers
a category from the action for display). Contract tests pin the wording in all five scope
lines and descriptions, pin that the statement really cannot match a null row, and read
`prisma/schema.prisma` so the disclosure cannot be dropped as stale while the column is
still nullable.

**The alternative was put to the owner and refused.** The system entry could take the
null case explicitly (`"category" IS NULL OR "category" = ANY (…)`), which would keep the
five sets disjoint and make the evidence complete. But it routes those 82 call sites'
rows — booking policy, communications, deletion decisions — into an entry that needs
`support:view` alone, and it needs a fresh look at the `(category, createdAt)` index
against the 5-second statement timeout. On #2581 the owner ruled it out: Diagnostics stays
strictly category-filtered and permission-scoped, and the rows get a category **at the
source** instead. The canonical taxonomy, the permission map above and the census contract
are the first part of that work; the sweep that gives each of the 82 sites its category is
the second; the exact-action backfill of the historical null rows is the third. Until the
second lands, the disclosure above is the honest answer and stays.

## Evidence sources

Four of the nine entries read a **first-party calculation** rather than the
SELECT-only database, and each has a specific reason:

- **Readiness** combines the module flag, the encrypted dedicated-credential state,
  and the server-verified privilege shape of the diagnostics role. Two of those are
  structurally out of the diagnostics role's reach — ADR-007 forbids granting it any
  access to credential storage — and the third is a verdict *about* that role's own
  connection, which has to stay reportable in exactly the case where that connection
  is the blocker. So the tool reads `getDiagnosticsReadiness`, the same function
  `GET /api/admin/ai-diagnostics/readiness` renders. There is no second readiness
  calculation that can drift from the admin screen.
- **Deployment identity** lives in the image and on disk, not in the database.
- **Budget and usage health** takes its money from `getDiagnosticsUsageSummary`, the
  admin panel's own numbers including the live reservation total the budget gate
  sums. Re-deriving spend in SQL would be a third definition of the money.
- **Background-job health** uses `buildCronHealthReport`, the authoritative
  overdue/failed/skipped classification, over the same rows the Admin > Health screen
  reads. The model is never handed raw timestamps and asked to infer whether a
  nightly job is late.

A server-owned entry is **not** a way around the gates. Registry lookup, loop
budget, fresh AND-ed authorization, `.strict()` argument parsing with the
reserved-key scan, the metering circuit breaker, the fixed projection with redaction
and per-field caps, the row and byte ceilings, truncation honesty and the
approved-metadata audit row all apply identically. The only gate it skips is the
SELECT-only credential check, which does not govern it.

### The residual these three carry, stated plainly

Readiness genuinely could not be a `SELECT`: it needs encrypted credential state and a
verdict about the diagnostics role's own connection, both permanently out of that
role's reach. The other three **do** query application tables on the application's
own full-privilege connection — `DiagnosticsBudgetReservation` and
`DiagnosticsUsageEvent` for budget health, and whole `CronJobRun` rows for job health.
There is no column grant behind them, so unlike the correlation entries — where
`SELECT "ipAddress" FROM "AuditLog"` is refused by PostgreSQL itself — **the registry
projection is the only boundary**.

Nothing leaks today: the projections are correct, and the executor's per-field cap
refuses a JSON `resultSummary` outright. But `CronJobRun.error` (raw error text, often
a stack) and `DiagnosticsUsageEvent.errorMessage` (provider error text) sit one field
away, so **every edit to a source or a projection in this pack is a security-relevant
change** and needs the review a grant would get. The rule that stops this drifting
further is #2375's own: a future source that *could* be a column-granted `SELECT` must
be one.

Two bounds the SQL arm gets for free are supplied by hand here, because a first-party
calculation gets no `statement_timeout` and the executor's 15-second race abandons a
slow read without cancelling it:

- **Bounded fan-out.** Job health reads three queries per tracked job. At 34 jobs that
  is 103 statements, and issuing them in one `Promise.all` put 103 concurrent queries
  on the application pool per tool call. They now run in batches of four jobs.
- **Its own deadline, which refuses.** The job-health source stops issuing batches
  after 10 seconds and **rejects** rather than returning fewer runs — a partial run set
  would make the classifier report a healthy job as `missing`, which is a fabricated
  answer rather than an absent one. The operator sees `evidence_unavailable`.

One honest difference is reported rather than hidden: the Admin > Health screen asks
the cron-leader container whether scheduling is enabled, over HTTP. A diagnostics
tool must not make an outbound call, so `cronSchedulingEnabled` reflects **this
container's** configuration. It is its own field, so it cannot silently change a
job's verdict.

## The table grant

This pack adds **one** relation to the `SELECT_GRANTS` allowlist in
`provision-role.ts`, and it grants **columns, not the table**:

```
GRANT SELECT ("id","action","category","severity","outcome","entityType",
              "requestId","createdAt") ON public."AuditLog"
```

| Column | Why the correlation tools need it |
| --- | --- |
| `id` | The evidence reference, and the tiebreaker that makes the ordering total — so the audit `resultHash` is stable for identical evidence. |
| `action` | The stable server-defined action code. |
| `category` | The domain filter, and the field that keeps the five entries disjoint. |
| `severity`, `outcome` | Closed server-side classifications. |
| `entityType` | **What kind** of record the event concerned — never which one. |
| `requestId` | The correlation key that ties one operator action to the events it produced. |
| `createdAt` | The window predicate, and the projected instant. |

`AuditLog` is exactly the relation #2375 says must not be granted wholesale: it also
carries `ipAddress`, `userAgent`, `summary`, `details`, arbitrary `metadata` JSON,
and `memberId` / `actorMemberId` / `subjectMemberId` / `targetId` / `entityId`. A
column grant makes the projection a **server-enforced** boundary rather than an
application one — as the diagnostics role, `SELECT "ipAddress" FROM "AuditLog"` is
refused by PostgreSQL itself (42501), and so is `SELECT *`. A future tool, a
projection bug, or a `psql` session opened with that credential all hit the same
refusal.

`entityId` is the deliberate omission to explain. It is often a member id, and this
pack's permission set is system-plus-domain rather than a per-record investigation
with ADR-004's per-invocation personal-data opt-in. Per-record evidence — the member,
the booking, the payment — is AID-6B (#2376) and AID-6C (#2377) work, under their own
area permission and their own privacy review. Every entry in this pack therefore
reports `surfacesPersonalData: false`, and means it.

The runtime self-check verifies the granted **columns** against the same allowlist
and refuses the role if a wider grant appears. That matters because a hand-added
table-level `GRANT SELECT ON "AuditLog"` leaves the relation-level count at zero —
the relation *is* declared — while the role gains every withheld column. Measured on
PostgreSQL 16: with the eight-column grant, `has_table_privilege` is false and
`has_any_column_privilege` is true, so a relation-level check cannot separate the two
grants even in principle.

Re-running provisioning **narrows** as well as widens: PostgreSQL's `REVOKE`
reference states that revoking a privilege on a table also revokes the corresponding
column privileges, so a release that drops a column from the allowlist really does
take it away. The real-PostgreSQL proof asserts it by hand-granting `"ipAddress"`,
re-provisioning, and finding it refused.

**Upgrading to this release is a two-step operation: deploy, then re-run
`npm run diagnostics:provision-role`.** Until it is re-run, readiness reports
`over_privileged` or the correlation tools fail with a privilege error — the
deliberate friction ADR-007 asks for.

## Bounds

| Control | Value |
| --- | --- |
| Correlation window | Closed enum: `15m`, `1h` (default), `6h`, `24h`, `7d`. No other value parses. |
| Correlation input | One optional **exact** request id, 3–128 characters, no whitespace or quotes. The predicate is `=`; there is no `LIKE`, no wildcard, nothing to enumerate with. |
| Correlation rows | 22, newest first, with truncation reported. |
| Correlation bytes | 16 384, measured against 22 rows at the widest values the projection can emit. |
| Job health rows | 18, **worst severity first**, with the registered job count on every row. |
| Job health bytes | 16 384, measured the same way. |
| Single-row tools | Readiness, deployment and usage health return exactly one row. |
| Server-owned read | 15 s deadline on the **wait**; job health carries its own 10 s deadline on the **work**. Expiry and refusal are both `evidence_unavailable` with no rows. |

Three of those deserve their reasoning, and all three numbers are measured rather than
estimated — an earlier revision of this page estimated them and got both ceilings
wrong:

- **22 correlation rows, not the 50 #2375 permits.** The substrate renders a tool
  result into an evidence block capped at 8 000 characters, about 1 000 of which is
  fixed framing. Real action codes in this repository run to 60 characters, so a
  rendered row is ~260. Thirty rows came to exactly 8 000 characters with three rows
  gone and a fourth cut mid-field. Two later revisions of this page said **24** rendered
  whole "with room to spare"; both measured a block this pack never emits, because they
  left out the `scope:` line the executor attaches to every one of these five results —
  and those lines now run to 627 characters. Re-measured per entry with them, at a
  24-character request id: the system entry lists 22 of 24 at a mix of today's real
  action codes, and every entry lists 22 of 24 when each row carries the longest real
  60-character code. **At 22, all five render whole in both cases**, the worst of them at
  7 718 of the 8 000. So the ceiling is a measurement, and it moves when the framing
  does: it came down from 24 when the absent-category disclosure was added to every scope
  line. It is not expected to survive a hostile width — a member can plant 128-character
  request ids and clip any ceiling — which is safe only because the block reports its own
  clip in both channels; see below.
- **The job-health ceiling is below the number of registered jobs** (34 at the time of
  writing, and the number only grows). The source orders by severity (error, warning,
  info, ok) and then by job name, and the executor keeps the first **18**. A healthy
  job can never displace an unhealthy one, and every row carries `registeredJobCount`
  so "eighteen of thirty-four" is never mistaken for "eighteen jobs exist". Eighteen
  rather than twenty because twenty rows render to 7 999 of the 8 000 available
  characters once every job has both a success and an older failure — the steady state
  of a mature deployment — so the block would routinely have to drop its last row.
- **Both byte ceilings are 16 384.** The executor's size gate **refuses** a result over
  the entry's ceiling; it never trims one. Job health declared 8 192, and 20 rows of
  its own shape on an ordinary deployment serialised to 8 272 — so a full result was
  refused with `result_too_large`, and the model was told to narrow a question that
  takes no arguments at all. A registry contract test now serialises every entry's own
  projected shape at its own row limit and fails if the entry's ceiling is
  unachievable.

**When a result really is too wide for the block, the block says so — in both channels.**
It drops whole rows from the tail and states `rows (K of N listed …)`, so the count the
model reads always matches the rows in front of it and a partial row is never presented
as a row. It also reports the clip as the **machine-readable** evidence state:
`evidence-state="result_truncated"` in the opening tag and the matching sentence in the
body, derived from the same number as the header. That second half was missing at first:
the state came from the executor's own `truncated` flag, which is set only when the source
returned more rows than the row limit, so a block that clipped a third of the rows it held
could carry `evidence-state="ok"` and "Evidence was retrieved." above an incomplete
listing.
A consumer branches on the state, so a silent cap has to read as a flag rather than as a
complete answer.

The window predicate is always applied, **including** when a request id is supplied.
That is a performance control: `AuditLog` has no index on `requestId`, so a
request-id-only read would be a sequential scan of the platform's whole access trail
against a 5-second statement timeout. Widen the window if the event being correlated
is older than an hour.

## What is never returned

No API key, encrypted or decrypted credential value, database password, connection
string, role password, credential identifier, or raw privilege detail the readiness
contract withholds. No prompt, answer, tool argument, tool result or provider
payload. No provider error **text** — `usage_health` returns the stable
`latestFailureCode` and not the stored `errorMessage`. No job error text or job result
payload. No stack trace. No IP address, user agent, event description, stored
metadata, member id, booking id or payment id.

The projections are the enforcement: a field a registry entry does not name cannot
reach the model even if its source starts returning it, and the tests hand each
projection a row carrying exactly those secrets and identifiers to prove it.

## Stable states, and freshness

Every result carries an `observedAt` instant and a **stable evidence state** from the
shared vocabulary in `src/lib/diagnostics/case/states.ts`, rendered in the evidence
block as `evidence-state="…"`. The state is what keeps four different things apart
that an empty result cannot:

`not_found` (we looked and there is nothing) · `permission_denied` (you were not
permitted, and nothing inferred it) · `not_configured` (this deployment has not set
it up) · `evidence_unavailable` (the source could not be reached).

Timestamps are ISO-8601 **UTC**, and the field names say so (`occurredAtUtc`,
`latestRunAtUtc`). An operator-facing answer is expected to be rendered in New
Zealand time by the surface that shows it.

## The shared diagnostic-case contract

`src/lib/diagnostics/case/` holds the structure the later packs contribute to, so one
Diagnostics conversation can combine booking, membership and finance evidence for a
single question under whichever areas the administrator holds. It carries the primary
record, the authoritative current state, blockers, warnings, current facts, history
kept apart from current facts, related records, the sources consulted **with their
evidence state**, and suggested next actions with the actor and permission each
needs.

Two properties are load-bearing and both are pinned by tests:

- **A denial is recorded as an outcome, not as a missing source.** A case that simply
  contained no finance evidence would read as "there is no finance problem"; a
  recorded denial says the evidence was withheld and which permission unlocks it.
- **An inference is not a rule result.** Every finding carries a `confidence`, and a
  case whose blockers are all `inferred` reports `hasInferredBlockerOnly`, so a
  surface can frame the answer as a likely cause rather than a verdict.

## Prompt injection

Every projected value comes out of a database and is treated as untrusted,
prompt-injection-capable evidence regardless of how server-owned it looks: it is
redacted and length-capped by the projection step, then neutralised by the evidence
renderer, which strips angle brackets and quotes so a stored value cannot forge a
block delimiter, add an attribute, or fake a new row. The evidence block tells the
model in its own header that everything inside is data to report and never an
instruction to obey.

## Operator troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| Every correlation tool fails; readiness says `over_privileged` | The release added a grant and provisioning has not been re-run | `npm run diagnostics:provision-role`, then re-check readiness |
| Readiness says `not_configured` for the database role | `AI_DIAGNOSTICS_DATABASE_URL` is unset | Provision the role and set the variable ([deployment.md](deployment.md)) |
| `diagnostics.readiness` answers, but no other tool will run | The diagnostics credential is the blocker | Read the `databaseRoleState` and `blockerCodes` this tool returns; that is what it is for |
| A correlation tool returns nothing for a request id you can see in the admin audit log | The event is older than the window | Re-ask with a wider window, up to `7d` |
| `evidence_unavailable` from a system tool | The application's own database or the deployed bundle could not be read | Check application health; this is not the diagnostics credential |
| `knowledgeBundleState` is not `verified` | The deployed knowledge bundle is missing or failed verification | See [the bundle guide](../diagnostics/KNOWLEDGE_BUNDLE.md); code answers stay unavailable until it verifies |
| Background-job health disagrees with Admin > Health about whether cron is enabled | This container's configuration differs from the cron leader's | Trust the screen for scheduling; the per-job classification is identical |

Incident response: the audit trail for tool use is
`ai_diagnostics.tool_invocation` in `AuditLog`, retention class
`sensitive_access` (24 months). It records the acting administrator, the tool id, the
areas checked, the allow/deny outcome, the stable failure reason, a non-reversible
hash of the accepted arguments and of the result, row and byte counts, duration,
round index and the observed-at instant — and never the arguments, the results, the
question or the answer. There is no per-tool version field: a tool's contract is its
code, so the release identifier — which `diagnostics.deployment_evidence` reports —
is what ties an audit row to the exact definition that produced it. To answer "what did this administrator look at",
query that action for their member id; to answer "was this the same answer twice",
compare `resultHash`.

## Adding to this pack

Follow the checklist in [tools.md](tools.md) → "Adding a tool". Two extra rules apply
here:

1. If the question has an authoritative first-party answer already — a rule engine, a
   health classifier, a money calculation — read it as a `server_owned` entry rather
   than re-deriving it in SQL. A second calculation that can drift from the admin
   screen is the failure mode #2375 names explicitly.
2. A new relation is granted **by column** unless every column of it is appropriate
   diagnostics evidence, and the pack doc lists each column with the reason a tool
   needs it. Re-provisioning is part of shipping it.

## Related

- [Tool substrate reference](tools.md) — the gates, bounds, audit, and the rules for
  adding a tool.
- [Deployment and operator guide](deployment.md) — provisioning the role, the grants
  it makes, and what readiness reports.
- [Page context](page-context.md) and the
  [knowledge bundle](../diagnostics/KNOWLEDGE_BUNDLE.md) — the other two evidence
  channels.
- [Hub, ADRs, and threat model](README.md).
