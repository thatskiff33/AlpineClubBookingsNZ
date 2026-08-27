# Xero Subsystem Architecture

> Part of the [documentation hub](../README.md).

This document maps the operational Xero integration: the ~50 `xero-*` modules
in `src/lib`, the database tables they own, the API routes and cron tasks that
drive them, and the dataflow through the three main flows (outbound documents,
inbound reconciliation, repair/hardening). It complements the repo-wide
[`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) ("Xero integration layers"), which
lists the module boundaries; this document explains how the pieces move at
runtime.

Source of truth for behavior is always the code. This map was produced by the
2026-07 quality wave (issue #1128) and reflects the codebase at that date.

## Membership subscription invoices

`MEMBERSHIP_SUBSCRIPTION_INVOICE` is an outbound outbox discriminator anchored
on `MembershipSubscriptionCharge`. Its correlation key is charge-stable.
Dispatch resolves the snapshotted recipient and uses the account/item mapping
frozen at confirmation,
then searches by the immutable `MEMSUB-*` reference. Zero matches creates an
AUTHORISED ACCREC invoice with inclusive line amounts and `OUTPUT2`; one exact
contact/account/item/amount/due-interval/type/state match is adopted. Only `AUTHORISED` is
adoptable; draft, submitted, paid, voided, and deleted invoices conflict rather
than being emailed. Duplicates or a mismatch set
the charge to `CONFLICT` without calling an Xero update endpoint.

Creation/adoption is committed locally (charge, covered subscriptions, canonical
Xero link) before `emailInvoice`. If email fails the operation is `PARTIAL` and
the charge is `EMAIL_FAILED`. Retrying enqueues the same charge key; the stored
`xeroInvoiceId` makes dispatch skip lookup/create and retry only email with its
stable email idempotency key. Crash recovery follows that same path.

The frozen recipient name/email are audit evidence. Dispatch deliberately uses
that recipient member's current Xero contact identity and Xero contact email.
Inbound invoice changes are joined back through charge coverage so a shared
family invoice updates recipient and non-recipient subscriptions together.

## Contact and member partial-success boundary

Contact creation keeps the provider call outside the local link transaction. Once
Xero returns a contact id, `createXeroContactForMember` carries a typed server-only
phase if the local link is unconfirmed or if the link committed before operation-log
completion failed. The admin routes for create, link, unlink, and contact import
track their own authoritative commit phases and return fixed `409 XERO_PARTIAL_SUCCESS`
recovery metadata for ordinary failures as well as hosting-participant contention.
Only positive, proven facts cross the API boundary; caught provider/database detail
remains server-side. Refresh and cleanup flags are included only while that specific
step is unfinished. The partial-unlink recovery names the two pieces of state that
can outlive the nulled pointer — the member's CONTACT ledger rows may still be
ACTIVE (`contactLinkRowsMayRemainActive`) and the `XERO_UNLINK` audit entry may be
missing (`auditEntryMayBeMissing`) — each only while that step is genuinely
unfinished, so the operator knows what to check rather than only that the unlink
"completed only in part".

An exact unmarked member contact-create reservation is treated separately as
`CREATE_IN_PROGRESS`: it suppresses another Create but does not claim that Xero
created a contact. Resetting a stale `RUNNING` reservation to `FAILED` preserves
that conservative state through `ORPHANED_STALE_RUNNING`. A recorded
provider-created pending-link phase retains the stronger recovery copy even after
the same stale reset.

Three things clear these fences, and only these three. Successful completion closes
the operation through the normal funnel. Explicit admin resolution
(`/api/admin/xero/operations/[id]/resolve`) sets `manuallyResolvedAt`, which every
blocker predicate filters on. And a canonical link commit closes a
provider-created create whose OWN recorded contact is the one just linked —
`closeProviderCreatedContactRecoveryForLinkedContact`, called from the manual link,
the inbound patch, and `findOrCreateXeroContact`'s phase-2 write, inside the same
Member row fence. That last one is deliberately narrow: `FAILED` rows only (a
`RUNNING` reservation is still live provider work), proven provider creation only,
and an exact `resolvedContactId` match. A create that made a *different* contact
stays open, because Xero then holds a second contact for this member and that is a
duplicate an operator must adjudicate. The write is a status-guarded `updateMany`,
so it is idempotent and a concurrent admin resolve simply wins.

Member merge, account deletion and the member detail display all read one predicate
for this — `findMemberContactChangeMergeBlocker` — so a refused member can never
render as clean. The refusals name the blocking operation id and point at
Admin → Xero → Operations; the member detail Xero panel discloses the same
operation even when the member IS linked, which is precisely the case that used to
read clean while both lifecycle operations refused them.

`findOrCreateXeroContact` with `repairExistingLink` is the one caller allowed to
reserve a CREATE for an already-linked member: the caller has declared the current
link unusable (Xero rejected the reference, or an admin forced a re-sync), and
refusing was a dead end for a walk-in placeholder-email owner whose email search is
skipped by design. Repair first re-resolves by exact name — that search excludes
archived contacts, so a live same-named contact is re-linked rather than duplicated,
while an archived or absent one leaves creation as the honest outcome.

All consuming admin surfaces treat this as recovery, not a retryable failure. They
suppress duplicate create/link/unlink/import actions, reload or reflect canonical
member state, and keep a focused alert mounted across loading and refresh failure.
Provider idempotency, queue redelivery, and the rule that provider calls stay outside
database transactions are unchanged.

## Contact email containment on a copy

`INV-CONFIG-005` (ENV-SAFETY 3, #3036; epic #2986). Every application-managed
Xero contact write consumes `INV-CONFIG-003`'s canonical environment role before
it puts an email address on a contact.

**Two layers, answering two different questions.** *Which role is this?* is
answered for every Xero write there is or will be. *Is this contact contained?* is
answered where a document could reach a member.

**Layer 1 — the role, at a chokepoint.** `callXeroApi` is the single wrapper every
provider call in this subsystem goes through, and it refuses a MUTATION while the
role is UNKNOWN, before the retry ladder and before any usage row (nothing was
attempted, so nothing is metered). The classification is fail-closed: an operation
whose name does not begin with `get` is a mutation, so a writer added later is
refused without being enumerated. Reads are deliberately allowed — see
`xero-environment-write-gate.ts`. This layer exists because the funnel below is
NOT the whole story: a census on this issue found seven writers that never touch
it, and the surfaces claiming "nothing is written to Xero" were therefore false.

**Layer 2 — the contact funnel.** `findOrCreateXeroContact` is the funnel every
Xero DOCUMENT writer goes through to obtain its contact, so the containment gate
lives INSIDE it rather than at each caller. Counted on this branch there are
**twelve** direct call sites: `xero-booking-invoices.ts`,
`xero-subscription-invoices.ts`, `xero-entrance-fee-invoices.ts`,
`xero-supplementary-invoices.ts` and `xero-group-settlement-invoices.ts` (the five
invoice creators, one each), `xero-credit-notes.ts` (**two**),
`xero-modification-credit-notes.ts`, `xero-applied-credit-allocation.ts`,
`nomination.ts`, the admin force-sync route and the operation-retry worker. Plus
one INDIRECT site: `retryXeroWriteWithContactRepair`'s default `repairContactLink`
(`xero-contacts.ts`), which re-resolves to a DIFFERENT contact when it repairs a
stale link — and which is outside every transaction, verified rather than assumed.
`createXeroContactForMember` and `updateXeroContact` ask the same question for
themselves, because neither goes through the funnel.

**And three writers that need CONTAINMENT without going through the funnel.** The
rule is not "every Xero write": it is every operation that raises a new document
against a contact, or that can leave an invoice OUTSTANDING against one — because
those are the ones Xero's own reminders can act on. Three qualify:
`createXeroMembershipCancellationCreditNote` (the fifth credit-note creator,
which takes its contact from the invoice it is crediting),
`updateXeroBookingInvoiceForBooking` (re-pricing can RAISE the amount due) and
`deallocateExcessAppliedCreditForBooking` (removing credit raises it too). All
three call `requireContainedXeroContactForInvoiceOperation`, and **each names the
contact its own operation will act on** rather than letting the helper look one
up: the first version resolved `Member.xeroContactId`, which is a DIFFERENT
contact from the invoice's after a member merge or an admin re-link — so it proved
containment of a contact the operation never touched. The cancellation credit note
passes the invoice's contact, the booking re-price passes
`currentInvoice.contact` (which is why its check sits below the invoice read
rather than at the top of the function), and the deallocation asks Xero which
contact its invoice belongs to — a read it spends only on a copy, because the
contact is supplied as a lazily-called function. Recording a payment, allocating a credit note and voiding an invoice only
reduce what is outstanding; archiving a contact and changing contact-group
membership carry no document and no address. Those take layer 1 and not layer 2.

**The restored-database path is the reason this exists.** A copy restored from the
club's live database arrives with every member already linked, so the funnel's
steady-state fast path returns the stored contact id with no provider write and no
look at what that contact holds. Every invoice is raised `AUTHORISED` and stays
that way — deliberately, so settlement behaviour remains testable on a copy — and
Xero's own invoice reminders email the contact's stored address for outstanding
authorised invoices **with no API call from this application at all**. So
`INV-CONFIG-004`'s gate on `emailInvoice` is not sufficient: containment has to
happen before the invoice exists, on the id the funnel is about to hand back.

**Which role read, and the one substitution that would break it.** Containment
consumes `resolveEnvironmentRole()` directly and NEVER `resolveDeliveryPolicy()`.
The delivery policy exempts a confirmed copy that has declared a local capture
mailbox, because a capture intercepts everything this application sends; Xero
sends from its own servers, so a capture container never sees an invoice email.
A non-production installation therefore needs full containment regardless of its
transport mode — which includes every stack the browser suite runs on.

**The three answers.**

| Role | What happens |
| --- | --- |
| `PRODUCTION` | Nothing. `applyXeroContactEmailPolicy` is the identity function, no containment record is read or written, and every payload, stored request payload and idempotency key is byte-identical to before this change. |
| `NON_PRODUCTION` | Every address written into a contact payload is replaced by its contained form, and any contact the funnel is about to return is proved contained first. |
| `UNKNOWN` | Refused. No transform (UNKNOWN is not evidence of being a copy, so rewriting the club's real accounting on a guess is as wrong as emailing real members on one), and no provider MUTATION at all — no invoice, credit note, contact, payment or credit allocation — until the role is declared. Reads still run. |

**The contained address.** `xero-sandbox-contact-email.ts` is a pure leaf: a
SHA-256 of the normalised address, on the reserved `xero-sandbox.invalid` domain
(RFC 2606, never deliverable). Deterministic, so the same real address always maps
to the same contained one and a restored copy can recognise a contact it has
already dealt with; idempotent, so nothing double-wraps when the address travels
back out of Xero and into a payload again. The domain is deliberately NOT one of
the three placeholder domains — see `INV-CONFIG-005` for why merging them would
make a copy stop behaving like production.

**The proof, and what it costs.** One `XeroSandboxContactContainment` row per Xero
contact, holding the contained address derived from the member's current stored
address plus whether a deliverable address was actually overwritten. The steady
state is one indexed read per contact and **zero** provider calls, so a batch or
subscription run over hundreds of members touches Xero not at all. A provider read
and at most one provider write happen once per contact, on first containment, with
an idempotency key derived from the contact id and the address being written. A
row is written only after reading Xero's stored value back — never from "we
believe we sent that" — and the fast path requires the recorded address to match
what the application would write today, so a change to the member's address
re-verifies rather than trusting a claim made before the change.

**And the proof expires.** The fingerprint notices a LOCAL change; nothing
notices a change on the provider side, which is the side the proof is a claim
about. So the fast path also requires the proof to be younger than
`XERO_CONTAINMENT_PROOF_MAX_AGE_MS` (24 hours) and re-reads the contact past it.
The residual is the window: a change made in Xero, or a repair pushed from the
live site, is not noticed until it expires. `rewroteAddress` is monotone for the
same family of reasons — a re-verification finds the contained address in place
and would otherwise retract the record of a real overwrite, which is what the
operator count is built on.

**Where it runs.** Outside every transaction, like every other provider call in
this subsystem: after the funnel's short advisory-locked link transaction has
committed, and before the id reaches anything that can raise a document. No caller
of the funnel is itself inside a transaction — **verified at every call site
above, not deduced.** The stronger-sounding claim, that a caller *could not* be
inside one because the funnel opens its own, is FALSE and is not made: such a
caller would simply take a second pooled connection, which was already a pool
hazard before this change (it is what F7, #1355, restructured this function
around). The group-settlement path resolves its contact before its
`pg_advisory_xact_lock(1)` fence opens, which is the hazard `INV-CONFIG-004`
recorded for the same caller.

**Failure is a refusal.** If containment cannot be established — the provider read
fails, the write fails, the proof cannot be recorded, the migration has not been
applied — `XeroContactContainmentError` propagates and the document is not raised.
A copy that could not contain a contact and invoiced anyway is the outcome this
rule exists to prevent.

**The inbound direction.** A contained address must never become a `Member.email`:
both "import this Xero contact as a member" paths refuse one, because a member
minted from it would read as reachable on every screen and be able to receive
nothing.

**The bulk contact sync IS affected, and says so.** It matches members to contacts
by address, so on a copy every contained contact stops matching. It used to report
those as "No matching member by email", which is the same false-reason defect this
change fixed in `xero-member-import.ts`: the contact HAS an address, it simply
cannot be used. It now carries its own reason, so a copy's sync report says what
actually happened rather than implying the club's data is wrong.

**Operator surface.** `/admin/environment` reports how many contacts are
contained, how many of those were holding a deliverable address this installation
overwrote, when the first containment was, when the last check was and when a
deliverable address was last actually replaced — or "unavailable" rather than a
zero when a figure cannot be read. It also LISTS the rewritten contacts (member
name, a link into Xero, the instant), because the repair is per contact and is
performed by hand in Xero: no shipped route can push a stored address onto a
contact that already holds one, a copy is forbidden from writing a real address,
and the live site holds no record of what a copy changed. No email address of any
kind reaches that payload.

## Entrance-fee invoices

`ENTRANCE_FEE_INVOICE` is a one-off per-member charge (#1886, F21). Before
minting, `createXeroEntranceFeeInvoice` re-checks the durable
`ENTRANCE_FEE_INVOICE` link and then adopts by reference: it searches Xero by
the member-unique reference (`Entrance fee (<Tier>) - <full member id>`) and
adopts only THIS member's own `AUTHORISED` invoice for the expected amount.
Voided/deleted/draft invoices are ignored (so a re-issue is never suppressed), a
different-contact match is never adopted, and a wrong-amount or duplicate match
surfaces a `PROVIDER_MISMATCH`/`DUPLICATE_REFERENCE` conflict instead of a silent
adopt-first — the same discipline as the subscription path. Concurrent
double-minting is prevented by a member-scoped Xero mint idempotency key (mints
converge on one invoice, mirroring the contact path in F7/#1355) rather than a
DB lock across the provider call, backstopped by the raw partial unique index
`XeroObjectLink_entrance_fee_active_unique` (at most one ACTIVE entrance-fee link
per member).

## Bird's-eye dataflow

```mermaid
flowchart LR
    subgraph Triggers
        BIZ[Booking / payment / refund /\nmembership flows]
        WH[Xero webhook\n/api/webhooks/xero]
        CRON[Cron\n/api/cron/xero?task=...]
        ADMIN[Admin UI\n/api/admin/xero/*]
        CLI[scripts/xero-booking-repair.ts]
    end

    subgraph Ledger [Reconciliation ledger &#40;Postgres&#41;]
        OPS[(XeroSyncOperation)]
        LINKS[(XeroObjectLink)]
        EVENTS[(XeroInboundEvent)]
        CURSORS[(XeroSyncCursor)]
        CACHES[(XeroContactCache /\nGroupCache / AdminCache)]
    end

    subgraph Workers
        OUTBOX[xero-operation-outbox\nprocessQueuedXeroOutboxOperations]
        RETRIES[xero-operation-queue\nprocessQueuedXeroOperationRetries]
        INBOUND[xero-inbound-reconciliation\nrunXeroInboundReconciliationCycle]
        REPAIR[xero-booking-repair\nrunBookingXeroRepair]
        HARDEN[xero-hardening\nbackfill / cleanup / report]
    end

    subgraph Infra [Infrastructure]
        CLIENT[xero-api-client\ncallXeroApi + withXeroRetry]
        TOKENS[xero-token-store\nencrypted tokens + refresh lease]
        OAUTH[xero-oauth\nconsent / callback / disconnect]
    end

    XERO[(Xero API)]

    BIZ -- enqueue + kick --> OPS
    WH -- store event --> EVENTS
    WH -- bounded kick --> INBOUND
    CRON --> OUTBOX & RETRIES & INBOUND & HARDEN
    ADMIN --> OPS & EVENTS & REPAIR
    CLI --> REPAIR

    OUTBOX -- claim PENDING --> OPS
    RETRIES -- claim REQUEUE --> OPS
    INBOUND -- claim RECEIVED/FAILED --> EVENTS
    INBOUND -- cursors --> CURSORS
    REPAIR -- plan/apply --> OPS

    OUTBOX & INBOUND & REPAIR & HARDEN --> CLIENT
    CLIENT --> TOKENS
    OAUTH --> TOKENS
    CLIENT <--> XERO
    XERO -- webhooks --> WH

    OUTBOX & INBOUND --> LINKS
    INBOUND --> CACHES
```

Two design rules shape everything below:

- **Every Xero side effect is a ledger row.** All outbound writes and inbound
  reconciliations run inside a `XeroSyncOperation` (started/completed/failed
  via `xero-sync.ts`), and every created/discovered Xero object is linked to a
  local record through `XeroObjectLink`. The admin diagnostics, health
  snapshots, repair tooling, and hardening reports are all queries over this
  ledger.
- **Provider calls stay out of business transactions.** Business flows never
  call Xero inline. They enqueue an outbox operation inside their own
  transaction and then *kick* the worker after commit
  (`kickQueuedXeroOutboxOperationsIfConnected`, ~20 call sites). Cron sweeps
  whatever the kicks missed.

## Module map

`src/lib/xero.ts` is a compatibility facade (re-exports only, no logic) for
external callers. New code should import the focused module. The subsystem's
own `src/lib/xero-*` modules must import the source domain module directly, not
the facade — an `eslint.config.mjs` `no-restricted-imports` override enforces
this (#1208). Shared JSON-guard micro-helpers (`asRecord`/`readString`/
`readNumber`) live in `xero-json`. The subsystem groups as:

### Infrastructure

| Module | Owns |
| --- | --- |
| `xero-config` | Resolves the operational connection **from the encrypted DB store** (#2079): client id/secret and webhook key via `IntegrationCredential`, the redirect URI from `NEXTAUTH_URL`, and the auto-generated wrapped token-encryption key. No `XERO_*` credential env vars are read; legacy vars are detected and flagged. |
| `xero-oauth` | Consent URL, OAuth callback (`handleXeroCallback`), client construction, disconnect (revoke + clear tokens). |
| `xero-oauth-state` | CSRF state cookie for the OAuth round-trip. |
| `xero-token-store` | AES-encrypted token persistence (`XeroToken` row), connection status, and the **refresh lease** (`claimXeroTokenRefreshLease`) so concurrent serverless instances don't double-refresh; losers wait for the lease deadline and re-read. |
| `xero-api-client` | `getAuthenticatedXeroClient` (refreshes under lease), `callXeroApi` (meters every call into `XeroApiUsageDaily`/`XeroApiUsageEvent`, observes the daily budget and process-local rate-limit cool-downs), `withXeroRetry` (in-process retry for 429/5xx/408), `XeroDailyLimitError`, `XeroTransientOutageError`. |
| `xero-api-usage` | Daily budget constant and usage recording/summary. |
| `xero-api-errors`, `xero-error-shape` | Error classification helpers (status code, body message, headers). |
| `xero-error-alert` | Ops email on sync errors, deduplicated to one per hour via `EmailLog`. |
| `xero-links`, `xero-record-links`, `xero-record-types` | Deep links into the Xero UI and into local admin pages; shared record-activity types. See "Deep links into Xero" below for why the tenant GUID cannot be used in a Xero URL. |
| `xero-link-short-code` | `getXeroOrgShortCode()` — the organisation short code for links built on the SERVER (the twin of the `useXeroOrgShortCode` hook). Never throws; null means "build the generic link". |
| `xero-feature-flags` | `XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH`, `XERO_ENABLE_LIVE_MEMBER_GROUP_LOOKUPS`, `XERO_ENABLE_AUTOLOAD_XERO_CONTACT_GROUPS`. |
| `xero-organisation` | Cached connected-org facts: financial-year-end month, org name, lock dates, and the deep-link **short code**. |

### Reconciliation ledger core

| Module | Owns |
| --- | --- |
| `xero-sync` | The ledger primitives: `startXeroSyncOperation` / `completeXeroSyncOperation` / `failXeroSyncOperation`, payload redaction + hashing, `buildXeroIdempotencyKey`, `upsertXeroObjectLink` (enforces single-active canonical links for Member CONTACT, Payment PRIMARY_INVOICE, MemberSubscription SUBSCRIPTION_INVOICE), `recordXeroInboundEvent`. |
| `xero-sync-cursors` | `XeroSyncCursor` read/write for incremental syncs, plus throttling helpers. |
| `xero-stale-operations` | Filters/counters for operations stuck in RUNNING and inbound events stuck in PROCESSING (feeds cron health and the admin reset/replay actions). |

### Outbound document pipeline

| Module | Owns |
| --- | --- |
| `xero-operation-outbox` | `enqueueXero*Operation` (12 queue types) and the worker `processQueuedXeroOutboxOperations` (scans the indexed `queueType` column via `XERO_OUTBOX_QUEUE_TYPES`); also WAITING_PAYMENT release/reap for supplementary invoices. |
| `xero-operation-outbox-payload` | The 12 queue-type constants (plus the `XERO_OUTBOX_QUEUE_TYPES` list the pending scan filters on), payload schemas, and payload→expected-operation mapping used to claim rows safely. |
| `xero-operation-retry` | `retryXeroSyncOperation`: immediate replay of a failed operation (admin "Retry"), including contact-payload rebuild for member contact ops. |
| `xero-operation-queue` | Background replay: a REQUEUE `XeroSyncOperation` wraps the original id; `processQueuedXeroOperationRetries` claims and executes them via `retryXeroSyncOperation`. |
| `xero-operation-claim` | The shared `claimXeroSyncOperationToRunning(id, guard)` single-flight (#1272 part 2): one conditional `updateMany` that flips a PENDING row to RUNNING (with the four error/timestamp resets) only when `count === 1`. Both the outbox scan and the retry scan delegate their claim to it; only the caller's guard predicate differs. |
| `xero-booking-invoice-queue` | Thin helper: enqueue booking invoice + immediate kick, for callers that want one line. |
| `xero-booking-edit-settlement` | Classifies an admin booking edit into the right financial follow-up (update invoice / supplementary invoice / credit note) and queues it. |

### Financial document builders (called only by the outbox worker and repair)

| Module | Owns |
| --- | --- |
| `xero-booking-invoices` | Primary booking invoice create/update (`buildInvoiceLineItems`). |
| `xero-invoice-payments` | Recording Stripe payments against invoices and Stripe refunds as credit-note payments. |
| `xero-credit-notes` | Refund credit notes, unapplied (account-credit) credit notes, allocation to invoices. Stripe refunds settle **per delta** (#1162): a payment refunded in several steps gets one credit note per uncovered delta, keyed on a cumulative refunded-cents watermark; non-Stripe refunds keep one note per payment. |
| `xero-supplementary-invoices` | Positive booking-modification delta invoices. |
| `xero-modification-credit-notes` | Negative booking-modification credit notes. |
| `xero-entrance-fee-invoices` | One-off entrance-fee invoices per age tier. |
| `xero-group-settlement-invoices` | Combined ORGANISER_PAYS internet-banking invoice across joiner bookings. |
| `xero-invoice-helpers` | Shared date/allocation helpers for the six modules above. |
| `xero-mappings` | Account-code / item-code resolution from `XeroAccountMapping`/`XeroItemCodeMapping` (with legacy fallbacks), entrance-fee categorisation and idempotency keys. |

### Contacts and membership

| Module | Owns |
| --- | --- |
| `xero-contacts` | `findOrCreateXeroContact`, contact create/update, name normalisation/matching, and `retryXeroWriteWithContactRepair` (invoice writes retry once after repairing a stale contact link). |
| `xero-contact-containment` | `INV-CONFIG-005`: the environment-role gate on every contact write, the unforgeable policy token the payload builders require, and `ensureXeroContactContained` — the durable proof that a contact a copy is about to invoice can no longer reach a member. |
| `xero-environment-write-gate` | Leaf: the fail-closed role gate `callXeroApi` consults before any Xero MUTATION, the read/write classification, and the one operator-facing refusal wording. Imports the role resolver and nothing else, so it can sit under `xero-api-client` without a cycle. |
| `xero-sandbox-contact-email` | Pure leaf: how a contained address is spelled, and the predicates that recognise one. No database, no environment, no role. |
| `xero-contact-containment-status` | The operator count for `/admin/environment`: how many contacts are contained, and how many held a deliverable address that was overwritten. |
| `xero-contact-cache` | `XeroContactCache` + per-contact group-membership cache primitives (no dependency on CRUD/bulk flows). |
| `xero-contact-groups` | Contact-group cache refresh, cache-backed reads, managed age-tier group sync. |
| `xero-bulk-contact-sync` | Cursor-driven incremental contact refresh from Xero (`syncContactsFromXero`). |
| `xero-member-import` | Creates local members from cached contacts in mapped groups. |
| `xero-duplicate-contacts`, `xero-contact-link-mismatches`, `xero-contact-sync` | Admin diagnostics: duplicate detection, link-mismatch snapshots, contact update payload builders. |
| `xero-membership-sync` | Subscription status per season derived from Xero invoices; incremental `refreshAllMembershipStatuses` driver. |

### Repair, hardening, admin

| Module | Owns |
| --- | --- |
| `xero-inbound-reconciliation` | Stored-event worker + per-entity reconcilers + incremental cursor reconciliation (see Flow 2). Split into cohesive `xero-inbound/*` sub-modules (#1208 item 1 / #1270, entry re-exports the public surface); see refactor item 1 for the module map. |
| `xero-booking-repair` | Booking-vs-Xero audit and self-repair (see Flow 3). CLI entry: `scripts/xero-booking-repair.ts`. Split into cohesive `xero-booking-repair-*` sub-modules (#1208 item 2, entry re-exports the public surface); see refactor item 2 for the module map. |
| `xero-hardening` | Historical `XeroObjectLink` backfill, stale canonical-link cleanup, the emailed reconciliation report, repeated-failure alerting. Split into cohesive `xero-hardening-*` sub-modules (#1208 item 5, entry re-exports the public surface); see refactor item 5 for the module map. Cleanup and the report's drift classifications are source-aware for Stripe per-delta refund notes (#2901): see "Repairing Stripe refund-note links" under Flow 3. |
| `xero-refund-note-link-repair` | Dry-run-first operator repair for Stripe per-delta `REFUND_CREDIT_NOTE` links damaged by the pre-#2901 cleanup loop: unconditionally deactivates local mirrors of notes VOIDED/DELETED in Xero, reactivates wrongly deactivated links (recorded-status only, never past the provider-backed cash refund-note target — `resolveStripeCashRefundEvidence`, #2902/INV-PAY-050; landing short is applied honestly and the self-heal reissues the remainder), refuses payments with a still-executable credit-note operation (queued/running/awaiting-payment, failed-but-retryable, or a queued retry of one). No provider calls; `--apply` is bound to reviewed payment ids. CLI entry: `scripts/xero-refund-note-link-repair.ts`. Runbook: "Repairing Stripe refund-note links (#2901)" under Flow 3. |
| `xero-refund-note-status-recorder` | Read-only provider GETs that record each linked refund credit note's live Xero status onto ALL of its local links, active or not (`--record-statuses`; run automatically before `--apply`). Exists because inbound reconciliation structurally cannot stamp a status onto an inactive link, and the repair never reactivates an unknown-status note. |
| `xero-refund-note-status` | The one home for "does this credit-note status still count as refund coverage?" (`VOIDED`/`DELETED` do not) and for reading a link's recorded status — shared by the inbound contribution math, `sumCoveredRefundCreditNoteCents`, cleanup, the drift report and the operator repair so no path can disagree (#2901). |
| `xero-invoice-rounding-audit` | Read-only diagnostic that replays the pre-#1231 line maths in integer cents to flag issued invoices that would have carried the #1163 rounding drift, across **both** builder callers — per-booking invoices (`Payment.xeroInvoiceId`) and group-settlement invoices (`GroupBookingSettlement.xeroInvoiceId`). Makes **no** live-provider calls and mutates nothing (only `booking.findMany` + `groupBookingSettlement.findMany`). CLI entry: `scripts/audit-xero-invoice-rounding.ts`. See "Historical rounding-drift audit" below. |
| `xero-credit-sync-checker` | #2501 detect-and-warn reconciliation of **applied account credit**: compares each booking's stamped `BOOKING_APPLIED` sum (BookingApp's known credit, the same figure the #2483 email nets from) against its live Xero invoice `amountCredited`, and warns admins on drift with the exact per-booking amount. Read-only, idempotent, fail-safe. See "Credit-sync drift checker" below. |
| `xero-cron-runner` | Maps the 8 cron tasks to the workers above, records `CronJobRun` rows, gates on module + connection. |
| `xero-admin-failures`, `xero-admin-health`, `xero-record-activity`, `xero-admin-cache` | Admin overviews: failed-operation triage states, missing-invoice/missing-credit-note health snapshot, per-record activity timeline, cached chart-of-accounts/items. |

### HTTP surface

- `POST /api/webhooks/xero` — HMAC-verified event intake (Flow 2). A
  valid-signature **empty-events** POST is Xero's intent-to-receive (ITR)
  validation ping: the route records a `WebhookValidationReceipt` marker
  (receipt time + a non-reversible fingerprint of the resolved webhook key) so
  the setup wizard can prove the round-trip, then returns 200 (#2081).
- `GET /api/admin/xero/webhook/verify-status` — the wizard's webhook **Verify**
  poll + amber-badge source. Freshness-scoped and key-bound: green only for an
  ITR marker newer than a server-issued verify-start AND matching the currently
  stored key's fingerprint (so a stale marker or one under a replaced key never
  satisfies a new verify). Any admin may read; the key write is Full-Admin-only.
- `POST /api/cron/xero?task=memberships|outbox|retries|inbound|backfill|link-cleanup|report|credit-sync|all`
  — `CRON_SECRET`-gated; `all` runs the tasks in that order; `backfill` also
  runs `link-cleanup` by default. Tasks needing a connection are skipped (and
  recorded as SKIPPED) when Xero is disconnected or the `xeroIntegration`
  module is off. `credit-sync` (#2501) additionally self-throttles: a completed
  pass suppresses further Xero reads for ~20h, so bundling it into a frequent
  `all` cannot burn the daily Xero quota.
- ~38 admin routes under `/api/admin/xero/**` and `/api/admin/members/[id]/xero-*`
  — OAuth connect/callback/disconnect, status/health/usage, operations list +
  retry/requeue/resolve/mark-non-replayable/reset-stale-running, inbound-events
  list + replay, contact tooling (search/import/sync/duplicates/mismatches),
  mappings, record activity.

## Data model

| Table | Role |
| --- | --- |
| `XeroToken` | Single-row encrypted OAuth token set + `refreshInProgressUntil` lease. |
| `XeroSyncOperation` | The ledger. `direction` INBOUND/OUTBOUND, `entityType`, `operationType`, optional `localModel`/`localId`, `idempotencyKey`, `correlationKey`, `replayable`, error fields, redacted request/response payloads, resulting Xero object identity, manual-resolution override fields, and `queueType` (a denormalized, indexed copy of `requestPayload.queueType` set at enqueue — canonical value still lives in the payload; #1271). **Status machine:** `PENDING → RUNNING → SUCCEEDED | FAILED`, plus `WAITING_PAYMENT → PENDING` for supplementary invoices held until their Stripe payment settles. Claims are optimistic `updateMany` transitions, so concurrent workers cannot double-run a row. |
| `XeroObjectLink` | Local record ⇄ Xero object links with a `role` (e.g. `PRIMARY_INVOICE`, `REFUND_CREDIT_NOTE`, `CONTACT`, `ENTRANCE_FEE_INVOICE`) and `active` flag; unique on (local, xero, role). Canonical single-active scopes are enforced on upsert. |
| `XeroInboundEvent` | Stored webhook/admin events. **Status machine:** `RECEIVED → PROCESSING → PROCESSED | FAILED` (FAILED retried after a backoff; stale PROCESSING is operator-replayable). Unique `correlationKey` makes webhook delivery idempotent. |
| `ProcessedWebhookEvent` | Provider-scoped processing dedupe (`source`+`eventId` unique); the inbound worker claims a row before reconciling and releases it on failure. |
| `WebhookValidationReceipt` | One row per provider recording the last valid intent-to-receive (ITR) validation ping (#2081): `validatedAt` + a non-reversible SHA-256 `keyFingerprint` of the webhook key that signed it (never the key). Drives the wizard's freshness-scoped, key-bound webhook Verify and the persistent amber "webhooks not configured" badge. |
| `XeroSyncCursor` | Incremental checkpoints per (`resourceType`, `scope`) for contact/membership/invoice reconciliation. |
| `XeroContactCache`, `XeroContactGroupCache`, `XeroContactGroupMembershipCache` | Local snapshots of Xero contacts and group memberships (feed admin tooling, member import, group sync). |
| `XeroApiUsageDaily`, `XeroApiUsageEvent` | Metered API usage vs. the daily budget; rate-limit hit tracking. |
| `XeroAdminCache` | TTL cache of chart-of-accounts and items per tenant. |
| `XeroAccountMapping`, `XeroItemCodeMapping` | Operator-configured account/item code mappings resolved by `xero-mappings`. |

## Flow 1 — Outbound financial documents (the outbox)

Business flows that create money artefacts (booking paid, refund approved,
modification settled, membership cancellation approved, group settlement
raised, entrance fee due) enqueue an operation and kick the worker. Nothing
talks to Xero inside a business transaction.

```mermaid
sequenceDiagram
    autonumber
    participant BIZ as Business flow<br/>(booking-create, stripe-webhook-service,<br/>booking-cancel, refund admin, ...)
    participant OB as xero-operation-outbox
    participant DB as Postgres<br/>(XeroSyncOperation / XeroObjectLink)
    participant DOM as Document module<br/>(xero-booking-invoices, xero-credit-notes, ...)
    participant CT as xero-contacts
    participant API as xero-api-client
    participant XERO as Xero

    BIZ->>OB: enqueueXero*Operation(...)
    OB->>DB: existing-link / duplicate checks,<br/>INSERT op (PENDING or WAITING_PAYMENT,<br/>requestPayload.queueType, idempotency key)
    BIZ--)OB: kickQueuedXeroOutboxOperationsIfConnected({limit:1})<br/>(after commit; cron ?task=outbox sweeps the rest)

    Note over OB: Supplementary invoices held as WAITING_PAYMENT are released<br/>to PENDING by stripe-webhook-service when the payment settles;<br/>reapStaleWaitingPaymentXeroOutboxOperations fails them after 14 days.

    OB->>DB: claim: updateMany(id, status=PENDING,<br/>expected entity/operation) → RUNNING
    OB->>DOM: dispatch on queueType (12 types)
    DOM->>CT: findOrCreateXeroContact(member)
    CT->>API: callXeroApi(withXeroRetry(...))
    API->>XERO: create/search contact
    DOM->>API: create invoice / credit note / allocation<br/>(retryXeroWriteWithContactRepair on stale contact)
    API->>XERO: POST document
    XERO-->>DOM: document id / number
    opt Stripe already settled
        DOM->>XERO: record payment against invoice /<br/>credit-note payment for refunds
    end
    DOM->>DB: completeXeroSyncOperation(SUCCEEDED,<br/>redacted response, upsert XeroObjectLinks)
    alt failure
        DOM->>DB: failXeroSyncOperation(FAILED + error code/message)
        Note over DB: surfaced in admin failures overview;<br/>replayed via retry/requeue (below) or repair (Flow 3)
    end
```

The 12 queue types: entrance fee, booking invoice, booking invoice update,
refund credit note, account credit note, supplementary invoice, modification
credit note, modification account credit note, credit-note allocation,
membership-cancellation credit note, membership-cancellation contact update,
group-settlement invoice.

**Retry taxonomy** (each layer is distinct — do not conflate when changing):

1. **Transport** — `withXeroRetry` retries 429/5xx/408 in-process with backoff;
   `callXeroApi` meters usage and trips process-local cool-downs
   (`XeroDailyLimitError`, `XeroTransientOutageError`).
2. **Stale contact repair** — `retryXeroWriteWithContactRepair` repairs the
   member↔contact link once and retries the write.
3. **Operation replay** — a FAILED ledger row is never auto-retried by the
   outbox loop (it only claims PENDING). Admins either replay immediately
   (`retryXeroSyncOperation`) or queue a background REQUEUE wrapper
   (`enqueueXeroSyncOperationRetry` → `processQueuedXeroOperationRetries`,
   cron `?task=retries`). Because FAILED is that terminal, an operation a
   process-global cooldown refused **before any HTTP** is no longer failed at
   all (#2423 review): it returns to PENDING with `startedAt: null`, the same
   un-claim the applied-credit busy collision uses, so the next cron re-drives
   work that never reached Xero. Otherwise the first failing operation of a
   batch armed the breaker and condemned operations 2..N of that same batch,
   un-attempted, to wait for an admin's Requeue.
4. **Inbound event retry** — FAILED `XeroInboundEvent` rows are re-swept after
   `XERO_INBOUND_FAILED_RETRY_BACKOFF_MS`; stale PROCESSING rows are
   operator-replayable.

## Flow 2 — Inbound reconciliation (webhooks + incremental cursors)

Xero pushes CONTACT and INVOICE events; the webhook stores them and returns
fast. Reconciliation happens in a bounded worker kicked after the response and
swept by cron. Internet-banking settlement rides this flow: when an invoice is
paid in Xero **with cash evidence** (`amountPaid` > 0, falling back to actual
payment records; operator-applied overpayments/prepayments count), the
matching local payments/bookings are flipped here. A PAID event produced by
credit-note allocation — the app's own invoice-clearing notes do exactly that
on every unpaid-IB cancellation — settles nothing (#1435): identifiers are
stamped for linkage only, admins are alerted if the booking is still live,
and a payload carrying neither cash field fails the event into the
FAILED-retry sweep rather than settling blind. Both credit-minting arms —
cash landing on an already-cancelled booking's stale invoice, and the
late-capacity-failure cancel — mint member credit sized by the invoice's
quantified cash, clamped to the payment amount (#1357/#1459) and, across all
payments matched to one invoice, to the invoice's remaining cash (#1505): a
mixed cash+allocation invoice credits only the cash portion, the admin alert
names both amounts so the allocation source gets verified, and verified cash
arriving after a mint alerts with the delta (it never credits automatically).
Two never-settled payments on one invoice each mint no more than the invoice's
cash NOT already minted for the other (a defensive invariant — no app flow
produces that shape; the remaining-cash read-back happens inside each payment's
reconcile transaction under the shared advisory lock, so it stays idempotent
under retry, and a capped mint raises the same loud alert, never a silent
overmint).

```mermaid
sequenceDiagram
    autonumber
    participant XERO as Xero
    participant WH as /api/webhooks/xero
    participant DB as Postgres<br/>(XeroInboundEvent / ProcessedWebhookEvent)
    participant W as xero-inbound-reconciliation
    participant REC as Per-entity reconcilers
    participant BIZ as Booking / payment / membership state

    XERO->>WH: POST events (HMAC signature)
    WH->>WH: verify HMAC-SHA256 (timing-safe), bound body/count
    loop each event
        WH->>DB: recordXeroInboundEvent(RECEIVED,<br/>unique correlationKey — duplicate-safe)
    end
    WH-->>XERO: 200 ok
    WH--)W: after(): runXeroInboundReconciliationCycle<br/>(batch ≤10, ≤3 batches; cron ?task=inbound sweeps)

    loop claimed events (RECEIVED, or FAILED past backoff)
        W->>DB: claim → PROCESSING; dedupe via ProcessedWebhookEvent
        W->>DB: startXeroSyncOperation(INBOUND, WEBHOOK_RECONCILE)
        W->>REC: processXeroInboundEvent(event)
        alt CONTACT
            REC->>BIZ: refresh contact cache + member link,<br/>managed group sync, membership backfill
        else INVOICE (paid)
            REC->>BIZ: syncInternetBankingPaymentsForPaidInvoice:<br/>cash-gated (#1435) — with cash evidence flip IB<br/>payments → PAID, confirm booking, bed allocation,<br/>waitlist, emails; allocation-only PAID settles nothing<br/>(identifier stamp + live-booking admin alert)
            REC->>BIZ: syncGroupSettlementForPaidInvoice:<br/>same cash gate; with cash evidence flip all<br/>joiner bookings on the organiser invoice
            REC->>BIZ: refresh linked subscriptions
        else PAYMENT / CREDIT-NOTE
            REC->>BIZ: reconcile payment / credit note:<br/>refund business-state repair,<br/>account-credit allocation repair
        end
        W->>DB: complete op + mark event PROCESSED<br/>(on error: FAILED + backoff, release dedupe claim)
    end

    Note over W: then cursor-driven incremental reconciliation<br/>(XeroSyncCursor + minimum intervals):
    W->>REC: contacts changed since cursor (syncContactsFromXero)
    W->>REC: membership invoices since cursor
    W->>REC: invoice reconciliation driver
```

Operator replay (`/api/admin/xero/inbound-events/[id]/replay`) deletes the
dedupe row, resets the event to RECEIVED, and reprocesses it synchronously —
allowed for FAILED/PROCESSED events and for PROCESSING events older than the
staleness threshold (dead-worker takeover).

## Flow 3 — Repair and hardening

Reconciliation heals what Xero tells us about; repair audits what we *should*
have told Xero. `runBookingXeroRepair` cross-checks bookings, payments,
modifications, the operation ledger, and object links, then plans and
(optionally) applies corrective actions — almost all of which are just new
outbox operations, so Flow 1 idempotency applies.

```mermaid
sequenceDiagram
    autonumber
    participant OP as Operator
    participant CLI as scripts/xero-booking-repair.ts<br/>(--dry-run / --apply / --booking / --from --to)
    participant REP as xero-booking-repair
    participant DB as Postgres
    participant OB as Outbox + retry workers

    OP->>CLI: run scoped repair
    CLI->>REP: runBookingXeroRepair(scope, {apply})
    REP->>DB: loadAuditData: bookings + payments +<br/>modifications + XeroSyncOperations + XeroObjectLinks
    REP->>REP: classify findings (13 codes:<br/>MISSING_PRIMARY_INVOICE, STALE_PRIMARY_INVOICE_DETAILS,<br/>CANCELLED_BOOKING_OPEN_INVOICE, XERO_AMOUNT_MISMATCH,<br/>BLOCKED_BY_XERO_OPERATION, ...)
    REP->>REP: plan actions (15 types; safe-to-auto-apply flag:<br/>QUEUE_* invoice/credit-note ops, REQUEUE_XERO_OPERATION,<br/>SYNC_*_LINK/FIELD, MARK_MANUAL_REVIEW)
    opt --apply
        loop up to 3 passes
            REP->>DB: apply safe actions (enqueue outbox ops,<br/>requeue failed ops, fix links/fields)
            REP->>OB: processQueuedXeroOutboxOperations +<br/>processQueuedXeroOperationRetries
            OB->>DB: execute, update ledger
            REP->>DB: re-audit; stop when clean
        end
    end
    REP-->>CLI: pass reports + human summary
```

Scheduled hardening (cron tasks, all idempotent):

- `backfill` — `backfillHistoricalXeroObjectLinks`: creates canonical
  `XeroObjectLink` rows for pre-ledger history (runs `link-cleanup` too).
- `link-cleanup` — `cleanupStaleCanonicalXeroObjectLinks`: deactivates
  superseded canonical links. **Source-aware for payment refund notes
  (#2901):** a `source: STRIPE` payment refunded in steps legitimately holds
  one ACTIVE `REFUND_CREDIT_NOTE` link per refund delta (`INV-ADDPAY-020`),
  and its scalar `Payment.xeroRefundCreditNoteId` names only the latest of
  them — so cleanup never deactivates a LIVE active Stripe per-delta note link
  (resolved from the links' own payment ids, so a null scalar still shields
  them), while non-Stripe payment sources keep single-canonical enforcement
  and malformed (wrong `xeroObjectType`) or foreign (no such payment) links
  stay subject to cleanup. The exemption is status-aware: an active link whose
  recorded Xero status is VOIDED/DELETED is stale drift — a cancelled note is
  never coverage — and cleanup deactivates it (a local flip, never a provider
  call), which re-arms the credit-reconciliation self-heal after an operator
  void. Before this, cleanup and that self-heal fed each other an unbounded
  duplicate-note loop: cleanup deactivated live coverage, reconciliation saw
  the shortfall and minted another provider note, the scalar moved, and the
  next cleanup deactivated the other side. The reconciliation report's
  stale/mismatched/duplicate drift classifications share the same
  status-aware exemption so the emailed digest cannot flag the multi-note
  contract as drift, and a new `overCoveredStripeRefundPayments` drift class
  flags a payment whose active, non-cancelled coverage exceeds its refunded
  total — the state that silently suppresses every later refund note and that
  nothing else detects.
- `report` — `sendXeroReconciliationReport`: emailed issue digest (repeated
  failures, unsupported partials, stale pending, persistently-failing inbound
  events, link problems).
- Repeated-failure alerting (`maybeNotifyXeroRepeatedFailure`) and the
  once-per-hour error alert (`notifyXeroSyncError`) keep failure noise bounded.

### Repairing Stripe refund-note links (#2901)

Operator runbook for an instance damaged by the pre-#2901 cleanup loop: some
per-delta `REFUND_CREDIT_NOTE` links are wrongly inactive locally, and Xero
holds surplus duplicate credit notes (each usually with a refund payment
recorded against the Stripe bank account) that no money movement backs.

The repair is dry-run-first and split between Xero (manual, operator-only) and
the local ledger (scripted). **No code path ever voids or deletes a Xero
document automatically** — that judgement stays with the operator.

1. **Record live note statuses, then review the dry run** (keep the output
   with the change record):

   ```bash
   npx tsx scripts/xero-refund-note-link-repair.ts --record-statuses   # all refunded Stripe payments
   npx tsx scripts/xero-refund-note-link-repair.ts --record-statuses --payment <id>
   ```

   `--record-statuses` fetches each linked credit note from Xero (read-only
   GETs — nothing is created, voided or deleted) and merges its live
   `status` onto ALL of that note's local links, **including inactive
   ones**, then prints the dry-run report. This step is what makes the
   report trustworthy: inbound reconciliation structurally cannot stamp a
   status onto an inactive link (it reaches links only while they are active,
   or through the scalar pointer), and **a link whose live status was never
   recorded is never reactivated** — the report renders it as
   `status unknown`. For each payment whose active coverage diverges from the
   **cash refund-note target** — the provider-backed cash evidence of
   INV-PAY-050 (#2902), shown beside the raw refunded mirror with the rule
   that produced it (`provider-ledger` / `legacy-mirror`) — the report lists
   every refund-note link (active/inactive, recorded or payload-recovered
   amount, recorded Xero status) and the plan: reactivations (oldest first,
   never past the cash target), active links mirroring notes already
   VOIDED/DELETED in Xero (always deactivated — a cancelled note is never
   coverage), and what still needs manual review. A payment whose cash
   target is ZERO while refund notes are active is the #2902 fictitious
   shape: an account-credit-only cancellation carrying a cash refund note
   (and usually a Stripe-bank refund payment) no Stripe transaction backs.
2. **Fix the Xero side manually.** In Xero, void the surplus duplicate credit
   notes (and remove their refund payments) so exactly the notes matching the
   real refund deltas survive. **No code path ever does this for you.**
3. **Re-run `--record-statuses` and review again**: the voided notes are now
   recorded VOIDED (their still-active mirrors land inactive on recording,
   exactly as the inbound webhook would record them) and the previously
   ambiguous payments should read `REPAIRABLE`. Note the payment ids you are
   approving.
4. **Hold the Xero outbox during the apply window** — do not trigger
   `POST /api/cron/xero` or the admin outbox drain while step 5 runs. The
   outbox executor prices a credit note from a lock-free coverage read taken
   seconds before its provider call, so changing coverage mid-flight could
   mint a duplicate note — and so could the background retry drain and the
   admin panel's manual retry, which execute the same mint. The script
   refuses any payment with a credit-note operation that could still
   execute — a CREATE that is queued, running, awaiting payment
   confirmation, **or FAILED/PARTIAL while still marked replayable** (that
   combination is exactly what manual retry and requeue accept, and the
   credit-note retry runs while its row still reads FAILED), or a
   queued/running REQUEUE of one — re-checked inside each transaction. To
   clear a failed credit-note operation's block, retry it to completion or
   **mark it non-replayable** in the admin Xero panel; a non-replayable
   failed operation is terminally dead and does not block (and marking one
   "resolved" alone changes neither its status nor its replayability, so
   that by itself clears nothing). The apply transactions also re-sum
   coverage after their claims and roll back on any divergence — but not
   racing the executor at all is the cheap, certain option.
5. **Apply, bound to the payments you reviewed** (local ledger writes only,
   each payment in its own transaction, re-planned from an in-transaction
   snapshot and applied through status-guarded claims whose matched counts
   must equal the plan; safe to re-run — a second pass finds nothing):

   ```bash
   npx tsx scripts/xero-refund-note-link-repair.ts --apply --payment <id> [--payment <id>...]
   ```

   `--apply` refuses to run unscoped: it takes the reviewed payment ids so it
   can never write a plan no human saw. It re-records live statuses first
   (`--skip-status-check` opts out when Xero is unreachable; unknown-status
   links are never reactivated either way). A failed payment rolls back and
   is reported without aborting the rest of the run.

The script never reactivates unrelated links (other roles/object types), links
on non-Stripe, never-invoiced or nonexistent payments, links whose note is
VOIDED/DELETED **or whose live status was never recorded**, or any set that
would push coverage past the cash refund-note target. A plan that lands SHORT
of the target still applies its honest writes — once the phantom coverage is
gone, the daily credit-reconciliation self-heal issues one note for exactly
the uncovered remainder (never void anything just to force an exact landing).
A payment whose active, non-cancelled coverage EXCEEDS the target is reported
for manual review in Xero and left untouched — including the #2902
account-credit shape above, where the operator voids the fictitious notes and
their Stripe-bank refund payments in Xero, records statuses, and the next
apply run deactivates the local mirrors. Modules:
`src/lib/xero-refund-note-link-repair.ts` (planner/applier, no provider calls)
and `src/lib/xero-refund-note-status-recorder.ts` (read-only status GETs).

### Stripe refund notes cover cash evidence, never the mirror (#2902)

`Payment.refundedAmountCents` deliberately mirrors BOTH refund dispositions —
cash returned through Stripe AND cancellation/booking-modification value held
as member account credit (`applyLocalRefundAllocation` runs on the credit
paths so a later cancel cannot refund the same cents twice, #1031). It stays
authoritative for settlement and conservation maths. It is therefore the
WRONG input for deciding whether a Stripe cash-refund credit note should
exist in Xero: an account-credit-only cancellation used to read as a missing
Stripe refund, and the daily self-heal minted a fictitious
`REFUND_CREDIT_NOTE` plus a refund payment against the Stripe bank account
that no provider transaction backs.

INV-PAY-050 binds every refund-note surface to
`resolveStripeCashRefundEvidence` (`src/lib/stripe-cash-refund-evidence.ts`)
instead: `PaymentRefund` cents excluding only `failed` and `canceled` rows when
the payment has ledger rows (recorded before enqueue on every modern cash path,
so stepped refunds sum naturally, #1162/#1354), else the pre-ledger fallback of
the mirror minus the booking's account-credit disposition. That exclusion list
is deliberately the mirror's own, so a refund Stripe has accepted but not yet
settled keeps counting as cash (owner decision, 21 Aug 2026). Bound surfaces: health detection
(`getRefundsMissingXeroCreditNotes`, which also reports the cash figure), the
self-heal enqueue amount and the STRIPE enqueue cap
(`enqueueXeroRefundCreditNoteOperation`), the execution-time delta recompute
in `createXeroCreditNote` — which completes an already-queued fictitious
operation WITHOUT billing Xero — and the #2901 repair's coverage target
above. Three stated limits. Two are fail-safe — they can only UNDER-state cash,
so the pipeline under-flags a genuine refund note and never mints one: a payment
refunded partly before and partly after the `PaymentRefund` ledger existed
resolves from its partial ledger rows; and the legacy fallback subtracts the
booking's WHOLE account-credit disposition from each per-payment mirror,
because `MemberCredit` records only the source booking — no per-payment
attribution was ever persisted, so on a rare multi-Payment booking mixing a
genuine pre-ledger cash refund on one payment with an account-credit
disposition on another, the cash payment's note is under-flagged (the
repair's dry-run report still shows the divergence for manual review). The
third is NOT fail-safe in that direction and is the deliberate cost of counting
in-progress refunds: a refund Stripe has accepted but later `failed` counts as
cash between those two events, so the note can briefly OVER-state. It is
bounded — `cashRefundCents` stays clamped to `refundedAmountCents`, so the
overstatement can never exceed what was actually refunded — and the next
reconciliation run corrects it once the row lands on `failed`. It was chosen
over the alternative, which under-states every still-settling refund and is
both more common and harder to notice.
Fictitious notes minted BEFORE #2902 are found by the dry-run report above
and cleaned through the same operator void-then-apply loop.

Admin triage complements this: the failures overview groups FAILED operations
into actionable states (retryable, requeued, manually resolved,
non-replayable), the health snapshot lists paid bookings missing invoices and
refunds missing credit notes (flagged when the provider-backed CASH refund
evidence — never the refunded-amount mirror, #2902/INV-PAY-050 — still exceeds
the cents already covered by active refund credit notes, so multi-note refunds
are handled and account-credit-only cancellations are excluded), and
per-record activity shows the ledger for one booking/payment/member.

Owner-substitution alert (operator runbook): when a booking request's held owner
is no longer a valid non-login contact at conversion, the accept substitutes a
fresh contact rather than failing the requester, and the invoice bills that fresh
contact instead of the intended organisation. This raises the
`admin-owner-substitution` admin email alert (gated by the "Xero sync errors"
preference) alongside a durable `booking_request.owner_substituted` audit row.
On this alert the finance admin reconciles the invoice's Xero contact: repoint the
booking's invoice from the newly-created contact to the intended organisation in
Xero (and archive/merge the stray contact if appropriate). The alert names the
booking request, the booking, the intended vs. substituted contact, and the
substitution reason to guide the fix.

Expanding an operation in the admin Xero operations panel shows a plain-English
summary by default instead of raw JSON (#1448). `summarizeXeroOperation`
(`src/lib/xero-operation-summaries.ts`, a framework-agnostic pure module the
client panel imports) keys on `(entityType, operationType)` plus payload-shape
sniffing: it reads `requestPayload.queueType` when it is still present
(PENDING / failed-before-dispatch rows) and otherwise recognises the persisted
Xero request/response shapes (invoice, credit note, allocation, managed
contact-group sync). It builds facts from data already run through the
object-level `redactSensitiveJson`, so a summary can never surface a value the
redacted raw view would mask, and money is formatted only through the shared
`formatCents` helper (integer cents; Xero decimal dollars are converted to cents
first). Unknown or unmapped shapes return `null`, and the panel falls back to
the redacted raw request/response JSON exactly as before. A per-row **Show raw
JSON** toggle reveals the same redacted `<pre>` blocks for any mapped row.

### Credit-sync drift checker (#2501, read-only, detect-and-warn)

The owner's #2483 decision split the unpaid-confirmation credit problem in two:
the member-facing email nets applied account credit from **BookingApp's own
ledger** with no wait on Xero (delivered under #2483), and a **separate checker**
keeps that local ledger and Xero's live invoice allocations in sync, warning
admins whenever they drift. That split is what makes the local computation safe —
a manual Xero-side edit that diverges from the local ledger surfaces to an admin
instead of the two silently disagreeing. This checker is that separate half.

**Module:** `xero-credit-sync-checker` (`reconcileXeroCreditSync`).
**Cron task:** `credit-sync` (`xero-cron-runner`), recorded as
`xero-credit-sync-check`; scheduled in-process daily at 02:45 NZT (and runnable
via `POST /api/cron/xero?task=credit-sync`).

**What it reconciles, per booking (integer cents throughout):**

- `localStampedCents = |Σ stamped BOOKING_APPLIED rows|` — the applied credit
  BookingApp believes it has already allocated onto the club's Xero invoice
  (the rows whose `xeroCreditNoteId` is set). This is BookingApp's *known
  credit*, the same quantity `deriveBookingAppliedCreditCents` gives the #2483
  email.
- `xeroCreditedCents = round(invoice.amountCredited * 100)` — the credit Xero's
  live invoice actually shows allocated (read via `getInvoice`).

The scan universe is exactly the stamped-credit population — the only bookings
for which a Xero-invoice allocation is provably expected. Applied credit that
was never stamped (e.g. card-netted credit that reduces the charge rather than a
Xero invoice) is deliberately out of scope, because separating it from a stalled
IB allocation needs the payment source, and the stalled/failed-op class is
already covered by the reconciliation `report` task.

**Drift-warning contract (`admin-credit-sync-drift`, content-only, gated by the
"Xero sync errors" preference):**

| Finding | Fires when | Reported amount |
| --- | --- | --- |
| `missing_in_xero` | `xeroCreditedCents < localStampedCents` | shortfall = `localStampedCents − xeroCreditedCents` |
| `excess_in_xero` | `xeroCreditedCents > localStampedCents` | excess = `xeroCreditedCents − localStampedCents` |
| `no_invoice` | stamped credit but the payment has no linked Xero invoice | the whole stamped amount |

The email names the member, booking, invoice (deep-linked, org-stamped at send
time per #2314) and the exact per-note breakdown, and states plainly that
nothing was changed — it is a warning, never an auto-correct (the owner asked
for a warning; auto-correcting would risk masking the very regression the
checker exists to surface, cf. the #1547 alert-only rule).

**Safety posture (Critical — Xero + money):**

- **Read-only.** Mutates no financial state.
- **Fail-safe.** A Xero read failure (outage, rate-limit, degraded payload)
  **defers** that booking — it never emits a false-drift warning; a booking with
  an in-flight allocation/deallocation op (`entityType ALLOCATION`, PENDING or
  RUNNING) is deferred too (a transient window, not drift). Only a settled
  mismatch warns.
- **Breaker-friendly.** The `getInvoice` read passes `armTransientBreaker:
  false` (#2394/#2423): a reconciliation read must not arm the process-global
  transient-outage breaker and take invoicing/sync/webhooks down. It still
  *respects* a breaker armed elsewhere (`withXeroRetry` refuses up front), which
  simply defers every booking that run.
- **Idempotent + quota-safe.** Re-running produces the same findings. A
  *complete* pass (every scanned booking checked, none deferred, not truncated)
  throttles real Xero work for ~20h off the `CronJobRun` history — no schema and
  no per-booking state — so a persisting drift warns at most ~once/day and a
  frequent `all` schedule cannot exhaust the daily Xero quota. A pass that was
  truncated or deferred is **not** complete, so it does not throttle and the next
  run retries.

### Historical rounding-drift audit (#1318, read-only)

Issue #1163 was a 1–2 cent Xero invoice drift: the pre-#1231 line builder grouped
a guest's nights into contiguous **date** runs only and billed each run as
`quantity: nightCount, unitAmount: round(totalCents / nightCount) / 100`. When a
single contiguous run mixed nightly prices (a season boundary, or locked-vs-
re-priced nights), `nightCount * round(totalCents / nightCount)` could not
represent the exact cent total, so the issued invoice's guest-line total drifted.
The legacy no-per-night path drifted the same way whenever `guest.priceCents` was
not divisible by the night count. **PR #1231 fixed it for new invoices** by
splitting every run to a single price (so `perNightCents * nightCount ===
totalCents` by construction) but did **not** retroactively heal already-issued
invoices.

**Stance on historical data:**

- **Fresh install / new deployment — no action.** There is no pre-#1231 history to
  heal, so nothing to run.
- **Fork or existing install — self-check with the audit.** `xero-invoice-rounding-audit`
  (`scripts/audit-xero-invoice-rounding.ts`) replays the pre-#1231 maths in
  integer cents over persisted booking/guest/night data and flags issued
  invoices whose guest-line total would have drifted. It scans **both** invoice
  sources that use `buildInvoiceLineItems`:
  - **Per-booking invoices** (`Payment.xeroInvoiceId`), keyed off the booking's
    guests/nights, and
  - **Group-booking settlement invoices** (`GroupBookingSettlement.xeroInvoiceId`).
    For each settlement it re-runs the **exact** child query the real builder uses
    (`xero-group-settlement-invoices.ts`: `parentBookingId = organiserBookingId`,
    `organiserSettled = true`, `deletedAt = null`, `status in {CONFIRMED, PAID}`)
    and sums each settleable child's per-guest run drift, so the reconstructed
    line-item input matches what was invoiced.

  It is a **diagnostic only**: zero live-provider calls, no transactions, no
  mutations — it issues only `booking.findMany` +
  `groupBookingSettlement.findMany` reads (cursor-paginated). Run it against a
  **non-production copy** of the database:

  ```bash
  DATABASE_URL='postgresql://user:pass@host:5432/scratch_copy' \
    npx tsx scripts/audit-xero-invoice-rounding.ts --issued-before 2026-07-04
  # or: npm run xero:audit-invoice-rounding -- --issued-before 2026-07-04
  ```

  `--issued-before <YYYY-MM-DD>` should be the date you deployed #1231; it scopes
  the scan to invoices created before the fix via the issued-at proxy —
  `Payment.createdAt` for booking invoices and `GroupBookingSettlement.createdAt`
  for settlement invoices (both pre-exist their Xero invoice, so the filter is
  over-inclusive-but-safe). Omit it to scan every issued invoice. The report
  labels each candidate `[BOOKING]` or `[GROUP SETTLEMENT]` and prints the invoice
  id/number, the affected line run, and the computed drift in cents.

- **A flag is a candidate, not a proven error.** It means the local data would have
  produced a drifting line total under the pre-#1231 builder. It does **not** prove
  the live Xero invoice is still wrong: the invoice may have been issued after
  #1231 (already correct — the `createdAt` proxy is over-inclusive), or since been
  voided / credited / superseded. The audit also replays against the **current**
  persisted night data: a booking (or, for a settlement, **any one of its child
  bookings**) re-priced, modified, or cancelled after the invoice was issued will
  replay against post-change data that may differ from what was actually invoiced.
  The audit cannot see Xero invoice status, so **confirm each candidate against
  Xero before acting.**
- **Remediation is out of scope here.** Any correction is a **manual accounting
  action** (a Xero credit note / adjustment by the operator) or a separately-scoped
  repair task — this audit never edits money, invoices, or Xero.

Scope boundary: only `buildInvoiceLineItems` carries this pattern, and both its
callers — per-booking invoices and `xero-group-settlement-invoices` — are now
scanned. The entrance-fee and supplementary builders emit single `quantity: 1`
exact-cent lines and cannot drift, so they are out of scope by construction.

## OAuth and token lifecycle (supporting flow)

1. Admin hits `/api/admin/xero/connect` → consent URL with a signed state
   cookie (`xero-oauth-state`).
2. Xero redirects to `/api/admin/xero/callback` → `handleXeroCallback`
   validates state, exchanges the code, and `saveXeroTokens` encrypts
   access/refresh tokens with the auto-generated, HKDF-wrapped token key from the
   encrypted credential store (#2079) into the single `XeroToken` row (tenant id
   included).
3. Every worker call goes through `getAuthenticatedXeroClient`: if the access
   token is near expiry it claims the refresh lease
   (`refreshInProgressUntil`); the winner refreshes and persists, losers wait
   out the lease and re-read. This keeps serverless concurrency from burning
   refresh tokens.
4. `/api/admin/xero/disconnect` revokes and deletes tokens; workers then
   short-circuit via `isXeroConnected()` (cron records SKIPPED).

## Guided setup wizard (#2080)

The operator-facing setup surface at **`/admin/xero/setup`** is a guided,
three-step wizard, built as a **config of the reusable, provider-agnostic
`IntegrationWizard` shell** (`src/components/admin/integration-wizard/`) so
Stripe (C4) and Google (C5) reuse the same shell with their own steps:

1. **Create your Xero app** — portal-mirroring instructions with a shared
   `CopyField` (secure-context-aware, with a select-on-focus fallback for
   plain-HTTP LAN) for the app name, company URL, and the **resolved redirect
   URI** (derived from `NEXTAUTH_URL` via `getOperationalXeroRedirectUri`, so the
   displayed value is exactly what the flow sends).
2. **Enter credentials** — the write-only client id / secret form posting to the
   C1 credentials API (Full Admin only; weak-secret gate surfaced; verify-reset
   drops the connection and re-arms). Supersedes C1's interim
   `xero-credentials-section`.
3. **Connect** — the existing OAuth flow, then confirms the connected
   organisation **name** (via `/api/admin/xero/organisation`, extended to return
   the name and, since #2261, the deep-link short code). The connect route
   accepts a sanitised `?return=/admin/...` so the callback resumes on the
   wizard rather than the Sync page.

   Since **#2394** a failed organisation read is **shown, not swallowed**. The
   route's `readFailure` classifies it as `disconnected` / `rate_limited`
   (with the Xero limit and any `Retry-After`) / `unavailable`. Those three are
   the only kinds that reflect an answer FROM Xero; the wizard context adds
   three client-only kinds for the cases where nothing was asked of Xero at
   all, and the distinction is load-bearing, because copy on those branches may
   not vouch for the Xero connection:

   | kind | raised by | retry offered |
   | --- | --- | --- |
   | `forbidden` | our route returns **403** — the role has no finance access | no |
   | `signed_out` | our route returns **401** — the session expired | yes (sign in, then press) |
   | `check_failed` | the status read failed, the browser is offline, or the response would not parse | yes |

   `signed_out` is split from `forbidden` deliberately: the status and
   organisation routes resolve to the same `finance:view` requirement, so a
   plain permission denial 403s the status read first and never reaches here —
   which makes an expired session the likelier trigger, and "ask for finance
   access" the wrong advice for it.

   The retry is **manual by design** (owner decision on #2394): it re-runs the
   context load, which asks with `?refresh=1` — the only way past the
   60-second negative cache the failure just wrote. Its cost is **at most one**
   live `getOrganisations` call per press: the read takes no transient retry,
   and while a process-global cooldown armed elsewhere is active `withXeroRetry`
   refuses before any HTTP, so the press costs nothing and returns the
   remaining wait. Nothing auto-retries, so a rate limit is never made worse by
   the wizard.

   **The `?connected=true` marker is consumed once**, by `useXeroWizardContext`,
   which reads it and strips it from the address bar with `history.replaceState`
   before folding the forced read into its own first load. Both halves matter
   (#2394 review, F1). The shell mounts only the ACTIVE step and `goTo` is pure
   client state — no navigation — so the earlier step-level mount effect re-fired
   a forced live read every time an operator walked back to Connect, with nobody
   pressing anything; and because the shell blocks the step until the context has
   loaded, that step-level force always landed *after* the hook's own mount read
   had already gone to Xero, making every connect return cost two live calls
   instead of one. So: an ordinary page load costs no live call, the return from
   Xero costs exactly one, and every later visit costs none.

   Before all this, the wizard context's bare `catch {}`, that one-shot
   post-OAuth `refresh()` mount effect, and a null-name degradation that no
   caller could distinguish from "Xero has no name" combined to pin the step on
   "Confirming the organisation name…" indefinitely after a single blip.

   Three smaller invariants the step now holds, each from the #2394 review:

   - **A cached name never suppresses a failure** (F4). A failed read still
     serves the last known summary, so `name` can arrive beside `readFailure` —
     and the failure class that most often does this is a revoked-in-Xero
     authorisation, which leaves our token row (and `/api/admin/xero/status`)
     looking healthy. The step keeps the name but drops the success styling and
     labels it "the last organisation we saw", so the one failure this feature
     exists to surface cannot render as a green tick.
   - **A repeat failure changes the DOM** (F5). Identical text means React
     mutates nothing and the `role="alert"` region announces nothing at all —
     worst on the daily limit, whose wording cannot change for hours. The
     context carries `orgErrorAt` / `orgErrorAttempts` and the step renders
     "Checked N times, most recently at …".
   - **The busy state is `aria-busy`, never `disabled`** (F3, the
     `restore-built-ins.tsx` house rule). Re-entrancy is dropped by an in-flight
     ref inside the hook, so the control keeps focus while it works and N
     presses still cost one call.

   The step also renders `useXeroConnection`'s `error` now, so an OAuth callback
   that redirects back with `?error=` no longer lands silently. That value is
   **allow-listed on read** against `xero-oauth-callback-messages.ts` — the same
   three strings the callback route may write — because it is now rendered in a
   danger-styled box on two admin pages, and an unfiltered query parameter there
   is a phishing surface (React escapes it, so it was never XSS). Anything
   unrecognised becomes the generic "Xero connection failed" rather than being
   dropped.

Each step gates on **live server truth** (`isVerified(context)`); a small
`IntegrationWizardProgress` row persists only a resume cursor (advisory), so a
reload mid-flow resumes at the right step and a stale cursor can never skip a
gate. Advisory also means it loses to the operator: the shell tags its step
cursor with who placed it, and a resume that has not been APPLIED yet when the
operator clicks a step stands down instead of moving them (#2781, and see
`src/components/admin/integration-wizard/integration-wizard.tsx`). The window is
not the fetch — the shell renders a spinner until the cursor has arrived, so
there is no stepper to click while the GET is in flight. It is the React turn
after it resolves: the commit that first paints an interactive stepper, and the
passive effect that places the cursor, are two separate steps. Its length is
therefore main-thread scheduling rather than network latency, which is why it
fired under contended CI load and never locally.

**Mock-Xero E2E harness.** A test-only seam (`xero-mock-endpoint.ts`, gated on
`XERO_MOCK_API_ORIGIN`) routes the consent/token/connections/organisation calls
to gated `/api/testing/xero-mock/*` endpoints for the wizard happy-path
Playwright spec. It is **production-inert**: with the env var unset (every real
deployment) the OAuth/organisation code path is unchanged and the mock endpoints
404. C3 extends the harness with a webhook-validation ping and chart of accounts.

## Deep links into Xero (#2261)

The `xero-links.ts` builders cover two shapes of outbound link:

- **Object links** — a contact, invoice, or credit note, keyed on the Xero
  object's own id (`buildXeroContactUrl`, `buildXeroInvoiceUrl`,
  `buildXeroCreditNoteUrl`).
- **Organisation links** — the report centre (`buildXeroReportsUrl`) and the
  **"Go to Xero" button** in the Xero Sync page header (`buildXeroDashboardUrl`).
  There is one such button, in the page header rather than inside a section, so
  it is present whichever sections the admin has expanded.

Since #2283 the builders are the **only** way a Xero URL is spelled in `src/`:
the twenty-one inline `https://go.xero.com/…` strings that used to sit across
ten admin components (member detail and table, payments, subscriptions,
`sync-results-panel`, `shared.tsx`, `health-diagnostics-panel.tsx`) were all
migrated, so a change to `xero-links.ts` **does** reach every admin link into
Xero — though *reaching* a link is not the same as *scoping* it to the club's
organisation; see the bound below. The owner verified the failure mode those inline links carried: on a
Xero login with more than one organisation, a short-code-less URL lands in
whichever organisation the session last used — another club's books. Four of
them also used the new-app `/app/contacts/contact/…` path, which needs the
short code in the URL; they now go through `buildXeroContactUrl`, whose
`organisationlogin?shortcode=…&redirecturl=…` wrapper (short code known) or
session-scoped classic path (short code unavailable) is live either way. The
guard test `src/lib/__tests__/xero-links-guard.test.ts` fails CI on any new
`go.xero.com` URL literal in `src/` outside `xero-links.ts` — `https:`,
`http:` and protocol-relative `//` spellings alike, with prose mentions of the
bare host still legal and test files excluded (they assert and mock the
builders' exact output). It cannot see a host assembled from pieces, so it is
a brake on the obvious drift rather than a proof.

**The server-side rule (#2314).** Passing through a builder is not the same as
carrying the short code, and #2283 only reached the links a *client* component
renders. Everything built on the server was still short-code-less. The rule now,
settled by owner decision on 1 and 2 August 2026, is three sentences long:

1. **Every server-side producer resolves the short code**, by calling
   `getXeroOrgShortCode()` (`src/lib/xero-link-short-code.ts`) — the server-side
   twin of the `useXeroOrgShortCode` hook, wrapping
   `getXeroConnectedOrganisation`'s cache. It never throws and never hides a
   link; a null short code degrades to the generic URL. **Degrades, precisely:**
   a null short code means Xero is disconnected, mid-reconnect, or its
   organisation read failed — exactly when a stored URL is most likely to name
   books the club no longer owns — so `applyXeroOrgShortCode` **strips** the
   organisation in that case rather than passing the stored value through. A
   read can therefore never emit an organisation the club is not currently
   connected to, which is the half of the no-migration reasoning under rule 2
   that has to hold in the bad state as well as the good one.
2. **Nothing organisation-specific is ever persisted.**
   `XeroObjectLink.xeroObjectUrl` and `XeroSyncOperation.xeroObjectUrl`
   (`prisma/schema.prisma`) stay generic, because a short code baked into a row
   is wrong the moment the club reconnects to a **different** Xero organisation
   and nothing would ever correct it. `applyXeroOrgShortCode(url, { shortCode })`
   scopes a stored URL when it is read — and re-points one that already carries
   some other organisation's code, so a row written under a previous connection
   heals itself. This is an **invariant of the columns, not a convention**, and
   it is enforced in two places rather than promised. Most writes go through the
   two funnels in `xero-sync.ts` (`upsertXeroObjectLink` and
   `completeXeroSyncOperation`), each of which passes the value through
   `stripXeroOrgShortCode` on the way in — so none of the ~50 call sites that
   build a `xeroObjectUrl` and hand it to a funnel has to remember the rule.
   Three files cannot use a funnel and write the column with direct Prisma
   calls: `membership-cancellation-xero.ts` (a first-writer-wins
   `INSERT … ON CONFLICT DO NOTHING` claim, which an upsert would hand to the
   *last* writer), `xero-subscription-invoices.ts` (two link upserts inside a
   transaction whose shape the funnel's canonical de-duplication would change)
   and `xero-hardening-backfill.ts` (bulk `createMany` reconstruction of
   historical rows). Each strips at the write, and
   `src/lib/__tests__/xero-object-url-write-guard.test.ts` fails CI on any
   direct write of `xeroObjectUrl` that does not — including a fourth file
   appearing, or a payload moved out of the call where the guard cannot read it.
   A legacy row carrying a short code is normalised the next time it is written.
   No migration was needed or written: reads neutralise a stale code
   unconditionally (`applyXeroOrgShortCode` **strips** when no short code
   resolves, rather than passing the stored value through — see the note under
   rule 1 below), and writes converge.
3. **Emailed links are stamped at send time**, inside the three senders in
   `src/lib/email/admin-alerts-finance.ts` (manual-settlement conflict, repeated
   Xero failure, reconciliation report). A screen can re-render and pick up the
   current organisation; an email cannot, so it is the surface that most needs
   the organisation named, and the alert is a point-in-time snapshot of
   everything else it reports anyway. Those three senders are also the only
   callers that pass `getXeroOrgShortCode({ confirmLive: true })`: the 12-hour
   cache is per process and its invalidation bus reaches only the process that
   handled the connect/disconnect, so a cron or worker process can hold the
   PREVIOUS organisation's short code for hours after a reconnect — and
   `/organisationlogin/default.aspx?shortcode=…` actively switches the reader's
   Xero session, which makes a stale code worse than none. `confirmLive` forces
   the read and returns null unless it succeeded, so an email names the
   organisation only when it was confirmed at send time and otherwise degrades
   to the generic link. It is affordable because the senders bound it, not
   traffic: the repeated-failure alert is deduplicated against `EmailLog` for
   the window, the settlement conflict is throttled by a cross-instance
   `AlertCooldown` claim, and the nightly report takes one read for the whole
   email.

The producers behind the six server-fed render sites, all covered:

| Render site | URL produced by |
| --- | --- |
| `xero/_components/operations-panel.tsx` | `api/admin/xero/operations/route.ts` |
| `xero/_components/inbound-events-panel.tsx` | `api/admin/xero/inbound-events/route.ts` |
| `xero/_components/setup-panels.tsx` (duplicate contacts) | `xero-duplicate-contacts.ts` |
| `components/admin/xero-record-activity-panel.tsx` | `xero-record-activity.ts` |
| `components/admin/xero-suggested-contact-card.tsx` | `api/admin/xero/import-member-contact/route.ts` |
| `finance/_components/finance-dashboard-client.tsx` ("Open Xero reports") | `finance-dashboard-page.ts` |

Three write routes also return a link in their JSON response — member
`xero-link`, member `xero-push`, and Xero `force-sync` — and those returned
links are scoped, so the admin who has just linked, pushed or force-synced lands
in the club's books. `import-member-contact` is where both halves of rule 2 meet
in one handler: it stores the generic URL on the `XeroObjectLink` row and returns
the scoped one.

`xero-duplicate-contacts.ts` was the in-tree contradiction that made this a
decision rather than a patch — one function passed a short code and another did
not. Both now resolve it the same way, and the private `getOrganisations` call
the first one made has been dropped in favour of the shared cache.

The whole rule is pinned by `src/lib/__tests__/xero-server-deep-links.test.ts`
(each producer, against the real builders),
`src/lib/email/__tests__/xero-alert-deep-links.test.ts` (send-time stamping),
`src/lib/__tests__/xero-object-url-write-guard.test.ts` (rule 2's write side, as
a mechanism) and the `applyXeroOrgShortCode` cases in
`src/lib/__tests__/xero-links.test.ts`.

The identifier a Xero URL needs is the organisation **short code** (`!aBc12`),
*not* the tenant GUID stored on the `XeroToken` row. The GUID is not usable in a
Xero URL at all, so a link built from it would 404 — the reason every builder
takes an optional `shortCode` and degrades to a session-scoped `go.xero.com`
path without it. Both forms are live URLs; the short code only decides whether
the admin lands in **this club's** organisation or in whichever organisation
their Xero session last used.

The short code is read only from Xero's `getOrganisations` response, so it is
surfaced on **`/api/admin/xero/organisation`** (alongside the org name and
financial-year-end month), behind `getXeroConnectedOrganisation`'s 12-hour
in-process cache. It is deliberately **not** on `/api/admin/xero/status`:
status is a pure `XeroToken`-row read that every admin surface gating on Xero
hits (`useXeroStatus`), and hanging a live Xero call off it would spend API
budget on pages that only ask "is Xero connected?". Client-side, the pages that
render Xero deep links — the Xero Sync page, the members list and member
detail pages, payments, and subscriptions — each mount
`useXeroOrgShortCode` (in `src/hooks`, shared since #2283) **once per page**,
only when connected, and pass the short code down to their link-rendering
components as a required prop; a null short code degrades every link to the
generic session-scoped URL, it never hides one. They join the setup wizard's
org confirmation and the subscription-lockout settings panel as callers of the
organisation route, and all of them share the one in-process cache, so a cold
cache still costs at most one `getOrganisations` call per server process per
12 hours. The finance dashboard used to make the opposite trade — link generic
rather than fetch a short code — on the reasoning that a live Xero call per page
load was too expensive. The shared cache is what retired that argument, so its
two "Open Xero reports" source notes (`finance-dashboard-page.ts`, the P&L and
balance-sheet views) now resolve the short code server-side like every other
producer: one read per server process per TTL, shared with every other caller,
and a null one still degrades to the generic link.

Three honest bounds on that. First, the organisation route is **finance-only** —
settled, not open (owner decision, #2314, 2 August 2026): it asks for
`finance:view` in its own handler rather than leaving the area to be inferred
from the request path, so the answer no longer depends on a header
`src/proxy.ts` may or may not have stamped. Widening it to any admin who can
view settings was considered and declined — it grows the surface for no current
feature need. So "every admin" above reads "every admin holding the finance
area", which under the seeded role bundles includes the bookings, membership and
read-only administrators as well as the finance ones; an admin outside that set
(a content editor, say) sees the same links unqualified — degraded, never
hidden, which is the documented contract. `xero-organisation-route-authz.test.ts`
pins that audience against the real permission matrix.
Second, the short code arrives from a client fetch, so between mount and
resolution the links render their degraded `href`; a very fast first click gets
the session-scoped URL. That window is the pre-existing behaviour of the Xero
Sync page's button, now shared by four more pages.
Third, the 12-hour cache is per PROCESS and the invalidation bus
(`xero-organisation-cache-bus.ts`) reaches only the process that handled the
connect/disconnect. So after a reconnect to a **different** organisation, a web,
cron or worker process that did not handle it can keep serving the previous
organisation's short code until its entry expires. Accepted for screens — they
re-render, and re-reading per render is the cost the shared cache exists to
avoid; the alternative (stamping the summary with the `XeroToken` tenant id and
re-reading that row to compare) would put a database round trip on every cache
hit, including the operations list an admin polls. Not accepted for email: see
`confirmLive` under rule 3. The bound is stated in full next to
`ORG_CACHE_TTL_MS` in `src/lib/xero-organisation.ts`.

`getXeroConnectedOrganisation` is single-flight and caches **failures** as well
as successes. A present-but-failing connection (revoked refresh token awaiting
re-entry, an org read 500, a per-minute 429 raised by a concurrent bulk sync)
would otherwise leave the cache permanently cold, so every admin page load would
re-attempt a live call — the state in which admins reload most. A failed read is
therefore cached for **60 seconds** (serving the last known summary, or nulls),
concurrent cold-cache callers await a single shared read, and this read passes
`maxRetries: 0` so it never waits out a 429 for minutes on a page-decoration
call. Any later success replaces the negative entry and restores the 12-hour
TTL.

Since #2394 the summary also carries **`readFailure`** — `disconnected`,
`rate_limited` (plus which Xero limit and any `Retry-After`) or `unavailable`,
null on success — because every other field degrades silently on failure, which
left callers unable to tell "Xero has no name for you" from "we never got to
ask". Classification is **name-keyed** (like `classifyXeroLockDateCheckFailure`
and `getXeroApiErrorInfo`) rather than `instanceof`: `XeroDailyLimitError` and
`XeroTransientOutageError` are raised by the process-global cooldowns *before*
any HTTP call, so they carry no status code and their own `retryAfterSec` is the
only "when will this clear" signal there is. A failure can arrive **alongside**
a real value, because the fallback still serves the last known summary — callers
should prefer the value and read `readFailure` as "this is why it is not
fresher". Existing callers that only want values (the deep-link short code, the
year-end month, the lockout panel) ignore the field and are unchanged.

`forceRefresh` skips the negative entry **and** the in-flight join, which is
what makes the setup wizard's **Try again** meaningful: within the 60-second
window an ordinary read would hand back the cached failure, and a retry that
re-serves the failure it was pressed to clear is worse than no button. Nothing
on this path auto-retries; a live read happens on a press, and once on the
return from Xero, where the organisation may have just changed.

It passes **`maxTransientRetries: 0, armTransientBreaker: false`** alongside
that, and the pair is one decision (#2394 review, F2). Exhausting the transient
budget arms `rememberXeroTransientOutage`, the **process-global** breaker that
fails every subsequent Xero call fast for two minutes — invoicing, sync and
webhook replay included. #2261 chose `maxTransientRetries: 1` so a single 5xx
could not trip it; #2394 then put an operator-facing button in front of this
read, rendered precisely when Xero is 5xx-ing and with copy inviting a press,
which turned that budget into "two Xero calls per press, and a press that can
stop invoicing". Zeroing the budget alone is *worse* (the first 5xx would arm
the breaker), so `withXeroRetry` gained an explicit `armTransientBreaker`
opt-out. The read still **respects** a cooldown armed by a call that matters —
it refuses before any HTTP and reports the remaining wait — it just may not
start one. A page decoration must never be able to stop invoicing, however
often a human presses.

Since #2423 the year-end read below takes the same pair for a different reason —
it is unattended member traffic rather than a button.

`getXeroFinancialYearEndMonth` (same module, feeding membership
financial-year resolution) is **single-flight but deliberately not
negative-cached**. The de-duplication is the half that is free: concurrent
callers on a cold or failing cache collapse to one underlying Xero call instead
of N, at the cost only that a joiner shares the leader's outcome rather than
making its own attempt. Negative caching is the half that is not free here —
this is a money-adjacent value, so a connection an admin has just fixed must be
picked up by the very next call, not up to a minute later. What it **does**
share with the summary read (#2283) is `maxRetries: 0` — a read that degrades
immediately and re-attempts shortly gains nothing by waiting out a 429 inside
the call — and, since #2423, the full `maxTransientRetries: 0,
armTransientBreaker: false` pair.

`maxTransientRetries` moved from 1 to 0 in #2423's review because the budget of
1 had exactly one stated job: exhausting it is what arms the breaker, so a
budget of 1 meant "two consecutive 5xx to arm". The opt-out deletes that job,
and what the second attempt still cost was a second live Xero call on every
failed read — during an outage, twice per throttle window against the
**per-tenant daily cap invoicing shares** — plus, when the 5xx carries
`Retry-After`, a sleep of up to `maxWaitSec` **inside the member request**, with
every concurrent caller joined to it by the single flight. Zeroing the budget is
only safe *alongside* the opt-out (otherwise the first 5xx would arm the
breaker), which is why the two move together here exactly as they do on the
summary read.

The arming opt-out is the same mechanism as the summary read's, reached from the
opposite direction. #2283 left the capability here on a **frequency** argument
("it takes two consecutive 5xx"), not on a finding that this read should be able
to stop the rest of the integration. That argument does not hold where the read
actually sits: it is on **unattended member-facing traffic** (the subscription
gate), so it fires with nobody choosing to trigger it, and failures cache
nothing — while Xero is 5xx-ing, only the attempt throttle below bounded it, and
at the 15 seconds it then had, one member request per window would have kept a
120-second cooldown permanently armed. Meanwhile the read's own failure costs nothing (it degrades
to the fallback month), where the breaker it armed turned queued invoicing into
FAILED-unattempted rows that nothing auto-recovers — sharply enough that a single
member `confirm-draft` request could arm the cooldown and then have its **own**
invoice refused by it. Detection is untouched: arming remains the default for
every call that matters — invoicing, sync, webhook replay and the lock-date read
— so a genuine Xero outage still trips the breaker, just never from here. And as
on the summary read, opting out of **arming** is not opting out of
**respecting**: a cooldown armed by one of those calls still refuses this read
before any HTTP, and it degrades exactly as any other failure does.

Be precise about what the opt-out costs, because arming was doing **two** jobs.
Detection is the one it keeps; the other was **storm control** — a read that
armed the breaker thereby suppressed *itself*, pre-HTTP, for the cooldown. Drop
arming and that suppression goes too, leaving the read free to make a live
`getOrganisations` call every throttle window for the whole of an outage. So
#2423's review restored it **locally** (see the throttle below): the read backs
off for about as long as the breaker would have held it, without touching any
other caller. That matters beyond quota tidiness, because the **daily-limit
gate is a separate mechanism this change does not touch**:
`rememberXeroDailyLimit` has no opt-out, is armed by any caller that sees
`x-rate-limit-problem: day`, and is enforced inside `getAuthenticatedXeroClient`
itself — so it stops **every** Xero call in the process for up to 24 hours,
which is far worse than the 120-second breaker. Bounding this read's
outage-time volume is what keeps a member page view from being a plausible
route to it.

Capping the retries removed something the waiting did as a side effect, so
#2283's review restored both halves explicitly:

- **An honest fallback.** A failing read returns the last successful year-end
  month if it has one, else the year-end month sitting on the connected-org
  **summary** cache — the same `getOrganisations` field, one cache along.
  Before, a cold cache plus one 429 returned `null`, and
  `getFinancialYearResolution` turns `null` into `DEFAULT_FINANCIAL_YEAR_END_MONTH`
  (March), silently moving the season boundary — and with it
  `isSubscriptionEnforcementActive` — for the requests that hit it. Both
  sources are cleared by the same invalidation and guarded by the same
  generation counter, so neither can resurrect a previous organisation's month.
- **Attempt throttling.** A failure records when the next live attempt is
  allowed, and until then non-forced callers are handed that same fallback
  without a live Xero call. This is attempt control, not a negative value cache
  (the owner's option A bans the latter): nothing is pinned, and `forceRefresh`
  ignores the window entirely. It matters because this read sits behind
  member-facing traffic, which is **serial** — single flight only collapses
  callers that overlap in time, so without a throttle a broken connection
  became one live `getOrganisations` per request, the fastest way to pin Xero's
  per-minute limit and push an instance towards the daily limit. (Before #2423
  it also armed the global breaker; it no longer can, which is why the window
  now has to carry the storm control on its own.)

  Two window lengths, one rule (#2423 review):

  - **15 seconds** by default. Deliberately a quarter of the summary read's
    negative TTL: this value is money-adjacent, so a connection an admin has
    just fixed comes back almost at once. It is what a `disconnected` failure
    gets — an admin reconnecting is the fix, and the next request must see it —
    and what **any** failure gets while the fallback is `null`, because a cold
    cache serves the March default until a real month arrives, moving the season
    boundary. The cold-cache exemption is capped at **eight consecutive
    failures** (~2 minutes): #2283's rule is about a blip, not a licence to poll
    Xero every 15 seconds for hours from a process that booted mid-outage, which
    is ~4 calls a minute against the same shared daily cap. After that the long
    window applies and recovery costs ≤2 minutes instead of ≤15 seconds — a
    process that has already spent two minutes serving the March default.
  - **~120 seconds** when the failure is `unavailable` or `rate_limited` (a
    5xx/408, a refused socket, a live 429, or either process-global cooldown
    refusing pre-HTTP) **and** a real month is already held. Nobody can fix that
    by acting now, the answer served meanwhile is the true one, and the length
    mirrors `XERO_TRANSIENT_FAILURE_COOLDOWN_SEC` — the suppression the breaker
    used to provide for free. It is duplicated rather than imported so that a
    test mocking `xero-api-client` wholesale cannot turn the window into `NaN`.

All three organisation reads in that module — the year-end month, the
connected-org summary, and `getXeroLockDates` — share **one generation
counter**, because they share one invalidation. A read that started before a
connect/disconnect must not write the old organisation's answer into the
freshly cleared cache. Be precise about what that guarantees: it bounds the
**cache**, not the value already in flight. The abandoned read still resolves to
the single caller that started it, and for the year-end month that caller may be
`refreshFinancialYearConfig`, which passes what it was handed to
`setFinancialYearEndMonth` — a module global in `financial-year.ts` with no TTL
and no generation, held until the next refresh. That residual is single-request
and pre-existing; the counter's job is to stop a stale answer being **repeated**
for a whole TTL.

**Do not read that module global to decide anything on a background path
(#3116).** `financial-year.ts`'s cached year-end is written only by
`refreshFinancialYearConfig`, and nothing on the Xero cron, the outbox worker or
any other non-request path calls it — so on those paths it is the March default
whatever the club has configured. Two places got that wrong and both are fixed:
the membership sweep, which used it to decide **which season a Xero invoice
falls in** (and to bound the invoice query it sends), and four invoice and
credit-note descriptions, which used it to **name** the season. The sweep's
year-end is now a required field on `SubscriptionInvoiceMatchOptions`, resolved
once per run by `buildSubscriptionInvoiceMatchOptions` so a single sweep cannot
classify two invoices against two different windows; the description sites
resolve it and pass it explicitly. A caller that holds the value passes it; a
caller that does not resolves it — neither reads the global.

The lock-dates read is where that matters most. It is the fail-closed one: a
retroactive booking whose check-in falls on or before the effective lock date is
rejected at create time, and the read throws rather than degrading so the guard
can never be silently skipped. Without the generation check, a read in flight
across a reconnect would repopulate the just-cleared 5-minute cache with the
**previous** organisation's lock dates, and a booking that should have been
rejected would pass the guard and post its invoice into a locked period in the
organisation now connected.

**This read fires on mount of `/admin/xero`** (and, since #2283, of the other
deep-linking admin pages via the same hook), and that is a deliberate,
accepted exception to the usual reflex that live Xero calls hang off a click.
The click-only rule written on `/api/admin/xero/status` is scoped to the
**`?probe=1` connection-health probe** (#2105) and is untouched — a probe is an
uncached live call, so it must stay behind the "Check connection" button. The
organisation read is a different shape: it is cached in-process, so mounts do
not multiply calls. An uncached read is the only one that reaches Xero, and the
cache bounds that to **at most one `getOrganisations` call per server process
per 12 hours** — or per **60 seconds** while the read is failing, via the
negative cache below. A cold cache is also the only case that could stall the
link, and it degrades to the generic `go.xero.com` URL rather than blocking the
page. That was judged an acceptable price for links that always point at the
right organisation; hanging the read off a click instead would mean the
admin's first click went to the wrong organisation. `useXeroOrgShortCode`'s doc
comment carries the same note for anyone who arrives from the client side.

Cache invalidation is unchanged by the added field: the summary cache entry
holds the whole object, and `resetXeroOrganisationCaches` (fired from the
token store's connect/disconnect via `xero-organisation-cache-bus`) nulls it
wholesale — negative entries included, and abandoning any read in flight — so a
reconnect to a different organisation can never keep pointing "Go to Xero" at
the old org.

## Refactor opportunities (ranked)

Ranked by risk-reduction value; item 1 touches the most money-path logic.
These are candidates for future issues, not commitments.

1. **Split `xero-inbound-reconciliation.ts` (3,427 lines).** _Done (#1208 item 1
   / #1270):_ the file was split verbatim (behavior preserving, export-parity)
   into cohesive `src/lib/xero-inbound/<concern>.ts` sub-modules with an acyclic
   import graph — `types` (all interfaces + `XeroInboundReplayError`) and
   `constants` are leaves; the shared helpers `amounts` (money/credit/allocation
   math + metadata guards, including the still-local `getJsonRecord`),
   `object-links` (link dedupe/derive/find/recover) and `audit` sit above them;
   the per-concern reconcilers `contact`, `payment`, `invoice-paid-effects`
   (the internet-banking settlement flip + group-settlement side effects),
   `invoice`, `credit-note-repairs` (the two big business-state repairs
   `repairRefundedPaymentBusinessState` ~260 lines and
   `repairAccountCreditAllocationBusinessState` ~220 lines), `credit-note`, and
   the `incremental-reconciliation` cursor drivers depend only downward
   (`invoice` → `payment`/`contact`/`invoice-paid-effects`; `credit-note` →
   `credit-note-repairs`); and the `event-processing` worker (claim, dedupe,
   backoff, replay + the stored-event dispatcher and the public cycle/replay
   entry points) sits on top. `xero-inbound-reconciliation.ts` remains the entry
   as a re-export barrel over the unchanged public surface (3 functions +
   5 result types + `XeroInboundReplayError`) so every importer and the
   `xero-inbound-reconciliation.test.ts` doubles resolve unchanged. The
   settlement/repair code — the highest-risk money logic in the subsystem — now
   lives in `invoice-paid-effects` and `credit-note-repairs` where it can be
   reviewed in isolation.
2. **Split `xero-booking-repair.ts` (3,004 lines).** _Done (#1208 item 2):_
   the ~2,700 lines of private helpers were extracted verbatim (behavior
   preserving) into cohesive `xero-booking-repair-<phase>.ts` sub-modules —
   `-types`, `-deps`, `-utils`, `-payments`, `-object-resolution`, `-analysis`,
   `-findings`, `-classify`, `-load`, `-passes` — with an acyclic import graph
   (types/deps/utils are leaves; `classify` depends downward; the entry sits on
   top). `xero-booking-repair.ts` remains the entry (the `runBookingXeroRepair`
   orchestrator plus `formatBookingXeroRepairHumanSummary`) and re-exports the
   unchanged public surface. `classifyBookingContext` is a single sequential
   function that mutates its own local accumulators, so it stays whole in
   `-classify` (kept together, above the LOC soft cap, rather than editing the
   body). The private helpers still duplicate utilities elsewhere (JSON readers
   vs. `asRecord` copies in 4+ xero modules; `dollarsToCents` vs. shared money
   utils); de-duplicating them is deferred to item 6 to keep this split
   behavior-preserving.
3. **Make the outbox queue type first-class.** The PENDING query is a
   hand-written 12-branch `OR` over the `requestPayload.queueType` JSON path
   (unindexable), the dispatcher is a 12-way switch, and the 12 `enqueue*`
   functions repeat the same insert shape. A registry map
   (`queueType → {expectedOperation, handler}`) plus deriving the filter from
   the payload module's constant list removes three copies of the same
   knowledge. **Done (#1271):** `queueType` is now a denormalized, indexed
   `XeroSyncOperation` column (`@@index([queueType, status, createdAt])`),
   captured once at enqueue in `startXeroSyncOperation` (and backfilled from
   `requestPayload->>'queueType'`) and never updated afterward. The payload field
   stays canonical — the PENDING-scan `OR` and the parsing switch still read it.
   **Why the column mirrors the payload only pre-dispatch:** the column mirrors
   the payload only for rows still awaiting dispatch (`PENDING`/`WAITING_PAYMENT`);
   once a row is dispatched some handlers (e.g. the booking-invoice create/update)
   overwrite `requestPayload` wholesale and drop `queueType`, so the column and
   payload diverge post-dispatch. That is safe because the only consumer is the
   PENDING outbox scan (switched to the column in #1272 part 1), whose set is
   exactly the pre-dispatch set where column and payload still agree; the
   dispatcher and the parsing switch still read `queueType` from the payload.
   Making the column the sole discriminator everywhere is the remaining #1272
   consolidation (see item 4).
4. **Unify the operation-replay stack.** `xero-operation-outbox`,
   `xero-operation-outbox-payload`, `xero-operation-queue`, and
   `xero-operation-retry` describe one lifecycle (enqueue → scan/dispatch →
   execute → retry/replay → payload). _Done (#1272), in two owner-reviewed
   parts:_
   - _Part 1:_ the PENDING outbox scan
     (`processQueuedXeroOutboxOperations`) now filters on the indexed
     `queueType` column (using the `(queueType, status, createdAt)` index)
     instead of a hand-written 12-branch `requestPayload->>'queueType'` OR
     predicate, and the 12 queue-type values are consolidated into one exported
     `XERO_OUTBOX_QUEUE_TYPES` list in `xero-operation-outbox-payload` that the
     scan's `IN` consumes (single source of truth; per-type dispatch routing and
     the payload parse switch are byte-identical).
   - _Part 2:_ the duplicated claim-to-RUNNING `updateMany` in the outbox scan
     and the retry scan is extracted verbatim into one shared
     `claimXeroSyncOperationToRunning(id, guard)` primitive
     (`xero-operation-claim`); both callers delegate, passing only their
     guard predicate, so each resulting `WHERE` (and the atomic `count === 1`
     single-flight) is identical to before. A dispatch-domain test now drives the
     real if/else chain to prove it routes exactly `XERO_OUTBOX_QUEUE_TYPES`.

   _Deliberately not pursued (owner decision):_ physically co-locating the four
   files behind one `xero-operation-replay` boundary and folding
   `xero-stale-operations` plus complete/fail/requeue/stale into a single
   lifecycle god-helper — the column scan (part 1) and the shared claim helper
   (part 2) are the consolidations that de-duplicate real logic and close #1272;
   the rest would be churn without a behavioral payoff.
5. **Split `xero-hardening.ts` (1,606 lines).** _Done (#1208 item 5):_ the
   private helpers were extracted verbatim (behavior preserving) into cohesive
   `xero-hardening-<concern>.ts` sub-modules with an acyclic import graph —
   `-types` (all public type contracts plus the two shared private
   record types) and `-shared` (the failure-window/scope-key helpers and the
   REQUEUE/threshold constants used by more than one concern) are leaves;
   `-canonical-links` (`cleanupStaleCanonicalXeroObjectLinks`),
   `-repeated-failure` (`maybeNotifyXeroRepeatedFailure`), `-report`
   (`buildXeroReconciliationReport` + `sendXeroReconciliationReport`, including
   the #1196 persistently-failing inbound-events section), and `-backfill`
   (`backfillHistoricalXeroObjectLinks`) each depend only on the two leaves.
   `xero-hardening.ts` remains the entry and re-exports the unchanged public
   surface (5 functions + 9 types) so `xero-cron-runner`, the admin
   link-maintenance route, `xero-sync`, and the tests resolve unchanged.
   `-report` stays above the LOC soft cap (~960 lines) because it is
   irreducible under this split's own rules: `buildXeroReconciliationReport` is
   a single ~610-line function that must stay whole (carving it would break
   behavior preservation), and its remaining report-only helpers
   (`groupRepeatedFailures`, the issue-item/URL builders, the age/cutoff
   helpers) and report-only `Pick` types are consumed nowhere else, so moving
   them out would force exporting private helpers rather than keeping them
   module-internal.
6. **De-duplicate micro-helpers.** _Partly done (#1208):_ the byte-identical
   `asRecord`/`readString`/`readNumber` guards that appeared in `xero-sync`,
   `xero-operation-queue`, `xero-operation-retry`, `xero-admin-failures`, and
   `xero-operation-outbox-payload` now import from the shared `xero-json`
   module. The differently-shaped `getJsonRecord` guards from
   `xero-inbound-reconciliation` now live (still local, NOT merged into
   `xero-json`) in its `xero-inbound/amounts` sub-module after the item-1 split
   (#1270); merging them into `xero-json` is intentionally deferred to preserve
   behavior. The
   `readJsonRecord`/`readJsonString`/`readJsonNumber` guards from
   `xero-booking-repair` now live (still local, NOT merged into `xero-json`) in
   its `xero-booking-repair-utils` sub-module after the item-2 split; merging
   them into `xero-json` is intentionally deferred to preserve behavior.
7. **Finish retiring the `xero.ts` facade inside the subsystem.** _Done
   (#1208):_ no `src/lib/xero-*` module imports the `@/lib/xero` facade anymore
   — each imports the source domain module directly, and an `eslint.config.mjs`
   `no-restricted-imports` override forbids the facade path from `xero-*` files
   to hold the boundary. The facade stays for external callers.
8. **Minor:** _Partly done (#1208):_ the `messageForTask` nested-ternary chain
   in `xero-cron-runner` is now a `switch`. The webhook route's per-category
   `if` blocks were kept — they emit real observability log lines, so dropping
   them would change log output rather than being no-ops.
