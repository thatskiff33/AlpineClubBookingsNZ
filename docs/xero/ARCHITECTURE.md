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

The charge is the operation's `localId` (`subscriptionInvoiceChargeId`), and the
queued payload is the queue type alone (`INV-INT-026`, #3971). It used to carry
`chargeId`, which the persisting redactor blanks as a Stripe charge key, so every
subscription invoice failed with "Membership subscription charge not found:
[REDACTED]". A FAILED row is retried from Xero Operations: Retry sends the same
row back to the outbox under the same correlation key, and the active-key index
refuses it while another attempt for the charge is live. It refuses a charge
that already has a Xero invoice (resend its email from Subscription billing) or
no longer needs one, and the worker completes a charge already invoiced and
emailed without calling Xero.

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

## Seeding the missing person contacts (#2939)

`INV-INT-022` (the census) and `INV-INT-023` (the run). A club arriving here has
years of Xero history and a membership
list that only partly matches it. `findOrCreateXeroContact` gives a member a
Xero customer the first time a document is raised for them, which is fine month
to month and useless before a first real use: nobody knows how many members have
no customer, which of them Xero already holds one for, or which would become a
duplicate. `xero-missing-contact-seeding.ts` answers all three and then does the
work in bounded chunks, behind **Members with no Xero contact** on
`/admin/xero`. Three modules: `xero-missing-contact-seeding-shape.ts` (the types
and the call-cost constants, importing nothing so the admin panel can key its
copy on the engine's own unions), `xero-missing-contact-seeding.ts` (the census)
and `xero-missing-contact-seeding-run.ts` (the run).

**It resolves nothing itself, and that is the design.** Every contact is
obtained by calling `findOrCreateXeroContact` once per member. Five properties
therefore come with the funnel rather than being written a second time here, and
each is one a bulk tool could plausibly have got wrong:

| Property | Where it comes from |
| --- | --- |
| Link before create, against the PROVIDER | the funnel's Xero email search, which runs before any create. A missing local link is not proof Xero has no contact, so the cache is never treated as the answer |
| Retry and replay converge | the member-scoped reservation under the member row fence, plus a member-scoped Xero idempotency key. A re-run, a concurrent invoice and an interrupted chunk all land on one contact |
| The two-homes refusal | phase 2's `lockXeroContactHome` + `assertXeroContactHasNoOtherHome` (`INV-INT-018`) |
| Undeclared installations write nothing | `resolveXeroContactEmailPolicy` and the `callXeroApi` write gate (`INV-CONFIG-005`, epic #2986). The run additionally asks the gate once up front, so an operator gets one refusal rather than one per member |
| Contact-email containment on a copy | `ensureXeroContactContained` |

**The one thing it asks the funnel to do DIFFERENTLY: `requireAuthoritativeMatch`.**
The funnel's defaults are tuned for a document writer, where the expensive
outcome is a blocked invoice. Two of them proceed on an answer the provider did
not give: a Xero search that fails for anything but the daily limit falls
through to a CREATE, and a create Xero refuses on its contact-name uniqueness
rule is recovered by adopting the existing same-named contact — on the
NORMALISED NAME ALONE, with no email comparison.

Both trades invert for a bulk run. Nothing is blocked by refusing; what is
expensive is a duplicate customer in a ledger with no merge API, or worse, a new
member silently linked to a fifteen-year-old contact that happens to share their
name, after which every invoice, statement and reminder for them lands on
somebody else's account — and the panel would report it as "linked to a contact
Xero already had", indistinguishable from the safe email match the operator
approved.

So the run passes the option, which only ever turns a fallback into a refusal
and can therefore create or link nothing the default would not. A member the
provider could not be asked about authoritatively becomes a recorded failure the
next run retries. The run then compares the contact id the funnel RETURNED
against the one the reviewed plan promised, because a plan digest cannot see a
divergence that happens inside the funnel after the plan already matched.

**Why this is not the bulk path `INV-INT-019` used to exempt.** That exemption
was written before this tool existed, and its parenthetical named #2939 — which
reads as though whatever #2939 built would inherit it. It does not. The refusal
is unaffordable to a path that holds one transaction open across many contacts,
because the contact-home key would be held for the length of the run. This path
holds no such transaction: it is a loop of independent per-member calls, each
opening and closing the funnel's own short phase-2 transaction. The lock is
taken and released once per member, exactly as for a single invoice. #2939 also
closed the inbound exemption rather than leaving it standing —
`applyInboundMemberContactPatch` and the bulk member import both take the key
and the refusal now.

**The census, and why the dry run refuses before a contact sync.** The dry run
writes nothing at all and classifies from `XeroContactCache`. If that cache has
never been refreshed it returns `cacheReady: false` rather than counts, because
an empty cache makes every member look like "no contact in Xero" — the one
answer that would send an operator confidently towards duplicates. It also
reports the cache's AGE and marks it stale past a week: existence was always
checked and age was not, yet age is exactly what turns a "no cached match" row
into a duplicate, since a six-month-old cache reads identically to a
five-minute-old one.

**It classifies on BOTH axes the funnel can match on.** The email index answers
"does Xero already hold a customer at this address"; the NAME index answers
"will Xero refuse a create for this member because it already holds a customer
with this name", which is a different question and the only one of the two the
provider enforces. Both come from one pass over the cached contacts already in
memory, and the name is normalised with `normalizeXeroContactMatchValue` — the
same normaliser `findExistingXeroContactByExactName` compares with — so a name
this index finds is exactly a name the funnel's recovery would have adopted on.

**The run's bound is three guards, and each closes a door the others cannot.**
It processes the intersection of the member ids the operator reviewed with a
pushable set recomputed server-side at execution time. The reviewed half keeps
out anybody who became eligible only since the review; the recomputed half is
the revalidation of every row, so a stale or forged id is simply absent.

Membership is blind to a member whose PLAN changed while they stayed pushable —
the operator approves "link Jane to the contact Xero already has", the contact
sync archives it underneath them, and Jane is still pushable, now as a create.
So the reviewed plan's digest is posted with the ids and compared, refusing with
`SeedingPlanChangedError` exactly as the sibling member-grouping re-sync refuses
with `plan_changed`. There is still no persisted dry-run row and no single-use
claim, unlike that re-sync (#1961) — its plan is a set of Xero group ADDs a
double-run would repeat, whereas every write here is idempotent by member, so
the digest is carried in the request rather than stored.

The third guard is `requireAuthoritativeMatch` plus the returned-id comparison
above, which catch what happens INSIDE the funnel after the plan has matched.

**Bounded by real cost, and by the clock.** The chunk size is derived from what
a member actually costs: two Xero calls with contact grouping off (an email
search and a create), and up to four with it on, because the funnel's tail then
runs a managed-group sync that short-circuits before any provider call only in
`NONE` mode. A flat 25 was at least 75 calls against a 60-per-minute budget. A
wall-clock budget also stops the loop and returns its partial result, because a
route killed by its host's timeout loses the whole result — the summary audit
row is written after the run returns — while the contacts it created stay in
Xero.

**Ambiguity is returned, never guessed.** Six classes: a school already holds
the only contact on the address; another member holds it; two unlinked members
share the address (the family case, where a dependant carries the parent's
address); several contacts carry it; the one that does carries a different name;
or — on the name axis rather than the email one — Xero already holds an active
contact under this member's exact name at a different address. The name
comparison for the fifth is `namesAppearToMatchMemberAndContact`, shared with
the link-mismatch report rather than copied (`INV-SSOT`).

**What the operator is told afterwards.** Every member the chunk touched is
named, with what happened to them and WHICH Xero contact they ended up on —
counts alone cannot show a wrong adoption. A failure carries its kind, because
each has a different remedy and one of them, `PARTIAL_SUCCESS`, has standing
guidance that is *do not repeat the action*. Reviewed members the run declined
to touch are separated into those an earlier chunk already did and those that
stopped being pushable, which are different events and only the second needs
looking at.

## What an erasure leaves in Xero (#3058)

`INV-INT-024`. Engine `xero-erased-member-contact-review.ts`, shape
`xero-erased-member-contact-review-shape.ts`, surface
`GET /api/admin/xero/erased-member-contacts` and the **Erased members with a
Xero contact** panel. It is the mirror image of the missing-contact census
above: that one finds members with no contact, this one finds contacts with no
member.

**Erasure asks Xero for nothing about the CONTACT, by decision.** Both erasure
paths — the approved `DeletionRequest` anonymisation in
`deletion-requests/[id]/route.ts`, and the approved lifecycle `DELETE` in
`member-lifecycle-actions.ts` — null `Member.xeroContactId`, retire the
canonical `CONTACT` link, delete the `XeroContactCache` row, and stop. Xero
keeps the contact, its details, its history and every invoice raised against it.
There is no provider-cleanup queue, no destructive retry state and no `erasure
pending Xero` state, so no replay can create provider work.

**It is not free of Xero writes altogether, and the earlier wording said it
was.** Erasure cancels the member's future `PENDING`/`PAYMENT_PENDING`/
`CONFIRMED` bookings through `cancelBooking`, which enqueues account,
modification and refund credit notes and kicks the outbox. Those are ordinary
cancellation writes in the accounting ledger — the same ones any cancellation
makes — and they touch no contact, but a treasurer who read "nothing at all
happens in Xero" could disprove it from their own credit notes. Three things
hold the narrower claim: neither erasure source names a provider call or an
outbox enqueue; every DIRECTLY imported module that reaches Xero is declared by
name with its reason in `member-erasure-no-xero-mutation-contract.test.ts`, of
which there is exactly one (`booking-cancel`, on the anonymising path); and
`findOrCreateXeroContact` asserts the member is available for a contact change
before any provider call, so the credit-note path's own contact repair
(`retryXeroWriteWithContactRepair`) cannot mint a contact for the member the
erasure just anonymised.

That import check is one level deep on purpose. Measured on this tree, 358
modules are reachable from the anonymising erasure and **31** of them reach a
Xero provider call or an outbox enqueue — an allowlist over that is a census of
the application, not a guard. The older `/(^|\/)xero/` specifier test was worse
than depth: it read `membership-cancellation-xero` and
`organisation-xero-contacts` as not-Xero modules, so either could have been
imported onto an erasure path and passed unseen.

**Two filters turn retired links into a review.** A retired `CONTACT` link is
not evidence of an erasure: the merge-loser teardown, the admin manual unlink
route, `cleanupStaleCanonicalXeroObjectLinks` and the `INV-INT-020` school
transfer all produce one. So the engine first drops every contact that still has
a local home — asked through `findXeroContactHomes`, which is `INV-INT-018`'s one
accessor and therefore reads the `Organisation` column as well as the `Member`
one, so a school's live Xero customer is never reported as abandoned — and then
requires a POSITIVE erasure record: an approved `DeletionRequest`, or an approved
`MemberLifecycleActionRequest` with action `DELETE`. Both outlive the row they
describe. The anonymisation markers are deliberately not consulted;
`INV-LIFE-015` calls them a strong signal rather than a schema invariant, and a
hard delete leaves no row to carry them.

**What it cannot see**, stated because a review aid that reads as a guarantee is
worse than one that does not: a contact whose canonical link was never written.
Measured across the eight writers of a non-null `Member.xeroContactId`, every
one writes that link except `createXeroContactForMember`, which commits the
column in one transaction and the link in the next and documents the window;
`backfillMemberContactLink` repairs pre-ledger history.

**Disclosure.** Ids, the erasure kind and its date, to `finance:view`. The
contact cache is read for `contactId` and `contactStatus` only — its other
columns hold the erased person's name, email, phone and address — and a contact
Xero holds as `ARCHIVED` or `GDPRREQUEST` is counted rather than listed.

**How a row is retired, and why it needed a `POST`.** Nothing local can see a
treasurer archive a contact. The bulk contact sync's changed-contact fetcher,
`fetchChangedXeroContactsFromXero`, passes `includeArchived: false` and is the
only fetcher that sync uses for them on either path; the three call sites that
pass `true` are driven by ids derived from records that still hold a contact id,
and an erased member holds none. And the erasure deleted the cache row. So an
archived contact was permanently invisible here: the row stayed listed for ever,
the archived counter stayed zero, and the archived branch was dead code in
production — while four places promised the list would shrink when Contact Sync
ran.

`POST /api/admin/xero/erased-member-contacts` closes that loop. It asks
`getContacts` about exactly the ids on screen with archived included, keeps ONE
field of the answer, and stamps it on the retired `CONTACT` link's `metadata`
(`xero-erased-member-contact-status-check.ts`).

**The two verbs are gated differently, and the split is the point.** The `GET`
is `finance:view`: it computes from local state, calls no provider and writes
nothing, so any officer admitted to the treasurer audience may read what an
erasure left behind. The `POST` is `finance:edit`. It spends the club's metered
Xero allowance — fifty ids a call, with an explicit `XeroDailyLimitError`
branch — and once that allowance is gone, invoice sync, payment sync and the
outbox stop for everybody until it resets; and it writes the observation onto
the retired link. That is the same level `missing-contacts` takes on its run,
and the same one the two mismatch-resync panels take from the route map's
default for a `POST` under `/api/admin/xero`. The panel matches it with an
`AdminViewOnlySectionBanner` and a `ViewOnlyActionButton` on the check, so a
view-only officer reads the list and is not offered a button that would 403. It writes no `XeroContactCache`
row deliberately, for two independent reasons: a full refresh re-imports the
erased person's name, email, phone, address and the date of birth this
application writes into the NZBN field; and a status-only stub would give
`buildXeroContactCompanyNumberPatch` the "we looked and it is empty" reading
that is its permission to write, re-creating from the privacy screen exactly the
defect the erasure deletes the row to avoid.

The alternative — making Contact Sync fetch archived contacts — was rejected on
measurement: that loop has no archived handling at all, so archived contacts
would flow into member matching and creation unguarded.

**Retention, stated because the screen's whole subject is erasure.** A row is a
durable on-screen record that a member id was erased and when. It goes when Xero
is observed to hold its contact as archived or GDPR-erased, and otherwise it
stays indefinitely — correctly, because there really is an orphaned customer
nobody has decided about.

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
| `xero-config` | Resolves the operational connection **from the encrypted DB store** (#2079): client id/secret and webhook key via `IntegrationCredential`, and the redirect URI from `NEXTAUTH_URL` (the wrapped token-encryption key it used to generate was retired by #3806). No `XERO_*` credential env vars are read; legacy vars are detected and flagged. |
| `xero-oauth` | Consent URL, OAuth callback (`handleXeroCallback`), client construction, disconnect (revoke + clear tokens). |
| `xero-oauth-state` | CSRF state cookie for the OAuth round-trip. |
| `xero-token-store` | Token persistence: the only copy in the encrypted credential store (`xero-oauth` / `token-set`, #3454); the `XeroConnection` row (#3806) and, for the previous release, the `XeroToken` row; connection status; and the **refresh lease** (`claimXeroTokenRefreshLease`, on both rows) so concurrent instances — and an older deployed colour — don't double-refresh; losers wait for the lease deadline and re-read. |
| `xero-connection` | `readXeroConnection`: the one reader of the connection's non-secret facts — tenant and token expiry — for every surface that asks "is Xero connected" (#3806). |
| `xero-api-client` | `getAuthenticatedXeroClient` (refreshes under lease), `callXeroApi` (meters every call into `XeroApiUsageDaily`/`XeroApiUsageEvent`, observes the daily budget and process-local rate-limit cool-downs), `withXeroRetry` (in-process retry for 429/5xx/408), `XeroDailyLimitError`, `XeroTransientOutageError`. |
| `xero-api-usage` | Daily budget constant and usage recording/summary. |
| `xero-active-operation-statuses` | The active correlation-key population, shared by enqueue, resolution and repair reads. The census pins it to the partial unique index; supplementary-invoice statuses alias it and wider blockers extend it. |
| `xero-api-errors`, `xero-error-shape` | Error classification helpers (status code, body message, headers). |
| `xero-error-alert` | Ops email on sync errors, deduplicated to one per hour via `EmailLog`. |
| `xero-links`, `xero-record-links`, `xero-record-types` | Deep links into the Xero UI and into local admin pages; shared record-activity types. See "Deep links into Xero" below for why the tenant GUID cannot be used in a Xero URL. |
| `xero-link-short-code` | `getXeroOrgShortCode()` — the organisation short code for links built on the SERVER (the twin of the `useXeroOrgShortCode` hook). Never throws; null means "build the generic link". |
| `xero-feature-flags` | `XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH`, `XERO_ENABLE_LIVE_MEMBER_GROUP_LOOKUPS`, `XERO_ENABLE_AUTOLOAD_XERO_CONTACT_GROUPS`. |
| `xero-organisation` | Cached connected-org facts: financial-year-end month, org name, lock dates, the deep-link **short code**, and the **base currency** (#3633, read off the same `getOrganisations` response, so no extra call). |
| `xero-base-currency` | `xeroBaseCurrencyMismatch()` — the one comparison behind the warning shown when the organisation's base currency differs from the club's currency (#3633). Invoices carry no currency, so Xero books them in its base currency. A warning only: it changes no invoice. `xero-base-currency-server.ts` hands the base currency to a server page only for a viewer who may read the organisation summary (finance view). |

### Reconciliation ledger core

| Module | Owns |
| --- | --- |
| `xero-sync` | The ledger primitives: `startXeroSyncOperation` / `completeXeroSyncOperation` / `failXeroSyncOperation`, payload redaction + hashing, `buildXeroIdempotencyKey`, `upsertXeroObjectLink` (enforces single-active canonical links for Member CONTACT, Payment PRIMARY_INVOICE, MemberSubscription SUBSCRIPTION_INVOICE), `recordXeroInboundEvent`. |
| `xero-sync-cursors` | `XeroSyncCursor` read/write for incremental syncs, plus throttling helpers. |
| `xero-stale-operations` | Filters/counters for operations stuck in RUNNING and inbound events stuck in PROCESSING (feeds cron health and the admin reset/replay actions). |

### Outbound document pipeline

| Module | Owns |
| --- | --- |
| `xero-operation-outbox` | `enqueueXero*Operation` (every queue type in `XERO_OUTBOX_QUEUE_TYPES`) and the worker `processQueuedXeroOutboxOperations` (scans the indexed `queueType` column via `XERO_OUTBOX_QUEUE_TYPES`); also WAITING_PAYMENT release/reap for supplementary invoices. |
| `xero-operation-outbox-payload` | The queue-type constants (17 since #3635, plus the `XERO_OUTBOX_QUEUE_TYPES` list the pending scan filters on), payload schemas, and payload→expected-operation mapping used to claim rows safely. |
| `xero-operation-retry` | `retryXeroSyncOperation`: immediate replay of a failed operation (admin "Retry"), including contact-payload rebuild for member contact ops. |
| `xero-operation-queue` | Background replay: a REQUEUE `XeroSyncOperation` wraps the original id; `processQueuedXeroOperationRetries` claims and executes them via `retryXeroSyncOperation`. |
| `xero-operation-claim` | The shared `claimXeroSyncOperationToRunning(id, guard)` single-flight (#1272 part 2): one conditional `updateMany` that flips a PENDING row to RUNNING (with the four error/timestamp resets) only when `count === 1`. Both the outbox scan and the retry scan delegate their claim to it; only the caller's guard predicate differs. |
| `xero-booking-invoice-queue` | Thin helper: enqueue booking invoice + immediate kick, for callers that want one line. |
| `xero-booking-edit-settlement` | Classifies an admin booking edit into the right financial follow-up (update invoice / supplementary invoice / credit note) and queues it. |
| Kept late captures (#3635, `INV-PAY-110`) | A card payment captured after its booking was cancelled and KEPT by a treasurer (the #3639 task dismissed), recorded exactly as a card receipt: GROSS, dated the club day of the Stripe charge (`stripe-capture-date.ts`, stored on the row before the send; a kept change payment's supplementary invoice likewise), paid from `stripeBankAccount` that day. One pure decision, `decideLateCapture` (`late-capture-kept-xero-rules.ts`), serves the reaper, the late-capture release, the dismissal, the worker and the repair tool. A change payment on an invoiced booking is recorded by the document its change's evidence names (#4324, `INV-PAY-144`; `keptChangeCaptureRoute`, decided once by the keep - and the repair tool - in `planKeptLateCaptureXeroRecord`, under the approval task's row and then the change's supplementary-invoice anchor lock): its change's supplementary invoice where one naming the capture is paid or awaiting release (the late-success release, followed by a receipt only for a live unpaid change-invoice target under the anchor); its own `ADDITIONAL_CAPTURE_RECEIPT` - a payment on the invoice that bills the change, capped at Xero's AmountDue, with no gap check on a cancelled booking - where the change settled against the primary (#3980's marker), never had a supplementary invoice, has a live one billing this capture (raised unpaid, or recording it - never one moved onto, and paid by, another capture, or waiting on another intent), or is the anchor of a live #3980 gap invoice; the `KEPT_LATE_CAPTURE_INVOICE` where every supplementary invoice of the change was withdrawn or records another capture and no live gap invoice bills it; and nothing, for the repair tool to name, where no change can be read from the capture, even where an unpaid invoice names it (the owner's decision on #4324). A paid cancel leaves the primary standing, so a separate kept invoice for a change it bills would count the income twice. Whatever another writer records of the capture (`readCaptureRecorder`: the primary's create, a gap invoice's payment, the credit-release sweep's share, #4253) is taken out of a kept invoice, and a capture another writer records or holds whole gets none; the repair tool's dry run lists that net figure. Once a kept invoice bills a change, the supplementary enqueue raises no invoice for that change and the repair tool offers none; a #3980 gap invoice so refused raises the treasurer's `PRIMARY_INVOICE_UNDERBILLED` task instead, naming the change (`keptInvoiceBillsChange`), since the gap would bill that change a second time. The receipt counts as the capture's receipt for its refunds (`readLateCaptureXeroReceipt`, through the one read of its payment link), its worker re-reads the task under the anchor before Xero where its unlocked read finds the capture no longer kept, and always before storing a decision, closing its row in that same transaction when the capture is no longer kept, and credits back refunds once recorded; an approval after a reopen takes the anchor before its first write and withdraws one that has decided nothing. The booking's own payment, and a change payment on a booking Xero never invoiced, get a `KEPT_LATE_CAPTURE_INVOICE` (`xero-kept-late-capture-invoice.ts`) anchored on the approval task (`ManualRefundTask`) and keyed by it, carrying `capturedCents` and `capturedOn`, its payment through `createXeroPaymentForInvoice`. It touches neither the booking's own invoice nor its clearing note. A new queue type rather than a third supplementary anchor, because that builder is a booking change's document and its task anchor already means a second ask. **Refunds** of every kind are the ordinary refund note, owed only once the app recorded the capture's receipt (`readLateCaptureXeroReceipt`, `late-capture-xero-receipt.ts`: none, recorded, or resolved by hand), so an invoice cleared at cancel never causes a Stripe-account refund. Notes are sized per capture (`noteLateCaptureRefunds`, the capture's refunds less the notes recording its `paymentIntentId`; complete for every late-capture refund made since #4131, which refunds only the capture's own charge, `lateCaptureOwnChargeSlice`; the stated limit is a slice the previous release's plan took from another charge, before the deploy or by an attempt redelivered across it, which is not the capture's and stays the nightly self-heal's case, raised against the booking's own invoice), name the capture's own receipt and never `payment.xeroInvoiceId`, and are dated the refund's day; the worker credits back refunds taken before its send (`creditBackLateCaptureRefunds`). Every refund-note cap and gap reads one figure, the note-eligible cash (`refund-note-eligible-cash.ts`): the cash evidence less refunds of late captures without an app-recorded receipt, so the nightly self-heal never raises one. A late capture is known by its task row, so one whose automatic refund went out while its record did not (a crash, or a lost record write the webhook answers 500) is recorded first - by Stripe's redelivery, or by the self-heal's own check before it raises any card note, each proving from the refund's Stripe metadata that the late-capture door sent it (#4149, `late-capture-record-recovery.ts`); a payment the self-heal cannot check that night gets no card note. Meanwhile a `charge.refunded` for it queues no generic note, and on a cancelled booking a capture that landed after the cancel (the handler's marker or a cancel claim, `late-capture-landed-after.ts`) is outside the note-eligible cash even before its row exists, and the self-heal finds such captures from its own list rather than the gap (#4170); a capture the superseded-payment refund refunded on a cancelled booking is one of these by its cancel claim, so it is never noted, and the self-heal never asks Stripe about it (#4173). **The task row is the lock**: the enqueue (dismissal, repair) and the worker's send-time check take it `FOR UPDATE`, the check and a withdrawal commit together, and a raised invoice's missing payment is retried whatever the task's status (the repair tool offers it). Approval: an unsent row is withdrawn, a PARTIAL one goes back for its payment. Retry sends FAILED/PARTIAL back to the outbox from the kept queued payload. **An approved refund that Stripe gave up on, closed as "Paid another way"** (#3924 round 6, `INV-PAY-122`) leaves the capture in the Stripe account, so it owes the same receipt (`decideLateCapture`'s `refundClosedPaidAnotherWay`): the close queues it (putting a FAILED row back to PENDING only if it cannot have reached Xero - no payment link, no attempted invoice call, `keptReceiptMayHaveReachedXero`, #3924 rounds 7 and 8; one that may have is left FAILED and the close reports it held for an officer, never queued, as its dialog promised from the same fact, `keptReceiptHeldForOfficer`, round 9), and the worker writes the receipt's link under the task row, then queues the close's bank-transfer refund note at most once in a second transaction under the same row, so the note never precedes the receipt and a note failure never rolls the link back. A receipt already on its way as a change's supplementary invoice (queued, sending or FAILED) gives the close the same waiting key with nothing queued, and that invoice's worker runs the same note step once it is sent (`queueWaitingPaidAnotherWayNote`, round 8). A FAILED one is told apart (`invoiceFailed`), and an officer's retry sends it back through the outbox on its own row with its queued payload, so the receipt reads its invoice and the note step runs - never an inline replay on a new row that names no capture (round 9). Round 10: only a change invoice whose capture an approval task owns goes back this way (an ordinary card edit's keeps the inline replay); one whose change already carries an active `SUPPLEMENTARY_INVOICE` link is refused with a 409 telling the officer to mark it resolved (`late-capture-change-invoice-retry.ts`, reading the link with the receipt reader's own `findActiveSupplementaryInvoiceLink`, round 11) - and, round 12, not to record by hand the close's share, whose note follows the linked invoice, but to record by hand the capture's card refunds no note answers (`readUnnotedLateCaptureCardRefunds`: its own `PaymentRefund` rows less the notes naming it that reached Xero, round 13; round 14: the row is resolved first, a note sent with no reply - the executed payload, no id, `refundCreditNoteCreateAttempted` - is named apart for the officer to check Xero before recording it, here and in every record-by-hand finding, and while the card verdict still names an invoice in Xero the figure is the note writer's own; round 15: a note is also in Xero by its active `REFUND_CREDIT_NOTE` link naming the capture, so an officer's retry on a new row with no queue type counts once, a row Xero refused with a 4xx (`xeroRefusedOperation`) is never sent, and while the card notes can still land - an invoice in Xero, or a receipt row on its way - nothing is recorded by hand and the 409 says the app notes the gap the next time it notes the charge), since every card-refund path reads the resolved row as resolved by hand; with no close or a $0 one, any card refund; and one that attempted `createInvoices` (`xeroCreateCallAttempted`, `invoiceMayBeInXero`) is held for an officer to check Xero first, as a held receipt row is. For a refund closed as paid another way only (`readPaidAnotherWayLateCaptureXeroReceipt`, round 11: the close's plan, its note step and the repair finding), the receipt reader takes the change's active link, or a row resolved by hand after the app sent it, as the receipt recorded against that invoice; every card-refund path keeps `readLateCaptureXeroReceipt`, where a resolved row is resolved by hand. Both run one body. The note names the receipt by its invoice id (`creditsInvoiceId`), never by `paymentIntentId`, which would count it as the capture's card note; it takes the stepped path whatever the payment's source, sized by the close's record less its own notes (`readPaidAnotherWayCloseShare`, never the payment-wide gap, and never closed against another note's link); and the refund-note gap reports the close cash its own notes do not cover (`paidAnotherWayUncoveredCents`, by the gap's own coverage), which the nightly self-heal and the repair tool take off their card ask; for a payment with such cash the self-heal also runs the note step again (`queueWaitingPaidAnotherWayNotesForPayment`, round 9), which queues a note never queued but never retries a failed one: that is **Retry in background** in Xero Operations. The note's Xero idempotency key is the close and its own coverage, never the payment-wide watermark (round 9). The repair tool retries or queues a missing receipt (`PAID_ANOTHER_WAY_LATE_CAPTURE_WITHOUT_XERO_RECEIPT`; a row that may have reached Xero is left for an officer) and queues a note that never followed its receipt (`PAID_ANOTHER_WAY_REFUND_NOTE_NOT_QUEUED`); every approved capture's close is answered by the close's finding first, never by the kept invoice's `KEPT_LATE_CAPTURE_REFUND_RECORD_BY_HAND` (round 11); a receipt resolved by hand before the app sent it is reported, naming the capture's own card refunds less the notes in Xero naming it plus what the close paid back (rounds 12 and 13; never `PaymentTransaction.refundedAmountCents`, which can carry another hand-back), to record by hand (`PAID_ANOTHER_WAY_REFUND_NOTE_RECORD_BY_HAND`, round 9), and not once any note row of the close exists, one resolved by hand included (round 10). Wherever every card-refund path reads the receipt resolved by hand (round 13: on that verdict alone, so also a change invoice resolved before the app sent it and a close whose note row exists) and no record-by-hand finding names the capture, `LATE_CAPTURE_CARD_REFUND_RECORD_BY_HAND` names its card refunds no note in Xero answers (`readLateCaptureCardRefundsByHand`, round 12), with or without a close; `KEPT_LATE_CAPTURE_REFUND_RECORD_BY_HAND` reads the same verdict and figure (round 13), so each capture is named once, and none where the app raises the card note: the card-refund verdict is deliberately not widened to raise the note, since rows resolved before #3924 may already be recorded by hand. Every record-by-hand finding is report-only: recording a refund by hand in Xero writes no row the app reads, and the tool cannot acknowledge a finding, so it keeps appearing, and says so. |
| Change fee on a late primary invoice (#3502) | A supplementary invoice needs a primary one to supplement, so a change fee the card collected before the booking's primary invoice was raised (a credit-paid or card-plus-credit booking edited while its invoice operation was still pending or failed) is billed on no supplementary invoice. The primary invoice bills every fee recorded on the payment (`recordedChangeFeeCents`) on the one shared fee line (`changeFeeLineItem`), as [The change fee on a booking's primary invoice](#the-change-fee-on-a-bookings-primary-invoice-3750-inv-pay-119) describes, so its total equals the cash recorded plus the applied credit allocated against it and the fee is billed exactly once. |
| Reduction against an unpaid ask (#3954, `INV-PAY-120`) | An increase's supplementary invoice waits `WAITING_PAYMENT` on its card ask and is never raised before the payment. The reduction reads what the parked invoices it retires would have billed, then CANCELS them in its own transaction (`ADDITIONAL_ASK_RETIRED_BY_REDUCTION`, never revived by a late capture, which is refunded). Which invoice billed the rest of the retired ask is read from evidence, not from which invoices happen to be parked yet (`unpaidAskBillingEvidence`): a request's own money by the asking edit's own answer to whether the primary invoice existed - the minting recovery's frozen `hadIssuedXeroInvoice`, or the one the door stamped on the request row (`PaymentTransaction.hadIssuedXeroInvoice`) - and money a request carried by the re-issue or fold its history names; a re-issue its own reduction was unsure of stays unsure. The offset comes off supplementary money first (`splitUnpaidAskOffsetForXero`). Decision A (owner, 9 Oct 2026): a smaller re-issued ask gets its own supplementary invoice, anchored on the reducing edit, for that money less the offset (never more than the ask), queued once the ask is minted and not retired since (withdrawn or failed; a paid one is still invoiced), waiting on its intent so it is marked paid on capture (`queueReissuedAskSupplementaryInvoice`). Where a later increase folded that re-issue into its own ask, the invoice waits on the increase's intent instead (`queueFoldedReissuedAskInvoices`), from its door's mint or its recovery's replay. The rest of the offset the primary invoice billed (owner decision 10 Oct 2026, "Auto credit note") takes an invoice-correction credit note for exactly that part (`unpaidAskBilledOffsetCents`), queued in the edit's own transaction (`queueReductionAskFollowUps`) and allocated against the primary invoice. It is scoped `UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE` on the per-share key slot, as #3809's give-back note is, so one reducing edit has one note however often it is replayed; it moved no cash, so the inbound sync leaves it out of the refunded total; and it is raised after the edit's own note - waiting while that note is queued or running, and while the edit expects one not yet queued, for up to six hours, looked at again every five minutes rather than on every outbox run, after which the repair pass hands it to a person (`unpaid-ask-billed-offset-order.ts`); a note the repair pass queues waits exactly when the edit expected an own note, as the edit recorded it on its history row with the same rule (#4049, `unpaidAskBilledOffsetOwnNoteExpected`): an edit that settled by giving back applied credit with nothing captured, or whose note an organiser's card refund raises, expected none, so the note does not wait. A history row written before #4049 has no answer; the repair pass carries one from an earlier operation of the note, else waits whenever a reduction note is due, which can hold the note six hours and hand it to a person but never raise it first. Where the evidence cannot be established (an answer never recorded, a carried figure that does not add up), nothing is credit-noted or invoiced on a guess: the offset the primary invoice may have billed (`unpaidAskBilledOffsetUnsureCents`) and what the re-issue's invoice may still owe (`reissuedAskInvoiceUnsureCents`) are recorded, and the repair pass lists them for a person. The reduction's own credit note covers only what it returned of money paid. The edit's history names every increase whose ask it retired - by a parked invoice's anchor, a waiting recovery, or the edit stamped on the retired request row (`PaymentTransaction.bookingModificationId`), so an ask retired before its increase queued its invoice is named too; the repair pass raises nothing for a named increase and checks the reduction instead (its re-issue invoice present, deferred while its recovery is open, folded into a later increase, or carried by a later reduction), and verifies or queues the billed-offset note (`scopedBilledOffsetNote`). |
| A change's card capture nothing else records (#3953, `INV-PAY-139`) | A change made while the booking's primary invoice did not exist queues no supplementary invoice, because the primary is built later from the post-change price and bills the extra. A card capture of that change's ask that the primary's own payment did not record gets its own receipt: one `ADDITIONAL_CAPTURE_RECEIPT` outbox row per capture (entity `PAYMENT`, anchored on its `PaymentTransaction`, keyed `payment-intent:<pi>:additional-capture-receipt:v1`), found or created by `enqueueAdditionalCaptureReceiptOperation` (`additional-capture-receipt-enqueue.ts`) under the per-anchor supplementary-invoice lock on the change the capture pays for (else the booking). It is queued by the late-success release when it answers `none-queued` (outcome `receipt-queued`, counted in `released` so the webhook, the confirm route and a keep kick the outbox; a replay answers `already-released`), and by the primary's link save, before its gap check, for every captured change the invoice's recorded cash does not cover (`queueReceiptsForUnrecordedCaptures`) - so a capture that landed between the create's read and its link is covered too. Never on one paid by internet banking, nor on a cancelled booking save a late capture a treasurer kept, which only the keep's decision queues (#4324, `INV-PAY-144`; a replayed release there finds its row and answers `already-released`). **One recorder per capture** (review round 1, `additional-capture-recorder.ts`): the primary's create stores the captures its recorded cash covers, oldest first, and the one it reached part of (`paymentIntentIdsRecordedAtLink`, `partiallyRecordedCaptureAtLink`, from the snapshot's `capturesAtBuild`), so a replay whose invoice Xero recorded at an earlier figure covers fewer; the #3980 gap invoice pays itself only from cash no receipt row claims and no supplementary invoice records (round 3: one naming the capture, or the change's own invoice that records a payment; `readSupplementaryRecordedIntents`), measured from what the link stored the primary recorded rather than re-walked from its cash, and names the captures it took, with the cents, on its queued payload (`primaryInvoiceGap`, `coveredPaymentIntentIds`, `coveredCaptureCents`; `attributeGapCash`), which the supplementary handler keeps when it sends; and `readCaptureRecorder` - asked by the enqueue under the lock, by the worker before it plans, and by the repair tool - stands the receipt down where the primary, a supplementary invoice naming the capture that records a payment (round 5: one raised unpaid naming it - the repair tool's invoice for a priced edit - is the receipt's `CHANGE_INVOICE` target instead), a gap invoice covering all of it, or the change's own invoice that records a payment records it. Where the gap took only part of the capture, or the primary's payment reached part of it, the receipt records the rest (`alreadyRecordedCents`). The worker (`additional-capture-xero-receipt.ts`) plans one receipt per booking at a time through a planning gate (round 4): under the per-anchor supplementary-invoice lock on the booking it waits for a live receipt already stamped `ADDITIONAL_CAPTURE_RECEIPT_PLANNING`, or stamps its own row and goes on, so whichever takes the lock second waits whatever order the claims committed in - and none while the booking's invoice create runs; only LIVE running rows count (`liveRunningXeroOperationFilter`), so a dead one blocks nothing. A wait returns the row to `PENDING` with code `ADDITIONAL_CAPTURE_RECEIPT_WAITING`, and the outbox scan leaves it out for a minute (`outboxScanSpacesWaitingReceipts`) so it does not take the head of every kick. It records **at capture time against the invoice that bills the capture**, read from Xero: the gap invoice where the capture's change is one it bills for, otherwise the change's own supplementary invoice where it was raised unpaid (target `CHANGE_INVOICE`, round 3: it bills the change and records no payment, so the capture is its money) - waiting while either is `PENDING`, `RUNNING` or `WAITING_PAYMENT` - otherwise the primary, whose room is its AmountDue less the applied credit its card settle still allocates (`primaryInvoiceStripeCashCents`). One invoice, never split: the gross capture less any part the primary or the gap invoice took, capped at that room, through `createXeroPaymentForInvoice` with reference `Stripe <pi>`, Xero key `payment-intent:<pi>:additional-capture-payment:<invoice>:v1`, dated the Stripe charge's club day, linked `ADDITIONAL_CAPTURE_PAYMENT` on the `PaymentTransaction` with the invoice in its metadata; cash left over is told to an officer. **Never twice:** the decision is stored in a short transaction under the per-anchor supplementary-invoice lock on the capture's change (round 6), after reading who records the capture again under it, and a supplementary invoice queued for the change under that same lock is raised unpaid where a capture of it has a receipt that is linked, running or carrying a decision (`anchorCaptureHasReceipt`), so the two never both record it (round 7: a capture whose ledger row carries no change stamp takes the change an officer's review charge names in its reason, `captureChangeId`; one no change can be read from stores under the booking's lock, refuses where a paid invoice on the booking names no capture, and a paying supplementary enqueue on that booking naming no capture takes the booking's lock before its anchor's and counts every such capture (round 9: an invoice naming its capture records that one alone, so it is never made unpaid by them); such a capture also refuses where a change of the booking has its invoice's Stripe payment linked in Xero and no live queued row naming a capture or marking a gap invoice explains it (an invoice from before #3641) - `docs/CONCURRENCY_AND_LOCKING.md`; round 8: a reaper-retired invoice the late-success release revives for the capture is revived unpaid, under the same lock, where the capture's receipt records it); a linked payment returns at once; an earlier run's payment is found by its reference and only linked; the decision is stored on the row before Xero is called, and a retry sends it unchanged - first linking its own payment if Xero already shows it under the reference (round 5) - and, where another invoice would now record the capture too, switching that invoice to raise unpaid if it has not sent (round 6, `switchUnsentRecorderUnpaid`; round 9: only the change's own invoice or one naming the capture, never a #3980 gap invoice, a FAILED one only where neither its row nor its response names a Xero invoice, and the officer is asked to check Xero either way) or telling an officer to check if it has; an officer's Retry of a change's invoice asks again under the change's lock whether it may still record the payment (`supplementaryReplayMayRecordPayment`; round 11: where a capture's receipt records it - its payment linked or its decision stored, never a bare running receipt (round 12) - the row is set unpaid there, so the receipt records against that invoice, and the Retry says it was raised unpaid; the late card charge's change-invoice requeue asks the same and keeps the stored payload) - and otherwise refusing with an officer alert where another document now records it before sending a new payment (round 4), and re-checking a primary decision's room net of applied credit - or refuses; it never picks another invoice. With no room on the primary and no gap invoice it runs #3980's own check (`recheckPrimaryInvoiceWorthGap`), which raises a missing gap, never a second, and never from this capture's cash (its receipt row claims it), and the receipt waits for that invoice. **Refuses** (`FAILED`, code `ADDITIONAL_CAPTURE_RECEIPT_REFUSED`, an `ADDITIONAL_CAPTURE_NOT_RECORDED` admin alert) where Xero does not return the invoice, it has nothing left due, the gap invoice for its change is not in Xero, the invoice's own Stripe payment is still owed (its create, or the gap invoice, PARTIAL with a payment fault and not resolved in Xero), or a retry finds the room gone (record by hand, then resolve); a capture no longer kept, or on a booking since cancelled or paid by internet banking, closes `CANCELLED`. Retry sends a FAILED row back to the outbox on its own row, its stored decision kept. A Stripe refund of the capture names the receipt's invoice on its refund note (`creditsInvoiceId`, from its payment link or its stored decision, `additional-capture-receipt-link.ts`); a note queued before the receipt reached a gap invoice is flagged to an officer when it completes. Every payment-wide note still names the primary. The repair tool reports `ADDITIONAL_CAPTURE_NOT_RECORDED_IN_XERO` ("card payment not recorded in Xero") for a change capture nothing records, and queues the receipt (`QUEUE_ADDITIONAL_CAPTURE_RECEIPT`) - automatically only where the primary's figures say which captures its cash covered; a refused receipt is handed to an officer, a failed one retried; and its missing-supplementary-invoice action raises that invoice unpaid where the change's capture's receipt has recorded it or may be recording it (its payment linked, the row RUNNING, or a decision stored on it), never for one that has decided nothing, which then records against that unpaid invoice. A treasurer-kept change capture on a cancelled booking is recorded by this receipt where the primary bills its change, and a kept-capture invoice counts as that capture's recorder here (`readCaptureRecorder`, `anchorCaptureHasReceipt`); the repair tool names those the keep missed, `KEPT_LATE_CAPTURE_NOT_RECORDED_IN_XERO` (#4324, `INV-PAY-144`). |
| Supplementary-invoice anchors | One booking change gets ONE supplementary invoice, anchored on its `BookingModification` — that anchor is what the enqueue's link-check and queued-check are scoped to, and what makes "one invoice per change" true rather than asserted. Since #3193 there is a second anchor: a `ManualRefundTask`, for the SECOND ASK — a settled financial-review share's own small invoice, raised when the change's invoice had already been sent and could not be raised to include it. It bills that share alone, never a total, and being on its own anchor is what keeps it out of every read scoped to the change. Same queue type, same handler, same advisory key namespace. **Only a SENT invoice buys one** (#3193 fix round): a row the outbox has merely claimed can return to the queue un-attempted and be raised to the combined total by the next settlement, which would then bill a separately-invoiced share twice - so the enqueue answers `short-sent` and `short-in-flight` separately and only the first raises anything. And because that anchor hides a second ask from the change's reads, it also hid it from the operator: `ManualRefundTask` is now a Xero local model, so the row opens on a record page, can be filtered for in the operations panel, and has a retry branch that replays it from its queued payload. |
| A superseded change's waiting invoice (#3403, `INV-PAY-140`) | A card change's supplementary invoice waits `WAITING_PAYMENT` on its own ask. When a later request supersedes that ask unpaid and carries its balance (`INV-PAY-098`), the invoice is re-pointed at the request that absorbed it - the first later row still payable or captured that no superseded-intent operation names (`supersededAskCarriers`) - by `followSupersededAskInvoicesToCarrier` (`superseded-ask-invoice-carry.ts`; owner decision 26 Oct 2026, "follow the money"), so that request's capture releases both invoices, each for its own amount, and a request never paid invoices nothing. It runs from the supersede's cancel step (worker and webhook; a superseded request captured late is refunded and carried on, so its refund hand-off runs it too), from every superseding minter before it returns its secret (a declined ask is carried at once, though its cancel, since #4422, may not finish then), from an edit's Xero leg that parks on an already-failed ask, and from the waiting-invoice reaper before it would retire the invoice. Per change under the per-anchor supplementary-invoice lock on the change and on the carrier (booking first, else sorted), guarded on status, intent and correlation key; refused, the row left as it was, where the booking ended, the change is linked or has another outstanding invoice, or the carrier would bill more than it asks (what bills changes other than its own at most its `carriedAskCents`). A carrier already captured is released at once, unpaid where its own receipt already records the capture or is still queued to (a paid invoice moved onto it would otherwise read as the whole capture's recorder and stand that receipt down). The late-success release checks a capture against every invoice naming it together, never one at a time. The payload keeps the first intent (`parkedFromPaymentIntentId`), which a reduction reads to attribute the invoice to the superseded row's own money, and which a kept capture of that first intent no cancel row owns (a declined ask superseded before #4422 and paid from a stale tab) uses to take the invoice back before its release (`returnMovedInvoicesToCapturedIntent`), deciding again whether it records a payment for that capture. A change's invoice naming another capture never records this one, so where the carrier was paid first the stale-tab capture gets its own receipt; where the carrier is kept after the invoice went back, the change was paid twice and the carrier's release tells an officer once (`alertTakenBackInvoicesPaidAgain`). Never folded onto the later invoice: that double-bills wherever the earlier invoice issued (bank transfer queues each unpaid when priced, so nothing moves there). |

### Financial document builders (called only by the outbox worker and repair)

| Module | Owns |
| --- | --- |
| `xero-booking-invoices` | Primary booking invoice create/update (`buildInvoiceLineItems`). |
| `xero-invoice-payments` | Recording Stripe payments against invoices and Stripe refunds as credit-note payments. |
| `xero-credit-notes` | Refund credit notes, unapplied (account-credit) credit notes, allocation to invoices. Stripe refunds settle **per delta** (#1162): a payment refunded in several steps gets one credit note per uncovered delta, keyed on a cumulative refunded-cents watermark; non-Stripe refunds keep one note per payment, except that a later cancellation hand-back on a bank transfer gets its own note keyed and sized on its task (#4287, `INV-ADDPAY-043`), and so does each card refund on one, keyed and sized on its `PaymentRefund` row (#4312, `INV-ADDPAY-047`), and each refund request (appeal) paid back by bank transfer gets its own note when its task is marked paid back, for the amount paid back, keyed by the request (`payment:<id>:refund-request-credit-note:<request>:v1`) and linked under its own role `REFUND_REQUEST_CREDIT_NOTE` (#3827, owner decision D-3813-8, `INV-PAY-118`). That role is selected by none of the one-note machinery (the link normaliser's single-note rule in `xero-sync.ts`, `cleanupStaleCanonicalXeroObjectLinks`, the drift report), never takes `Payment.xeroRefundCreditNoteId`, and is left out of `findCanonicalPaymentRefundCreditNote`'s fallbacks, so a cancellation's note and a request's never absorb each other. The booking repair tool and the failed-operations panel leave a request's note out of everything that answers for the payment's one refund note (`isRefundRequestNoteOperation`), and the request's note is queued in the same transaction as the completion that records its refund. A cash refund note's settling payment is recorded only where the money verifiably moved (`resolveRefundSettlement`, `INV-PAY-101`): Stripe for a card refund, the configured bank-transfer refund account for a recorded bank transfer, and otherwise the note is left unsettled with `refundPaymentSkipped` on the operation. The note is recorded (payment field, covering link, the row's `xeroObjectId`) in one transaction the moment Xero returns it, so an attempt that dies before its payment leaves a FAILED row naming its note; the retry and repair legs and the repair tool finish it through one read-back-then-settle (`xero-refund-note-settlement.ts`, `INV-PAY-111`): the payment or the skip, PARTIAL if the payment fails, one note-keyed payment key, dated the note's own day, and never a second payment on a note Xero already shows paid, part-paid or allocated. Rows written before #3548 with neither are listed by the reconciliation report and the repair tool (`xero-refund-note-unsettled.ts`) and settled only by an operator. |
| `xero-refund-method` | Leaf, pure: how the money went back — `card`, `internet-banking`, `account-credit` — as the ONE home for the wording every refund or credit document carries (#3529, `INV-PAY-101`), the default a method-less legacy row falls to (Stripe → card, anything else → bank transfer), and which mapping key settles a cash refund. The method is threaded from the settlement decision through the outbox payload; the builders never infer it from `Payment.source` when the caller said. Two booking-edit wordings (#3536) — *Invoice correction — nothing refunded* (an unpaid pay-on-account invoice lowered) and *Refunded in cash* (an edit-review refund paid back by hand, when the resolving officer says it went in cash; never inferred, `INV-PAY-116`) — ride beside the method as `noteWording`, which retries and the repair tool carry forward; words only, no settlement changes. Since #3935 the cash wording also reaches a since-cancelled booking's review refund note (`readRefundNoteWording`: cash only beside the internet-banking method). |
| `xero-supplementary-invoices` | Positive booking-modification delta invoices. Since #3530 (stage 2b) itemised from the edit's stored lines when they sum exactly to what the invoice bills; otherwise the single price-adjustment line, with the reason under `requestPayload.priceLines`. |
| `xero-modification-credit-notes` | Negative booking-modification credit notes. Itemised the same way, every sign inverted, only when the note returns the whole reduction (#3530). |
| `xero-modification-line-items` | The itemised lines on a booking-edit document (#3530): loads the codes the original invoice uses, renders one Xero line per stored line, one `Adjustment agreed with member: <note>` line per COMPLETED review share settled against the modification (stage 2c — how a parked edit's closure reads on its invoice or note), and the fee line; records `{source, reason, storedSumCents, sharesSumCents, billedCents}`. Selection is `booking-modification-document-lines` (pure); the per-line sentence is `booking-modification-lines`; the share rows are `edit-financial-review-charge-shape`'s. |
| `xero-hut-fee-line-codes` | Pure, no provider or database calls: the hut-fee item-code and account-code precedence (#1930 E4), extracted from `buildInvoiceLineItems` so the original invoice and the itemised modification documents code a night's money identically. |
| `xero-entrance-fee-invoices` | One-off entrance-fee invoices per age tier. |
| `xero-group-settlement-invoices` | Combined ORGANISER_PAYS internet-banking invoice across joiner bookings. |
| `xero-group-settlement-invoice-outbox` | The combined invoice's outbox identity (#3642): the per-attempt CREATE key (attempt 0 keeps the pre-#3642 key), the VOID keys, the object-link shape, and the CREATE enqueue (`newAttempt` asks for a new invoice; otherwise the current attempt is returned or re-driven under its key). |
| `xero-group-settlement-invoice-lines` | The combined invoice's lines, built from the settlement's committed CONFIRMED children with each joiner's promotion lines (one per code, #3828), and their total; the create worker raises nothing unless it equals the settlement's (#3642). |
| `xero-promo-adjustment-lines` | The promotion lines of a booking invoice: one coded line per promo code, or one recorded aggregate fallback (#3828, `INV-MONEY-040`). |
| `xero-group-settlement-invoice-voids` | The combined invoice's replayable VOIDs — after the group is cancelled (`INV-PAY-035`) and after the settlement abandons it (`INV-PAY-105`, #3642) — and the one read of that invoice's state in Xero: both VOIDs read it first, so an already-void invoice completes and one carrying money alerts instead of failing for ever. Pre-#3642 code reads an abandon VOID row as a cancellation VOID and leaves it FAILED (fails closed; retry after roll-forward). |
| `xero-invoice-helpers` | Shared date/allocation helpers for the six modules above. |
| `xero-account-class` | Leaf, pure: the ONE reading of a Xero account's CLASS (#2717), shared by the admin account pickers and the finance reports so they cannot come to disagree about what an expense account is. |
| `xero-account-mapping-keys` | Leaf, pure data: the ONE registry of account mapping keys (#2717) — label, description, required account-CLASS filter (optionally narrowed to named types), default code, registered fallback, and which keys carry a Xero Item code. The admin picker, the API allowlist, `xero-mappings`, the setup checklist and the seed all derive from it, which is what makes `INV-INT-021`'s filter structural rather than policed. `mappingWriteViolation` is the write path's refusal rule. |
| `xero-applied-credit-mint-accounts` | Leaf, pure: where a minted applied-credit remainder note's money lands (#2717). `mintSliceMappingKey` is the owner's rule — a discretionary `ADMIN_ADJUSTMENT` grant posts to `goodwillWriteOffs`, a member's own money stays on `hutFeeRefunds` — and the line coding/merge beside it is what keeps an unconfigured club's note unchanged. |
| `xero-mappings` | Account-code / item-code resolution from `XeroAccountMapping`/`XeroItemCodeMapping` (with legacy fallbacks), entrance-fee categorisation and idempotency keys. `getResolvedAccountMappingWithFallback` applies a key's registered one-hop fallback (`INV-INT-021`), and `isCodeExplicitlyConfigured` is the one definition of a club having CHOSEN a code. |

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
| `xero-missing-contact-seeding` | `INV-INT-022`: the read-only census of unlinked person members, on both the email and the name axis. |
| `xero-missing-contact-seeding-run` | `INV-INT-023`: the bounded run, resolving each member through `findOrCreateXeroContact` with `requireAuthoritativeMatch`. Resolves nothing itself. |
| `xero-missing-contact-seeding-shape` | What both return, and the call-cost constants the chunk size is derived from. Imports nothing, so the admin panel can key its operator copy on these unions. |
| `xero-erased-member-contact-review` | `INV-INT-024`: which Xero contacts an erasure left behind. Reads only; writes nothing, calls no provider, and has no `POST` surface. |
| `xero-erased-member-contact-review-shape` | What that review returns. Imports nothing, so the admin panel can key its operator copy on the `ErasureKind` union. |
| `xero-erased-member-contact-status-check` | `INV-INT-024`'s live check: `getContacts` over the listed ids with archived included, one field of the answer kept, stamped on the retired link. Reads Xero; writes nothing to it. |
| `xero-contact-cache-freshness` | How old the contact cache is, asked in one place so the seeding census and the erasure review cannot disagree about one table. |
| `xero-contact-status` | `INV-SSOT`: which `contactStatus` values count as a live contact, including Xero's `GDPRREQUEST`. One classifier for the census, the group import and the erasure review. |
| `xero-duplicate-contacts`, `xero-contact-link-mismatches`, `xero-contact-sync` | Admin diagnostics: duplicate detection, link-mismatch snapshots, contact update payload builders. |
| `xero-membership-sync` | Subscription status per season derived from Xero invoices; incremental `refreshAllMembershipStatuses` driver. |

### Repair, hardening, admin

| Module | Owns |
| --- | --- |
| `xero-inbound-reconciliation` | Stored-event worker + per-entity reconcilers + incremental cursor reconciliation (see Flow 2). Split into cohesive `xero-inbound/*` sub-modules (#1208 item 1 / #1270, entry re-exports the public surface); see refactor item 1 for the module map. |
| `xero-booking-repair` | Booking-vs-Xero audit and self-repair (see Flow 3). CLI entry: `scripts/xero-booking-repair.ts`. Split into cohesive `xero-booking-repair-*` sub-modules (#1208 item 2, entry re-exports the public surface); see refactor item 2 for the module map. |
| `xero-hardening` | Historical `XeroObjectLink` backfill, stale canonical-link cleanup, the emailed reconciliation report, repeated-failure alerting. Split into cohesive `xero-hardening-*` sub-modules (#1208 item 5, entry re-exports the public surface); see refactor item 5 for the module map. Cleanup and the report's drift classifications are source-aware for Stripe per-delta refund notes (#2901): see "Repairing Stripe refund-note links" under Flow 3. |
| `xero-refund-note-link-repair` | Dry-run-first operator repair for Stripe per-delta `REFUND_CREDIT_NOTE` links damaged by the pre-#2901 cleanup loop: unconditionally deactivates local mirrors of notes VOIDED/DELETED in Xero, reactivates wrongly deactivated links (recorded-status only, never past the note-eligible cash — `resolveRefundNoteEligibleCash`, #2902/INV-PAY-050 less late captures Xero never received, #3635 — with notes resolved in Xero counted as coverage; landing short is applied honestly and the self-heal reissues the remainder), refuses payments with a still-executable credit-note operation (queued/running/awaiting-payment, failed-but-retryable, or a queued retry of one). No provider calls; `--apply` is bound to reviewed payment ids. CLI entry: `scripts/xero-refund-note-link-repair.ts`. Runbook: "Repairing Stripe refund-note links (#2901)" under Flow 3. |
| `xero-refund-note-status-recorder` | Read-only provider GETs that record each linked refund credit note's live Xero status onto ALL of its local links, active or not (`--record-statuses`; run automatically before `--apply`). Exists because inbound reconciliation structurally cannot stamp a status onto an inactive link, and the repair never reactivates an unknown-status note. |
| `xero-refund-note-status` | The one home for "does this credit-note status still count as refund coverage?" (`VOIDED`/`DELETED` do not) and for reading a link's recorded status — shared by the inbound contribution math, `sumCoveredRefundCreditNoteCents`, cleanup, the drift report and the operator repair so no path can disagree (#2901). Also "does this create row count toward coverage?" (`countsTowardRefundNoteCoverage`, #4265): only its own note, never a refund request's. |
| `xero-resolve-refund-note` | "Resolve by hand" on a FAILED payment refund-note create that names no note (#4421, `INV-INT-028`): which rows ask for the Xero note's number (`refundNoteResolveShape`, `resolveCreditNotePrompt`), the note's check (reusing `verifyHandMadeRefundNote`), the `lock(1)`-then-Payment-row claim that records it on the row and as the payment's link (`writeHandMadeRefundNoteLink`), refusing a retry that ran or a note any other create row or link records, and the withdrawal that retires both (alerting if it fails). It also carries the resolve route's refund-note half (`resolveRecordingRefundNote`, `withdrawRecordedNoteOrAlert`, `answerExistingResolveMark`), and `xero-operation-resolve-guards.ts` its other pre-mark checks and plain mark writes, so the route stays a thin handler. Its words live in `bank-refund-void-follow-up-copy.ts`; the operator reason bounds in `xero-operation-resolution.ts`. |
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
- The admin routes under `/api/admin/xero/**` and `/api/admin/members/[id]/xero-*`
  — OAuth connect/callback/disconnect, status/health/usage, operations list +
  retry/requeue/resolve/mark-non-replayable/mark-failed/reset-stale-running, inbound-events
  list + replay, contact tooling (search/import/sync/duplicates/mismatches),
  mappings, record activity.

## Data model

| Table | Role |
| --- | --- |
| `XeroConnection` | Single row (id `default`): the connected tenant, the access token's expiry and the refresh lease. No secret. Kept in step with `XeroToken` by a trigger while that table exists (#3806, see "OAuth and token lifecycle"). |
| `XeroToken` | RETIRING (#3806). Kept only for the previous release: present while connected, with `tenantId`, `expiresAt` and its `refreshInProgressUntil` lease current; its ciphertext columns are no longer written or read. Dropped in R3. |
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

    Note over OB: Supplementary invoices held as WAITING_PAYMENT are released<br/>to PENDING by stripe-webhook-service when the payment settles;<br/>the waiting-invoice reaper (POST /api/cron/payments) releases one<br/>whose kept payment already arrived, keeps one a treasurer is still deciding,<br/>moves one a later request carries onto it (#3403),<br/>and retires one (14 days, or 24h after a<br/>decline) only once the pay door is closed; a late capture re-queues<br/>a retired one, or alerts where issuing it is unsafe (INV-PAY-104).

    OB->>DB: claim: updateMany(id, status=PENDING,<br/>expected entity/operation) → RUNNING
    OB->>DOM: dispatch on queueType (17 types)
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

The queue types (`XERO_OUTBOX_QUEUE_TYPES` is the one list): entrance fee,
booking invoice, booking invoice update, refund credit note, account credit
note, supplementary invoice, modification credit note, modification account
credit note, credit-note allocation, applied-credit allocation, applied-credit
deallocation, membership-cancellation credit note, membership-cancellation
contact update, group-settlement invoice, group-settlement invoice void,
membership subscription invoice, and kept late-capture invoice (#3635).

**A card booking paid entirely by account credit (#3836, `INV-PAY-024`)** is
confirmed at $0 and invoiced at its full price, like every card booking, so the
credit is all that pays the invoice. The invoice operation allocates it with
the same engine a card-and-credit booking uses (#1641,
`allocateAppliedCreditForBooking`), on the raise and on every replay: a payment
that captured nothing (`isCreditOnlyCardPayment`) passes the cash-captured gate
without its status being read: every credit-covered settle writes it
`SUCCEEDED` and a cancel leaves it so, on the paid path. The engine's stamps,
unique slices and per-slice links make every re-run allocate nothing more. The
engine is also the one gate for a cancel (#3836, bank transfers included): on a
`CANCELLED` booking, or one with a restore row, it only finishes slices already
committed - which the cancel's clearing note was sized net of - and never plans
or mints new ones, so the invoice is never credited both by a clearing note and
by an allocation. The repair pass's cancelled-open-invoice arm waits while the
booking's invoice or applied-credit allocation operation is unfinished. The
inbound credit-note repair writes the ledger's applied credit to the payment's
`creditAppliedCents` uncapped: the old cap at the card amount ($0 here) zeroed
it, and a cap at the booking's worth would cut a booking reduced before #3809,
which keeps all its credit at a cancel (owner decision, 4 Oct 2026); the worth
cap belongs to the cancel alone, for #3809's bookings. A mirror the old cap
already clipped to the card amount is read from the ledger by the cancel, its
preview and the refunded-card restore (`cancelTieredAppliedCreditCents`). An invoice raised
before #3836 is left owing until the booking repair pass's
`UNALLOCATED_APPLIED_CREDIT` finding queues the applied-credit allocation
operation (`docs/MAINTENANCE.md`); a cancelled one is never queued, since the
cancelled-open-invoice arm clears its invoice with a note instead. After a cancel the restored
credit is noteless until spent (#2717), as for a bank transfer.

**An applied-credit deallocation has one producer**: `giveBackAppliedCredit`
(`member-credit.ts`), the give-back of applied credit that the pre-payment
clamp, a credit-paid booking's financial-review share (#3791, `INV-PAY-113`)
and a credit-paid booking's ordinary price reduction (#3809, `INV-MOD-011`) all
go through. Where a booking's credit is allocated against its invoice beyond
the new applied figure - a bank transfer's (#1620) or, since #3809, a card
booking's (#1641), decided by the allocation slices and not the payment's
source - it queues the deallocation in
the same transaction as the ledger row, and the PENDING row fences the inbound
applied-credit repair until it converges, so an inbound sync cannot pull the
given-back credit back up to Xero's figure. It never deallocates on a CANCELLED
booking, whose invoice must not reopen. A review share then reaches Xero the way
an ordinary price reduction does (`dispatchEditReviewAccountCreditXero`), held
to three invariants for an issued invoice: the invoice less its reduction notes
is the booking's price, Xero's due is the app's owed, and the member's Xero
credit (counting noteless rows minted when spent, #2717) is the app's. So an
invoice-allocated modification credit note takes off the whole reduction
(`reviewInvoiceReductionCents`: the re-price's drop on an unpaid booking, the
agreed share on a covered one), the unallocated account note is raised only for
minted credit, and on a cancelled booking nothing but that minted note is sent:
given-back credit there is a noteless row, as the cancellation's own restore is.
A captured payment's share on a cancelled booking - card, bank-transfer
hand-back or minted credit - is netted against what the cancellation returned
first (#3835), and whatever its route raises follows the netted figure. Since
#3880 the card refund and the bank-transfer hand-back raise what the paid
cancellation's own card refund raises (`INV-SSOT`): a `REFUND_CREDIT_NOTE` on
the payment (`enqueueXeroRefundCreditNoteOperation`), unallocated and settled by
its own refund payment from the card clearing or bank-transfer refund account,
worded by the route (`INV-PAY-101`), or *Refunded in cash* when the officer
answers "In cash" on a hand-back (#3935, `INV-PAY-116`: `noteWording` on the
payload, words only, never in the key or the settlement) - so the cancelled
invoice is never reopened and the clearing or bank account has a document for
every cent that left. The
hand-back's row is queued inside the completion transaction, after its ledger
allocation, so it commits or rolls back with the money; the card refund's is
queued after the Stripe call, since a note is capped at the cash Stripe has
refunded (a lost one is uncovered cash, which the Stripe self-heal raises). It
is sized to the netted capture part, capped by the payment's uncovered refunds
as every refund note is. Only the OUTBOX row's correlation key carries the
review task (`reviewTaskKeyParts`), so sibling reviews' equal refunds queue a
row each and a replay finds its own queued row; the note's Xero idempotency key
is the payment's watermark key with no task, as every refund note's is, so a
crashed raise, a retry and a repair of the same cash still converge on one note
(`INV-PAY-111`). Two rows sized off the same recorded coverage would therefore
get one note: a run sizes only while no other live refund-note run on the
payment is RUNNING (`assertNoRefundCreditNoteInFlight`) and otherwise waits in
PENDING. A bank-transfer payment is noted per refund like a card: the task rides
the row's payload, and the note's link is stamped `perDelta`, stays active
beside its siblings and is never the payment's one canonical note: no writer
records it in `Payment.xeroRefundCreditNoteId`, every reader of that field takes
it through `canonicalRefundNoteFromField` (a field naming one counts as none),
and the booking-repair pass ignores it. The row of a per-refund note records its
watermark and `perDelta` mark too, so a retry of an inline row the operator's
retry created is still a per-refund run. A `CANCELLED_BOOKING_HAND_BACK`'s own
note is queued inside its completion transaction, as the review's hand-back is.
The
applied-credit part given back beside it takes no document: like the
cancellation's own restore it is a noteless credit row, minted a note when spent
(#2717), so the member's Xero credit lags the app's by exactly those rows until
then. A booking with no invoice (settled in cash) raises nothing, as a note
against no invoice could never succeed. For #3791's modification notes, by
contrast, each note's correlation and Xero idempotency keys carry the review task
(`reviewTaskKeyParts`), so sibling reviews of one edit raise a note each, and a
review's allocated note waits, returned to PENDING with the reason kept in
`lastErrorMessage`, while the payment's deallocation is PENDING or RUNNING. A
FAILED or PARTIAL deallocation only moves on an operator retry, so the note
fails instead, naming it: retry the deallocation, then the note. Since #3809 an
edit's own modification note waits the same way: a paid booking's price
reduction gives back applied credit through the same deallocation - all of a
credit-paid booking's tiered reduction, or what a card-and-credit booking's
card basis could not return - and `queueXeroBookingEditSettlement` takes it as
`appliedCreditGiveBackCents`: always an allocated note of its own, worded as
account credit - alone where nothing else was refunded, or beside the card or
bank refund's note or a credit election's unallocated one, since one note names
one method (`INV-PAY-101`). It rides the per-share key slot
(`reviewTaskKeyParts`) under the scope `applied-credit-give-back` (nested under
a review task's where there is one), so one key identifies it everywhere: the
edit's own note never answers for it, and the repair pass reads it only there,
so it can never mint a second. A card booking's deallocation that meets a slice
whose #1641 allocation is still in its invoice operation waits rather than
failing. So the invoice reopened by the deallocation
is closed again and no unallocated note is raised for it. The note is queued
after the commit, as every edit's is; if that queue fails, the repair pass
(`MISSING_MODIFICATION_CREDIT_NOTE`) re-queues it at the give-back the edit's
history row records - none where the tier gave nothing back - never at the
whole reduction. A card-path booking paid entirely by credit has its credit
allocated too since #3836, so it deallocates the same way; one invoiced before
#3836 whose allocation has not yet run has none to release, and there the note
alone takes the give-back off the invoice. Every
guest-removal door queues this leg through `queueGuestRemovalXeroSettlement`,
the consent decline and expiry included, which before #3809 queued nothing.
A note worded as account credit moved no cash, so the inbound credit-note sync
leaves it out of the fold of modification notes into a payment's refunded total
(`noCashModificationNoteIds`), as it does #3954's billed-offset note below. The
repair pass reads each scoped side note - the give-back's, and the billed
offset's - apart from the edit's own, so none hides another
(`withoutScopedSideNotes`), and verifies or queues each under its own scope
(`addScopedSideNoteFindings`).

**Deploy note (blue/green, #3791).** A review's note carries `reviewTaskId` in
its outbox payload, which the previous release ignores: it would raise the note
under the anchor's unscoped keys and without waiting for the deallocation.
Before the old colour's workers stop, drain or pause the outbox's modification
credit-note rows written by the new release (or stop the old workers before the
new release completes its first financial review). The outbox claim filters on
known queue types only, so the alternative is a queue type of its own for review
notes; that was not added. Since #3809 an edit's own modification note (no
review task) waits on the deallocation too, which the previous release does not
do, and a give-back beside a refund raises a second, scoped note: the same
drain or pause covers both.

**Deploy and rollback note (#3880).** The release before this one keeps one
active refund note per bank-transfer payment: a later write of a refund-note
link on that payment leaves active only the note its `xeroRefundCreditNoteId`
names (with the field empty, the note written); with the field empty it takes
any active note as the payment's one note, so a later cancellation hand-back is
skipped as "already linked"; and its worker raises a review's queued row as that
one note (no `perDelta` mark, recorded in the field). So, as for #3791, stop the
old colour's outbox workers before the new release completes a review's refund
on a cancelled booking. Before rolling back: (1) let every `CREDIT_NOTE` row on
a `Payment` whose payload carries `reviewTaskId` finish, whatever its queue type
(an operator's retry runs inline under a row with none), and mark a failed one
resolved in Xero, until this read-only list is empty:
`SELECT id, "queueType", status FROM "XeroSyncOperation" WHERE "localModel" = 'Payment' AND "entityType" = 'CREDIT_NOTE' AND "requestPayload"->>'reviewTaskId' IS NOT NULL AND status IN ('PENDING', 'RUNNING', 'FAILED', 'PARTIAL')`;
(2) list the per-refund notes,
`SELECT "localId", "xeroObjectId", active FROM "XeroObjectLink" WHERE role = 'REFUND_CREDIT_NOTE' AND metadata->>'perDelta' = 'true'`.
None: the rollback is safe. Any: the old code can switch those links off, so
roll back only if needed and, after rolling forward again, list them once more.
A listed link that is inactive while its note is still live in Xero (not VOIDED
or DELETED) must be set active again by hand
(`UPDATE "XeroObjectLink" SET active = true WHERE role = 'REFUND_CREDIT_NOTE' AND "localId" = '<payment>' AND "xeroObjectId" = '<note>'`):
nothing in the app does it, as the inbound reconcile reaches only active links.
Then check that each of those payments' `xeroRefundCreditNoteId` names its
cancellation's note or is null, and that a hand-back completed meanwhile has its
note.

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

   **A retry that claims the original must give it back (#3462).** A retry
   branch that has to stay visible to the settle-time fences while it runs
   (the booking invoice, #2262 H3) claims the original row FAILED/PARTIAL →
   RUNNING through `runWithClaimedOriginal`, the one place that claims and
   abandons. From then on the handler owns completion. If it throws before it
   records an outcome — a contact refusal, a missing account mapping — the
   claim is abandoned: `failXeroSyncOperation(claim, ..., { retryClaim: true })`
   returns the row to FAILED with the run's error, guarded on the claim itself
   (still RUNNING, still this run's `startedAt`), so a row the handler already
   completed is never overwritten. Before this, such a throw left the original
   RUNNING for ever, where neither Retry nor Requeue applies. The REQUEUE row's
   own failure names the original and reads its status after the attempt. It
   says "back to FAILED" only when this retry claimed the original and the
   abandon really wrote (`retryAbandonedItsClaim`); a branch that never claimed
   it gets "is FAILED; fix the cause, then requeue it". A REQUEUE row is never
   replayable itself, because replaying a replay compounds the state.

   **A PARTIAL repair claims its row too (#4256).** The PARTIAL invoice
   payment repair and the PARTIAL refund-note repair run through the same
   helper in its PARTIAL-only mode. The claim needs the row PARTIAL,
   unresolved and replayable, so an officer's resolve or mark non-replayable,
   or a second retry, landing after the retry's read makes it lose: nothing is
   written and Xero is not called. Before this, the zero-cash repair completed
   the row SUCCEEDED over such a mark, and two retries both reached Xero,
   stopped only by the payment's idempotency key. The invoice repair now closes
   its row: SUCCEEDED, or PARTIAL while an invoice-email fault remains, which
   the retry fence then refuses as a payment repair. A throw gives the row back
   PARTIAL with its payload and the run's error, guarded on the claim, never
   FAILED, whose error payload would replace what the repair reads.

   The claim stamps `lastErrorCode = PARTIAL_REPAIR_RUNNING`
   (`XERO_PARTIAL_REPAIR_RUNNING_CODE`). If the process dies mid-repair, the
   row is stuck RUNNING with that code, and Mark failed or Reset stale running
   (`writeStaleRunningXeroOperationReset`) returns it to PARTIAL, payload kept,
   rather than FAILED. A FAILED Payment invoice row would go down the invoice
   replay, which finds the invoice already linked, closes the row and records
   no payment. Every completion a claimed repair writes, including the refund
   settlement leg's, is guarded on the claim (`completeXeroSyncOperation`'s
   `retryClaim`), so a repair finishing after an operator's Mark failed
   writes nothing over it; that completion also clears the marker code. An
   invoice repair left PARTIAL by an email fault says so in `lastErrorMessage`
   and raises no repeated-failure alert. The FAILED refund-note repair claims
   its row too (FAILED mode), stamping `REFUND_NOTE_REPAIR_RUNNING`
   (`XERO_REFUND_NOTE_REPAIR_RUNNING_CODE`, #4356); a stale reset returns it
   to FAILED. While either marker is on the claim, no other caller's outcome
   but SUCCEEDED lands on the row (`INV-INT-029`). And since #4373 no outcome
   at all lands on a RUNNING row another claim stamped: every complete and
   fail carries the claim (`startedAt`) it was made under, so a stale-reset
   or failed attempt's late outcome never lands on the retry's claim. Mark non-replayable writes only onto a FAILED or
   PARTIAL row, so a retry that claimed it after the officer's read gets the
   409 "a retry is running"; a queued retry of a row marked not replayable is
   closed as skipped. Rows repaired before this release stay partly
   completed; retry them once and they close.

   Before it pays, the invoice repair looks for the payment link an earlier run
   recorded (`createXeroPaymentForInvoice` writes it, role `INVOICE_PAYMENT` or
   `SUPPLEMENTARY_INVOICE_PAYMENT`, metadata `invoiceId`). The inbound sync
   links every payment Xero reports on the invoice, a hand, part or DELETED one
   included, so a link counts only when it is live money
   (`isRecordedBookingInvoicePayment`) at exactly the repair's amount
   (`recordedRepairPayment`); any other link leaves the repair to pay under its
   idempotency key. A counted link closes the row on that payment, its own id
   and amount, and calls Xero for nothing, so a run that
   died after its payment never pays twice, whatever Xero still remembers of
   the idempotency key. A repair whose completion lost its claim (an operator
   reset the row while it ran) logs a warning and says "Retry it once to close
   it", never "Repaired". If Xero refuses a repair's payment as an
   overpayment, the money is already there: resolve the row in Xero. During a
   blue/green deploy overlap, the old version's stale reset sends a stuck
   repair to FAILED, and that row then needs Resolve in Xero or a by-hand
   check of the payment.

   **Stuck RUNNING rows.** A row RUNNING longer than
   `STALE_RUNNING_XERO_OPERATION_MINUTES` (15) is stale (`xero-stale-operations.ts`).
   `isStaleRunningXeroOperation` takes the row and checks RUNNING itself,
   because completing a row never clears its `startedAt`; the list route, the
   booking page, the resolve refusal and Mark failed all read it.
   The operations list flags it (`staleRunning`) and the panel offers a per-row
   **Mark failed** (`POST /api/admin/xero/operations/[id]/mark-failed`,
   finance:edit, reason required, audited `xero.operation.marked_failed` in
   category `xero`). The gate is plain staleness, not "stale and carrying an
   earlier error": a row whose worker died on its first attempt is stuck the
   same way and needs the same remedy. The write is
   `markStaleRunningXeroOperationFailed`, guarded on the claim it read, and it
   keeps any earlier error in the new message. When that error is itself an
   earlier stale reset, only the cause inside it is carried, so repeated cycles
   never nest the prefix. It and the bulk **Reset stale running** share one
   write, `writeStaleRunningXeroOperationReset`, which stamps
   `ORPHANED_STALE_RUNNING` and leaves the response payload and Xero object
   identity alone. Mark failed, the bulk reset and mark non-replayable each
   write their audit row inside the state change's transaction, so a failed
   audit rolls the change back instead of leaving an unattributed override.
   (Resolve cannot: its fence needs the mark committed and visible to the drain
   before it checks for an overlapping retry.) Once FAILED, the ordinary
   Retry / Requeue applies.
4. **Inbound event retry** — FAILED `XeroInboundEvent` rows are re-swept after
   `XERO_INBOUND_FAILED_RETRY_BACKOFF_MS`; stale PROCESSING rows are
   operator-replayable.

## Flow 2 — Inbound reconciliation (webhooks + incremental cursors)

Xero pushes CONTACT, INVOICE, and CREDITNOTE events (the credit-note
category has no underscore); the webhook stores each signed event as sent and
returns fast. A category this app does not reconcile is logged and left
processed, so it is visible without being retried forever. Reconciliation
happens in a bounded worker kicked after the response and swept by cron.

**A voided refund note (#4091, `INV-ADDPAY-041`).** A credit-note void
deactivates a payment's refund-note mirror whatever the payment: a card
payment's per-delta note, a per-refund note, or a bank-transfer payment's one
canonical note, whose mirror used to stay active. The void retires no sibling.
The same link write moves `Payment.xeroRefundCreditNoteId` to the newest other
live note that may be canonical (never a per-refund note, #3880), or clears it,
as the #2901 repair apply does, so the nightly missing-link report never sees a
pointer to an inactive mirror (#4046). A refund left with no live note shows no
drift in that report, by design; on a bank transfer the nightly follow-up
handles it (#4162, below). A mirror voided
before #4091 (still active, its pointer naming it) is healed by the nightly
`link-cleanup` through this same write (#4161). A later event for the voided
note — a redelivery, the retry of an event that failed after this write, or a
replay from Inbound Events — still recounts the payment's refunded total: the
reconcile resolves a cancelled note to every payment whose inactive mirror
records the void (`findPaymentIdsWithCancelledRefundNoteMirror`, #4291), read
after the event's own link writes so a concurrent void committed meanwhile is
seen. An audit row (source `xero-inbound-credit-note-voided-mirror-recount`)
names each payment only that lookup found. That is for the recount only, so the mirror stays off and the pointer released; a
mirror retired while its note was live, or a read of the note as live, resolves
nothing.

A link write that names no Xero status (a retry recording the note as its
cover, the enqueue's existing-note branch, a repair) can race the void: it
read the note as live, and the void commits before its write. Every
refund-note link write first reserves its natural key as an inactive row
without changing any existing row, then locks it in the same transaction and
re-reads it (`keepStoredRefundNoteVoid`). Concurrent
first insertions wait on the unique key before this read; the reservation
rolls back with the write. A void that committed while it waited is kept. The
mirror stays inactive, the status and incoming metadata merge over its stored
figures and provenance, and no sibling is retired. A pointer the retry wrote
back at the note is released if its Payment row is available without waiting
(`FOR NO KEY UPDATE SKIP LOCKED`). A busy Payment defers only pointer cleanup
to the nightly #4161 heal, so a Payment-first enqueue waiting for this same
link cannot deadlock the retry (#4223). Lock order: [Refund-note
link writes racing a void](../CONCURRENCY_AND_LOCKING.md#refund-note-link-writes-racing-a-void-4195-4223).

**An older live reading never revives a void (#4288, owner decision 24 Oct
2026).** Xero's contract: a VOIDED or DELETED credit note is terminal. It is
never live again, and re-crediting always raises a new note, so no officer
override revives one. Three writers record a status they read from Xero outside
any transaction: the inbound reconcile, the Stripe status recorder
(`recordStripeRefundNoteLinkStatuses`) and the hand-made note answer. A reading
taken before a void can therefore be written after it. Each records the note's
`UpdatedDateUTC` beside the status (`providerUpdatedAt`, through the one builder
`xeroCreditNoteSnapshotMetadata`; `refund-note-snapshot-stamp-census.test.ts`
fails a writer that names a status any other way). The same locked re-read
orders the two writes (`judgeRefundNoteWrite`):

- a live status never overwrites a stored VOIDED/DELETED, whatever either
  timestamp says. With no timestamp on either side (legacy rows, status-less
  writers) this is the decision's fallback; with both, it is the contract above;
- a VOIDED/DELETED reading is always applied;
- between two live readings, one whose `UpdatedDateUTC` is older than the stored
  one's keeps the stored status, stamp and figures; the canonical rule (active
  flag, sibling retirement) still applies. Equal
  timestamps are one snapshot and apply, as does a write when either side has no
  timestamp.

A kept void stays inactive and retires no sibling. A pointer naming it is
released without waiting on Payment, as for a status-less write, and the inbound
pointer gate refuses the note. A hand-made answer whose note was voided
meanwhile is refused (409), and its completion rolls back.

The inbound reconcile then acts on each payment's note as that payment's own
refund-note row holds it when it acts (`readRefundNoteRowsByPayment`), never on
the raw reading or on a verdict remembered from its own link write. Its recount
reads the row after the payment rows: an inactive or VOIDED/DELETED row counts
nothing, a live one counts its own figures. So a total that a void lowered is
not raised back by a reconcile still holding an older live reading, even one
whose link write landed before the void's. Before #4288 it was, on a bank
transfer and on a card payment alike: `INV-ADDPAY-021` lets an inbound recount
raise a card ledger, never lower it. A void's link write changes no Payment
column the claim compares, except a pointer naming the note, so the recount's
claim alone cannot see it. For a payment holding the note's own refund-note
row, the recount therefore decides in one short transaction, on a 10s/30s
budget because the nightly follow-up holds the Payment row for up to 30s. It
takes the Payment row lock, then re-reads that row by the same rule it counted
it. If the row no longer counts (voided or deactivated
since), it writes nothing and recounts once more; otherwise it takes the
as-read claim there. An unchanged verdict also checks the payment as read, so a
recount that waited on the lock sees the write it waited for.

Every outcome is then some serial order of the recount and the void. Stated
limit: a void that commits after the locked re-read is the order "the recount,
then the void, then the void's own recount". On a bank transfer that last recount
lowers the total back. On a card the ledger is raise-only (`INV-ADDPAY-021`,
#1353), so the recount's raise stands and the existing refund-ledger-divergence
alert fires for a person to check. A recount that would need a second retry
fails its inbound event after every other write, and the stored event is
retried after its backoff (#4095), not left until another note arrives.

A live reading's allocations and refund payments are skipped only for a payment
whose row, in either refund-note role, is VOIDED/DELETED when they are written
(`withoutVoidedRefundNoteLinks`). Under a newer live snapshot they are written
as before #4288. No money reader uses a payment's `CREDIT_NOTE_ALLOCATION`
links, and a `REFUND_PAYMENT` reader asks only whether one names the note. An
older allocation link can therefore stay active beside a newer one.

A voided note is never re-adopted (owner decision). `findCanonicalPaymentRefundCreditNote`
skips any note a link records VOIDED or DELETED, whether it arrives as the field,
a refund payment's note, a succeeded create or an active link. The pointer gate
`mayRecordAsCanonicalRefundNote` refuses one, so no retry or repair writes it
back, and the booking repair tool neither offers it as a field backfill nor
counts it as a conflicting reference.

A reissue never gets a note back from Xero that is not its own. A void moves
coverage, so a reissue's key base can equal the voided note's own key or a live
note's. Once a refund note on the payment is voided, the refund-note key (built
the same way for the outbox row's correlation key and the Xero idempotency key,
`refundNoteKeyAfterVoidParts`) ends `:after-void:<ids>`, sorted and hashed when
long. The ids are every refund note, live or voided, recorded at the key's own
watermark (card and per-refund notes) or amount (a single note), or, once a
"Paid another way" close has a voided note, every note its own rows raised. A
link that records no figure is read from its create row, and counts as matching
when that records none either (fail closed). With no void the key is
byte-identical. A card payment's #2901 self-heal reissue follows the same rule.

As a last check, the create path refuses Xero's answer before recording anything
when the note is VOIDED or DELETED or another create row on the payment already
raised it: the row fails with that reason and neither the pointer nor a link is
written, so no key reuse can re-adopt or relabel a note.

Stated limit: a lost attempt's retry keeps its key only while nothing it is keyed
on moves. A void of a note the payment's coverage counted moves a card note's
watermark between the attempt and its retry, so the retry can mint a second note
(true on `main` before #4091 too). A void that adds a matching or unreadable
link to the suffix does the same. Both need a void inside a lost-answer window.

On a bank transfer a void is undone, then asked once (#4162, `INV-ADDPAY-042`).
The inbound sync no longer lowers the refunded total below the payment's own
transaction detail (`INV-ADDPAY-021`); the nightly follow-up moves the detail,
the hand-back's ledger line and the total together and puts the money back on
the refund list. Nothing is re-raised automatically. While a payment holds a
voided note the follow-up has not handled, the floor logs its divergence at
info and raises no alert - including, while report-only, notes the job would
undo, which no screen lists: the count below is where those appear. See
[Voided bank-transfer refund notes](#voided-bank-transfer-refund-notes-4162).
Otherwise the alert is a real shortfall in Xero: usually a refund whose note
was never raised, or a void already answered with its cash kept
([A later refund folded into the first note](#a-later-refund-folded-into-the-first-note-4230)).

**A refund request's own note, voided (#4195).** The same void rule holds for
a refund request's own note (`REFUND_REQUEST_CREDIT_NOTE`, `INV-PAY-118`). The
inbound sync writes its voided mirror inactive; it never names the pointer, so
nothing else moves. A request-note link write that names no Xero status (a
retry's, or a completion's) reads the stored row under its row lock in the same
transaction (`keepStoredRefundNoteVoid`, the payment's own notes' rule too), so
a void that committed while it waited keeps the link inactive and its status on
the row. `refundRequestOwnNotes`
never takes a voided note as the request's cover, even a mirror an older release
left active: every reader judges it by its recorded status, so it needs no heal.
When a request's note is raised again, its Xero key is
`payment:<id>:refund-request-credit-note:<request>:v1:after-void:<ids>`, naming
the request's own voided notes. Only a queued row keeps the plain key it was
enqueued under; a row the builder starts itself (an inline retry, or a
re-raise) carries the `after-void` key as its own keys too. The create check
refuses a note any request link records voided. Unlike the payment's one
note, the void moves no refunded total: the inbound repair never reads a
request's note. So the booking repair still counts that request's amount and
never hands its cash to the cancellation's note.

**A request's paid-back cash in the inbound recount (#4215).** The inbound
repair rebuilds a payment's refunded total (`repairRefundedPaymentBusinessState`)
when a note that resolves to the payment is reconciled: its own refund note
(the cancellation's), its account-credit note, or an edit's note credited to
its invoice (`INV-PAY-126`). A request's own note resolves to no payment, so
its update triggers no recount. On a bank transfer that total follows Xero
down only to the payment's own detail (`INV-ADDPAY-021`, #4162's floor), and
before #4215 the sum held the payment's refund, account-credit and
modification notes but no refund request's cash, so any of those reconciles
read the requests' cash as missing - an edit-note reconcile as well as the
cancellation's. Before the floor that dropped it from the total; with the
floor it raised a false divergence alert, and a total an earlier release had
already dropped stayed low, since the floor never raises one. The recount now adds what each
request's completed hand-back recorded (`COMPLETED_REFUND_REQUEST_HAND_BACK_TASK_WHERE`,
beside `isRefundRequestHandBackTask`: the task's `amountCents`, which is what
its completion moved the total by). It is read from the task, never the
request's note, because that note may still be queued, may have been voided
while the cash stays paid back, or was never queued: a request completed
before the booking had an invoice raises none. It is never attributed to the
canonical note (`INV-PAY-118`). The tasks are read after the payment row, so a
request completed between the two reads moves the row and the repair's claim
is lost and re-run, never written without it.

The booking repair tool reads the same rows through the same reader
(`readPaidBackRefundRequests`, #4231): the cash a cancellation's missing note
answers is the refunded total less the requests' paid-back cash, so a request
with no note of its own is never sized into the cancellation's note and then
counted again by the recount. And because a completion queues the request's
own note only against an invoice, a request paid back before the booking had
one is offered that note by the tool once the invoice exists
(`REFUND_REQUEST_NOTE_NOT_QUEUED`, action `QUEUE_REFUND_REQUEST_CREDIT_NOTE`):
queued through the completion's own enqueue
(`enqueueXeroRefundRequestCreditNoteOperation`), keyed by the request and sized
from its task, and only for a request with no request-note CREATE row of any
status and no request-note link. A request whose note was raised and then
voided in Xero has its row, so the tool never re-raises it: that stays the
officer's decision (#4195, #4214). The action is **never auto-applied**: a
credit an officer raised by hand in Xero is invisible to the tool, so the
officer checks Xero for one first and then confirms the action by its key
(`--apply-action`). And it is offered **only where the payment has no
cancellation refund note of any kind** - no `xeroRefundCreditNoteId`, no
`REFUND_CREDIT_NOTE` link active or not (`refundNoteSetsForPayments`,
its `notedPaymentIds`, read with `REFUND_CREDIT_NOTE_LINK_WHERE`), and
no refund-note create row that is no request's, whatever its status. Before
#4231 the tool, or an officer, could size the cancellation's note with the
request's cash folded in, and only Xero can say whether it did: an amount the
app recorded goes stale once the note is edited there. So with any
cancellation note the finding goes to a person (`manual_review`) with no
action, in two ordered steps: first always compare the cancellation note's
lines on the booking's invoice in Xero with the cancellation's own refund, and
edit it in place if the request's refund is in it; then raise the request's
own credit by hand only if none exists yet. A note Xero voided, or a create row
withdrawn (`CANCELLED`), holds nothing; for a row still queued or failed the
officer waits for it, or checks its amount in Xero Operations, before raising
anything by hand. Only the offer's finding, where no cancellation note exists,
says a credit already raised is the whole answer. A request's note the app
never queued has no outbox row to mark resolved in Xero, so a credit raised by
hand leaves either finding standing; an officer reads it against Xero.

**Deploy and rollback note (#4215).** No schema changes. A payment is only
recounted when Xero sends an event for one of the notes above, which may never
happen again, so a damaged payment may never heal by itself. Three populations
need the two checks below: payments damaged before this release shipped;
payments either colour damages during the switch window, while both serve and
the old colour's inbound worker still runs the old recount on any reconcile
(stop it before the new release takes over, as for #4091); and, after a
rollback, every payment the previous release recounts or repairs until rolling
forward again. A previous release that already has #4162's floor never lowers
a total below its rows, so on it only the too-high check below can grow; one
without the floor drops request cash as before. The previous release's repair tool nets only the requests'
notes, so do not apply its refund-note actions on a payment with a paid-back
request. Run both checks after rolling forward, and again once the old colour
has stopped. Both compare the payment's refunded total with its charge rows
(`PaymentTransaction`): a request's paid-back cash stays on the rows, which the
recount never writes. `starts_with` matches the key prefix exactly.

*Refunded total too low* - a recount dropped a request's cash. The settled-cash
audit (`pnpm run payments:audit-ib-settled-cash`, #3979) lists only totals
above the rows, never below, so list these (read-only):
`SELECT p.id, p."bookingId", p."refundedAmountCents", (SELECT SUM(t."refundedAmountCents") FROM "PaymentTransaction" t WHERE t."paymentId" = p.id) AS "rowsRefundedCents", (SELECT SUM(m."amountCents") FROM "ManualRefundTask" m WHERE m."paymentId" = p.id AND m.kind = 'CANCELLED_BOOKING_HAND_BACK' AND m.status = 'COMPLETED' AND starts_with(m."occurrenceKey", 'refund-request-hand-back:')) AS "requestsPaidBackCents" FROM "Payment" p WHERE p.source = 'INTERNET_BANKING' AND EXISTS (SELECT 1 FROM "ManualRefundTask" m WHERE m."paymentId" = p.id AND m.kind = 'CANCELLED_BOOKING_HAND_BACK' AND m.status = 'COMPLETED' AND starts_with(m."occurrenceKey", 'refund-request-hand-back:')) AND p."refundedAmountCents" < (SELECT SUM(t."refundedAmountCents") FROM "PaymentTransaction" t WHERE t."paymentId" = p.id) ORDER BY p.id`.
A payment whose canonical note Xero voided can be listed too: a release before
#4162 lowered the total for a void without touching the rows (#4091), and the
nightly follow-up (`INV-ADDPAY-042`) moves the rows only once its writes are
switched on. So an officer checks each listed payment in Xero before healing
it, and leaves a voided one to that follow-up. To heal one, replay a stored event for one of its notes: Xero,
Inbound events, the `CREDITNOTE` event for the payment's cancellation or
account-credit note, then Replay (finance edit permission). The replay reads
the note from Xero again and writes nothing there, and its recount now keeps
the request's cash. Find the events with (read-only; put the payment's id in
both places):
`SELECT e.id, e."resourceId", e.status, e."createdAt" FROM "XeroInboundEvent" e WHERE e."eventCategory" = 'CREDITNOTE' AND e."resourceId" IN (SELECT p."xeroRefundCreditNoteId" FROM "Payment" p WHERE p.id = '<payment id>' UNION SELECT l."xeroObjectId" FROM "XeroObjectLink" l WHERE l."localModel" = 'Payment' AND l."localId" = '<payment id>' AND l."xeroObjectType" = 'CREDIT_NOTE' AND l.role IN ('REFUND_CREDIT_NOTE', 'ACCOUNT_CREDIT_NOTE')) ORDER BY e."createdAt" DESC`.
The booking repair tool does not run the recount, so it cannot heal one. Any
later refund the app records on the payment also resets the refunded total from
the rows (`reconcilePaymentAggregates`), which heals it - but which equally
puts back cash a voided canonical note had taken out of the total before
#4162 (#4091), so it is no remedy for a payment listed for that reason. A payment with no
stored event for any of its notes and no later refund has no on-demand
trigger: it heals on the next Xero event for one of those notes, and until
then its refunded total reads low and the officer treats the rows' figure as
the cash handed back.

*Refunded total too high* - a request's cash counted twice. Before this
release, a request paid back before the booking had an invoice queued no note
of its own, and the repair tool (or an officer by hand) could raise the
cancellation's note for the whole refunded total, the request's cash included.
The new recount adds the request's cash beside that note, so the payment reads,
say, $200 refunded against $150 on its rows. List these (read-only; only
requests with no request-note CREATE row, read by the row's payload or its
key, and no request-note link, as the repair tool reads it):
`SELECT p.id, p."bookingId", p."refundedAmountCents", (SELECT SUM(t."refundedAmountCents") FROM "PaymentTransaction" t WHERE t."paymentId" = p.id) AS "rowsRefundedCents", (SELECT SUM(m."amountCents") FROM "ManualRefundTask" m WHERE m."paymentId" = p.id AND m.kind = 'CANCELLED_BOOKING_HAND_BACK' AND m.status = 'COMPLETED' AND starts_with(m."occurrenceKey", 'refund-request-hand-back:') AND NOT EXISTS (SELECT 1 FROM "XeroSyncOperation" o WHERE o."localModel" = 'Payment' AND o."localId" = p.id AND o."entityType" = 'CREDIT_NOTE' AND o."operationType" = 'CREATE' AND (o."requestPayload"->>'refundRequestId' = substr(m."occurrenceKey", 26) OR starts_with(o."correlationKey", 'payment:' || p.id || ':refund-request-credit-note:' || substr(m."occurrenceKey", 26) || ':'))) AND NOT EXISTS (SELECT 1 FROM "XeroObjectLink" l WHERE l."localModel" = 'Payment' AND l."localId" = p.id AND l."xeroObjectType" = 'CREDIT_NOTE' AND l.role = 'REFUND_REQUEST_CREDIT_NOTE' AND l.metadata->>'refundRequestId' = substr(m."occurrenceKey", 26))) AS "requestsWithoutNoteCents" FROM "Payment" p WHERE p.source = 'INTERNET_BANKING' AND EXISTS (SELECT 1 FROM "ManualRefundTask" m WHERE m."paymentId" = p.id AND m.kind = 'CANCELLED_BOOKING_HAND_BACK' AND m.status = 'COMPLETED' AND starts_with(m."occurrenceKey", 'refund-request-hand-back:') AND NOT EXISTS (SELECT 1 FROM "XeroSyncOperation" o WHERE o."localModel" = 'Payment' AND o."localId" = p.id AND o."entityType" = 'CREDIT_NOTE' AND o."operationType" = 'CREATE' AND (o."requestPayload"->>'refundRequestId' = substr(m."occurrenceKey", 26) OR starts_with(o."correlationKey", 'payment:' || p.id || ':refund-request-credit-note:' || substr(m."occurrenceKey", 26) || ':'))) AND NOT EXISTS (SELECT 1 FROM "XeroObjectLink" l WHERE l."localModel" = 'Payment' AND l."localId" = p.id AND l."xeroObjectType" = 'CREDIT_NOTE' AND l.role = 'REFUND_REQUEST_CREDIT_NOTE' AND l.metadata->>'refundRequestId' = substr(m."occurrenceKey", 26))) AND p."refundedAmountCents" > (SELECT SUM(t."refundedAmountCents") FROM "PaymentTransaction" t WHERE t."paymentId" = p.id) ORDER BY p.id`.

The settled-cash audit lists the same payments under `folded`, a label that
misleads here: no credit note was folded in, the request's cash is counted by
both the cancellation's note and the recount.

*Every request the repair tool sends to a person* - the same folding, found
before the recount has raised anything, whatever the payment's refunded total:
each request the tool would note, on a payment with a cancellation note, as
the tool reads one (read-only; the payment's pointer, a `REFUND_CREDIT_NOTE`
link active or not, or a refund-note create row that is no request's, a row
naming no queue type included):
`SELECT p.id, p."bookingId", p."refundedAmountCents", (SELECT SUM(t."refundedAmountCents") FROM "PaymentTransaction" t WHERE t."paymentId" = p.id) AS "rowsRefundedCents", (SELECT SUM(m."amountCents") FROM "ManualRefundTask" m WHERE m."paymentId" = p.id AND m.kind = 'CANCELLED_BOOKING_HAND_BACK' AND m.status = 'COMPLETED' AND starts_with(m."occurrenceKey", 'refund-request-hand-back:') AND NOT EXISTS (SELECT 1 FROM "XeroSyncOperation" o WHERE o."localModel" = 'Payment' AND o."localId" = p.id AND o."entityType" = 'CREDIT_NOTE' AND o."operationType" = 'CREATE' AND (o."requestPayload"->>'refundRequestId' = substr(m."occurrenceKey", 26) OR starts_with(o."correlationKey", 'payment:' || p.id || ':refund-request-credit-note:' || substr(m."occurrenceKey", 26) || ':'))) AND NOT EXISTS (SELECT 1 FROM "XeroObjectLink" l WHERE l."localModel" = 'Payment' AND l."localId" = p.id AND l."xeroObjectType" = 'CREDIT_NOTE' AND l.role = 'REFUND_REQUEST_CREDIT_NOTE' AND l.metadata->>'refundRequestId' = substr(m."occurrenceKey", 26))) AS "requestsWithoutNoteCents", p."xeroRefundCreditNoteId" FROM "Payment" p WHERE p.source = 'INTERNET_BANKING' AND EXISTS (SELECT 1 FROM "ManualRefundTask" m WHERE m."paymentId" = p.id AND m.kind = 'CANCELLED_BOOKING_HAND_BACK' AND m.status = 'COMPLETED' AND starts_with(m."occurrenceKey", 'refund-request-hand-back:') AND NOT EXISTS (SELECT 1 FROM "XeroSyncOperation" o WHERE o."localModel" = 'Payment' AND o."localId" = p.id AND o."entityType" = 'CREDIT_NOTE' AND o."operationType" = 'CREATE' AND (o."requestPayload"->>'refundRequestId' = substr(m."occurrenceKey", 26) OR starts_with(o."correlationKey", 'payment:' || p.id || ':refund-request-credit-note:' || substr(m."occurrenceKey", 26) || ':'))) AND NOT EXISTS (SELECT 1 FROM "XeroObjectLink" l WHERE l."localModel" = 'Payment' AND l."localId" = p.id AND l."xeroObjectType" = 'CREDIT_NOTE' AND l.role = 'REFUND_REQUEST_CREDIT_NOTE' AND l.metadata->>'refundRequestId' = substr(m."occurrenceKey", 26))) AND p."xeroInvoiceId" IS NOT NULL AND (p."xeroRefundCreditNoteId" IS NOT NULL OR EXISTS (SELECT 1 FROM "XeroObjectLink" c WHERE c."localModel" = 'Payment' AND c."localId" = p.id AND c."xeroObjectType" = 'CREDIT_NOTE' AND c.role = 'REFUND_CREDIT_NOTE') OR EXISTS (SELECT 1 FROM "XeroSyncOperation" c WHERE c."localModel" = 'Payment' AND c."localId" = p.id AND c."entityType" = 'CREDIT_NOTE' AND c."operationType" = 'CREATE' AND coalesce(c."queueType", c."requestPayload"->>'queueType', 'REFUND_CREDIT_NOTE') = 'REFUND_CREDIT_NOTE' AND c."requestPayload"->>'refundRequestId' IS NULL AND position(':refund-request-credit-note:' in coalesce(c."correlationKey", '')) = 0)) ORDER BY p.id`.

To remedy a payment from either list, work in two steps, in this order. A
credit already raised for the request never makes the first step unnecessary:
a folded note beside it would still credit the request twice.

1. **Always check the cancellation note.** Compare its lines on the booking's
   invoice in Xero with the cancellation's own refund (the booking's
   cancellation in the app, or its refund lines in Xero); quote no figure
   worked out from the totals, which the recount may already have moved. If
   the request's refund is in it, edit the note **in place** so its lines carry
   only the cancellation's own refund. A note Xero voided, or a create row
   withdrawn (`CANCELLED`) in Xero Operations, holds nothing; for a row still
   queued or failed there, wait for it or check its amount in Xero Operations
   before going on.
2. **Then the request's own credit.** Check the booking's invoice in Xero for a
   credit already raised for the request (its amount is the request's
   paid-back cash). Raise the request's own credit note by hand in Xero only if
   none exists yet, so Xero carries each refund once.

Editing in Xero: an approved credit note can be edited only once its
allocations and refund payments are removed; remove them, change the lines,
then allocate and record the refund payment again. Removing a refund payment
that was reconciled unreconciles its bank statement line, which must then be
matched again. A lock date blocks both editing and voiding a note dated before
it: the club's adviser lifts the lock for the change, or the payment is
escalated to the treasurer. **Never void the note**: on a bank transfer a void
is #4162's to carry - the nightly follow-up undoes the hand-back it recorded
and puts the money back on the refund list as owed, and a replacement raised by
hand is linked to nothing. Where Xero will not let the note be edited at all,
void it and let #4162 take it (only once
`XERO_ENABLE_BANK_REFUND_VOID_WRITES=true`; before that nothing moves): a note
holding two refunds matches no single hand-back, so it is listed on Stuck
States, where a person picks the cancellation's own refund; that refund then
comes back on the refund list, answered "Already in Xero" with the number of
the replacement note raised by hand for the cancellation's own refund. The
note's update event recounts the payment either way. The repair tool's
finding for the request stays: it cannot see a credit raised by hand.

Stated limit of both checks: the rows are not the whole story wherever an
invoice correction legitimately puts the refunded total above them
(`INV-PAY-126`). Such a payment can be missed by the too-low check, its
correction hiding a dropped request, and listed by the too-high check without
a double count. An officer reads each listed payment's notes in Xero before
acting, and treats a payment with an invoice correction as needing that read
even when it is not listed.

**Re-raising a voided request note is the officer's decision (#4214, owner
decision).** No retry re-raises one, whatever its row's state. Every retry door
on Xero Operations (Retry all, a row's Retry and its Requeue, through
`enqueueXeroSyncOperationRetry`) and the queued retry's worker
(`retryXeroSyncOperation`) refuse, with a 409 naming #4214, a request-note
create row whose request's own note Xero voided with nothing live replacing it
(`isRetryOfVoidedRefundRequestNote`). So do the request's PARTIAL row, a FAILED
row that names its note, and a stale FAILED row from before the note was
raised. A SUCCEEDED row is never retried, and its enqueue finds that row and
queues nothing. The panel may show a stale FAILED row as Repaired when a
SUCCEEDED row shares its plain correlation key, and the booking repair tool
reports such a request with no Retry and never auto-applies one
(`refundRequestNoteVoidedWithNoLive`). The officer action #4214 builds, "Raise
a fresh credit note", is the only remedy; until it ships, raise the replacement
by hand in Xero.

**Deploy and rollback note (#4091).** The previous release writes a voided
canonical bank-transfer mirror active, re-adopts a voided note through its
succeeded create, and sends the plain key, so a reissue there can get the voided
note back from Xero. Stop and drain every old-colour refund-note writer before
the new release queues or writes refund notes: outbox, inbound and retry
workers, plus web/direct retry paths. The old canonical writer takes sibling
rows before its own row; #4223 takes its own row first. Both writing the same
note with an active historical sibling can deadlock (40P01), so mirror healing
does not make mixed execution compatible. Before rollback, stop and drain the
new release's same writers before restarting old ones; after rolling forward,
stop and drain the old writers again before enabling the new ones. A retry of
a row the old code first attempted, on a payment that already has a matching
void, gets the new key and so may mint a fresh note beside one the lost
attempt raised; the scoping above makes that rare. Before rolling back, and after rolling forward, list the rows at risk
(read-only):
`SELECT "localId", "xeroObjectId", "updatedAt" FROM "XeroObjectLink" WHERE "localModel" = 'Payment' AND role = 'REFUND_CREDIT_NOTE' AND active AND upper(trim(metadata->>'status')) IN ('VOIDED', 'DELETED')`
(voided mirrors still active), and
`SELECT o.id, o."localId", o.status, o."correlationKey" FROM "XeroSyncOperation" o WHERE o."localModel" = 'Payment' AND o."entityType" = 'CREDIT_NOTE' AND o."operationType" = 'CREATE' AND o.status IN ('PENDING', 'RUNNING', 'WAITING_PAYMENT', 'FAILED', 'PARTIAL') AND EXISTS (SELECT 1 FROM "XeroObjectLink" l WHERE l."localModel" = 'Payment' AND l."localId" = o."localId" AND l.role = 'REFUND_CREDIT_NOTE' AND upper(trim(l.metadata->>'status')) IN ('VOIDED', 'DELETED'))`
(unfinished refund-note creates on a payment with a void). Let each listed create
finish on one colour; the nightly `link-cleanup` heals a listed mirror (#4161).
While the previous colour still runs its cleanup, it can flip a voided mirror
inactive without moving the pointer (#4192's state); the next nightly run on
the new release heals that too.

**Deploy and rollback note (#4195).** The previous release keeps a voided
request-note mirror active, takes it as the request's cover and sends the
request's plain key. An old-colour retry can therefore get the voided note back
from Xero, and its completion rewrites the link's metadata without the status,
re-arming the link where no later reader can see the void. Stop the old
colour's outbox and retry workers before the new release takes over, and do
not retry request-note rows from the old colour during the switch. Before
rolling back, and after rolling forward, list the request mirrors still active
that record a void (read-only):
`SELECT "localId", "xeroObjectId", "updatedAt" FROM "XeroObjectLink" WHERE "localModel" = 'Payment' AND role = 'REFUND_REQUEST_CREDIT_NOTE' AND active AND upper(trim(metadata->>'status')) IN ('VOIDED', 'DELETED')`.
The new release reads each as voided without a heal; check each listed request
in Xero, where the officer decides whether to raise a fresh note (#4214).
That check cannot find a link the old colour re-armed with its status
stripped: nothing local records the void any more. So also list every
request-note create that completed during the switch window, and check each
note in Xero (read-only; set the window's start and end, in UTC):
`SELECT id, "localId", "xeroObjectId", status, "completedAt" FROM "XeroSyncOperation" WHERE "localModel" = 'Payment' AND "entityType" = 'CREDIT_NOTE' AND "operationType" = 'CREATE' AND ("requestPayload"->>'refundRequestId' IS NOT NULL OR "correlationKey" LIKE '%:refund-request-credit-note:%') AND "completedAt" BETWEEN '<window start>' AND '<window end>' ORDER BY "completedAt"`.
A note Xero shows VOIDED there is a voided note the request still treats as
live: record it for the officer, who decides as for any voided request note
(#4214).

Internet-banking settlement rides this flow: when an invoice is
paid in Xero **with cash evidence** (`amountPaid` > 0, falling back to actual
payment records; operator-applied overpayments/prepayments count), the
matching local payments/bookings are flipped here, and the receipt is recorded
at the cash the invoice collected, not the figure the payment was born with,
whenever that cash is this payment's alone (#3979, `INV-PAY-125`). A PAID event produced by
credit-note allocation — the app's own invoice-clearing notes do exactly that
on every unpaid-IB cancellation — settles nothing (#1435): identifiers are
stamped for linkage only, admins are alerted if the booking is still live,
and a payload carrying neither cash field fails the event into the
FAILED-retry sweep rather than settling blind. Both credit-minting arms —
cash landing on an already-cancelled booking's stale invoice, and the
late-capacity-failure cancel — mint member credit sized by the invoice's
quantified cash, clamped to the receipt's figure (#1357/#1459, which since
#3979 is that cash itself whenever it was recorded) and, across all payments
matched to one invoice, to the invoice's remaining cash (#1505): a mixed
cash+allocation invoice credits only the cash portion, the admin alert names
both amounts so the allocation source gets verified (since #3979 the invoice's
total less the member's own applied credit, against the cash), and verified cash
arriving after a mint alerts with the delta (it never credits automatically).
Two never-settled payments on one invoice each mint no more than the invoice's
cash NOT already minted for the other (a defensive invariant — no app flow
produces that shape; the remaining-cash read-back happens inside each payment's
reconcile transaction under the shared advisory lock, so it stays idempotent
under retry, and a capped mint raises the same loud alert, never a silent
overmint). The late-capacity-failure cancel also restores the booking's applied
account credit in full, under the per-member credit-ledger lock and only once
no applied-credit deallocation is unconverged (#3792). The inbound credit-note
sync then leaves that booking's member ledger alone: a later de-allocation or
raise in Xero on a booking with a restore row writes nothing, raises
`applied-credit-restored-booking-allocation-change` through
`notifyXeroSyncError`, and records a critical `xero` audit row, which survives
that alert's one-an-hour throttle (`INV-PAY-019`).

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
    REP->>REP: classify findings (15 codes:<br/>MISSING_PRIMARY_INVOICE, STALE_PRIMARY_INVOICE_DETAILS,<br/>CANCELLED_BOOKING_OPEN_INVOICE, XERO_AMOUNT_MISMATCH,<br/>BLOCKED_BY_XERO_OPERATION, ...)
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

**An operation resolved in Xero is done (#3635, `INV-INT-025`).** The
operations panel's **Resolve** records that an officer fixed a failed or
partial operation by hand in Xero. It leaves the row `FAILED`/`PARTIAL` and
replayable, so status alone would still read it as live; every reader asks
`isResolvedInXero` (`xero-operation-resolution.ts`) or its query-side spelling
on `manuallyResolvedAt`.

- **Retries.** The retry helper refuses the row before anything else. Manual
  retry and requeue answer 409, and a retry queued before the resolve is closed
  `CANCELLED` by the drain, not run - also when its claim loses to a resolve,
  which throws the resolved error rather than "claimed by another retry".
- **Enqueues.** A new row does not carry the old row's mark, so the enqueues
  are fenced too (`xero-resolved-in-xero-fences.ts`). A resolved refund-note
  create counts its RECORDED amount as covered
  (`readResolvedRefundCreditNoteCoverage`, read by the same
  `parsePaymentCreditNoteRetryInput` the retry replays with): never a
  per-payment block, so a later refund beyond it gets its own note, sized from
  the same coverage, and the hand-made note is never covered twice. A resolved
  row whose note a link records VOIDED or DELETED covers nothing (#4250,
  `refundNoteIdSets(...).cancelled`, read in the same query as the live
  notes): Xero no longer holds that note, so the nightly card self-heal sees
  the gap and raises a fresh note (`INV-ADDPAY-041`). Its id is still
  reported, but never its key: a re-raise's key can equal it when the note
  executed at another watermark than it was queued at. Its amount is never
  read. Owner decision (21 Oct 2026): a voided card refund note is raised
  again automatically, even one resolved in Xero, so officers are told not to
  replace it by hand as well, which would duplicate it. A row's coverage is
  its own, live note, and never a refund request's (#4265, owner decision
  26 Oct 2026; `countsTowardRefundNoteCoverage`, read by this reader and by
  `sumRefundCreditNoteCoverageOfRowsCents`): a refund request's note answers
  the request (`INV-PAY-118`), and a row closed as covered by another refund's
  note (`coveredByExistingNote`, #4258) raised none of its own. Such a row
  covers nothing, live or voided, and its amount is never read; its key and id
  are still reported, so the request's own fence holds. A voided request note
  is #4391's to handle. A resolved row whose
  amount cannot be read, unless its note is voided or deleted (#4250), makes
  the enqueue refuse loudly (error log, "raise it by hand"). `readRefundCreditNoteGap` is the one reader of the gap
  for the self-heal list and the booking page. No new booking invoice is queued
  while the payment's latest invoice create is resolved, and the
  missing-invoices list behind **Queue all** leaves those out. Single-booking
  force-sync is the one override: it passes `overrideResolvedInXero`, and its
  audit row names the operation whose mark it overrode.
- **A late success still lands (#4374, `INV-INT-029`).** A caller sharing the
  row (#1354) whose own Xero call succeeds after the mark still records its
  success: the status-guarded write lands on the resolved FAILED or PARTIAL
  row, leaves the mark as it finds it, and records its links, which are real
  Xero objects. The row is read back in the same transaction, under the
  write's row lock. When it is SUCCEEDED and `isResolvedInXero`, a warning is logged and the officers get one **Xero Sync
  Error** alert per operation (`XERO_SUCCESS_AFTER_RESOLUTION`,
  `sendAdminAlertOnceEver`, key
  `xero-success-after-resolution:<operation id>`), after commit and outside
  any transaction (`xero-success-after-resolution-alert.ts`). A success that
  recorded no object still alerts: an applied-credit run allocates through
  child operations, and a deallocation changes Xero without recording one.
  - **What it says.** On an officer's mark: Xero may hold the item twice, or
    the late call may have found and used the officer's own document by its
    reference, so check Xero before voiding. On a row the app closed because
    its credit note was spent outside the app (#4219,
    `isClosedByCreditSpentOutsideApp`): the credit ledger and Xero may now
    disagree. It never says the
    mark stays: the resolve route withdraws a mark it has just written when a
    retry overlaps it.
  - **Injected transactions.** A caller that hands `completeXeroSyncOperation`
    its own transaction (`store`) gets the alert back as `deferredPostCommit`
    and runs it after its commit; a rollback sends nothing. The member-contact
    completions do this; the only other such caller writes CANCELLED.
    `xero-success-after-resolution-alert.test.ts` pins the callers, and fails
    on an options argument it cannot read as text.
  - **Limit: no retry of its own.** If the send throws before reaching
    anyone, or nobody can receive it, `sendAdminAlertOnceEver` gives the claim
    back or defers it, but nothing calls again unless another success lands
    on the row. The logged warning is then the only trace.
- **A refund note resolved by hand names its note (#4421, owner decision
  26 Oct 2026, `INV-INT-028`).** On a FAILED payment refund-note create that
  names no note of its own and counts as its own refund's
  (`refundNoteResolveShape`, `xero-resolve-refund-note.ts`, built on the row
  constants the coverage reader above queries with, `REFUND_NOTE_CREATE_ROW`),
  Resolve asks for the number of the credit note the officer made in Xero. The
  list route sends whether it asks, for what amount, and why a row will be
  refused (`resolveCreditNotePrompt`), and the panel's dialog stays open while
  the route checks. The route checks the note with the hand-made answer's own
  `verifyHandMadeRefundNote` before any transaction - approved or paid, a sales
  credit note for the booking's contact (the invoice the note names, else the
  payment's, else the owner's), allocated to no other invoice and exactly the
  row's recorded amount. Then, in one transaction under `lock(1)` and the
  Payment row, it re-reads the row and refuses with a 409, writing nothing,
  when a retry of the row ran since the route read it (`findRetryRunningOrSince`:
  a FAILED refund note's retry runs on its own REQUEUE row and never claims the
  original), when a run already raised the row's note at any time
  (`findSupersedingRefundNoteRun`: its retry, or a create on the payment with
  the same correlation key, SUCCEEDED or PARTIAL - the original stays FAILED
  naming no note, and the failure overview calls it repaired; also asked before
  the Xero check and shown by the list), when a live copy of the note is queued
  (`findQueuedLiveCopy`, asked again under the locks), or another credit-note
  create row or any link records the note;
  the status-guarded claim (FAILED, unresolved, no note) writes the mark with
  the note's id and number, and the answer's own link writer
  (`writeHandMadeRefundNoteLink`) the payment's live per-refund
  `REFUND_CREDIT_NOTE` link naming the row (`resolvedOperationId`). After the
  commit the note is read once more (`reconcileHandMadeNoteAfterRecording`).
  With the link, the inbound sync marks the note voided if Xero voids it, the
  resolved row then covers nothing (#4250's rule) and the voided-note readers
  take over: a bank transfer's nightly follow-up undoes the refund and asks
  once, a card refund's note is raised again. While it is live, the link counts
  the note and the row adds nothing, so it is counted once, and the #4162
  answer's guard refuses it. A mark withdrawn for a running retry retires its
  link under the same locks and is audited; a withdrawal that fails leaves the
  mark and the live link while the retry may raise its own note, so it raises a
  `refund-ledger-divergence` alert naming the operation and the note. Only that
  row's later resolve takes a retired link back. Refused, and every refusal of
  a resolve that offered or needed a number audited with the number tried and
  the status, whichever check refused it: a number for a row that takes none,
  a PARTIAL refund-note row naming no note (it would count as covered with no
  note on record), and a FAILED one whose amount cannot be read - Retry refuses
  that one too, so the officer marks it non-replayable (which stops re-runs,
  not the listing) and asks the treasurer. A refund request's note (#4391), a row that already names its note
  and every other row resolve as before. Legacy: a row resolved before #4421
  names no note and stays so - nothing can backfill a number nobody recorded.
- **The outbox.** After it claims a row and before any Xero call, the outbox
  asks `findResolvedSiblingSince`: was a sibling for the same document (same
  correlation key) resolved after this copy was queued? If so the copy is
  closed `CANCELLED`, because the hand-made document stands for it.
- **Resolve against a running retry.** The route refuses while the operation is
  RUNNING (a claiming retry), while a live copy of the same document is queued,
  or while a queued retry of it is RUNNING or started at or before the mark and
  completed at or after it (`findRetryOverlappingMark`,
  `xero-operation-resolve-guards.ts`). The queued-retry check runs after the
  mark is written, and a mark that finds one is withdrawn: a drain that read
  the row before the mark had already claimed its queued row, so the check sees
  it whether it is still running or has just finished, and a drain that reads
  after the mark refuses to run. A second officer is told "already resolved"
  only when the same check would keep the first mark. What remains: clock skew
  between the instance that wrote the mark and the one that stamped the retry,
  and a caller of `retryXeroSyncOperation` that bypassed the drain (none today).
  A queued retry that stood down because it read a mark later withdrawn records
  that nothing ran and the operation may be unresolved. A stuck running retry
  points the officer at **Reset stale running operations**.
- **Applied-credit allocations and deallocations cannot be resolved.** Fixing
  Xero by hand does not converge the local credit-slice ledger, and an
  unconverged deallocation fences cancels, the hold-expiry cron and credit
  writes (`findAppliedCreditDeallocationFence`); a resolved one would hold them
  for good. They are retry-only: the route refuses them, and a mark on one
  written before this release is void on the retry path
  (`isResolvedInXeroForRetry`), so it can still be retried to convergence. The
  one failure a retry cannot fix, a credit note spent in Xero outside the app
  (#4218), converges itself for an applied-credit allocation (#4219, below, on its
  first attempt, or on a retry when it was recorded before that release); no
  officer mark is involved.
- **Repair tool.** `getBlockingOperation` returns a discriminated result:
  `retryable`, `blocked` (live, or refused by the retry helper) or `resolved`.
  A resolved row never outranks a newer live failure, and it is never dropped,
  because then every arm would read "nothing blocking" and queue a new document
  beside the one the officer made. `buildRetryAction` accepts only the
  `retryable` case. Resolved means "never re-run", not "never reported": where
  no document is recorded the arm reports `RESOLVED_IN_XERO_BY_OFFICER` at info
  level with no action, the booking page shows the same, and the reconciliation
  report data counts resolved rows (`resolvedInXeroOperations`) without calling
  them failures; the emailed digest does not show that count. The repeated-failure alert leaves them out too.

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
  never coverage — and cleanup deactivates it (a local write, never a provider
  call), which re-arms the credit-reconciliation self-heal after an operator
  void. **Every such mirror, on any source (#4161),** and every inactive one
  that its own payment's `Payment.xeroRefundCreditNoteId` still names (#4192,
  left by the old cleanup's direct flip), is counted first
  (`cancelledRefundCreditNoteMirrors`, `pointedInactiveCancelledRefundNoteMirrors`
  in the run's summary). Each is then healed through `upsertXeroObjectLink`
  with its recorded status merged, never flipped directly: the link write
  deactivates it (`INV-ADDPAY-041`) and releases a pointer that names it
  (#4046). This catches a bank-transfer payment's canonical note voided before
  #4091, whose active mirror matched its pointer. Local rows only, no provider
  call, no money column. Each heal is its own transaction: it locks and
  re-reads the link and writes nothing if it changed, and it is deferred while
  another writer holds the payment row (taken `NOWAIT`) or the payment has a
  credit-note operation that could still mint
  ([CONCURRENCY_AND_LOCKING.md](../CONCURRENCY_AND_LOCKING.md#refund-note-link-heal-4161)).
  A healed link matches neither shape, so a second run changes nothing. A heal
  that fails is returned in `failedRefundNoteHealLinkIds`, after the rest are
  tried, and the cron records the task as failed; a deferred one is retried
  the next night. Before #2901's exemption, cleanup and that self-heal fed
  each other an unbounded duplicate-note loop: cleanup deactivated live
  coverage, reconciliation saw the shortfall and minted another provider note,
  the scalar moved, and the next cleanup deactivated the other side. The
  reconciliation report's stale/mismatched/duplicate drift classifications
  share the same status-aware exemption so the emailed digest cannot flag the
  multi-note contract as drift, and a new `overCoveredStripeRefundPayments`
  drift class flags a payment whose active, non-cancelled coverage exceeds its
  refunded total — the state that silently suppresses every later refund note
  and that nothing else detects.
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
   pnpm run xero:refund-note-link-repair --record-statuses   # all refunded Stripe payments
   pnpm run xero:refund-note-link-repair --record-statuses --payment <id>
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
   INV-PAY-050 (#2902) less refunds of late captures Xero never received
   (`resolveRefundNoteEligibleCash`, `INV-PAY-110`, #3635), shown beside the
   raw refunded mirror with the rule that produced it (`provider-ledger` /
   `legacy-mirror`) — the report lists
   every refund-note link (active/inactive, recorded or payload-recovered
   amount, recorded Xero status) and the plan. Active coverage counts notes
   an officer resolved in Xero, as the enqueue does (`INV-INT-025`), and a
   resolved note whose amount cannot be read blocks the payment, unless its
   note is voided or deleted (#4250). The plan: reactivations (oldest first,
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
   confirmation, **or FAILED/PARTIAL while still marked replayable and not
   resolved in Xero** (that combination is exactly what manual retry and
   requeue accept, and the credit-note retry runs while its row still reads
   FAILED), or a queued/running REQUEUE of one — re-checked inside each
   transaction. To clear a failed credit-note operation's block, retry it to
   completion, **mark it non-replayable**, or **mark it resolved in Xero** in
   the admin Xero panel. Either mark makes it terminally dead: since #3635
   (`INV-INT-025`) no retry path re-runs a resolved operation, so it no longer
   blocks. The apply transactions also re-sum
   coverage after their claims and roll back on any divergence — but not
   racing the executor at all is the cheap, certain option.
5. **Apply, bound to the payments you reviewed** (local ledger writes only,
   each payment in its own transaction, re-planned from an in-transaction
   snapshot and applied through status-guarded claims whose matched counts
   must equal the plan; safe to re-run — a second pass finds nothing):

   ```bash
   pnpm run xero:refund-note-link-repair --apply --payment <id> [--payment <id>...]
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

### Voided bank-transfer refund notes (#4162)

Owner decision 17 Oct 2026 ("undo, then ask once", `INV-ADDPAY-042`). The
treasurer's hand-back is the record that a bank refund was paid; its refund
credit note mirrors it. A void in Xero means "this refund is no longer
recorded", and only the treasurer knows whether the transfer went or bounced.

**The nightly follow-up** (`src/lib/bank-refund-void-follow-up.ts`) runs in the
02:25 slot right after `link-cleanup`, whose #4161 heal turns voided mirrors
off (job `xero-bank-refund-void-follow-up`, local rows only, so it runs with
Xero disconnected too). For each `REFUND_CREDIT_NOTE` link on an
`INTERNET_BANKING` payment whose recorded status is VOIDED or DELETED, the
classifier (`src/lib/bank-refund-void-scan.ts`) answers one of:

| Answer | What happens |
| --- | --- |
| awaiting heal | The mirror is still active: the next night, after the heal. |
| handled | Its nightly follow-up exists (the key is the claim); a link marker records a spare, a person's answer, or picks in full; or a person's picks add up to its amount (one pick when its amount cannot be read). Nothing more. |
| deferred | A refund-note create on the payment could still mint (a row whose note Xero voided never counts). Tried again next night; listed on Stuck States after 7 days and counted in the run's summary (`deferredOverdue`). |
| spare | Live notes plus notes resolved by hand (`INV-INT-025`, never a resolved row whose own note Xero voided, #4250's shared rule, nor a refund request's note, #4265) still cover every bank hand-back and the eligible card refund cash (`resolveRefundNoteEligibleCash` less paid-another-way cash): nothing moves; a `bankRefundVoid` marker on the link records it. |
| undo | In one transaction under `lock(1)` then the Payment row: insert the follow-up (`CANCELLED_BOOKING_HAND_BACK`, key `bank-refund-void:<paymentId>:<creditNoteId>`), unwind the amount from the allocation (`unwindLocalRefundAllocation`, oldest first, never below card refunds), reverse the hand-back's `BANK_REFUND` line (`settlementLineReversal`) and recompute the total (`reconcilePaymentAggregates`). No email, booking event or provider call. |
| unmatched | The amount cannot be read, no single live hand-back line has it, the detail no longer holds it, it recorded a card refund's record (a "Paid another way" close or shortfall), it recorded a card refund itself (#4312, `card-refund`: a note keyed on its `PaymentRefund`, by its payload or its key), or a person has picked part of it: listed on Stuck States. A person picks the live bank refunds it recorded, one at a time, and the same undo runs for each (`pickRefundForUnmatchedVoid`, owner 18 Oct 2026), claimed under `bank-refund-void:<paymentId>:<creditNoteId>:<lineId>`; never a line its own task's live notes still record even in part (shown with its live share, left to a recorded answer), nor one larger than what is left of the note's amount. The pick that leaves nothing to pick writes a `picked` marker. A card refund's record has nothing to pick - its note is re-raised from the repair tool and the answer recorded; nor does a card refund's own note (`isCardMoneyVoidReason`), which takes a recorded answer once Xero is checked: nothing re-raises it, so a person raises it by hand where Xero should still show it. A late capture's refund is no exception: its voided note keeps its credit note's id, so the capture's sizing (`noteLateCaptureRefunds`, `classifyLateCaptureCardNote`) still counts it and a later refund of the capture asks only for itself; any other row with nothing to pick says why and takes a recorded answer. |

A note is matched to the hand-back it recorded by the task it names - a
cancellation's note carries `handBackTaskId` in its payload since #4162 (never
in its key), a review's `reviewTaskId`, a follow-up's fresh note
`paidAnotherWayTaskId`, a hand-made note's link `handBackTaskId` - and that
task's live line for exactly the note's amount. An older note naming no task
takes the one live hand-back line of its amount, only when no other live
`BANK_REFUND` line on the booking has that amount. A line whose own task's live
notes (create rows naming the task, or a hand-made link) still record any of it
is never matched: an undo takes back the whole line.

**Report-only by default.** Until `XERO_ENABLE_BANK_REFUND_VOID_WRITES=true`
the job classifies and logs, and writes nothing; a person's pick or answer is
refused (409) and the panel is read-only. Each night a note is classified
unlocked first; only a spare or an undo takes the locks, and handled notes are
left out of the scan in SQL.

**The answers** (refund list, `resolveManualRefundTask`): a fresh note is queued
in the completion's transaction, keyed and sized on the follow-up (the
`paidAnotherWayTaskId` path a card refund shortfall uses: Xero key
`payment:<id>:refund-credit-note:paid-another-way:<task>:<own cover>:v3`), dated
today. "Already in Xero" reads the hand-made note by number before the
transaction (`getCreditNotes`, and the payment's invoice for its contact,
`bank-refund-void-answer.ts`; one retry, 5s wait, "Xero is busy" on a rate
limit, "try again tomorrow" on the daily limit), checks it is an `ACCRECCREDIT` that is AUTHORISED or PAID, for the
amount, for the invoice's contact (else the owner's), allocated to no other
invoice, tracked by nothing else here (this payment's own inactive,
non-voided link is reactivated) and named by no credit-note create, on any
payment, that is resolved by hand or not yet SUCCEEDED (#4321: with no live
link, a resolved row counts the note as its own refund's, and the resolve route
can still flip an unfinished one). Since #4421 a FAILED row an officer resolves
after making its note by hand records that note, on the row and as a link, so
it is refused too; a row resolved before then names none. The completion links
it, through the writer the resolve shares (`writeHandMadeRefundNoteLink`), as a per-refund
`REFUND_CREDIT_NOTE` naming the follow-up. A void, or a newer reading, that
commits before that link write is kept under the link's row lock and the answer
is refused (#4288). After
the commit the note is reconciled once more (`reconcileXeroCreditNote`), so a
later void is caught. A fresh note is refused on a payment with no Xero invoice, and when
nothing could be queued.

**Count before switching on.** `pnpm run xero:bank-refund-void-count` (read-only:
no transaction, no lock, no write, no provider call; `--list` adds ids,
`--json` is machine-readable) sorts every voided note with the job's own
classifier into: awaiting heal; handled (follow-up, spare, answered, picked);
deferred; spare; undo with the payment's total already below its detail or
still equal to it; unmatched by reason (amount unknown, no line, ambiguous,
detail short, paid another way, coverage unknown, partly picked - counted at
what is left to pick). It also counts bank-transfer payments whose
total is below their detail with no void, which the job never touches, and
says how many payments hold several voids (each note is counted against today's
records, so those can overstate).

### A later refund folded into the first note (#4230)

A bank-transfer payment issues its refund notes through the single-note branch
of `enqueueXeroRefundCreditNoteOperation`: once the payment has its one
canonical refund note, a later enqueue that is not keyed per refund
(`reviewTaskId`, `paidAnotherWayTaskId`) is taken as a replay and raises
nothing ("already linked"). That is right for a replay, and wrong for a
second, distinct refund - for example a cancellation hand-back completed after
another refund made the canonical note, or a refund request's card part
approved after the cancellation's note (`refund-requests/[id]` queues it with
no keyed options). #4287 lists every writer that reaches the branch, the
webhook card-refund delta, the nightly self-heal's re-ask and the late-capture
note among them. The refund is paid and recorded on the charge rows, but no
note in Xero carries it. The inbound recount then reads Xero as accounting for
less than the rows, and the floor (`INV-ADDPAY-021`) keeps the rows and alerts.

**Since #4287 a cancellation hand-back no longer folds.** Completed after the
payment has its canonical note, it gets a note of its own, keyed and sized on
its task
([A later bank-transfer hand-back gets its own note](#a-later-bank-transfer-hand-back-gets-its-own-note-4287)).
**Since #4312 three card writers no longer fold either.** A refund request's card
part, a refund made in the Stripe dashboard and a late capture's refund each get
a note of their own, keyed and sized on the card refund
([A card refund on a bank transfer gets its own note](#a-card-refund-on-a-bank-transfer-gets-its-own-note-4312)).
No other writer card-refunds money Xero holds on a bank-transfer payment: a
cancellation gives it account credit, never a card refund
(`forcedCancelRefundMethod`); an edit's reduction goes back by hand, because
its card refund needs a payment taken through Stripe (`hasSucceededPayment` in
`applyPaymentAdjustments`, `editRefundGoesBackByHand`); and a group cancel
refunds to a card only the children paid by card. Two other card refunds can
land on one, and neither is owed a note: a duplicate capture's (#4211, a bank
receipt counts as the booking's settler) and a superseded intent's that
captured anyway. Neither capture was ever receipted in Xero - a bank-transfer
invoice records no Stripe payment - so a note would credit money Xero never
received. Each records its refund row the moment Stripe answers, so
`charge.refunded` usually finds nothing new; if the webhook records one first,
its refund goes in the delta to the single-note branch, as before #4312.
Refunds folded before either release stay folded: nothing raises their notes,
and the deploy note below is how they are found.

**The alert is true, so the recount does not add the cash (owner decision 22
Oct 2026).** Adding the folded refund to the recount, as #4215 does for a
refund request's paid-back cash (whose own note exists under another role),
would silence the only signal: for a card part the refund-note gap reader
(`readRefundCreditNoteGap`) shows nothing uncovered, because the bank note's
coverage hides the card cash. So the alert names the payment, its booking and
the note whose change raised it, and its advice
(`BANK_TRANSFER_REFUND_SHORTFALL_ADVICE`, quoted by the Xero guide's
troubleshooting row) asks for a note by hand only for a refund whose note was
never raised. A void reaches the alert only once it has been answered: while a
voided note waits for the nightly follow-up the floor logs at info and raises
nothing (`hasVoidAwaitingFollowUp`), and once the follow-up has undone it the
rows no longer hold its cash. What is left is a void answered with the cash
still recorded (a `bankRefundVoid` marker on its link), whose replacement comes
from that answer on the refund list or Stuck States, never by hand. #4287
gives a later cancellation hand-back its own note (`INV-ADDPAY-043`), and #4312
a card refund (`INV-ADDPAY-047`). Pinned on real PostgreSQL by
`xero-bt-recount-handbacks`, which also pins two cases that are safe: a group
organiser's hand-back (#4042) moves no payment's total, since each joiner's
refund sits on the joiner's payment under its own note; and the recount writes
`Payment.refundedAmountCents` and never the charge rows, which the paid cancel
folds later (#1491) and the floor reads as its detail.

**Deploy note (#4230).** No schema changes. A payment already holding a folded
refund alerts on each reconcile of its notes. List the bank-transfer payments
whose paid-back refunds add up to more than their live refund notes
(read-only), so an officer can raise the missing notes by hand:

```sql
SELECT p.id, p."bookingId", p."refundedAmountCents",
  (SELECT COALESCE(SUM(t."refundedAmountCents"), 0) FROM "PaymentTransaction" t WHERE t."paymentId" = p.id) AS "rowsRefundedCents",
  h."handBacksCents", u."undoneCents", r."cardRefundsCents", n."refundNotesCents"
FROM "Payment" p
CROSS JOIN LATERAL (
  SELECT COALESCE(SUM(m."amountCents"), 0) AS "handBacksCents"
  FROM "ManualRefundTask" m
  WHERE m."paymentId" = p.id AND m.status = 'COMPLETED'
    AND (
      (m.kind = 'CANCELLED_BOOKING_HAND_BACK'
        AND NOT starts_with(coalesce(m."occurrenceKey", ''), 'edit-refund-hand-back:')
        AND NOT starts_with(coalesce(m."occurrenceKey", ''), 'refund-request-hand-back:')
        AND NOT starts_with(coalesce(m."occurrenceKey", ''), 'bank-refund-void:'))
      OR (m.kind = 'EDIT_FINANCIAL_REVIEW' AND m."settlementDirection" = 'REFUND_TO_MEMBER'
        AND EXISTS (SELECT 1 FROM "Booking" b WHERE b.id = p."bookingId" AND b.status = 'CANCELLED'))
    )
) h
CROSS JOIN LATERAL (
  SELECT COALESCE(SUM(v."amountCents"), 0) AS "undoneCents"
  FROM "ManualRefundTask" v
  WHERE v."paymentId" = p.id AND v.kind = 'CANCELLED_BOOKING_HAND_BACK'
    AND starts_with(v."occurrenceKey", 'bank-refund-void:') AND v.status <> 'COMPLETED'
) u
CROSS JOIN LATERAL (
  SELECT COALESCE(SUM(f."amountCents"), 0) AS "cardRefundsCents"
  FROM "PaymentRefund" f
  WHERE f."paymentId" = p.id AND f.status NOT IN ('failed', 'canceled')
) r
CROSS JOIN LATERAL (
  SELECT COALESCE(SUM(CASE WHEN jsonb_typeof(l.metadata->'amountCents') = 'number' THEN (l.metadata->>'amountCents')::numeric ELSE 0 END), 0) AS "refundNotesCents"
  FROM "XeroObjectLink" l
  WHERE l."localModel" = 'Payment' AND l."localId" = p.id AND l."xeroObjectType" = 'CREDIT_NOTE' AND l.role = 'REFUND_CREDIT_NOTE' AND l.active
    AND upper(trim(coalesce(l.metadata->>'status', ''))) NOT IN ('VOIDED', 'DELETED')
) n
WHERE p.source = 'INTERNET_BANKING' AND p."xeroInvoiceId" IS NOT NULL
  AND h."handBacksCents" - u."undoneCents" + r."cardRefundsCents" > n."refundNotesCents"
ORDER BY p.id;
```

What it counts as paid back, each answered by a refund note when all is well:

- **Completed hand-backs**, except those another note answers: an edit's
  refund hand-back (the edit's own note), a refund request's (the request's
  own note, `INV-PAY-118`), and a bank refund re-confirmed after a void, which
  re-records the hand-back it undid. A "Paid another way" close and a card
  refund shortfall's bank part count: each has its own refund note. A group
  organiser's hand-back has no payment.
- **Completed reviews that refunded the member on a cancelled booking**: each
  queues its own refund note (#3880).
- **Less every bank refund the nightly follow-up undid and nobody has
  re-confirmed** (`undoneCents`: an open or dismissed follow-up), so a void the
  follow-up has handled is not listed for ever. A re-confirmed one stays
  counted, against its fresh note.
- **Card refunds Stripe made** (`cardRefundsCents`).

Stated limits, all listing a payment rather than missing one: a link written
before amounts were recorded counts as nothing; a refund of a late capture Xero
never received deliberately has no note (`INV-PAY-110`); a review refunded by
card counts twice (its task and its card refund), and one the booking was
cancelled after was answered by the edit's note; an edit's card refund is
answered by the edit's own modification note, which the query does not read,
so check the booking's edits in Xero before raising anything for a card refund;
a voided note still waiting for the nightly follow-up, or answered with its
cash kept, is left out of the notes while its refund still counts - leave those
to the refund list and Stuck States.

For each listed payment an officer compares the booking's invoice in Xero with
its refunds and raises a note by hand for any refund whose note was never
raised. Stated limit: a note raised by hand is linked to no payment here, so the
recount still cannot count it, and a later reconcile of the payment's own notes
alerts again; the officer checks the hand-raised note is in Xero and goes on.

*Refunded total below the rows.* Where a listed payment's
`refundedAmountCents` is below its `rowsRefundedCents`, a release before the
floor lowered it, and it stays low: the floor never raises a total, the recount
never adds folded cash, a replay of a stored event recounts the same way, and
the booking repair tool does not run the recount. Nothing here corrects it; the
next refund the app records on the payment resets the total from its rows
(`reconcilePaymentAggregates`). Until then the officer reads the rows' figure as
the cash handed back. Otherwise the refunded total is held at the rows by the
floor.

### A later bank-transfer hand-back gets its own note (#4287)

Owner decision, 22 Oct 2026 (`INV-ADDPAY-043`). A bank-transfer
(`INTERNET_BANKING`) payment's first refund still takes its one canonical
refund note; a payment of any other source is untouched. A cancellation hand-back
completed later is noted on its own task: the completion
(`queueCancelledBookingHandBackNoteInTransaction`) asks
`cancellationHandBackNotedOnItsOwnRecord`, and where the answer is yes it
queues the note with `paidAnotherWayTaskId` set to the task, beside the
`handBackTaskId` it already carried (#4162). That is the per-record route a
"Paid another way" close, a card refund shortfall and a re-confirmed bank
refund already take, so the key, the sizing (`readPaidAnotherWayCloseShare`:
the task's amount less its own notes), the dedupe, the Xero key after a void
(`INV-ADDPAY-041`), the retry and the `perDelta` link are theirs, unchanged.

The answer is yes when:

- **the payment already has its canonical note**, linked
  (`findCanonicalPaymentRefundCreditNote`) or on its way - a canonical create
  row still PENDING, RUNNING or FAILED, or one whose payload cannot be read
  (taken as on its way: a wrong "own" is harmless, a wrong "canonical"
  absorbs). A queued row is not linked yet. Without this branch two hand-backs
  of the same amount completed close together would both take the canonical
  route under the same key (`payment:<id>:refund-credit-note:<amount>:v1`),
  and the second's enqueue would dedupe into the first's row: one note for
  two refunds;
- **or the payment has any STRIPE transaction row, in any status (a wrong
  "own" is harmless), or a card refund row.** Once a card refund is recorded, the payment's refund-note cash is read
  from the card refunds (`resolveStripeCashRefundEvidence`, provider ledger),
  which leave the hand-back's bank cash out, so a canonical note sized against
  that cash when it runs would floor at nothing - the "payment-wide figure
  floors at 0" the blueprint names. The charge row is asked, not the refund,
  so a card refund landing between the completion and its note's run cannot
  shrink the note.

**Its cash counts beside its note.** A hand-back noted this way is noted bank
cash in `readPaidAnotherWayCash`, as a close is. Without that, on a payment
with card refunds its note would sit in the coverage a card note is sized
against with no cash beside it, and a card note raised after it - a retry of
the cancel's card note, say - would be closed as covered and never reach Xero.
A hand-back whose note is the canonical one, or that has none, is not a record
there at all. It counts only while its refund stands: once Xero voids its note
and the #4162 nightly undo reverses its `BANK_REFUND` line, the task stays
COMPLETED but its undo's follow-up names it (`originalTaskId`), and the
hand-back counts, and sizes its own note, at its amount less every such
follow-up's - nothing, for a whole undo (`standingHandBackCents`). Counted
forever, it would read as noted cash no note answers and shrink every later
card or canonical note by it.

**A re-confirmed refund counts too (#4315 item 2, handled here).** When the
treasurer re-confirms the follow-up, its refund is recorded again with its own
note - a fresh one keyed on the follow-up, or a hand-made one linked to it
(`recordedByHand`). That note is in the payment's coverage, so the COMPLETED
follow-up is noted bank cash beside it once a note row names it (in any
status) or, for a follow-up, once a hand-made note is linked to it; and a
hand-made note covers it in its share. The cash reader thus has three terms
beyond the hand-back rule's record: the follow-up as a record, the netting
(`standingHandBackCents`, for both kinds), and that hand-made cover. It nets the same way: a second void of its note, undone, names the
follow-up as `originalTaskId`, and it counts nothing. A DISMISSED follow-up
(the transfer bounced) counts nothing. Each refund counts once: the original
nets out what the undo took back, and the follow-up counts only its own. Every
reader of this cash moves with it - the refund-note cash
(`resolveStripeCashRefundEvidence`), each record's share and the payment's
uncovered closes (`readPaidAnotherWayUncoveredCents`), the void scan's card
cash, the capacity-race check (`noteMayCover`), and through the cash the link
repair and the hardening report.

**Locks.** The decision is read inside the completion, after
`applyLocalRefundAllocation` has taken the Payment row lock (#4217), so a
second completion on the same payment reads only after the first has
committed its row. No new advisory key: the note's key is the task's. The
order is pinned by `manual-refund-task.test.ts` (allocation, then decision,
then enqueue, on one transaction) and `payment-lock-before-rebuild.test.ts`
(the allocation's first statement is the lock).

**Readers.** The inbound recount, the coverage sum
(`sumRefundCreditNoteCoverageCents`) and the gap reader
(`readRefundCreditNoteGap`) count the note through its link like any other, so
a payment whose refunds all have notes shows nothing uncovered, the #4162 floor
raises no alert once each note's own Xero event has been reconciled, and the
#4230 deploy note does not list it. Until the note is in Xero the alert is
true, as for any refund whose note has not landed yet.

**Never for a historical refund** (owner, 22 Oct 2026). Only the completion
asks, as it records the refund; nothing re-asks for a hand-back already
completed. A refund an older release folded keeps the officer's hand-made note
and the #4230 deploy note's list.

**Deploy, the switch window and rollback.** No schema change and no
migration. Two limits hold wherever the older release runs beside rows the new
one wrote - during the blue/green switch window, and after a rollback:

- **The older release's worker cannot run a per-task hand-back row.** Its
  `readPaidAnotherWayCloseShare` matches no plain hand-back, so it refuses the
  row ("is not on this payment") and the row stays FAILED, with no note in
  Xero. Once the new release serves alone - after cutover, or after rolling
  forward again - re-queue those rows from the failed-operations panel
  (**Retry in background**); the new release raises each note, sized on its
  task.
- **The older release does not count a per-task hand-back's cash beside its
  note,** so on a payment with card refunds a card note it raises in that time
  can be closed as covered. Check such payments in Xero afterwards.

On rollback the older release folds a later hand-back again; notes already
raised per task stay valid in Xero and every reader still counts them through
their links.

**The card writers: #4312.** A refund request's card part, the webhook's
card-refund delta and a late capture's note were stopped here for the owner,
because none could be keyed and sized on a record of its own with the
per-record routes that existed: a card refund's `PaymentRefund` row names no
refund request, an approval whose card refund goes to the recovery queue has no
row when its note is queued, and sizing by capture would count again a refund an
older canonical note answered. The owner approved a blueprint on 24 Oct 2026,
built as the next section describes.

The nightly self-heal never reaches the branch: its list
(`getRefundsMissingXeroCreditNotes`) reads card payments only (#4022). Pinned
on real PostgreSQL by `xero-bt-per-refund-notes`, beside
`xero-bt-recount-handbacks` and `xero-bt-card-refund-notes`. The routes around
that filter - a payment whose source changes later, the other hand-back writers
and the repair tool's queue action - were traced for #4239 against `main @ 9f47c7783`
(25 Oct 2026), and none reached a card note then; no test enforces that
([`../reviews/2026-10-25-xero-self-heal-bank-hand-back-routes.md`](../reviews/2026-10-25-xero-self-heal-bank-hand-back-routes.md)).

### A card refund on a bank transfer gets its own note (#4312)

Owner decision, 24 Oct 2026 (`INV-ADDPAY-047`). On an `INTERNET_BANKING`
payment, a card refund - an edit's card capture refunded by an approved refund
request, a refund made in the Stripe dashboard, or a late capture's refund - gets
a Xero refund note of its own, keyed on its `PaymentRefund` row: the payload
names it (`cardRefundId`, its `stripeRefundId`), and the note answers the
refund's amount less what its own notes already cover
(`readCardRefundNoteShare`, read by the enqueue and the note's execution alike).
It never takes the payment's canonical pointer: its link is `perDelta`, like a
hand-back's own note (#4287). The note credits the payment's invoice, or for a
late capture its receipt, and settles as a card refund (`INV-PAY-101`). One key
serves the outbox row and Xero (`cardRefundNoteKey`: the refund, its own notes'
cover, and after a void the voided notes of its own, `INV-ADDPAY-041`), so two
writers asking for one refund at once collide on one row.

The charge-backed recovery preflight (#4359, `INV-PAY-145`) can now record a
refund before `charge.refunded` arrives. Both use
`queueRecordedCardRefundNotes` for the same late-capture, receipt and ordinary
refund-note routing. The first recorder queues the existing correction; the
later delivery deduplicates it. A dashboard hold does not adopt that refund as a
debt's answer or change its note's sizing.

**Who asks, and when** - each writer, where it first knows the refund
(`card-refund-own-note.ts`):

- **A refund request's approval** (`refund-requests/[id]`,
  `queueRefundRequestCardNotes`) asks for each refund its inline attempt made
  (the plan's `madeRefundId`s). What went to the recovery queue is asked for by
  the **recovery replay** as it makes each refund - on any outcome of that
  attempt, a refused or failing later slice included
  (`replayNotingEachRefund`, which reads each Stripe call's refunds as it
  returns or throws, so an error the replay raises afterwards - re-planning
  the row, say - cannot hide them), so a refund that did not exist at
  approval still gets its note. The approval records on its recovery row that
  it left the notes to the refunds: the row's Stripe key prefix, the one the
  replay sends under anyway (`notesEachRefund`). A row an older release wrote
  carries none - that approval queued the card part's note itself - and its
  replay asks for nothing (`refundRequestRecoveryNotesEachRefund`). On a card
  payment the approval's one per-delta note is unchanged.
- **`charge.refunded`** (`queueWebhookCardRefundNotes`) asks only for a refund
  its own sync is the first to record (`newlyCountedRefundIds`; such a refund
  also runs the late-capture checks when the refunded total did not move), sorted by the
  Stripe metadata every app door stamps (`cardRefundDoorOf`): a refund with
  none - made in the Stripe dashboard - gets its own note here, in full; a
  refund request's is left to its approval or replay; one the recovery replay
  sent again for a refund Stripe failed later never enters the delta (below);
  any other door's stays in the delta, queued as before, which converges on
  that door's own note.
- **Any other recovery replay** (`queueAnsweringRefundNotes`) asks for each
  refund it makes of a late capture - handed to the capture's note, as
  `charge.refunded` hands it - and each re-send the rule below notes on its
  own record.
- **A late capture's note** (`noteLateCaptureRefunds`) keeps its one ask per
  capture and splits it (`planLateCaptureCardNotes`): each refund made since the
  cutover is asked for on its own record, naming the capture, oldest first; the
  older refunds keep the capture's one note. A capture-wide note that already
  answers more than the older refunds takes the excess off the own asks, so no
  refund is noted twice.

**A refund sent again for one Stripe failed later (#4104).** The failed
refund keeps the note it took while it counted, and #4104 meant that note to
answer the money once it goes back. So the refund the recovery replay sends in
its place is sized less the failed refund's own notes
(`readFailedRefundsAnsweredBy`, in `readCardRefundNoteShare`): normally it
raises nothing.

- **Which refund answers a failure is the replay's own record, and nothing
  else.** The replay sends a slice for the failures it owes
  (`cardRefundSliceFailedRefundIds`: a row of its own's key,
  `card_refund_failed_later_<refund>`, or a re-planned slice's
  `failedRefundIds`) and, once Stripe answers, marks that slice with the
  refund Stripe made (`madeRefundId`, `refundPlanOrRetryRefusals` - on success
  as already beside a refusal). The mark is compare-and-set on the plan the
  attempt sent from, never on its hold of the row: Stripe's answer under the
  slice's key is a fact whoever holds the row, so a late attempt the reaper
  already moved to FAILED still marks it, while a re-plan in between changes
  the plan and wins. That refund
  answers the slice's failures (`cardRefundFailuresAnsweredBy`). No charge,
  amount or time is read: a refund no slice is marked with - one made in the
  Stripe dashboard, whenever - answers nothing and is noted in full. So a
  dashboard refund made while the row still waits, and the replay's re-send
  after it, are two refunds with two notes' worth of credit: $80 in Xero for
  $80 refunded (the member was paid twice, #4359).
- **A re-send Stripe failed too passes on what it answered.** The slice marked
  with it lists its own failures, which join the next re-send's answer; a slice
  re-planned while its row is open lists the failed re-send beside the earlier
  failures instead. Each failure is listed on one slice, so its note answers
  one refund.
- **One rule, both writers.** A re-send is noted on its own record when one of
  its failures was (`ownNoted`); when none was, their fold in the canonical
  note answers it and it is noted nowhere. It never enters the canonical delta,
  whose payment-wide gap would hand it another refund's share. The replay asks
  once it has marked the slice; `charge.refunded` asks the same rule for a
  marked one. One it records before the mark - Stripe's answer reached the
  webhook first - is known by the unmarked re-send it could answer
  (`pairResendRecordedFirst`): a slice sent for failures, on its charge for its
  amount, of a row whose runner sends exactly its metadata
  (`carriesCardRefundOperationMetadata`), raised before it. A row that will
  replay the slice is left to: the retry reads the same refund back under the
  same key, marks and asks. A dead row is never replayed, so its one such
  slice is marked there and the rule applied. A failed-later row's refund also
  says so in its metadata (`CARD_REFUND_FAILED_LATER_REASON`), and is never
  the delta even when no slice is found.

Late captures keep their capture's sizing.

**Never for a historical refund.** Only a refund Stripe made since the cutover
marker migration finished on the install
(`20261122010000_bt_card_refund_notes_cutover`, a `SELECT 1`;
`madeSinceCardRefundNoteCutover`) qualifies, read again when the note runs; if
the marker never finished, none does, and the approval takes the payment's one
note for its card part and marks no recovery row (`notesEachCardRefund`), as
before. A refund made before it keeps what an older release gave it - the
canonical note, a fold, or the officer's hand-made note - and stays on the #4230
deploy note's list. The marker's own finish is the cutover
(`readMigrationFinishedAt`): rolled back and applied again, it moves to the new
finish; dropped by a squash, every refund reads as made before it
([marker migrations](../BLUE_GREEN_MIGRATION_POLICY.md#marker-migrations-are-never-squashed)).

**Readers.** No new term anywhere. The coverage sum, the gap reader and the
inbound recount count the note through its link, so a payment whose refunds all
have notes shows nothing uncovered, the #4162 floor raises no alert once each
note's own Xero event is reconciled, and the deploy note does not list it. The
card refund is cash evidence through its row (`resolveStripeCashRefundEvidence`)
and its note is coverage, so the hand-back cash reader (#4287,
`readPaidAnotherWayCash`) neither counts it nor is squeezed by it. A voided card
note goes to a person on Stuck States (`card-refund`) and is never matched by
amount to a bank refund and undone (`bank-refund-void-scan.ts`).

**Locks.** Enqueued outside any transaction, as these writers' notes always
were; the collision on one row is the outbox's partial unique index on an
active correlation key. No Payment row lock is taken (nothing here writes the
Payment row) and no new advisory key.

**Deploy, the switch window and rollback.** No schema change; one marker
migration. A card refund's own row carries no watermark, so a previous
release's worker - in the switch window, or after a rollback - runs it as the
one note it would have folded into: closed as covered when the payment has its
canonical note, else raised for the refund's amount as that note. Either way the
older release folds again; notes already raised per refund stay valid and are
still counted through their links, and its rewrite of the row's payload drops
`cardRefundId` but not the key, so the row is still found as the refund's own
(`cardRefundNoteRowsWhere`, `cardRefundIdOfNoteRow`). UPGRADING carries the
read-only query that lists the late-captured payments' refunds made while the
previous version served, from the `PaymentRefund` rows, each with the note of
its own this release raised or may still raise, or with none yet.

Stated limits:

- **The switch window, and any period after a rollback.** A late-capture refund
  the previous release recorded after the marker finished, and folded, can be
  asked for again by that capture's note under this release (a credit-back, or a
  later refund of the same capture) and given a note of its own, beside any
  note an officer raised by hand: nothing here records a hand-raised note, so
  it does not stop this release's. The UPGRADING query lists those refunds, run
  with the time this release last began serving alone - with no row yet until
  the next event asks for the capture, and leaving out a failed row a retry
  already raised - and the officer voids a hand-raised duplicate once the app's
  note is in Xero.
- **A refund appeal's card part waiting in the recovery queue when the previous
  release takes over** - after a rollback, or while it still runs the recovery
  job during the switch - gets no note: this release's approval left the note to
  the refund, and the previous release's replay raises none. The #4230 deploy
  note's query lists the payment for a note by hand.
- **A dashboard refund that settles a row Stripe gave up on is noted in
  full.** A re-send that failed too is owed by a row raised dead
  (`raised-dead`), which is never sent again; the treasurer is told to pay the
  member another way and close it as "Paid another way", whose note is sized
  against the failed refund's card note. A refund made in the Stripe dashboard
  instead is linked to nothing the app made, so it gets its own note and the
  failed refund's note still stands: Xero credits that amount twice until an
  officer voids one (owner decision, 25 Oct 2026). #4361 plans the automated
  design for this family of cases, #4359 included.
- **A re-send whose final attempt loses its answer after `charge.refunded`
  left it to that attempt is noted by nobody.** The webhook defers to a row
  still mid-attempt; when that attempt's answer is lost (a timeout, a crash the
  reaper finds) and its retries are spent, no writer reads the refund again,
  and no refund row stores the slice's key or Stripe metadata to pair it from.
  So too a re-send that several dead rows' slices could each be, and one that
  a live row's slice and a dead row's could each be: it is left to the live
  row's replay, which marks its slice with the refund it makes itself, so when
  it was the dead row's it is marked by nobody (the webhook logs both). It is
  usually money-neutral in Xero: the failed refund's own note already answers
  it. Where it is not - the failure's note was partial or voided - it surfaces
  only when a note on that payment next changes in Xero. #4361's stage 3
  (exact answers) closes it.
- **A voided failure note is not asked again.** When Xero voids the note of a
  refund Stripe failed later, the re-send it answered was sized less it, and
  nothing asks for the difference: Stuck States lists the void (`card-refund`)
  and its copy tells the officer to check whether the re-send has a note of its
  own for its full amount, and raise what is missing by hand.
- **A crash after Stripe answered and before the note was queued** loses the
  note, as it always did; the #4162 floor's alert and the deploy note find it.

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
non-replayable), the health snapshot lists paid bookings missing invoices
(decided by the one invoice-evidence rule in `xero-booking-invoice-evidence.ts`
— the payment's stored invoice id or an active `PRIMARY_INVOICE` link — read in
its set form, never by the invoice operation's status, so a create that failed
after Xero accepted the invoice is not listed, and a booking is listed only
when its records hold neither; #3001/#3467) and
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
checker exists to surface, cf. the #1547 alert-only rule). The checker stays
that way. The one narrow exception to "warn, don't correct" lives elsewhere:
a credit note spent in Xero outside the app converges the ledger from the
allocation worker (owner decision, 17 Oct 2026; see "A credit note spent
outside the app" below).

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

  A guest holding a night whose price is **not known** (`BookingGuestNight.priceCents`
  is `NULL` — a night a parked edit committed without valuing, #3170) has their
  per-night detail dropped for the replay, and is replayed on the whole-stay
  legacy path instead. That is not a shortcut: it is what `buildInvoiceLineItems`
  itself now does for such a guest, and this audit's whole promise is that it
  replays the builder. Valuing an unknown night at zero would have reported a
  drift figure that is not the drift.

  It is a **diagnostic only**: zero live-provider calls, no transactions, no
  mutations — it issues only `booking.findMany` +
  `groupBookingSettlement.findMany` reads (cursor-paginated). Run it against a
  **non-production copy** of the database:

  ```bash
  DATABASE_URL='postgresql://user:pass@host:5432/scratch_copy' \
    pnpm run xero:audit-invoice-rounding --issued-before 2026-07-04
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
scanned. The entrance-fee builder emits single `quantity: 1` exact-cent lines
and cannot drift, so it is out of scope by construction. Since #3530 the
supplementary and modification-credit-note builders may carry itemised
`quantity: n` lines, but each is a stored line whose money is
`sign × unitCents × quantity` by the parser's rule, and a set that does not sum
to the document's figure is refused as a whole (`INV-MOD-058`) — so those
documents reconcile to the cent by construction rather than by audit.

### Stored promotion build-up on a booking invoice (#3277)

The per-booking invoice keeps its established line shape: gross stored
guest/night lines from `buildInvoiceLineItems`, followed by one booking-level
signed promotion line. Before a non-zero promotion line is sent, the create path
loads the canonical recorded build-up and verifies its aggregate against
`Booking.promoAdjustmentCents`. A byte-identical recorded aggregate is sourced
as `STORED`; missing history or a disagreement uses the existing headline under
an explicit compatibility fallback, so the invoice amount does not change. The
source, reason, stored cents and current cents are recorded in the existing
`XeroSyncOperation.requestPayload`; no provider call is moved into a database
transaction.

This verification is deliberately booking-wide. Inexact provenance on one
night does not prevent a reconciling aggregate promotion line from being
verified. It does not change group-settlement invoice totals; the combined
group invoice carries each child's promotion line since #3642.

### One promotion line per promo code (#3828, `INV-MONEY-040`)

A booking may carry several promo codes (#3492), and the treasurer reconciles
each on its own line. `xero-promo-adjustment-lines.ts` plans the promotion
lines of a per-booking invoice and of each group-settlement child:

- **One code, or none:** the single line, unchanged in description, `taxType`,
  quantity, signed amount, coding and operation payload.
- **Several codes:** one `Promo adjustment - CODE` line per code with a
  non-zero adjustment, in the booker's order, each coded by
  `resolvePromoLineCodes` for its own code, at that redemption's recorded
  build-up. The operation's `requestPayload.promoLines` records the split.
- **Fallback:** when a code's rows do not reconcile to its redemption
  (`CODE_BUILDUP_NOT_KNOWN`) or the codes do not sum to the verified aggregate
  (`CODE_LINES_DO_NOT_SUM`), one aggregate `Promo adjustment - A, B` line at the
  generic promotion coding, with the reason in `promoLines`. The invoice total
  never depends on the split.

The invoice-update path passes every line whose description starts
`Promo adjustment` through untouched, so a several-code invoice keeps all its
promotion lines. Edit documents code each stored `PROMO_DELTA` by the code it
names (`INV-MOD-058`); a code the edit released is looked up by code. A
several-code edit whose per-code changes do not add up stores one line naming
no code, coded generically. Where the booking held several codes before the
edit, each line also records them (`codesBefore`), so a booking that lost every
code is still coded per line once the released redemptions are deleted; a lone
line without it on a booking with no code left is coded generically, as a
one-code booking's removal always was (`INV-MONEY-040`).

Stage 4 (#3278, `INV-MONEY-031`) also derives the complete booking-money
reconciliation state from that same coherent booking snapshot before provider
authentication. The state and every ordered reason are retained only in
`XeroSyncOperation.requestPayload` as reconciliation evidence. The object sent
to Xero still contains the established invoice lines and no additional field;
the classifier neither changes an amount nor moves a provider call into a
database transaction. Group-settlement line shape remains outside Stage 4.

That evidence is recorded under two separate keys, because an operation can be
run twice and the two runs observe different things. `moneyReconciliation` is
the state at the moment the operation raised its invoice. When a later run of
the same operation finds the invoice already there, it records what it sees
under `moneyReconciliationOnReplay` instead and leaves the raise-time verdict
untouched — a retry months later must not be able to restate, or to erase, what
was true when the money was invoiced.

### The change fee on a booking's primary invoice (#3750, `INV-PAY-119`)

The change fee recorded on a booking's payment (`recordedChangeFeeCents`) is
the one figure the pay steps collect and the primary invoice bills, in full,
on the one change-fee line (`changeFeeLineItem`). In full because no other
document can have carried it first: an edit's supplementary invoice or credit
note is raised only against an issued primary invoice, and no booking-payment
writer clears that link once set. The combined group invoice bills each
joiner's recorded fee the same way, and the guest-narration merge on an
invoice update never relabels the fee line.

The gap is an invoice built before the booking last changed — an edit
committed while the create was in flight, or a lost response replayed under the
same idempotency key, which returns the original invoice
(`xero-primary-invoice-fee-gap.ts`). Since #3980 it is measured on the
booking's whole worth (`bookingWorthCents`: `finalPriceCents` plus the
recorded fee), not its fee alone:

- **Every writer that settles against the primary invoice claims it**
  (`INV-PAY-136`). A writer that changes the booking's worth and read no
  invoice link raises no document of its own, so it confirms the link is still
  unset with one guarded write on the payment row (`writeEditOnPayment`,
  `booking-primary-invoice-claim.ts`): `updateMany where {id, xeroInvoiceId:
  null}`, carrying its fee increment where it records one and an increment of
  0 otherwise. A count other than 1 refuses the whole change with
  `PrimaryInvoiceRaisedDuringEditError` (409, "please try again"; a
  finished-stay correction says "approve it again"). The error is the
  transient race refusal, so a guest-consent decline or expiry rolls back
  rather than ending BLOCKED. On the retry the change reads the link and
  adjusts the invoice like any edit. The writers: the date change, batch edit
  (and the finished-stay correction through it), guest removal and guest
  acceptance re-price, all through `applyPaymentAdjustments`; the guests
  route's own settle step; the review price re-base, claiming against the
  review closure's own read of the link, so a link saved between the two reads
  refuses the closure; and the school pending-adult naming. The edit doors mark their history row
  `primaryInvoiceSettlement`, with how the edit settled (refund, credit,
  applied credit given back, unpaid-ask offset) and what it asked the card for.
  The credit election changes no price, so it does not claim.
- **Measured at the link.** The create reads the booking and the edits already
  marked, in one REPEATABLE READ transaction (`xero-primary-invoice-read.ts`),
  so the worth it records as built from and the lines it sends describe the
  same booking even if an edit commits between the reads. It saves the
  payment's link with a write guarded on the link being unset and, in the same
  transaction, writes onto its operation's payload what the returned invoice
  billed (its fee lines and its total), the fee the payment held, read back
  under the row lock, the booking's worth read after the row write, the edits
  marked at build, and the Stripe cash recorded against the invoice
  (`primaryInvoiceCashCents`), computed once. The row lock orders the save
  against every claim: a claim made first is in the worth read back, one made
  after is refused. A second save of the SAME invoice (a run reset from stale
  RUNNING and retried, or two runs at once) finds the link already set, stores
  nothing and re-checks from the first save's figures, so an edit properly
  billed against the linked invoice is never measured into a gap. Where no
  figures are stored for it - another writer linked the same invoice first -
  this run's own figures are measured against the worth now, and any gap is a
  task for the treasurer, never billed: edits after that link may have
  adjusted the invoice themselves.
- **The gap is what moved** (`primaryInvoiceWorthGap`): the worth at the link
  less the worth built from, plus the total sent less the total Xero billed.
  The first term is an edit that landed mid-create; the second a replay
  handed back the original invoice. Both totals include the promotion lines.
  A booking whose lines already price it differently from its headline
  (`reconcileBookingMoney`) shows no gap from that, since it is not a race. A
  record written before #3980 is measured on its fee alone.
- **A shortfall is billed on a supplementary invoice**
  (`xero-primary-invoice-gap-anchors.ts`). It is anchored only on an edit that
  landed while the create was in flight: a marked edit the create's snapshot
  did not hold and, where the create's operation replays an earlier one, made
  after that earlier one. An edit the snapshot held is already on the
  invoice's lines; anchoring on it would bill a re-base's or a school naming's
  money (writers that mark nothing) as that old edit's. Of those, the newest
  that moved money (a price or fee change) and has no edit-financial review is
  the anchor - a reviewed edit's own review charge is anchored on it - or a
  correction that routed its fee there (`feeOnPrimaryInvoice`, #3955); none of
  those raised a document of its own. No such edit: the treasurer's task. Its
  lines are the fee recorded since the build as a change fee and the rest as
  price, signed as an edit's are (#1356). It is raised unpaid, like any
  edit's supplementary invoice, unless a captured Stripe payment holds it: the
  primary's Stripe payment is capped (`primaryInvoiceStripeCashCents`) so the
  applied credit the card settle then
  allocates still fits on it — the allocation engine's own ledger figure
  (`cardSettleAppliedCreditCents`, `unallocatedAppliedCents`), never the
  payment's `creditAppliedCents` mirror, which is only the settle's gate. The
  cash left over after the stored `primaryInvoiceCashCents` must cover the
  shortfall. Captured cash that neither invoice takes is logged with both
  figures and recorded on the create's operation (`primaryInvoiceCashShortfall`).
  Any enqueue outcome other than a fresh operation is logged as an error. A
  later reduction that retires the anchor's unpaid card ask reads its money as
  already invoiced, as it reads any ask an edit made with no invoice yet
  (`unpaid-ask-billing-evidence.ts`): its offset is credited by note and never
  invoiced again, since the gap invoice stays open and is not the parked
  invoice the retire cancels.
- **An overcharge is a Xero Operations task** (owner, 21 Oct 2026). An invoice
  billing more than the booking was worth at its link, or a shortfall no
  qualifying marked edit anchors, is not corrected automatically: no credit
  note is raised. The check writes one `XeroSyncOperation`
  (`xero-primary-invoice-review-task.ts`): `entityType` `REVIEW`,
  `operationType` `PRIMARY_INVOICE_WORTH_GAP`, on the booking, FAILED and not
  replayable, with the gap and figures on its payload and a plain-English,
  redacted `lastErrorMessage`. An overcharge's message and figures say how the
  reductions that landed mid-create (marked since the create's snapshot) were
  settled - refund paid out, account credit, applied credit given back, unpaid
  ask taken off - so the treasurer accounts for the refund too; where none
  landed mid-create, they name no settlement. It shows in
  the panel as an active failure, Retry refuses it, and the treasurer closes it
  with **Resolve (fixed in Xero)** (`INV-INT-025`) once they have acted. Its own
  correlation key, one per booking, invoice and direction, means a re-run
  raises no second task and no invoice or credit-note query mistakes it for a
  document's operation. The booking-vs-Xero repair pass expects no invoice or
  note of a marked edit's own (`xero-booking-repair-classify.ts`), so it never
  raises one beside the task, nor says the invoice "already bills" an edit that
  landed mid-create.
- **Retry-safe.** A run that dies after saving the link is re-driven through
  the create's "invoice already exists" exit, which re-runs the check from the
  stored figures alone (`recheckPrimaryInvoiceWorthGap`). A shortfall already
  queued on one of the anchors is not queued again, no other edit's queued
  figure is raised, and a task already raised is found, not raised again. A
  run that dies after recording its Stripe payment but before saving the link
  re-creates under the same keys; where the invoice Xero returns already
  carries that payment (found by its `Stripe <intent>` reference) and the cap
  reaches zero, its `INVOICE_PAYMENT` link is recorded and its amount stored as the
  primary's cash, rather than the cash being skipped.
- **Repaired at the attempted payment.** When the Stripe payment write fails,
  the create ends PARTIAL, and the Xero Operations repair records the payment
  that create tried to write (`primaryInvoiceAttemptedCashCents`, stored in the
  same record), read through the same parser as the gap check
  (`xero-primary-invoice-fee-at-link.ts`, sized in
  `xero-partial-invoice-repair-amount.ts`). It never records the invoice total,
  which on a card booking with applied credit overstates the card cash and
  leaves the credit allocation nothing to settle (#4010), nor the stored
  `primaryInvoiceCashCents`, which is floored at an earlier unmatched payment.
  Older records fall back: stored cash before #4010, the total before #3955
  (no `primaryInvoiceBilledFee` record, or one without the cash figure). A
  zero repair amount on a non-zero invoice is reported as taken by applied
  credit, but that path is defensive and effectively unreachable today: every
  create that skips its payment records `paymentSkipped`, which refuses the
  repair.
- **Limits.** A card capture of the anchor edit's own ask is recorded against
  the gap invoice by the capture's own receipt (#3953, `INV-PAY-139`, the row
  above): the link save queues receipts for captures the primary's cash does
  not cover before the gap check, the gap invoice never pays itself from a
  capture with a receipt row, and the receipt records against the gap invoice
  where the capture's change is one it bills for. An edit on a booking with no payment row has nothing to claim;
  the create needs a payment row to run at all, and the edit is marked, so one
  that commits before the link is still in the worth read back. Only the
  create's save stores figures: the other writers that set the link (the
  inbound "invoice paid" match and its settle, the inbound payment's link, the
  reconcile mirror of a primary transaction's invoice, an operator's field
  repair) take the same row, so a later claim is refused, but an edit that
  claimed just before one of them is not measured. An invoice linked without
  stored figures (before #3955, or by those writers) is not checked; the retry
  warns when its payment records a fee. A record from before #3980 is checked
  for its fee only.

## Booking-page supplementary invoice observations (#4047)

The booking page observes issued supplementary invoices through
`booking-supplementary-invoice-identities.ts` and
`xero-invoice-observation-read.ts`. Discovery covers Booking, BookingModification
and eligible financial-review second asks on ManualRefundTask, using canonical
payload and repair recovery rules. Replayed links are deduplicated. Card receipts
and the organiser's combined invoice never become another member bank demand.
The clearing selector remains narrower because its note does not cover second asks.

Each action authenticates through the existing Xero client, then makes at most
one native JSON GET for 20 scoped invoice IDs. The accounting deadline is five
seconds, active through body consumption via AbortController, with no automatic
retry. Authentication can refresh tokens or wait on its existing lease outside
that deadline; this section streams separately from the ordinary booking content.
`callXeroApi` retains metering and daily/outage gates, and the per-actor
`booking-supplementary-observation` key uses the booking-query limiter.

Amounts use `exactProviderAmountToCents` (`INV-MONEY-001`, `INV-MONEY-003`),
finite non-negative raw input and safe integer cents. Settlement requires raw
AmountDue exactly zero. Missing identities, malformed/contradictory status,
unissued instruments or positive amounts that normalise to zero remain unknown.
Void/deletion retires an instrument, not the debt. All observations are request-local,
dated and shown individually; no cross-batch current total or durable balance is written.

User continuations use an authenticated actor/booking/tenant/revision-bound signed
cursor and reauthorize every action. Current audience, ownership, lifecycle,
card ask, invoice population, module and tenant are re-read around provider waits.
Cancelled/bumped/deleted bookings and unauthorised audiences make no provider read.
Payment routes retain their final guards. No settlement, reconciliation, new lock
key, schema change, historical operation or ledger reader cutover is introduced
(`INV-INT-003`, `INV-LOCK-001`, `INV-LOCK-002`, `INV-LOCK-003`).

## OAuth and token lifecycle (supporting flow)

1. Admin hits `/api/admin/xero/connect` → consent URL with a signed state
   cookie (`xero-oauth-state`).
2. Xero redirects to `/api/admin/xero/callback` → `handleXeroCallback`
   validates state, exchanges the code, and `saveXeroTokens` stores the token
   set, recorded as the connecting administrator's act (#3454).
3. Every worker call goes through `getAuthenticatedXeroClient`: if the access
   token is near expiry it claims the refresh lease
   (`refreshInProgressUntil`); the winner refreshes and persists, losers wait
   out the lease and re-read. This keeps concurrency from burning refresh
   tokens. A refresh is recorded as the named `xero-token-refresh` job.
4. `/api/admin/xero/disconnect` revokes and deletes tokens, recorded as the
   administrator's act; workers then short-circuit via `isXeroConnected()` (cron
   records SKIPPED). Saving a Xero client id or secret deletes the tokens too
   (the verify-reset), in the **same transaction** as the credential write.

### Where the tokens are stored (#3454, #3806)

**The tokens** are one row of the encrypted integration-credential store,
provider `xero-oauth`, key `token-set`: a JSON token set encrypted under the
store's own key derivation. Every write therefore names its actor, commits its
`integration.credential.*` audit row in the same transaction, and declares what
it expected to find (`INV-PRIV-020`). Since #3806 R2 it is the only copy read:
a connection whose store copy is missing, unreadable or malformed, or names a
different organisation from the connection, reads as "reconnect required",
never as connected. The last case is a copy a release from before #3454 left
behind when it reconnected to another organisation: it writes only
`XeroToken`, so the trigger moves the connection and the store keeps the old
grant.

**The connection and the refresh lease** are the one `XeroConnection` row: no
row means not connected. It holds the tenant id, the access token's expiry and
`refreshInProgressUntil`, and no token, ciphertext or key. Every reader that
needs only the tenant or expiry (`isXeroConnected`, the health check, the setup
provider test, setup readiness, the stored financial-year resolution, config
transfer's tenant stamp, the admin cache key) asks `readXeroConnection`
(`src/lib/xero-connection.ts`), so they all read the same row. Whether the
tokens behind it are usable is the token store's `getXeroTokenReadability`.

**The old `XeroToken` row is kept for the previous release (#3454), until R3.**
A blue-green deploy runs the previous release beside this one, and after a
rollback it runs alone. It reads, refreshes, connects and disconnects only
through `XeroToken`, treats no row as not connected, and reads the store copy
only while the store's `mirror` fingerprint matches a hash of the row's id and
ciphertext. Xero refresh tokens rotate — each is spendable once — so if the
two releases disagreed about the current tokens, one side would end up on a
spent refresh token and the club would have to reconnect. Four rules prevent
that:

- **The row stays present while connected**, with `tenantId` and `expiresAt`
  current, written in the same transaction as every connect and refresh.
- **Two leases, claimed together.** A refresh claims
  `XeroToken.refreshInProgressUntil` first — the lease the previous release
  claims, so the two releases compete for one refresh token — and then
  `XeroConnection.refreshInProgressUntil`, the lease that stays when
  `XeroToken` goes. Losing either rolls the other back. The claim takes the
  leases FIRST and reads the store copy after, under those rows' locks, so the
  version a refresh compares-and-sets on belongs to the tokens it hands over. A
  refresh's save is fenced three times: both lease-guarded updates, and the
  compare-and-set. Before calling Xero, the refresh checks that its save can
  succeed (the auth-secret capture gate) and refuses without spending the token
  if not.
- **No ciphertext is written or read.** The schema `@ignore`s
  `XeroToken.accessToken` and `refreshToken`, so the client cannot name them.
  A connect replaces the row with a fresh one whose ciphertext the database
  fills with `''`, and records the fingerprint of exactly that; a refresh leaves
  the row's ciphertext alone and carries the fingerprint it read under the
  lease. The previous release therefore keeps reading the store copy. Its own
  writes rewrite both copies together (the #3454 dual-write), so they match too.
- **A trigger keeps `XeroConnection` in step with `XeroToken`.** After every
  insert, update, delete or truncate of `XeroToken`, a statement trigger copies
  the most recently written row's tenant and expiry (`updatedAt`, then `id`,
  descending — `XERO_TOKEN_ROW_ORDER`) into `XeroConnection`, or deletes it when
  no row is left. It never touches the lease, and writes nothing when neither
  value changed. It is one statement reading one snapshot, so a write that
  commits while it waits for its lock is never written back stale. So the
  previous release's connect, refresh, reconnect and disconnect reach this
  release too. Every writer touches `XeroToken` before `XeroConnection`, the
  order the trigger fixes (CONCURRENCY_AND_LOCKING.md). Two connects at the same
  moment can leave two `XeroToken` rows; every reader takes the newest, and the
  next connect or disconnect deletes both.

If the auth secret no longer passes the capture gate, the refresh refuses before
spending the token, alerts as "Token Store Unavailable", and the status page
reports Xero as not connected rather than "Connected".

**The token copy is never served from the credential store's cache.** That
cache holds a provider's rows for up to 45 seconds; a refresh token another
container rotated a moment ago would be dead in it. The token store reads the
row through the database on its own (or the lease transaction's) client.

**The wrapped token key is retired.** It encrypted only the `XeroToken`
ciphertext. This release never generates or reads it, and its next connect,
disconnect or verify-reset deletes a leftover `xero` / `token_key` row. The
previous release, while it still runs, generates a new one when it writes the
tokens and finds none, audited as `xero-token-key-generation`.

**Upgrading to R2.** A connection a #3454 release has refreshed since any
older release last ran carries a current store copy and keeps working. A
connection on a release without #3454 (every tagged release so far) has no
store copy, and one an older release refreshed after #3454 had stored a copy
holds a spent refresh token there; either needs a reconnect, or a refresh on a
#3454 build first. [UPGRADING.md](../UPGRADING.md) has the paths and the pre-deploy check.
Until R3, `XeroToken` may still hold the last ciphertext the previous release
wrote; after the first refresh here that refresh token has been spent. A
rollback past #3454, once R2 has connected, refreshed or disconnected, needs a
reconnect there.

**Retiring `XeroToken` (R3, #3806)** comes after R2 has fully deployed: first a
release that stops writing `XeroToken` and drops the trigger, then the
`phase=contract` drop of the table.

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
   the name and, since #2261, the deep-link short code). Since **#3633** the
   route also returns the organisation's **base currency**, and the step warns
   under the confirmation when it differs from the club's currency. The connect route
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

**Cursor write order (#4014).** Cursor writes go out one at a time, all as
keepalive requests, and only the newest write that waited is sent next. Two
independent writes could reach the server in either order. The row keeps the
last one committed, so an older step could overwrite a newer one, and the
wizard then came back from OAuth on Credentials instead of Connect. A write
still waiting when the page is left, as it is for OAuth, goes out at once as a
keepalive request, so the newest position is not lost; the next page may still
read the cursor before that write commits.

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
| `finance/_components/finance-dashboard-client.tsx` ("Open Xero reports") | `finance-dashboard-page/xero-reports-source-note.ts` (spread into the P&L and balance-sheet views' source notes) |

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
*not* the tenant GUID stored on the `XeroConnection` row. The GUID is not usable in a
Xero URL at all, so a link built from it would 404 — the reason every builder
takes an optional `shortCode` and degrades to a session-scoped `go.xero.com`
path without it. Both forms are live URLs; the short code only decides whether
the admin lands in **this club's** organisation or in whichever organisation
their Xero session last used.

The short code is read only from Xero's `getOrganisations` response, so it is
surfaced on **`/api/admin/xero/organisation`** (alongside the org name and
financial-year-end month), behind `getXeroConnectedOrganisation`'s 12-hour
in-process cache. It is deliberately **not** on `/api/admin/xero/status`:
status is a pure connection-row read that every admin surface gating on Xero
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
two "Open Xero reports" source notes (rendered by `finance-dashboard-page/pnl-view.ts`
and `finance-dashboard-page/balance-sheet-views.ts`, each spreading the one link
built in `finance-dashboard-page/xero-reports-source-note.ts`) now resolve the
short code server-side like every other
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
avoid; the alternative (stamping the summary with the connected tenant id and
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

## Credit lots and the outside-spend marker (#4219, expand release)

A credit lot's remaining balance is its amount less the slices drawn from it
(`MemberCreditNoteAllocation`) and less credit written down because its Xero note
was spent outside the app. A written-down lot is recorded as a negative
`ADMIN_ADJUSTMENT` row for the member stamped with the note, and the row that
releases the booking's applied credit is a positive `BOOKING_APPLIED` row. Both
carry `MemberCredit.outsideSpendConvergedAt`, which says the row is **not a
spendable lot**: a positive row is otherwise the member's own money, and the
planner would mint a Xero note for it. `src/lib/xero-credit-note-write-down.ts` is
the one definition; `gatherAppliedCreditLots`, the funding-lot finder and the
slice-fit check read through it, and `xero-applied-credit-slice-lookup.ts` holds
the two lookups they share. A note's write-down is taken once, from its oldest lot
first, not from every lot stamped with the note; the inbound repair never rewrites a
marked row's description.

This is the **expand release**: the readers ship first and nothing writes the
marker yet, so every row is unmarked and behaviour is unchanged. The writer, the
credit-note convergence, is a later release that must not be deployed until this
one is live and the previous app version has drained, so a previous version never
meets a marked row it cannot read.

## A credit note spent outside the app (#4218, #4219)

A treasurer can use a member's credit note in Xero directly (an offset, a payment
made against it, a manual allocation) without the app being told. For this one
fact, a credit note's remaining balance, **Xero's figure takes precedence over the
local ledger** (owner decision, 17 Oct 2026); everything else in the credit ledger
keeps the local ledger as its source of truth.

- **Signal.** The allocation worker asks Xero to allocate the note; Xero refuses it
  as larger than the note's remaining credit; a read of the note then confirms the
  refusal (the note shows less than the slice, and this invoice holds no
  allocation of the app's own that explains it). That is
  `CREDIT_NOTE_SPENT_OUTSIDE_APP` (owner decision, 19 Oct 2026: Xero's refusal,
  confirmed by a read, is the trigger, never a read made beforehand, which can lag
  an edit). A refusal the read cannot confirm is never acted on.
- **What counts as outside.** Decided from Xero's own list of what was done to the
  note, in that same read, never inferred from the app's ledger. An allocation to
  an invoice the app has a record of (a `XeroObjectLink` or a payment's
  `xeroInvoiceId`) or a payment the app made is the app's own, and the inbound sync
  mirrors it. Only an allocation to an invoice, and a payment, that the app has no
  record of is an outside spend. The routine writes down the lesser of the slice
  and the outside spend not yet written down for the note.
- **Converge** (`convergeCreditNoteSpentOutsideApp`, called by the worker, which
  then plans again so the booking's other slices still allocate). In one
  transaction, global lock then the member's credit-ledger lock, all state
  re-read under them:
  - a negative `ADMIN_ADJUSTMENT` row stamped with the note's id writes the lot
    down, and a positive `BOOKING_APPLIED` row releases the booking's applied
    credit by the same amount. The member's balance does not move. Both carry
    `MemberCredit.outsideSpendConvergedAt`: the marker says the row is **not a
    spendable lot** (a positive row is otherwise the member's own money, and the
    planner would mint a Xero note for it). `gatherAppliedCreditLots`, the
    funding-lot finder and the slice-fit check all read through
    `xero-credit-note-write-down.ts`, which defines the rows;
  - the booking's slice for that lot shrinks, or is deleted, so every reader that
    totals a booking's allocations sees only what Xero holds. When nothing is left
    to allocate the booking's unstamped rows are stamped with the note, as the
    engine stamps them after allocating, so the release does not net a later
    application to the booking;
  - `Payment.creditAppliedCents` is re-derived and the booking-ledger credits
    synced; the slice's failed allocation rows are closed through the resolution
    fields (reason `CREDIT_SPENT_OUTSIDE_APP`, no member id) and marked
    non-replayable; one `xero`-category audit row names the member as its subject,
    not its actor.
- **No Xero write, no money moves.** The member owes the released amount on the
  booking's invoice, which Xero's receivable already shows. The app's own booking
  page does not show a balance for a booking whose payment succeeded, so until the
  email lands the treasurer collects it from Xero. An automatic pay-link
  email to collect it is decided (owner, 17 Oct 2026) and ships as its own change
  after this one (#4253), settling the booking's existing open invoice.
- **Fails closed.** A cancelled booking, an owner who changed, no single slice for
  the note, a slice Xero already holds, a note shared by several lots, or an
  outside spend larger than the lot: nothing is written and the original failure
  stands. An unfinished deallocation of the booking's applied credit makes the
  worker wait (the existing busy path).
- **The evidence is read once, before the locks.** Xero's list and the note's total
  and remaining credit must agree (the list accounts for exactly what the note has
  lost, ignoring entries Xero marks deleted), or nothing is written. If the spend is
  reversed in the instant between that read and the transaction, credit Xero gave
  back is written down; it is capped by the booking's slice and is the inbound
  mirror's to restore.
- **Idempotent.** The write-down counts in the next calculation, so a repeat finds
  nothing missing; a concurrent run that lost the race finds the booking already
  converged, or its slice already shrunk below what was refused, and plans again.
- **Reversed or unnoticed spends** are the inbound mirror's, below: it restores a
  lot Xero gave back and writes down a spend that no booking tried to use.

## The inbound credit-note mirror (#4270)

The converge acts when Xero **refuses** an allocation the app tried. The mirror acts
on what Xero **shows**, so credit that no booking has claimed yet is not offered to a
member after it is gone, and credit Xero gives back is not lost. It writes only the
credit ledger, never Xero, and sends the member no email (owner decisions, 17 and 24
Oct 2026).

- **Where it runs.** Last in `reconcileXeroCreditNote` (the webhook path, reusing the
  note that handler already read, after the links and repairs it writes), and in a
  backstop sweep, the `credit-note-mirror` Xero cron task, run in the inbound
  reconcile's 15-minute slot. The webhook hook never fails the event: an error is
  logged and the sweep tries again.
- **One comparator.** `xero-credit-note-outside-spend.ts` holds the evidence parsers
  (`xeroAllocationsOf`, `xeroPaymentsOf`), the explained-shortfall rail
  (`spendIsExplained`: the list must equal the note's total less its remaining
  credit) and `outsideSpendCents`. The converge, the mirror and the Failures view
  share it, so they cannot disagree about what counts as outside.
- **Target state, not a delta.** With `O` the outside spend, `W` the net written down
  for the note (write-downs less restores), `D = min(O, lot)` and `delta = D - W`
  (`xero-credit-note-mirror-plan.ts`): a positive delta writes down at most the
  **free** part of the lot (not drawn by a booking's slice, not already written down,
  and not more than the member's balance, so it never goes below zero); a negative
  delta restores `-delta`, and never more than `W`. Credit already planned onto a
  booking is left to the converge, which also releases the booking, and the mirror's
  audit row records it as `leftForAllocationCents`. A replayed or out-of-order event
  cannot drift the ledger because the target is recomputed from Xero's list each time.
- **Rows.** A negative `ADMIN_ADJUSTMENT` row (write-down) or a positive one
  (restore), stamped with the note and marked `outsideSpendConvergedAt` like the
  converge's rows, so no reader treats either as a lot. `writtenDownCentsByCreditNote`
  returns the signed net, never below zero. One `xero`-category audit row per change
  (`xero.credit_note.outside_spend_mirrored`, `xero.credit_note.outside_spend_restored`),
  subject the member, no actor, committed in the same transaction; a no-op writes
  none. A restore's row names the bookings the converge released for the note, since
  the restore gives back the lot and not those bookings' applied credit.
- **One lot, one member, an active note.** The member is chosen before the transaction
  from the note's funding lot. A note that funds no lot is ignored (most events); one
  that funds several fails closed. A voided or deleted note is a different class of
  change: nothing is written and an error is logged for an officer.
- **Settled evidence.** The note's `UpdatedDateUTC` must be at least two minutes old,
  so an allocation or refund payment the app made and has not finished recording is
  not read as someone else's. A fresher note leaves a `RECHECK:<note>` row in
  `XeroSyncCursor`, which the sweep takes first on its next run. A missing or
  unreadable change time defers too. Credit drawn onto a booking whose allocation or
  deallocation is in flight (`PENDING` or `RUNNING`, or any deallocation fence) defers.
- **Locks.** The member's credit-ledger key only, never the global one: the mirror
  releases no booking's credit and moves no settlement money. See
  [CONCURRENCY_AND_LOCKING.md](../CONCURRENCY_AND_LOCKING.md#a-credit-note-spent-or-un-spent-in-xero-the-members-credit-ledger-only-4270).
- **The sweep** reads the population from the local ledger, never a Xero "modified
  since" cursor: notes funding a lot with credit not yet drawn or written down, or
  with a net write-down that could be restored. It reads at most 100 notes a run from
  a stored cursor (`SWEEP` row), stops after three failed reads in a row, and once a
  complete pass has run it does not start another for twelve hours (deferred rechecks
  are never throttled). Every read passes `armTransientBreaker: false` and respects a
  breaker armed elsewhere.
- **Kill switch.** A `XeroSyncCursor` row, `resourceType` `CREDIT_NOTE_OUTSIDE_SPEND_MIRROR`,
  `scope` `WRITES`, read live, so it takes effect on the next note with no deploy and
  no restart. While it exists (unless its metadata says `writesDisabled: false`) the
  mirror computes and logs what it would have written and writes nothing. Unset means
  writes are on.

  ```sql
  -- Switch the mirror's writes OFF.
  INSERT INTO "XeroSyncCursor" (id, "resourceType", scope, metadata, "createdAt", "updatedAt")
  VALUES (gen_random_uuid()::text, 'CREDIT_NOTE_OUTSIDE_SPEND_MIRROR', 'WRITES', '{"writesDisabled": true}', now(), now())
  ON CONFLICT ("resourceType", scope) DO UPDATE SET metadata = '{"writesDisabled": true}', "updatedAt" = now();

  -- Switch them back ON.
  DELETE FROM "XeroSyncCursor" WHERE "resourceType" = 'CREDIT_NOTE_OUTSIDE_SPEND_MIRROR' AND scope = 'WRITES';
  ```
- **Differences from the converge.** The converge refuses a spend larger than the lot
  (`unexplained-spend`); the mirror bounds it by the lot, since it works from the
  whole list. They agree on everything up to that point, in either order, and
  together write down exactly `D`.
- **Deploy order.** No migration. A version before #4251 (the converge and the net
  readers) reads a written-down lot as free again. Deploy after #4251 is live and its
  predecessor has drained or, if the two ship together, switch the writes off before
  the deploy and back on once the previous colour has stopped (UPGRADING).
- **Rollback.** Switch writes off and correct the note's evidence in Xero; the mirror
  restores the credit. Never offset a wrong write-down with a manual credit
  adjustment: it is a spendable credit with no note, so a fresh Xero note would be
  raised for it while the original still holds the credit.

## Card payment for credit released after an outside spend (#4253)

After a credit note is found spent outside the app (previous section), the booking's
applied credit shrinks and the booking owes the difference. The member is asked for it
once, by card, and Xero is told about the payment without a second invoice.

- **No new invoice.** The released amount already stands on the booking's own
  invoice (`Payment.xeroInvoiceId`). The request is written with
  `hadIssuedXeroInvoice: false`, so no supplementary invoice is raised for it.
- **Sizing reads Xero.** The amount is the smaller of the release, what the ledger
  shows owed and unasked, and the invoice's `AmountDue` from a live read. A paid
  invoice closes the request; an invoice that is not open (voided, draft, unreadable)
  retries and finally alerts, because the member does owe the money.
- **The payment is a sweep** (`credit-release-xero-payment.ts`). Each run re-derives
  from the booking's ask chain which captured card payments collected credit-release
  money (`planCreditReleasePayments`) and records that part with
  `createXeroPaymentForInvoice` against the booking's invoice, from the Stripe
  account, dated the day Stripe took it. The `XeroObjectLink` (role
  `CREDIT_RELEASE_PAYMENT`) is the done marker. An edit's own money stays on its
  supplementary invoice, so one card payment is recorded against two invoices.
- **One writer per capture.** The ordinary additional-capture receipt writer
  (`readCaptureRecorder`) stands down for a capture the sweep owns, and subtracts the
  sweep's share from one it shares with an edit, so the card payment is never recorded
  twice on the primary invoice.
- **It fails closed.** An invoice no longer open, owing less than the card took, a
  partly refunded capture, or a chain that cannot be traced records nothing and alerts
  the officers once a day; failed attempts are an hour apart and capped at five. A
  payment attempt that never finished is replayed under the same key (no balance
  read, Xero's key makes it safe) for twelve hours, then held for an officer.
- **Xero first closes the request.** An unpaid request that carries nothing, or that
  carried only earlier credit-release requests (all of it stands on the booking's invoice),
  is closed when Xero shows its invoice paid (`credit-release-ask-close.ts`), the seam the
  inbound credit mirror can feed. One that carried an edit's money stays open for a person.
  The money is written as bank cash.
- **Switch.** Raising requests starts off. Set the `XeroSyncCursor` row
  `resourceType = CREDIT_RELEASE_ASK`, `scope = WRITER`, `metadata = {"enabled": true}`
  once the previous deploy colour has drained; set `enabled` to anything else to stop
  new requests (ones already raised still finish). Only releases created after the
  row was made are asked, and once it is enabled do not roll back to the previous
  colour: it would not know these requests.
- **Bank transfer.** The request email can offer a bank transfer beside the card
  (`credit-release-bank-transfer.ts`). The app holds no account details: the club writes
  them in the `paymentRequest.bankTransfer.instructions` booking message (Admin > Booking
  messages) and the email quotes the booking's Xero invoice number as the reference. It is
  offered only when the request is all released credit and equals what Xero shows the
  invoice still owing as the email is built, so a transfer of it clears the invoice; with no
  details written, on a request an edit was merged into, or for any other amount, the email
  offers card only. Xero matching the transfer to the invoice shows it paid, which the closer
  above turns into a closed request, one that carried earlier released credit included. A
  transfer that leaves the invoice part-paid closes and resizes nothing: before each reminder
  the invoice is read again, and showing less owing than the request's released credit stops
  the automatic reminders and leaves one audit note for the officers (`INV-ADDPAY-049`,
  `INV-ADDPAY-051`).
- **Reminders and merged requests.** The member is emailed at once, then reminded every 7
  days, four reminders after the request, and the officers' queues chase after that
  (`INV-ADDPAY-048`). An edit
  made while a release request is unpaid merges into one request; the card payment is
  recorded against both invoices (the release's money by the sweep on the booking's
  invoice, the edit's own by its supplementary invoice), with no step in Xero.
- **Backlog.** Releases from before the writer switch are asked for in small batches by a
  second `XeroSyncCursor` row, `scope = BACKLOG`, `metadata = {"enabled": true, "perRun": 5}`
  (`perRun` optional, default 5, at most 25), which needs the writer on as well. Each batch
  writes one audit row, and each release is re-checked against the ledger and the invoice
  in Xero before anyone is asked, closing with an audit where nothing is owed
  (`INV-ADDPAY-050`). Set the bank details first, enable the writer once the previous
  colour has drained, then the backlog.

Rules: `INV-ADDPAY-045`, `INV-ADDPAY-046`, `INV-ADDPAY-048`, `INV-ADDPAY-049`, `INV-ADDPAY-050`, `INV-ADDPAY-051`.



## Organiser-paid bank-transfer extras (#4299)

A change to a place paid through the group's combined invoice bills the
organiser, including its late-change fee. `organiser-billing.ts` resolves the
settlement, combined invoice and organiser; contact resolution runs outside the
edit transaction. Every edit door calls `queueOrganiserExtraForChange` after
creating its change history, inside its existing global money claim. The
supplementary invoice uses that change's existing anchor lock, so after-commit
kicks and historical repair find the same invoice. Its link records the payer,
combined invoice and signed price/fee figures. Missing combined-invoice records
refuse the edit; disconnected Xero leaves an unpaid queued invoice. The joiner's
payment has no primary invoice and its history is not marked as settling one.

`organiser-extra-state` and `organiser-extra-netting` reserve unpaid releases
before policy refunds. `ORGANISER_EXTRA_ADJUSTMENT` operations execute voids or
credit notes outside the money transaction. A part-paid invoice receives an
allocated note for the unpaid portion. Cash pays fees first; paid price refunds
follow policy, with notes split between extra and combined invoices. Refund
notes wait for their bank-transfer hand-back to complete and for the target
invoice to have nothing due; a delayed waiver keeps payout pending. A settled invoice's
note is settled through the existing refund-note settlement helper. The worker
re-reads invoice amounts after creating or recovering the waiver note, before
allocation, to recognise cash that raced the provider call and shrink the note.
Inbound extra receipts retain the original paid share and add actual cash once.
No synthetic bank payment is posted to Xero.

The app notice uses `group-organiser-extra-invoice`, is addressed and attributed
to the organiser's booking, and names the place, change, amount and invoice.
It is durably queued for the normal email retry worker (15-minute backoff), with
a change-stable identity. Suppression and recipient authority still run; the
joiner's private booking URL is never included. Xero does not email this invoice.
Historical B1 billing is an explicit reviewed repair action, described in
[Maintenance](../MAINTENANCE.md).
