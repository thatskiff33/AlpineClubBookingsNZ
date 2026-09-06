# Domain Invariants

These are non-negotiable business and technical rules for AlpineClubBookingsNZ.
Future reviews and issues should cite this file when proposing changes.

This file is the **index**. The rules themselves live in one file per domain
under [`docs/invariants/`](invariants/), each carrying a permanent `INV-*` id.
Every id defined anywhere in that directory appears below with a one-line
description, so you can find the right file without opening more than one.

## How to use this index

1. Find the row in the routing table whose "read it when you are changing…"
   matches your change, and open that file.
2. Or, if you already hold an id (from a code comment, a test name, a lint
   message or a review), find it in the tables further down: each `##` section
   lists every id in that domain with what it covers.
3. Cite ids, never line numbers. `INV-CAP-021` stays valid; a line number does
   not.

| File under `docs/invariants/` | Prefixes | Read it when you are changing… |
| --- | --- | --- |
| [`public-content.md`](invariants/public-content.md) | `INV-PUB` | public fee/policy page content and named lodge tokens |
| [`money.md`](invariants/money.md) | `INV-MONEY` | anything holding cents: fee authorities, whole-lodge pricing, promo caps, subscription charges, or the Xero invoice identity behind them |
| [`booking-dates-and-capacity.md`](invariants/booking-dates-and-capacity.md) | `INV-DATE`, `INV-CAP`, plus `INV-LIFE-062` | what day it is, who is present, how many beds, which bed, custodian bed holds |
| [`payment-and-settlement.md`](invariants/payment-and-settlement.md) | `INV-PAY` | taking, clearing, crediting or refunding money |
| [`member-guest-consent.md`](invariants/member-guest-consent.md) | `INV-GUEST` | a member bringing a member as a guest, and consent to do so |
| [`booking-modifications.md`](invariants/booking-modifications.md) | `INV-MOD` | editing an existing booking's dates, party or price |
| [`adult-member-hosting.md`](invariants/adult-member-hosting.md) | `INV-HOST` | who may host whom, and what strands cover |
| [`booking-requests.md`](invariants/booking-requests.md) | `INV-REQ` | booking-request officer notes and the member's own request area |
| [`subscription-lockout-pricing.md`](invariants/subscription-lockout-pricing.md) | `INV-LOCKOUT` | lapsed-subscription pricing, admin date overrides, retroactive creates, withheld email |
| [`booking-policy-exceptions.md`](invariants/booking-policy-exceptions.md) | `INV-EXCEPT` | policy-exception requests and officer decisions on them |
| [`additional-payment-chasing.md`](invariants/additional-payment-chasing.md) | `INV-ADDPAY` | an outstanding additional payment, quote/request holds, refund settlement |
| [`analytics-and-privacy.md`](invariants/analytics-and-privacy.md) | `INV-PRIV` | analytics loading, the consent banner, the public Analytics preferences control, the analytics route policy, what leaves this application for Google, what personal data may appear in a log, the audit `category` a writer records and who may therefore read the row |
| [`membership-lifecycle.md`](invariants/membership-lifecycle.md) | `INV-LIFE` (except `INV-LIFE-062`) | applications and nomination, cancellation, archive and deletion, roles and the admin lock-out guards, seasonal membership type and age tier, family groups, partner and parent/dependant links, email inheritance, inductions, member merge |
| [`integrations.md`](invariants/integrations.md) | `INV-INT` | webhooks, cron idempotency, provider callbacks, Xero member grouping |
| [`operations.md`](invariants/operations.md) | `INV-OPS`, `INV-LOCK` | raw SQL, advisory or row locking, which lock tier a writer takes, deployment, dropping a column, changing what a value already stored in a column means (an audit `category`, a status string) so the rows already written no longer match the code, what may be used as test input |
| [`product-configuration.md`](invariants/product-configuration.md) | `INV-CONFIG` | adding a value or feature a club could answer differently, a new setting existing deployments will not have, or a default an upgrade must fall back to |
| [`single-source-of-truth.md`](invariants/single-source-of-truth.md) | `INV-SSOT` | adding a constant, helper, formatter, type, validation rule or config value a second place will need; comparing two values; putting a default on a parameter that resolves an environment or configuration authority; or writing a guard, census or ratchet that claims to cross-check another one |

Three supporting files sit beside them: the full id scheme in
[`SCHEME.md`](invariants/SCHEME.md); the word-budget register of approved
exceptions and migration debt in [`WORD_BUDGETS.md`](invariants/WORD_BUDGETS.md);
and the imperfections found during the restructure and deliberately not fixed
in it, in [`_FOLLOW_UPS.md`](invariants/_FOLLOW_UPS.md).

## How IDs work

The full rules are in [`SCHEME.md`](invariants/SCHEME.md). The
operative ones:

- **Form.** `INV-<PREFIX>-<NNN>`, where `<NNN>` is exactly three digits from
  `001` — `INV-CAP-021`, `INV-MONEY-004`. A prefix names a durable area of the
  system and lives in exactly one file; a file may hold more than one prefix.
- **Permanent.** An id that has merged to `main` is **never renumbered, never
  reused and never deleted**. A superseded rule keeps its heading and gains a
  status line; a retired one keeps its heading and gains a reason. A rule that
  moves to another file keeps its id, and this index is authoritative for
  id → file.
- **Allocating a new one.** Pick the domain from the routing table, then the
  file. Take `max(existing number in that prefix) + 1` from the tables below.
  Put the block where a reader would look for it in the file — usually *not* at
  the end — and add its row here in file order. Number order and file order
  diverge immediately, and that is intended.
- **Citing.** Prefer the id, optionally as an anchor:
  `[INV-CAP-021](invariants/booking-dates-and-capacity.md#inv-cap-021)`.

## Public authoritative content

What the public site is allowed to publish.
File: [`invariants/public-content.md`](invariants/public-content.md). Prefix
`INV-PUB`.

| ID | Covers |
| --- | --- |
| `INV-PUB-001` | Fee/policy PageContent blocks are enabled and server-rendered; tokens alone publish nothing |
| `INV-PUB-002` | Public fees use current effective-dated schedules; joining fees resolve from `JoiningFee` only |
| `INV-PUB-003` | A named lodge token resolves one active lodge or nothing |

## Money

How money is represented and where a price comes from.
File: [`invariants/money.md`](invariants/money.md). Prefix `INV-MONEY`.

| ID | Covers |
| --- | --- |
| `INV-MONEY-001` | Store and calculate money as integer cents |
| `INV-MONEY-002` | Annual and joining fee authorities: cents, non-overlapping windows per type/tier |
| `INV-MONEY-003` | Do not introduce floating point money arithmetic |
| `INV-MONEY-004` | Whole-lodge approval price: manual override, else officer flat rate, else per-guest |
| `INV-MONEY-005` | A promo use means a delivered benefit; caps count those rows |
| `INV-MONEY-023` | Cap checks take the promo row lock, then re-read the counter |
| `INV-MONEY-024` | A reprice narrows promo coverage and protects existing beneficiaries; it never refuses |
| `INV-MONEY-025` | A cap check excluding a booking subtracts that booking's own allocation rows |
| `INV-MONEY-026` | TRAP: the in-memory allocation list is not benefit-filtered; filter it yourself |
| `INV-MONEY-027` | A `SET_PRICE` application netting to exactly zero counts as no use |
| `INV-MONEY-006` | Refunds, credits, Stripe and Xero amounts reconcile back to cent-based ledger records |
| `INV-MONEY-007` | Admin adjustments need audit, approval, and a visible business reason |
| `INV-MONEY-008` | A confirmed subscription charge is immutable; only delivery, status, Xero metadata advance |
| `INV-MONEY-009` | An annual fee's components sum to its total; one line each |
| `INV-MONEY-010` | Each `MemberSubscription` is covered by at most one charge; confirmation is idempotent |
| `INV-MONEY-011` | `PER_MEMBER` bills the member, `PER_FAMILY` one explicit recipient, `NO_INVOICE` zero cents |
| `INV-MONEY-012` | Club `familyBillingMode` decides whether family billing exists; stale schedules raise exceptions |
| `INV-MONEY-013` | A multi-family member's per-family fee bills only via their admin-chosen billing family |
| `INV-MONEY-014` | One family/type/membership-year tuple carries at most one durable charge |
| `INV-MONEY-015` | Approval stands when billing setup is incomplete; billing records a visible exception |
| `INV-MONEY-016` | Membership type alone decides subscription liability; access role grants no exemption |
| `INV-MONEY-017` | Paid-up: NOT_REQUIRED type, PAID current-season row, exempt tier; nomination honours first |
| `INV-MONEY-018` | Manual subscription mark-paid is cash-only, never clobbered; a Xero link reclaims authority |
| `INV-MONEY-019` | Opt-in item-code look-through detects paid subscriptions from every fee-schedule component code |
| `INV-MONEY-020` | Look-through on: subscription-invoice selection strong-first, settled, earliest; off keeps first-match |
| `INV-MONEY-021` | Xero invoice identity persists before email; adoption needs exact AUTHORISED match |
| `INV-MONEY-022` | At most one joining-fee invoice per member; conflicts surface, never adopted |

## Booking Dates And Capacity

What a lodge night is, who is present on a day, how many beds a lodge has, and
which bed a guest gets.
File:
[`invariants/booking-dates-and-capacity.md`](invariants/booking-dates-and-capacity.md).
Prefixes `INV-DATE`, `INV-CAP`. The same file also holds `INV-LIFE-062`, the
custodian bed hold, re-homed from membership lifecycle by #2706: it keeps its
number and prefix, and it is listed at the end of the table below.

| ID | Covers |
| --- | --- |
| `INV-DATE-001` | The stay boundary is stated once here; reference it, never restate it |
| `INV-DATE-002` | Night N runs midday NZ date N to midday N+1 |
| `INV-DATE-003` | A stay is `[checkIn, checkOut)` expanded to nights; explicit `BookingGuestNight` rows override |
| `INV-DATE-004` | Presence on day D: morning from the previous night, evening from D |
| `INV-DATE-005` | Two helper families — night model for resources, operational-day for people |
| `INV-DATE-020` | One expander turns a stay into nights; its envelope branch stays half-open |
| `INV-DATE-021` | Kiosk attendance is one current state per stay, re-read per segment |
| `INV-DATE-022` | SQL stay filters are coarse; kiosk writes decide over night rows |
| `INV-DATE-006` | The lobby wall is deliberately mixed, on its own fenced path |
| `INV-DATE-023` | The lobby wall's night count is derived independently of what it shows |
| `INV-DATE-007` | Departing lodge A and arriving at lodge B same date is legal |
| `INV-DATE-008` | Zero-night bookings expand to no nights and every route refuses them |
| `INV-DATE-009` | Six areas sit deliberately outside the boundary and must not be aligned |
| `INV-DATE-010` | `@db.Date` holds a club calendar date; UTC midnight is encoding only |
| `INV-DATE-011` | Lodge bookings use NZ date-only nights, not arbitrary timestamps |
| `INV-DATE-012` | `BookingGuest.stayStart`/`stayEnd` are date-only occupancy in the envelope |
| `INV-DATE-013` | Compare date columns only against date-only values, never a raw clock |
| `INV-DATE-024` | `Member.dateOfBirth` is a UTC-midnight calendar day; never local-midnight or instant comparison |
| `INV-DATE-025` | Club-local wall time may be missing or doubled; three probes resolve |
| `INV-DATE-026` | Calendar-day columns are `@db.Date`; Prisma bounds against them are UTC midnight |
| `INV-DATE-019` | Ask the club's calendar for "today", never the UTC clock |
| `INV-DATE-027` | Never truncate a `DateTime` to its UTC day; census the call graph |
| `INV-DATE-028` | Days added to a document date are calendar days via `addDaysDateOnly` |
| `INV-DATE-014` | Client-side a lodge night is an NZ `yyyy-MM-dd` string, end to end |
| `INV-DATE-015` | Rendering has one seam, `@/lib/club-time`; bare `toLocale*`, unzoned `Intl`, `date-fns` lint-blocked |
| `INV-DATE-029` | Naming the environment zone is lint-blocked; escape-hatch ceilings are tight, only fall |
| `INV-DATE-016` | The long spelled-out date shape is reserved for four named member-facing surfaces |
| `INV-DATE-017` | Two check-out boundaries coexist: completion `<` today, queues `<=` today |
| `INV-DATE-018` | Base Reports uses lodge nights, one positive cohort, cents-exact allocation |
| `INV-CAP-001` | Capacity is per lodge; no path may sum beds across lodges |
| `INV-CAP-002` | `lodgeId` is NOT NULL on six tables via a default-lodge column default |
| `INV-CAP-003` | `getLodgeCapacityStatus` resolves capacity; an explicit capacity caps beds |
| `INV-CAP-004` | `capacityHoldingBookingFilter()` decides which bookings consume beds |
| `INV-CAP-005` | A split guest portion always settles or is notified, never stranded |
| `INV-CAP-006` | Bed-allocation eligibility is a status-only superset of capacity-holding |
| `INV-CAP-032` | Every guest-creating path writes the canonical `BookingGuestNight` set, half-open and cents-exact |
| `INV-CAP-035` | The guest-night backfill is idempotent; re-run it verbatim after cutover |
| `INV-CAP-007` | Auto-allocated stays are room-continuous per booking, with bounded fallback |
| `INV-CAP-008` | Allocation preferences are per lodge and advisory, never safety overrides |
| `INV-CAP-009` | Automated placement never mixes one booking's minors with another's adult; manual warns |
| `INV-CAP-010` | DOUBLE: two confirmed partners; breaking that precondition sweeps future shared rows |
| `INV-CAP-030` | Member merge sweeps only future shared bed-nights its validity re-check refuses |
| `INV-CAP-031` | Shared doubles: placement rule, planner keys, DB caps, partner-shared headroom |
| `INV-CAP-036` | A shared double losing its primary auto-promotes the survivor, audited |
| `INV-CAP-011` | Waitlisted and offered bookings hold no capacity until confirmed |
| `INV-CAP-012` | A waitlist offer reprices at current rates and states what is payable |
| `INV-CAP-013` | A member is present on only one live booking per lodge night |
| `INV-CAP-014` | A member on another's booking may remove only their own place |
| `INV-CAP-015` | The person-night 409 payload is scoped to what the requester may see |
| `INV-CAP-016` | That 409 is flow-neutral; only the wizard adds "choose different dates" |
| `INV-CAP-017` | The person-night guard is app-level, lock-ordered and race-free by design |
| `INV-CAP-018` | A member holds at most one group-join roster row per group |
| `INV-CAP-019` | Draft, pending, waitlist, recovery and review states need repair paths |
| `INV-CAP-020` | Provisional-child cancellation is claim-guarded against the hold cron |
| `INV-CAP-021` | An exclusive whole-lodge hold blocks a night at zero beds, unbypassable |
| `INV-CAP-022` | A held booking owns no `BedAllocation` rows on any path |
| `INV-CAP-023` | A held booking's nights are unattributed, non-displaceable planner occupancy |
| `INV-CAP-024` | The requested-room lock follows approved rows, not the exclusive hold |
| `INV-CAP-025` | Approving beds is always scoped; an unselected approval is refused |
| `INV-CAP-026` | The requested-room lock is two-way; move and reviewed removal re-open it |
| `INV-CAP-027` | Allocation moves keep their nights, require review, commit atomically |
| `INV-CAP-028` | Destructive removal is preview-bound, digest-checked, and never replans |
| `INV-CAP-029` | A range assignment writes all or nothing and audits itself exactly once |
| `INV-CAP-033` | No bed choice without a concrete lodge; club-wide boards are read-only |
| `INV-CAP-034` | Bookings name their lodge; create refuses to default; member always shown |
| `INV-LIFE-062` | A hut-leader assignment may hold one bed: custodian occupancy, inclusive night semantics |

## Payment And Settlement

How money is taken, cleared, credited and refunded.
File:
[`invariants/payment-and-settlement.md`](invariants/payment-and-settlement.md).
Prefix `INV-PAY`.

| ID | Covers |
| --- | --- |
| `INV-PAY-001` | Manual mark-paid provenance for booking payments, and the predicate that reads it |
| `INV-PAY-038` | Mark-paid is a sibling entry into the one settlement body |
| `INV-PAY-039` | Mark-paid never calls Xero, and is refused on any Xero evidence |
| `INV-PAY-040` | A capacity failure refuses the mark-paid and records nothing |
| `INV-PAY-041` | Invoice minting is fenced at enqueue, at settle, and in the handler |
| `INV-PAY-042` | Inbound Xero PAID on a manually settled booking is raised, never ignored |
| `INV-PAY-043` | Duplicate capture on a cash-settled booking is auto-refunded, not silently kept |
| `INV-PAY-044` | Manually settled cancellation yields a durable `ManualRefundTask`, never a card refund |
| `INV-PAY-045` | Reversal is permitted only while nothing has happened it could not undo |
| `INV-PAY-046` | An outstanding upward-modification delta is asked about, never silently absorbed or dropped |
| `INV-PAY-052` | Not-covered settle spares one intent; captured payments refused at read |
| `INV-PAY-047` | The ledger mirror: every cent collected, paid with credit, or owed |
| `INV-PAY-048` | A stored unconsumed credit election is cleared, recorded and reported, never stranded |
| `INV-PAY-049` | Both directions are audited with the acting admin and the previous status |
| `INV-PAY-050` | Xero Stripe refund notes cover provider-backed cash evidence, never the refunded-amount mirror |
| `INV-PAY-051` | An unpriceable edit holds the money as one typed review task |
| `INV-PAY-061` | One review task per parked strand; departing strand always recorded |
| `INV-PAY-054` | Settled occurrences never suppress the next; stored prices are not proof |
| `INV-PAY-062` | Zero completion refused, naming the way out; credit-only records no refund |
| `INV-PAY-055` | Confirmed amounts settle through an existing path, chosen at completion |
| `INV-PAY-063` | Completions record their direction; charging re-enters the additional-payment path |
| `INV-PAY-056` | One booking edit raises one charge request, derived from settled shares |
| `INV-PAY-064` | Xero leg bills the total on one invoice per edit, anchor-locked |
| `INV-PAY-057` | Recorded shortfalls are billed on a second invoice; sent invoices only |
| `INV-PAY-065` | Both shortfall endings audited with opposite instructions; repair reads settled shares |
| `INV-PAY-058` | Recovery replays close debt only when the ask exists; edit-time answer |
| `INV-PAY-066` | Repair pass dates the primary invoice from operation history; unrequested shares traced |
| `INV-PAY-059` | Card refunds cap before claiming, task-keyed; anchor is the original edit |
| `INV-PAY-060` | Open review fences four money doors; three DB constraints; #3030 versus #3032 |
| `INV-PAY-002` | Account credit is consumed only at `PAYMENT_PENDING`; a draft election spends nothing |
| `INV-PAY-003` | The edit path writes an election only onto DRAFT, AWAITING_REVIEW and PAYMENT_PENDING |
| `INV-PAY-004` | Members edit own drafts; draft edits move no money or capacity |
| `INV-PAY-005` | The credit election is consumed by a guarded claim, never a read-then-write |
| `INV-PAY-006` | A stored election is clamped at confirmation, never refused; shortfall reported |
| `INV-PAY-007` | Nothing left to pay settles at $0 inside the pay transaction |
| `INV-PAY-008` | A $0 waitlist confirm always ends movable; four coded outcomes |
| `INV-PAY-009` | No settled booking carries a stored credit election; every settlement clears it |
| `INV-PAY-010` | A clear is reported only where the member lost something |
| `INV-PAY-011` | Neither report quotes the elected figure; the live balance is read |
| `INV-PAY-012` | The public payment link refuses a booking carrying an election |
| `INV-PAY-013` | Stripe and Internet Banking/Xero settlement paths must remain distinct |
| `INV-PAY-014` | Stripe paths own PaymentIntents, SetupIntents, refunds, webhooks and recovery operations |
| `INV-PAY-015` | Internet Banking bookings issue Xero invoices and reconcile through Xero state |
| `INV-PAY-016` | Internet Banking defaults are non-holding and no-cutoff; an enabled hold releases idempotently |
| `INV-PAY-017` | Hold-expiry release and its invoice-clearing credit-note outbox row commit in one transaction |
| `INV-PAY-018` | Cancelling never rewrites captured-payment truth; "captured" is decided on ledger evidence |
| `INV-PAY-019` | Applied credit is conserved across every cancellation branch; restore is structurally idempotent |
| `INV-PAY-020` | A confirmation reconciles against the member's statement: total minus credit equals settled |
| `INV-PAY-021` | An unpaid confirmation defers to the invoice and promises nothing about it |
| `INV-PAY-022` | Unpaid confirmation with applied credit states the netting, from the ledger |
| `INV-PAY-053` | Netted figure is not the allocation gate; pay the smaller |
| `INV-PAY-023` | Applied credit reduces Internet Banking invoices by allocating existing floating credit notes |
| `INV-PAY-024` | Applied credit also reduces the card charge; intent mints effective amount |
| `INV-PAY-025` | Payment on a cancelled booking's stale invoice needs cash evidence before crediting |
| `INV-PAY-026` | The same cash-evidence rule gates Internet Banking settlement on both inbound surfaces |
| `INV-PAY-027` | Payment, refund and credit operations are idempotent across retries, replays and reruns |
| `INV-PAY-028` | The Stripe webhook dedup claim is a processing lease, not "seen" |
| `INV-PAY-029` | A FAILED Stripe payment keeps its WAITING_PAYMENT Xero op for 24h |
| `INV-PAY-030` | External provider side effects require clear retry and idempotency behaviour |
| `INV-PAY-031` | Organiser-pays settlement applies only if payment matches the settleable children |
| `INV-PAY-032` | Group children confirmed before payment have a reaper releasing beds and notifying |
| `INV-PAY-033` | Reverted group children end terminally: a second reap window cancels once |
| `INV-PAY-034` | Organiser-cancel cleanup is re-drivable; the frozen per-child refund plan is never recomputed |
| `INV-PAY-035` | Organiser cancellation is a durable settlement fence, written under `lock(1)` first |
| `INV-PAY-036` | Each group-cancel child's refund credit-note enqueue commits inside that child's cancel transaction |
| `INV-PAY-037` | Failed settlement refunds stay durably owed; no child mirror applies twice |

## Member-Guest Consent

When a member added as somebody else's guest must be asked first, and what each
answer is recorded as.
File:
[`invariants/member-guest-consent.md`](invariants/member-guest-consent.md).
Prefix `INV-GUEST`.

| ID | Covers |
| --- | --- |
| `INV-GUEST-001` | Member-guest consent state lives in five `BookingGuest` columns, not a side table |
| `INV-GUEST-002` | MG1 shipped those columns inert; MG2 turns them on behind `memberGuests` |
| `INV-GUEST-003` | An approved stay extends without re-asking, and declining can be refused |
| `INV-GUEST-004` | `NULL` is not `CONFIRMED`: null means consent was never needed |
| `INV-GUEST-005` | A consent never solicited is recorded as such; `consentRequestedAt` is the discriminator |
| `INV-GUEST-006` | A `DECLINED` row must name who declined; an unattributed decline is broken |
| `INV-GUEST-007` | Who answered is audited separately from who was asked, in one column |
| `INV-GUEST-008` | Nobody answers for a member who can sign in; delegates gated |
| `INV-GUEST-009` | Delegate answers are emailed to the member; no money or links |
| `INV-GUEST-010` | A `PENDING` row holds the bed until `consentExpiresAt`; no expiry is illegal |
| `INV-GUEST-011` | Consent is not transitive across bookings; copies become admin assignments |
| `INV-GUEST-012` | A merged-away member's guest rows keep their consent; the survivor inherits it |
| `INV-GUEST-013` | A pending guest is not operationally present, via one explicit `OR` |
| `INV-GUEST-014` | Pending guests hold beds and person-nights; capacity never filters on consent |
| `INV-GUEST-015` | A data-subject export is not operational and includes the member's pending rows |
| `INV-GUEST-016` | MG4: edit path, admin parity, request pipeline; no address in URLs |
| `INV-GUEST-017` | Exactly eight column shapes are legal, and the table lists them |
| `INV-GUEST-018` | That table is generated from the code table by a test |

## Booking Modifications

Editing an existing booking — and, under the same source heading, the policies a
booking is held to: adult-member hosting, booking requests, subscription-lockout
pricing, policy exceptions and additional-payment chasing. Those live in their
own files, listed below in turn.

### Modification rules

File:
[`invariants/booking-modifications.md`](invariants/booking-modifications.md).
Prefix `INV-MOD`.

| ID | Covers |
| --- | --- |
| `INV-MOD-001` | Booking changes never desynchronise guests, money, Xero, beds, audit or waitlist |
| `INV-MOD-002` | Deltas, credits, refunds and additional payments stay traceable to booking and modification |
| `INV-MOD-003` | A modification increase whose Stripe intent fails transiently is never lost silently |
| `INV-MOD-004` | Guest stay ranges sit inside the envelope; outside ranges auto-expand it |
| `INV-MOD-005` | Nightly prices lock at booking time; only changed guests and nights reprice |
| `INV-MOD-006` | Every edit path passes the default group discount; locked nights win |
| `INV-MOD-026` | One club switch, one chokepoint: whether later-added nights earn group discount |
| `INV-MOD-027` | Officers may member-rate a non-member-rate guest; refused on mid-stay or parking edits |
| `INV-MOD-007` | Hut nightly rates key on membership type and optional age tier |
| `INV-MOD-008` | An unpaid member repriced under `NON_MEMBER_PRICING` is `NON_MEMBER_DEFAULT`, not forced |
| `INV-MOD-009` | Membership, not the subscription, gates member-only promotions; a repriced member stays eligible |
| `INV-MOD-010` | Priced guests store a rate-type snapshot; kept locked nights stay stale |
| `INV-MOD-011` | Reductions refund within the cancellation tier; captured payments need settlement elections |
| `INV-MOD-012` | Pre-payment reduction below applied credit refunds the over-consumed slice under lock |
| `INV-MOD-013` | A modification parked to AWAITING_REVIEW refunds no credit, auto-pays nothing until released |
| `INV-MOD-014` | Xero deallocation commits the clamp offset and outbox op together, member-credit-locked |
| `INV-MOD-015` | After verification, superseded allocation links give way to Xero's real ids |
| `INV-MOD-016` | Deallocation retries resume checkpointed ids; allocated credit reads `MemberCreditNoteAllocation`, not stamps |
| `INV-MOD-017` | Legacy stamped applications are repaired under the lock before any use |
| `INV-MOD-018` | Every modification path applies the same lifecycle transitions, whichever endpoint changed it |
| `INV-MOD-019` | Self-service edits obey the date-window policy; in-progress stays extend future nights only |
| `INV-MOD-025` | In-progress edits price held nights, sell only new ones; never negative |
| `INV-MOD-020` | Minimum stay is the first exception-foundation consumer; only two soft reason codes |
| `INV-MOD-021` | A frozen violation explains a refusal, never authorises one; server-side stops |
| `INV-MOD-022` | The admin exemption is not one predicate, and is stated per path |
| `INV-MOD-023` | Advisory surfaces report the same facts and gate nothing; nothing persisted |
| `INV-MOD-024` | Minimum-stay policy administration is versioned; a stale version is refused, not overwritten |
| `INV-MOD-028` | Historical nights value only from sold-price rows; else `NULL` and parked review |

### Adult-member hosting

Whether a non-member guest-night must overlap an adult member who is actually
staying, and what happens when that cover is taken away.
File:
[`invariants/adult-member-hosting.md`](invariants/adult-member-hosting.md).
Prefix `INV-HOST`.

| ID | Covers |
| --- | --- |
| `INV-HOST-001` | Non-member guest-nights may be required to overlap a staying adult member |
| `INV-HOST-002` | One policy row per scope; `scopeKey` pinned; every write versioned |
| `INV-HOST-003` | A lodge row replaces the club default; unidentifiable scope is refused |
| `INV-HOST-004` | Hosts: active, unarchived ADULT members on a guest row that night |
| `INV-HOST-005` | Nights come from sparse `BookingGuestNight` rows; older rows use the envelope |
| `INV-HOST-006` | A #738 split booking borrows its same-member sibling's adults as host-only participants |
| `INV-HOST-007` | Borrowing is symmetric; every mutation reconciles the booking and live siblings |
| `INV-HOST-008` | Under `ADMIN_REVIEW_REQUIRED`: a review in its own `Booking` columns, never blocking check-in |
| `INV-HOST-009` | Admin exemption is per path; only reasoned on-behalf creates open APPROVED |
| `INV-HOST-010` | Re-evaluation is idempotent and runs on every path changing a party |
| `INV-HOST-011` | #2364 stops at configuration, evaluator and seams; request state is #2365 |
| `INV-HOST-012` | The policy is two independent dimensions — consequence and host scope — resolved separately |
| `INV-HOST-013` | Three consequences: `DISABLED`, `ADMIN_REVIEW_REQUIRED`, and `ENFORCED`, which refuses the booking |
| `INV-HOST-014` | `INHERIT` is lodge-only for the consequence; host-scope columns move together |
| `INV-HOST-015` | Two scopes only: same booking and same owner; wider two removed |
| `INV-HOST-016` | The built-in default is same-booking only, which makes the upgrade a no-op |
| `INV-HOST-017` | Enabled scopes are OR-ed per night; every non-member guest-night must be covered |
| `INV-HOST-018` | An active policy with no scope enabled is refused, never permissive |
| `INV-HOST-019` | Host identities are never disclosed to the booking owner |
| `INV-HOST-020` | School and organisation approvals are review-only; member whole-lodge approval is not exempt |
| `INV-HOST-021` | A reasoned explicit admin decision is an approval, even under `ENFORCED` |
| `INV-HOST-022` | Officer queue consequence comes from the frozen violation, not live policy |
| `INV-HOST-023` | Same-owner coverage reuses every same-booking definition, adding only host location |
| `INV-HOST-024` | Cross-booking strand checks need same-owner scope; own-booking seams still queue under `ENFORCED` |
| `INV-HOST-025` | A member's own-booking change is refused when it would strand another |
| `INV-HOST-026` | Refusal gated on ACTOR: non-owners allowed through, escalated, told nothing |
| `INV-HOST-027` | "Newly" uncovered is the test, compared on the shared material-identity key |
| `INV-HOST-028` | Authorised officers confirm, are allowed and escalated, against a versioned digest |
| `INV-HOST-029` | Changing one person's standing enqueues the check owed, under ordered locks |
| `INV-HOST-030` | Every confirming path re-reads the facts at confirmation; census proves it |
| `INV-HOST-031` | Coverage and member merge share one ordered per-owner advisory-lock handshake |
| `INV-HOST-032` | An incident opens only for an accepted booking: confirmed active attendance |
| `INV-HOST-033` | One active incident per booking; owner notification is lease-fenced, at-least-once delivery |
| `INV-HOST-034` | Resolution is one of four recorded causes, never inferred from absence |
| `INV-HOST-035` | Three resolutions close in the changing transaction; `COVERAGE_RESTORED` via post-commit drain |
| `INV-HOST-036` | The queue is at-least-once; database effects idempotent, email has a stated ambiguity |
| `INV-HOST-037` | Officer queue sits above the admin bookings list; no separate acknowledgement |
| `INV-HOST-038` | Inline drain covers the booking just written; the cron drains everything |
| `INV-HOST-039` | Every path that can enqueue must also drain, asserted tree-wide by census |
| `INV-HOST-040` | Dependent reads have an ordered, logged ceiling of their own |
| `INV-HOST-041` | System cancellations re-check supervision through a seam that can never refuse |
| `INV-HOST-042` | The fan-out-skipping mode gate reads every related booking's lodge |
| `INV-HOST-043` | Group identity is the organiser/join columns, never parentBookingId or container status |
| `INV-HOST-044` | Group Trip hosts are host-only, deduplicated against narrower scopes, own ceiling |
| `INV-HOST-045` | Kiosk cover-source display derives from the canonical snapshot only |
| `INV-HOST-046` | Stranding another account's Group Trip booking allows the change, escalates, discloses nothing |
| `INV-HOST-047` | Third optional scope, appended never reordered, off until a club enables it |
| `INV-HOST-048` | Outside the all-or-none CHECK; NULL on a decided row means off |
| `INV-HOST-049` | Same-owner dependent fan-out reads the vacated window; items carry dependents' nights |
| `INV-HOST-050` | Never refuse a change the member cannot make; linked move offered |
| `INV-HOST-051` | Linked move is atomic, settles once; both change fees unless disabled |
| `INV-HOST-052` | Declined linked moves record their own cause, registered a release early |
| `INV-HOST-053` | Re-evaluation explanations belong to their booking; explained causes never overwritten |

### Booking requests

File:
[`invariants/booking-requests.md`](invariants/booking-requests.md). Prefix
`INV-REQ`.

| ID | Covers |
| --- | --- |
| `INV-REQ-001` | An officer's decision carries two notes; which audience reads which is table-wide |
| `INV-REQ-002` | `adminNotes` is member-visible, on both request tables and both request kinds |
| `INV-REQ-003` | `internalNotes` is never member-visible, on either table or either kind |
| `INV-REQ-004` | Four structural properties hold that boundary, so no call site remembers |
| `INV-REQ-005` | Private notes never substitute for member-facing ones; drafts kept per request |
| `INV-REQ-006` | An expand-only nullable column; an older decision reads as "none" |
| `INV-REQ-007` | The member's projection states only facts: ledger capacity, conflicts reported, no promises |

### Subscription-lockout pricing, admin date overrides and member-facing email

File:
[`invariants/subscription-lockout-pricing.md`](invariants/subscription-lockout-pricing.md).
Prefix `INV-LOCKOUT`.

| ID | Covers |
| --- | --- |
| `INV-LOCKOUT-001` | Unpaid member: non-member rates, told why, and a paid-up adult required |
| `INV-LOCKOUT-002` | Three rules on one predicate: reprice, paid-up adult present, member-facing sentences |
| `INV-LOCKOUT-003` | `MembershipLockoutSettings.mode` picks `NO_BLOCK`, `HARD_BLOCK` or `NON_MEMBER_PRICING`, alone |
| `INV-LOCKOUT-004` | Independent booking failures report together: both codes, one exception review |
| `INV-LOCKOUT-005` | Two migrations, one deploy: expand adds `mode`, contract backfills and drops `enabled` |
| `INV-LOCKOUT-006` | The legacy mapping lives in the migration, not in a read-time fallback |
| `INV-LOCKOUT-007` | The drop is a windowed migration: the previous release reads `enabled` |
| `INV-LOCKOUT-008` | Bundle-format compatibility outlives the column; the legacy key maps to its mode |
| `INV-LOCKOUT-009` | Mode resolved once per request, handed to gates and pricing alike |
| `INV-LOCKOUT-010` | Failed mode reads fail the request, never quietly charging member rates |
| `INV-LOCKOUT-011` | The financial-year reseed is gated on the Xero module, not the mode |
| `INV-LOCKOUT-012` | Only refusals are mode-gated; unpaid-member-guest lookups still run for the privacy rule |
| `INV-LOCKOUT-013` | Six mode-gated refusal sites: the five routes plus the modify apply path |
| `INV-LOCKOUT-069` | Payment path has no subscription gate; locked-out members pay on-behalf bookings |
| `INV-LOCKOUT-070` | Two non-payment edges of that journey: 72-hour draft clock, $0 draft |
| `INV-LOCKOUT-014` | Paid-up-adult rule applies on removals too; consent decline or expiry exempt |
| `INV-LOCKOUT-015` | Waitlist is the sixth money path: offer states why, confirm re-checks |
| `INV-LOCKOUT-016` | D-12 reads the real consent column everywhere; pending invites never count |
| `INV-LOCKOUT-017` | Xero line narrates the RATE from the snapshot, not the flag |
| `INV-LOCKOUT-018` | Reprice happens at the single pricing gate, not at write paths |
| `INV-LOCKOUT-019` | The paid-up-adult rule has two triggers: somebody repriced, or an unfinancial owner |
| `INV-LOCKOUT-020` | Both triggers share one owing test; owner joins the facts batch |
| `INV-LOCKOUT-021` | Why the owner trigger exists, and why it is gentler than `HARD_BLOCK` |
| `INV-LOCKOUT-022` | The requirement stays scoped; it never newly refuses bookings unrelated to subscriptions |
| `INV-LOCKOUT-023` | Rate notice follows the reprice, never describing an uncharged price |
| `INV-LOCKOUT-024` | Cross-lodge waitlist promotion is the seventh money path and reached none |
| `INV-LOCKOUT-025` | Both waitlist paths append one shared "kept your place" sentence |
| `INV-LOCKOUT-026` | Every write path passes the owner; call-site census proves it |
| `INV-LOCKOUT-027` | Missing paid-up adult: 409 with HOLD and override door, counts only |
| `INV-LOCKOUT-028` | The frozen violation is unchanged; the member-facing response is audience-scoped on removals |
| `INV-LOCKOUT-029` | Violations name their nights; owner arm falls back to the envelope |
| `INV-LOCKOUT-030` | Repriced members stop counting as hosts; their own nights stay covered |
| `INV-LOCKOUT-031` | `NON_MEMBER_PRICING` is a relaxation with exactly two narrow exceptions, both stated |
| `INV-LOCKOUT-032` | Both land on a reviewable 409, beds held; `HARD_BLOCK` never stricter |
| `INV-LOCKOUT-033` | Owner trigger adds no third exception, replacing an outright `HARD_BLOCK` refusal |
| `INV-LOCKOUT-034` | Config transfer maps the legacy bundle key; unmapped drops a decision |
| `INV-LOCKOUT-035` | That hook derives only into an absent mode, before field validation |
| `INV-LOCKOUT-036` | Reversal is a mode change: no migration, no code, nothing repriced |
| `INV-LOCKOUT-037` | The admin-only date override: date-only, explicit `pricingMode`; `shift` freezes every cent |
| `INV-LOCKOUT-073` | Emailing a member about an admin edit is a per-action choice |
| `INV-LOCKOUT-044` | #1780 sweep extends the per-action notify choice to remaining admin emails |
| `INV-LOCKOUT-045` | An account-deletion approval with bookings to cancel claims `APPROVAL_IN_PROGRESS` before cancelling |
| `INV-LOCKOUT-046` | That claim is taken only when there is something irreversible to protect |
| `INV-LOCKOUT-047` | `APPROVAL_IN_PROGRESS` is an OPEN state every outstanding-request reader must count |
| `INV-LOCKOUT-048` | A Full Admin may release a started approval back to `PENDING`, audited |
| `INV-LOCKOUT-049` | Released requests are marked in the row; rejection gated and confirmed |
| `INV-LOCKOUT-050` | The authorised `PENDING` flavour travels into the guarded claim |
| `INV-LOCKOUT-051` | The release and its audit record commit together, under that row's lock |
| `INV-LOCKOUT-052` | Losing a guard to a release is reported as exactly that |
| `INV-LOCKOUT-053` | The override's other `pricingMode` (`INV-LOCKOUT-037`): `recalculate` reprices in full, clamps lifted |
| `INV-LOCKOUT-038` | Under an override an over-capacity target is warn-and-confirm, recorded and audited |
| `INV-LOCKOUT-039` | Per-booking "No emails" withholds everything about that booking, enforced at the mailer |
| `INV-LOCKOUT-054` | Authenticated booking links follow the booking-detail read gate |
| `INV-LOCKOUT-055` | Admin-audience mail is never withheld; the registry's audience is the authority |
| `INV-LOCKOUT-056` | An unreadable switch withholds the send and records the row FAILED |
| `INV-LOCKOUT-057` | Every withhold writes a `SKIPPED_NO_EMAILS` `EmailLog` row with no retained body |
| `INV-LOCKOUT-058` | The retry cron re-reads the switch and booking authority before every replay |
| `INV-LOCKOUT-059` | Waitlist candidacy excludes a silenced booking; two residual cases surfaced, not denied |
| `INV-LOCKOUT-060` | A silenced waitlist entry keeps its place and quoted position |
| `INV-LOCKOUT-061` | Xero-sent invoice emails are gated too, superseding the #1705 always-send carve-out |
| `INV-LOCKOUT-062` | Enabling the switch requires an acknowledgement; both set and clear are audited |
| `INV-LOCKOUT-063` | The acknowledgement is a two-button dialog, never a checkbox; `bookings:edit` |
| `INV-LOCKOUT-064` | A persistent banner lists what was withheld, grouped per template with counts |
| `INV-LOCKOUT-065` | Two consequences nothing can record are stated in the acknowledgement dialog |
| `INV-LOCKOUT-066` | A member must never learn the switch exists, render or RSC |
| `INV-LOCKOUT-067` | The per-action notify prompts are not offered while the switch is on |
| `INV-LOCKOUT-068` | The silenced path sends no `notifyMember` flag, never `false` |
| `INV-LOCKOUT-040` | Creation is today-or-future except admin retroactive creates within 365 days |
| `INV-LOCKOUT-071` | Create-time Xero lock-date guard: skipped when disconnected, fails closed, classifies cause |
| `INV-LOCKOUT-072` | Lock-date guard on modify paths: override always, ordinary edits narrowly |
| `INV-LOCKOUT-041` | Shift overrides write no Xero documents; on-behalf over-capacity creates are warn-and-confirm |
| `INV-LOCKOUT-042` | A deliberately over-capacity booking is never destroyed by a later capacity re-check |
| `INV-LOCKOUT-043` | Finished stays' card obligations never linger unseen: disjoint queues, one predicate |

### Booking-policy exceptions

File:
[`invariants/booking-policy-exceptions.md`](invariants/booking-policy-exceptions.md).
Prefix `INV-EXCEPT`.

| ID | Covers |
| --- | --- |
| `INV-EXCEPT-001` | The flow's scope — eligible SOFT failures only — and the immutable, self-proving proposal |
| `INV-EXCEPT-004` | The frozen evidence is authoritative; only reviewed, allowlisted violations can be stored |
| `INV-EXCEPT-005` | A held request's provisional reservation is per-night, directional and durable |
| `INV-EXCEPT-006` | Drift is set algebra over one proposal's frozen and current violations |
| `INV-EXCEPT-007` | `memberMessage` is required, trimmed, at most 1000 characters, normalised once |
| `INV-EXCEPT-008` | Only a `REQUESTED` request may move, once, under a guarded version claim |
| `INV-EXCEPT-009` | Every held bed carries an immutable deadline; only held beds do |
| `INV-EXCEPT-010` | Approval claims, releases and executes in one transaction |
| `INV-EXCEPT-002` | The request-creation half, and the dedicated store a new-booking proposal lives in |
| `INV-EXCEPT-011` | Violations are re-derived server-side; a proposal tripping none is refused |
| `INV-EXCEPT-012` | At most one open request per subject: a NULL-distinct unique index |
| `INV-EXCEPT-013` | Creation never changes a live booking |
| `INV-EXCEPT-014` | Cancel and supersede are guarded; a lost claim runs no side effect |
| `INV-EXCEPT-015` | The officer alert is fire-and-forget after commit, never in-band |
| `INV-EXCEPT-003` | The officer-decision half: approving executes in one transaction, never a status flip |
| `INV-EXCEPT-016` | The capacity recheck covers the full proposed party, excluding the live booking |
| `INV-EXCEPT-017` | The recheck window covers every frozen guest night, not the envelope alone |
| `INV-EXCEPT-018` | Capacity stays a hard refusal; approving officers are not override actors |
| `INV-EXCEPT-019` | Never a false keep-pending, including once the post-commit phase has begun |
| `INV-EXCEPT-020` | A kept-pending capacity conflict is always recorded, on either store |
| `INV-EXCEPT-021` | Live proposals are verified by replaying the frozen delta, never trusted |
| `INV-EXCEPT-035` | A refusal names only what was established, never an unseen cause |
| `INV-EXCEPT-022` | One implementation computes what the delta produces, for all four surfaces |
| `INV-EXCEPT-023` | Only reviewed rules are overridden; ADMIN never borrowed for guest authorisation |
| `INV-EXCEPT-024` | An approved hosting exception is recorded as decided in the same transaction |
| `INV-EXCEPT-025` | Adult-supervision review is never decided by proxy; opens PENDING and BLOCKED |
| `INV-EXCEPT-026` | Reauthorization re-reads the officer's current roles inside the approval transaction |
| `INV-EXCEPT-027` | A decision is explicit, attributable and single-flight against the version shown |
| `INV-EXCEPT-028` | The officer decides a party they were shown, guest by guest |
| `INV-EXCEPT-029` | The settlement-method choice is asked on the decision form, never reported pending |
| `INV-EXCEPT-030` | The member's list returns the officer's note, last conflict and booking |
| `INV-EXCEPT-031` | Approved new bookings get an approval email after commit; modifications do not |
| `INV-EXCEPT-032` | One algorithm decides both request tables, so the flavours cannot drift apart |
| `INV-EXCEPT-033` | A new booking is authorised as the requesting member, not merely created |
| `INV-EXCEPT-034` | A supersede carries the predecessor's attempt count forward |

### Additional-payment chasing, request holds and refund settlement

File:
[`invariants/additional-payment-chasing.md`](invariants/additional-payment-chasing.md).
Prefix `INV-ADDPAY`.

| ID | Covers |
| --- | --- |
| `INV-ADDPAY-001` | Who is owed an additional payment: booking status and amount together |
| `INV-ADDPAY-023` | Who may pay one: every member surface excludes CANCELLED and BUMPED |
| `INV-ADDPAY-024` | At most two reminders per obligation, and the chase stops at check-out |
| `INV-ADDPAY-025` | Nothing before the cron cutover is chased; read failures send nothing |
| `INV-ADDPAY-026` | Guarded stamps claim before each send, fenced to the current episode |
| `INV-ADDPAY-027` | One clock: manual and automatic sends share stamps and cooldown |
| `INV-ADDPAY-028` | Only a transmitted message counts as sent; otherwise stamps return |
| `INV-ADDPAY-029` | Silence is refused, not swallowed; unreachability is checked before anything is claimed |
| `INV-ADDPAY-002` | Three side doors into the finished-unpaid state are closed at the door |
| `INV-ADDPAY-003` | A booking left with only non-adults needs admin approval, however caused |
| `INV-ADDPAY-004` | Any pending admin review blocks a paid or completed booking from check-in |
| `INV-ADDPAY-005` | The member edit panel collects that justification proactively; the server stays enforcer |
| `INV-ADDPAY-006` | A quote hold spans the whole quote lifecycle, send through release |
| `INV-ADDPAY-007` | An accepted-but-unpaid quote hold is not protected against a later capacity reduction |
| `INV-ADDPAY-008` | School approval re-checks per-night capacity for the final guest list, both branches |
| `INV-ADDPAY-009` | A converted booking keeps the held lodge, negotiated price and owning contact |
| `INV-ADDPAY-010` | An admin decline releases the capacity hold from any declinable state |
| `INV-ADDPAY-011` | DECLINED requests are untouchable, quotes retired; standard edits refuse quoted bookings |
| `INV-ADDPAY-012` | The paid-name lock allows only identity-preserving spelling corrections, by four exact tests |
| `INV-ADDPAY-013` | Accepted residual: a one-edit short-name change resembles a typo; audit mitigates |
| `INV-ADDPAY-014` | Reductions against unpaid Xero invoices correct the net delta by credit note |
| `INV-ADDPAY-015` | Refundable base is capped by booking worth, never the payment mirror |
| `INV-ADDPAY-016` | A credit-settled reduction allocates against captured transactions in the same transaction |
| `INV-ADDPAY-017` | Net-positive mixed edits bill one supplementary Xero invoice; repair uses evidence |
| `INV-ADDPAY-018` | A cancellation's card-refund debt is durable before any external call |
| `INV-ADDPAY-019` | Xero contact resolution makes every provider call outside any database transaction |
| `INV-ADDPAY-020` | Stepped Stripe refunds settle as per-delta credit notes summing exactly |
| `INV-ADDPAY-021` | Stripe payments: local refund ledger is truth; inbound Xero only raises |
| `INV-ADDPAY-022` | Soft-delete hides a duplicate only when no external money history exists |
| `INV-ADDPAY-030` | Soft-deleted bookings are always CANCELLED and stay so; refusals mostly incidental |
| `INV-ADDPAY-031` | House shape for a deleted-booking guard: 404 for every role, after authorisation |
| `INV-ADDPAY-032` | Superseded by `INV-ADDPAY-035`/`INV-ADDPAY-036`: two writes stay reachable on a soft-deleted booking |
| `INV-ADDPAY-033` | Superseded by `INV-ADDPAY-034`: two unguarded GETs served a deleted booking's data |
| `INV-ADDPAY-034` | One shared "cancelled or removed" sentence for surfaces that explain |
| `INV-ADDPAY-035` | Soft-deleted bookings take no member-guest consent answer, from any role |
| `INV-ADDPAY-036` | Modification payments captured on deleted bookings are queued for a human |
| `INV-ADDPAY-037` | Auto-refund leaves DISMISSED task — #2773 orchestrator decision; owner has not ruled; `INV-ADDPAY-039` |
| `INV-ADDPAY-038` | Unmutable alert names population — #2773 orchestrator decision; owner has not ruled; `INV-ADDPAY-039` |
| `INV-ADDPAY-039` | Hand-refunded late capture never refunded again — orchestrator decision; owner has not ruled |

## Analytics And Privacy

Analytics loading and consent, what this application is allowed to send to
Google, what personal data may appear in a log, and who may read an audit row.
File:
[`invariants/analytics-and-privacy.md`](invariants/analytics-and-privacy.md).
Prefix `INV-PRIV`.

| ID | Covers |
| --- | --- |
| `INV-PRIV-001` | Google Analytics must not load unless all four stated conditions hold |
| `INV-PRIV-002` | Banner enabled with no accepted choice recorded: nothing at all reaches Google |
| `INV-PRIV-003` | Banner disabled: tag loads, banner-era decline invalidated once, preferences opt-out honoured |
| `INV-PRIV-004` | Advertising storage, user data and personalisation are denied in every signal |
| `INV-PRIV-005` | Page views carry origin and pathname only; no query, token, id |
| `INV-PRIV-006` | Exactly one page view per address across client-side navigation, de-duplicated |
| `INV-PRIV-007` | Both hold only if GA history-based enhanced measurement is off |
| `INV-PRIV-008` | Leaving the public site unmounts the runtime, kill-switches, queues a denial |
| `INV-PRIV-009` | Per-browser choice stores consent revision and surface; explicit action bumps it |
| `INV-PRIV-010` | Every one of these fails closed, and the public website still renders |
| `INV-PRIV-011` | Which fields the log/Sentry redactor strips; audit keeps name and address |
| `INV-PRIV-012` | Audit category follows the affected domain; visibility separate; written rows `INV-OPS-012` |
| `INV-PRIV-013` | `admin` writers move only to close a split; fifteen keeps, `lockers` settled |
| `INV-PRIV-014` | Diagnostics filters and typed search reach the provider ungated |
| `INV-PRIV-015` | A hut leader's PIN session: ten minutes' inactivity, twelve-hour ceiling, Lock control |
| `INV-PRIV-016` | Kiosk Group Trip disclosure by tier: linkage ordinal only; never `joinCode` |

## Membership Lifecycle

How a membership starts, changes and ends; who may act for whom inside a family;
roles, age tiers, inductions and member merge.
File:
[`invariants/membership-lifecycle.md`](invariants/membership-lifecycle.md).
Prefix `INV-LIFE`, with one exception: `INV-LIFE-062`, the custodian bed hold,
lives in
[`invariants/booking-dates-and-capacity.md`](invariants/booking-dates-and-capacity.md)
beside the `INV-CAP` rules and is listed under Booking Dates And Capacity above.
The `FamilyGroupMember.role` column drop that used to sit inside `INV-LIFE-037`
is now `INV-OPS-005` to `INV-OPS-011` in
[`invariants/operations.md`](invariants/operations.md).

| ID | Covers |
| --- | --- |
| `INV-LIFE-001` | Lifecycle changes must preserve financial, booking, audit, family, privacy and Xero history |
| `INV-LIFE-002` | Cancellation credits a subscription invoice only for its last uncancelled member |
| `INV-LIFE-003` | One cancellation at most credits a subscription invoice: durable first-writer claim |
| `INV-LIFE-004` | Unpaid-invoice approval blocker excuses an invoice only while it awaits crediting |
| `INV-LIFE-005` | Role, membership type, age tier, Xero group, committee: separate axes |
| `INV-LIFE-089` | Last active Full Admin can never be deactivated, de-logined or archived |
| `INV-LIFE-006` | Cancellation eligibility is an account-holder question, refusing exactly two record classes |
| `INV-LIFE-007` | Member-raised route: active and can-log-in only; family candidates unfiltered by role |
| `INV-LIFE-008` | Member-raised queries must select role columns; otherwise a person reads kiosk |
| `INV-LIFE-009` | Kiosk test is record-class: refused only when `LODGE` is everything |
| `INV-LIFE-010` | The `canLogin` term applies to `SCHOOL` alone; every other class is cancellable |
| `INV-LIFE-011` | Both callers feed the rule one shape; nothing refused is offered |
| `INV-LIFE-012` | Cancellation approval leaves access roles standing; `active: false` is the load-bearing flag |
| `INV-LIFE-013` | Two paths write `active: true`; each refuses cancelled, archived and deleted members |
| `INV-LIFE-014` | A deleted account yields no session even with `active: true`; providers refuse |
| `INV-LIFE-015` | The deleted-account marker is a strong signal, not a schema invariant |
| `INV-LIFE-016` | Cancellation clears no roles and no JWT; admin-access routes re-read `active` |
| `INV-LIFE-017` | Application-approval mapping preserves login uniqueness and auth, and never double-charges coverage |
| `INV-LIFE-066` | The applicant MAP path's #1026 privileged-email gate is Full-Admin-only, fail-closed |
| `INV-LIFE-067` | On-behalf booking pickers are `bookings:edit`-scoped and never require `membership:view` |
| `INV-LIFE-068` | MG4's member-guest picker: email mode `bookings:edit`, name mode also `membership:view` |
| `INV-LIFE-069` | On-behalf creation matches modification, and no on-behalf actor may target themselves |
| `INV-LIFE-070` | A Booking Officer may inline-create a non-login non-member booking owner |
| `INV-LIFE-071` | Legacy `Member.role`, seasonal assignment storage and age tiers stay separate axes |
| `INV-LIFE-072` | Built-in membership types never delete or merge; custom merges have preconditions |
| `INV-LIFE-073` | `NOT_APPLICABLE` is resolved by one shared helper on a four-step precedence ladder |
| `INV-LIFE-018` | Guards for age-exempt types, allowed-tier edits and N/A flips |
| `INV-LIFE-091` | Roll-forward reconciles age tiers in chunks; Xero import only creates assignments |
| `INV-LIFE-019` | `NOT_APPLICABLE` has no `AgeTierSetting` row and sits outside every age-based automation |
| `INV-LIFE-084` | Committee assignment is presentation only; contact routing per assignment via `contactEmailMode` |
| `INV-LIFE-085` | Member photos: scoped endpoint only; public only when rostered and displayed |
| `INV-LIFE-086` | Every stored image has EXIF/XMP metadata stripped; member-photo path fails closed |
| `INV-LIFE-087` | Seasonal membership type governs pricing and lockout, never access or committee |
| `INV-LIFE-020` | 2FA on: the JWT claim flips only via a server-minted challenge |
| `INV-LIFE-021` | A `FamilyGroup` with no `FamilyGroupMember` rows is inert everywhere |
| `INV-LIFE-022` | Family-group facts: the guest-eligibility correction, billing recipients, and memberless groups |
| `INV-LIFE-023` | Unregistered partner invites: single-use hashed token, claimable only by that email |
| `INV-LIFE-024` | Declared partner link: symmetric consented ordered pair; at most one CONFIRMED |
| `INV-LIFE-090` | Partner request API: by-email targets never disclose partner status (D9) |
| `INV-LIFE-025` | Parent/dependant links are limited to four generations and two parents |
| `INV-LIFE-026` | Depth cap checked symmetrically at link time by every parent-link writer |
| `INV-LIFE-027` | Merge is a parent-link writer by consequence; refuses depth and cycles |
| `INV-LIFE-028` | Admin member-create validates on the base client, leaving a millisecond over-deep window |
| `INV-LIFE-029` | Depth walks are level-bounded, report the longest path, refuse incomplete information |
| `INV-LIFE-030` | Parentage is recorded at any age; every real power is gated elsewhere |
| `INV-LIFE-031` | Every row of that table lands on the family-group gate (#2284) |
| `INV-LIFE-032` | Recording a young parent grants only a label and a mail-routing question |
| `INV-LIFE-033` | The parent side still requires active, non-archived, and a person |
| `INV-LIFE-034` | Organisations are excluded by role, never by age tier |
| `INV-LIFE-035` | Family group is the authorisation boundary; every login-holding adult is equal |
| `INV-LIFE-036` | The dividing line is `canLogin`, not age; nothing changes at eighteen |
| `INV-LIFE-037` | The four powers over a non-login member, and the cancellation-request confirmation flag |
| `INV-LIFE-074` | Adding a non-login member notifies them or their family adults |
| `INV-LIFE-075` | A delegated details edit shows read-only provenance on the family cards |
| `INV-LIFE-076` | One-step partner declaration keys on the voucher pointer, not family-group role |
| `INV-LIFE-077` | Family-group membership carries no rank; membership is the only fact recorded |
| `INV-LIFE-038` | What one member may see about another's parent: a deliberate two-layer whitelist |
| `INV-LIFE-039` | That whitelist is enforced server-side field by field; admin surfaces are unchanged |
| `INV-LIFE-040` | Admin link route's other requirements; target never the parent's ancestor |
| `INV-LIFE-041` | Candidate search and write guards: one identity predicate; options validated separately |
| `INV-LIFE-042` | Parent-candidate ranking puts non-minors first: a re-order of eligibles, never a filter |
| `INV-LIFE-043` | Three load-bearing rules: nullable columns, required graph facts, no no-op unsatisfiable clauses |
| `INV-LIFE-044` | Four generations confirmed; transitive email inheritance dropped (owner, 9 Aug 2026) |
| `INV-LIFE-045` | Delete eligibility counts direct dependants only, which stays correct at four generations |
| `INV-LIFE-046` | Family links grant no billing or fee coverage, contract-enforced |
| `INV-LIFE-047` | Email inheritance is DIRECT-PARENT ONLY: inherit from a parent or nobody |
| `INV-LIFE-048` | Accepted gap surfaced: one definition of unreachable, read by both surfaces |
| `INV-LIFE-049` | Two columns: the choice made and the terminal mailbox derived |
| `INV-LIFE-050` | Inherit sources are non-inheriting adults with a real address, or refused |
| `INV-LIFE-051` | Stored pointers are re-read before trust; inheriting members are no mailbox |
| `INV-LIFE-052` | Provenance, not identity, decides what unlinking clears |
| `INV-LIFE-053` | Pointers re-resolve on every address add, change or remove, transactionally |
| `INV-LIFE-054` | Daily convergence sweep backs those calls; safe to re-run |
| `INV-LIFE-055` | All four removal paths detach inbound links, never re-parenting the dependants |
| `INV-LIFE-056` | All four read who they detach before nulling, through one helper |
| `INV-LIFE-057` | The detach notice never claims those members now receive club email |
| `INV-LIFE-058` | Pending nomination states need a documented recovery path; applications never stall |
| `INV-LIFE-059` | Induction sign-off is one overall pass per signer, not an assignment |
| `INV-LIFE-060` | Trusted legacy induction baseline: a one-off exception with a defined population |
| `INV-LIFE-061` | Applying that baseline needs Full Admin and exact confirmations; new rows only |
| `INV-LIFE-063` | Hard delete stays limited to records passing every durable-history eligibility check |
| `INV-LIFE-064` | Family Group screens show a calculated age: one helper, never stored |
| `INV-LIFE-065` | Member profile merge: Full Admin only, additive, master-wins, re-derived field patch |
| `INV-LIFE-088` | Merge protects the four family-link columns three ways; drift refuses (#2437) |
| `INV-LIFE-078` | Every Member-referencing relation is classified move, resolve, cascade or snapshot |
| `INV-LIFE-079` | A meaningful loser subscription colliding with a master-held season blocks merge |
| `INV-LIFE-080` | Xero teardown deactivates the loser's links, re-pointing only the entrance-fee invoice |
| `INV-LIFE-081` | Xero contact writers are lifecycle-fenced under Member row locks |
| `INV-LIFE-082` | Full Admin only, guarded, preview-token-verified, phrase-confirmed and audited |
| `INV-LIFE-083` | Every refusal writes one best-effort, non-PII `MEMBER_MERGE_REFUSED` audit row |

## Integrations

Webhooks, cron idempotency, provider callbacks, and Xero member contact-group
grouping.
File: [`invariants/integrations.md`](invariants/integrations.md). Prefix
`INV-INT`.

| ID | Covers |
| --- | --- |
| `INV-INT-001` | Webhooks and cron jobs must be idempotent |
| `INV-INT-002` | Provider callbacks must verify signature, state or expected origin before local mutation |
| `INV-INT-003` | External provider calls stay outside long database transactions without a documented reason |
| `INV-INT-004` | Email, Xero and payment failures affecting business outcomes are visible and retryable |
| `INV-INT-005` | Logs, webhooks, Sentry, PR comments never expose secrets, tokens, personal data |
| `INV-INT-006` | One club-level mode governs Xero member auto-grouping; one rules table |
| `INV-INT-007` | Xero contact groups are never deleted; only managed membership changes |
| `INV-INT-008` | `NONE` mode is a total no-op on per-member sync and cancellation |
| `INV-INT-009` | Rules target a canonical age-tier set; empty set is the wildcard |
| `INV-INT-010` | Grouping resolution is pure and mode-driven, most-specific first, with deterministic tie-breaks |
| `INV-INT-011` | Add-suppression: a member already in a matched accepted group is skipped |
| `INV-INT-012` | The cutover migration deactivates every pre-existing rule it did not backfill itself |
| `INV-INT-013` | Mode or rule changes never auto-resync; members re-group on next trigger |
| `INV-INT-014` | Per-member sync: Xero calls outside transactions, ops ledgered, adds before removes |
| `INV-INT-015` | The bulk re-sync is admin-triggered, dry-run-first, chunked, resumable, never moves the watermark |
| `INV-INT-016` | The rooms API keeps its no-`lodgeId` mode for external consumers only |
| `INV-INT-017` | Xero NZBN field carries date of birth via one shared codec |

## Operations

Raw SQL, advisory and row locking, production deployment including the worked
windowed column drop, changing what values already stored in a column mean, and
what may be used as test input.
File: [`invariants/operations.md`](invariants/operations.md). Prefixes `INV-OPS`
and `INV-LOCK` — the latter is the two-tier advisory-lock protocol, kept beside
the row-locking rules it is the sibling of.

| ID | Covers |
| --- | --- |
| `INV-OPS-001` | Raw SQL never declares its result shape; lock raw, read typed |
| `INV-LOCK-001` | The scoped tier is the default; the global key is deliberate |
| `INV-LOCK-002` | Global before per-lodge; one helper mints the per-lodge capacity key |
| `INV-LOCK-003` | Every global-lock call site is registered, by site, with its own reason |
| `INV-LOCK-004` | A read taken under a lock uses the caller's transaction client |
| `INV-OPS-014` | Never interpolate or concatenate into `$queryRawUnsafe` / `$executeRawUnsafe` |
| `INV-OPS-013` | A `"use client"` module never imports server-only code at runtime |
| `INV-OPS-002` | Production deployment must respect `docs/BLUE_GREEN_MIGRATION_POLICY.md` |
| `INV-OPS-012` | Audit reclassification ships its backfill or files one; measured audience stated |
| `INV-OPS-005` | Doomed columns need `@ignore`: static defaults and implicit `RETURNING` name them |
| `INV-OPS-006` | Post-drop the compiler catches only `where`; `select` and `create` fail at runtime |
| `INV-OPS-007` | The surviving guard test pins the generated client's shape and raw SQL |
| `INV-OPS-008` | Payload readers must be gone before the drop, not just authorisation readers |
| `INV-OPS-009` | How the role-column drop shipped, and why the two-step plan was superseded |
| `INV-OPS-010` | A windowed drop: the `windowed` ledger row, rollback SQL, operator sequence |
| `INV-OPS-011` | The dropped column's stored values were meaningless rather than frozen |
| `INV-OPS-003` | Public CI and local validation must use test/demo credentials or placeholders |
| `INV-OPS-004` | Production data, backups, live providers and webhooks are not test inputs |

## Product Configuration

What varies between clubs gets a configuration surface rather than a constant,
an upgrade that adds one falls back safely, and an unconfigured state is visible
where an operator must act.
File:
[`invariants/product-configuration.md`](invariants/product-configuration.md).
Prefix `INV-CONFIG`. Added by #2720; it is not one of the ten pre-split domain
headings the index keeps verbatim.

| ID | Covers |
| --- | --- |
| `INV-CONFIG-001` | Club-varying values get a configuration surface; upgrades fall back safely and visibly |
| `INV-CONFIG-002` | One persisted IANA club timezone is the sole civil-time authority |
| `INV-CONFIG-003` | One explicit `APP_ENVIRONMENT_ROLE` decides production; nothing inferred, missing is UNKNOWN, deploy blocked |
| `INV-CONFIG-004` | Every application-controlled send passes one environment-aware boundary; four outcomes, all distinguishable |
| `INV-CONFIG-005` | Every application-managed Xero contact write consumes the canonical role; copies contained |

## Single Source Of Truth

A fact is defined once and read from that one place — what this repository
already requires of documentation, required of code. Prefer making the wrong
thing unrepresentable over policing it.
File:
[`invariants/single-source-of-truth.md`](invariants/single-source-of-truth.md).
Prefix `INV-SSOT`. Added by #3126, out of the Club Time epic (#2988) where the
cost of the missing rule was measured rather than argued; it is not one of the
ten pre-split domain headings the index keeps verbatim.

| ID | Covers |
| --- | --- |
| `INV-SSOT-001` | One canonical definition per concept; structural remedy preferred over guard |
| `INV-SSOT-002` | Both sides of a comparison come from one helper; encoding included |
| `INV-SSOT-003` | Authority-bearing parameters carry no default; lint exclusions judged and stated |
| `INV-SSOT-004` | Two instruments claiming independence must measure the same way; `stripComments` lives once |
