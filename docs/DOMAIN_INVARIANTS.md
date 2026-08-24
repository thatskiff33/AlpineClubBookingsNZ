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

Two supporting files sit beside them: the full id scheme in
[`SCHEME.md`](invariants/SCHEME.md), and the imperfections found
during the restructure and deliberately not fixed in it, in
[`_FOLLOW_UPS.md`](invariants/_FOLLOW_UPS.md).

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
| `INV-PUB-001` | Fee/policy PageContent blocks are enabled and server-rendered; a token alone publishes nothing |
| `INV-PUB-002` | Public fees use current effective-dated schedules; joining fees resolve from `JoiningFee` only |
| `INV-PUB-003` | A named lodge token resolves one active lodge or nothing; view models exclude ids and secrets |

## Money

How money is represented and where a price comes from.
File: [`invariants/money.md`](invariants/money.md). Prefix `INV-MONEY`.

| ID | Covers |
| --- | --- |
| `INV-MONEY-001` | Store and calculate money as integer cents |
| `INV-MONEY-002` | Annual and joining fee authorities: cents, non-overlapping windows per type and optional tier |
| `INV-MONEY-003` | Do not introduce floating point money arithmetic |
| `INV-MONEY-004` | Whole-lodge approval price: manual override, else an officer-elected flat rate covering every night, else per-guest |
| `INV-MONEY-005` | A promo "use" means a benefit was delivered; every cap counts only those allocation rows |
| `INV-MONEY-023` | Cap checks take the promo row lock and re-read the counter under it |
| `INV-MONEY-024` | A reprice narrows promo coverage and protects existing beneficiaries; it never refuses |
| `INV-MONEY-025` | A cap check excluding a booking subtracts that booking's own allocation rows |
| `INV-MONEY-026` | TRAP: the in-memory allocation list is not benefit-filtered; filter it yourself |
| `INV-MONEY-027` | A `SET_PRICE` application netting to exactly zero counts as no use |
| `INV-MONEY-006` | Refunds, credits, Stripe and Xero amounts reconcile back to cent-based ledger records |
| `INV-MONEY-007` | Admin adjustments need audit, approval, and a visible business reason |
| `INV-MONEY-008` | A confirmed subscription charge is immutable; only delivery, status and Xero metadata advance |
| `INV-MONEY-009` | An annual fee's components sum exactly to its total, one invoice line per component |
| `INV-MONEY-010` | Each `MemberSubscription` is covered by at most one charge; confirmation is idempotent |
| `INV-MONEY-011` | `PER_MEMBER` bills the member, `PER_FAMILY` one explicit recipient, `NO_INVOICE` zero cents |
| `INV-MONEY-012` | Club `familyBillingMode` decides whether family billing exists; a stale schedule raises an exception |
| `INV-MONEY-013` | A multi-family member's per-family fee bills only via their admin-chosen billing family |
| `INV-MONEY-014` | One family/type/membership-year tuple carries at most one durable charge |
| `INV-MONEY-015` | Membership approval stands when billing setup is incomplete; billing records a visible exception |
| `INV-MONEY-016` | Membership type alone decides subscription liability; access role grants no exemption |
| `INV-MONEY-017` | Paid-up: a NOT_REQUIRED type, a PAID current-season row, or an exempt age tier; nomination honours only the first |
| `INV-MONEY-018` | Manual subscription mark-paid is cash-only and never clobbered; a Xero link reclaims authority |
| `INV-MONEY-019` | Opt-in (default off) item-code look-through detects paid subscriptions from every fee-schedule component code, plus the flat code |
| `INV-MONEY-020` | Look-through on: subscription-invoice selection is strong-first, then settled, then earliest; off keeps legacy first-match |
| `INV-MONEY-021` | Xero invoice identity persists before email; invoices are adopted only on an exact AUTHORISED match |
| `INV-MONEY-022` | A member has at most one joining-fee invoice; conflicts surface rather than adopt silently |

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
| `INV-DATE-002` | Night N runs midday NZ on date N to midday NZ on date N+1 |
| `INV-DATE-003` | A stay is the half-open range `[checkIn, checkOut)` expanded to nights; explicit `BookingGuestNight` rows override the envelope |
| `INV-DATE-004` | Presence on day D: morning half from D−1's night, evening half from D's |
| `INV-DATE-005` | Two helper families — night model for resources, operational-day for people |
| `INV-DATE-020` | One expander turns a stay into nights; its envelope branch stays half-open |
| `INV-DATE-021` | Kiosk attendance is one current state per stay, re-read per segment |
| `INV-DATE-022` | A SQL stay filter is coarse; kiosk write lookups decide over the night rows |
| `INV-DATE-006` | The lobby wall is deliberately mixed and stays on its own fenced path |
| `INV-DATE-023` | The lobby wall's night count is derived independently of what it shows |
| `INV-DATE-007` | Departing lodge A and arriving at lodge B on one date is legal |
| `INV-DATE-008` | Zero-night bookings expand to no nights and every route refuses them |
| `INV-DATE-009` | Six areas sit deliberately outside the boundary and must not be aligned |
| `INV-DATE-010` | `@db.Date` holds an NZ calendar date; UTC midnight is encoding, not meaning |
| `INV-DATE-011` | Lodge bookings use NZ date-only nights, not arbitrary timestamps |
| `INV-DATE-012` | `BookingGuest.stayStart`/`stayEnd` are date-only occupancy in the envelope |
| `INV-DATE-013` | Compare date columns only against date-only values, never a raw clock |
| `INV-DATE-024` | `Member.dateOfBirth` is a calendar day at UTC midnight; never a local-midnight parse, never an instant comparison |
| `INV-DATE-019` | Ask the club's calendar for "today", never the UTC clock |
| `INV-DATE-014` | Client-side a lodge night is an NZ `yyyy-MM-dd` string, carried end to end |
| `INV-DATE-015` | Rendering has one seam, `nzst-date.ts`; bare `toLocale*` is lint-blocked |
| `INV-DATE-016` | `formatNZLongDate` is reserved for four named member-facing surfaces |
| `INV-DATE-017` | Two check-out boundaries coexist: completion `<` today, queues `<=` today |
| `INV-DATE-018` | Base Reports uses lodge nights, one positive cohort, cents-exact allocation |
| `INV-CAP-001` | Capacity is per lodge; no path may sum beds across lodges |
| `INV-CAP-002` | `lodgeId` is NOT NULL on six tables via a default-lodge column default |
| `INV-CAP-003` | `getLodgeCapacityStatus` resolves capacity; an explicit capacity caps beds |
| `INV-CAP-004` | `capacityHoldingBookingFilter()` decides which bookings consume beds |
| `INV-CAP-005` | A split guest portion always settles or is notified, never stranded |
| `INV-CAP-006` | Bed-allocation eligibility is a status-only superset of capacity-holding |
| `INV-CAP-032` | Every guest-creating path writes the canonical `BookingGuestNight` set, half-open and cents-exact |
| `INV-CAP-007` | Auto-allocated stays are room-continuous per booking, with bounded fallback |
| `INV-CAP-008` | Allocation preferences are per lodge and advisory, never safety overrides |
| `INV-CAP-009` | Automated placement never mixes one booking's minors with another's adult; the manual board warns only |
| `INV-CAP-010` | A DOUBLE may hold two confirmed partners; breaking that precondition sweeps future shared rows |
| `INV-CAP-030` | Member merge sweeps only the future shared bed-nights its own validity re-check refuses |
| `INV-CAP-031` | Cancellation and archive need no sweep; placement, planner keys, indexes, headroom, partner auto-promotion |
| `INV-CAP-011` | Waitlisted and offered bookings hold no capacity until confirmed |
| `INV-CAP-012` | A waitlist offer reprices at current rates and states what will be paid |
| `INV-CAP-013` | A member may be present on only one live booking per lodge night |
| `INV-CAP-014` | A member on another's booking may remove their own place, and only that |
| `INV-CAP-015` | The person-night 409 payload is scoped to what the requester may see |
| `INV-CAP-016` | That 409 is flow-neutral; only the wizard adds "choose different dates" |
| `INV-CAP-017` | The person-night guard is app-level, lock-ordered and race-free by design |
| `INV-CAP-018` | A member holds at most one group-join roster row per group |
| `INV-CAP-019` | Draft, pending, waitlist, recovery and review states need repair paths |
| `INV-CAP-020` | Provisional-child cancellation is claim-guarded against the hold cron |
| `INV-CAP-021` | An exclusive whole-lodge hold blocks a night at zero beds, unbypassable |
| `INV-CAP-022` | A held booking owns no `BedAllocation` rows on any path, manual or auto |
| `INV-CAP-023` | A held booking's nights are unattributed, non-displaceable planner occupancy |
| `INV-CAP-024` | The requested-room lock follows approved rows, not the exclusive hold |
| `INV-CAP-025` | Approving beds is always scoped; an unselected approval is refused |
| `INV-CAP-026` | The requested-room lock is two-way; move and reviewed removal re-open it |
| `INV-CAP-027` | Allocation moves keep their nights, require review, commit atomically |
| `INV-CAP-028` | Destructive removal is preview-bound, digest-checked, and never replans |
| `INV-CAP-029` | A range assignment writes all or nothing and audits itself exactly once |
| `INV-CAP-033` | The board offers no bed choice without a concrete lodge; every club-wide board is read-only and says why |
| `INV-CAP-034` | A booking names its lodge; the create refuses rather than defaulting, and the member is always shown it |
| `INV-LIFE-062` | A hut-leader assignment may hold one bed: a custodian occupancy, on inclusive night semantics |

## Payment And Settlement

How money is taken, cleared, credited and refunded.
File:
[`invariants/payment-and-settlement.md`](invariants/payment-and-settlement.md).
Prefix `INV-PAY`.

| ID | Covers |
| --- | --- |
| `INV-PAY-001` | Manual mark-paid provenance for booking payments, and the predicate that reads it |
| `INV-PAY-038` | Mark-paid is a sibling entry point into the one settlement body, not a second path |
| `INV-PAY-039` | Mark-paid never calls Xero, and is refused on any Xero evidence |
| `INV-PAY-040` | A capacity failure refuses the mark-paid and records nothing |
| `INV-PAY-041` | Invoice minting is fenced at enqueue, at settle, and in the handler |
| `INV-PAY-042` | Inbound Xero PAID on a manually settled booking is raised, never quietly ignored |
| `INV-PAY-043` | Duplicate capture on a cash-settled booking is auto-refunded, not silently kept |
| `INV-PAY-044` | Cancelling a manually settled booking yields a durable `ManualRefundTask`, never a card refund |
| `INV-PAY-045` | Reversal is permitted only while nothing has happened that it could not undo |
| `INV-PAY-046` | An outstanding upward-modification delta is asked about, never silently absorbed or left behind |
| `INV-PAY-047` | The generalised ledger mirror: every cent is collected, paid with credit, or still owed |
| `INV-PAY-048` | A stored unconsumed credit election is cleared, recorded and reported, never stranded |
| `INV-PAY-049` | Both directions are audited with the acting admin and the previous status |
| `INV-PAY-050` | Xero Stripe refund notes cover provider-backed cash evidence, never the refunded-amount mirror |
| `INV-PAY-002` | Account credit is consumed only at `PAYMENT_PENDING`; a draft stores an election and spends nothing |
| `INV-PAY-003` | The edit path may write an election only onto DRAFT, AWAITING_REVIEW and PAYMENT_PENDING |
| `INV-PAY-004` | Members may edit their own drafts; a draft edit moves no money and claims no capacity |
| `INV-PAY-005` | The credit election is consumed by a guarded claim, never a read-then-write |
| `INV-PAY-006` | A stored election is clamped at confirmation, never refused, and the shortfall is always reported |
| `INV-PAY-007` | A booking with nothing left to pay settles at $0 inside the pay transaction |
| `INV-PAY-008` | A $0 waitlist confirm always ends in a movable state; four distinct coded outcomes |
| `INV-PAY-009` | No settled booking carries a stored credit election; every settlement clears it under a guard |
| `INV-PAY-010` | A clear is reported only where the member lost something; a $0 settlement clears silently |
| `INV-PAY-011` | Neither report may quote the elected figure as still available; the live balance is read |
| `INV-PAY-012` | The public payment link refuses a booking carrying an election rather than ignoring it |
| `INV-PAY-013` | Stripe and Internet Banking/Xero settlement paths must remain distinct |
| `INV-PAY-014` | Stripe paths own PaymentIntents, SetupIntents, refunds, webhooks and recovery operations |
| `INV-PAY-015` | Internet Banking bookings issue Xero invoices and reconcile through Xero invoice/payment state |
| `INV-PAY-016` | Internet Banking defaults are non-holding and no-cutoff; an enabled hold is released idempotently |
| `INV-PAY-017` | Hold-expiry release and its invoice-clearing credit-note outbox row commit in one transaction |
| `INV-PAY-018` | Cancelling never rewrites captured-payment truth; "captured" is decided on ledger evidence |
| `INV-PAY-019` | Applied credit is conserved across every cancellation branch; restore is structurally idempotent |
| `INV-PAY-020` | A confirmation reconciles against the member's statement: total minus credit equals settled |
| `INV-PAY-021` | An unpaid confirmation defers to the invoice and promises nothing about it |
| `INV-PAY-022` | An unpaid confirmation carrying applied credit states the netting, from the club's own ledger |
| `INV-PAY-023` | Applied credit reduces an Internet Banking invoice by allocating existing floating credit notes |
| `INV-PAY-024` | Applied credit reduces the card charge too; the intent mints at the effective amount |
| `INV-PAY-025` | A payment on a cancelled booking's stale invoice needs positive cash evidence before minting credit |
| `INV-PAY-026` | The same cash-evidence rule gates Internet Banking settlement itself, on both inbound surfaces |
| `INV-PAY-027` | Payment, refund and credit operations must be idempotent across retries, replays and reruns |
| `INV-PAY-028` | The Stripe webhook dedup claim is a processing lease, not a bare "seen" marker |
| `INV-PAY-029` | A FAILED Stripe payment does not reap its WAITING_PAYMENT Xero op until a 24h grace passes |
| `INV-PAY-030` | External provider side effects require clear retry and idempotency behaviour |
| `INV-PAY-031` | Organiser-pays settlement applies only if the payment matches the settleable children at apply time |
| `INV-PAY-032` | Group children confirmed before payment have a reaper that releases the beds and notifies |
| `INV-PAY-033` | Reverted group children have a terminal path: a second unretried reap window cancels them once |
| `INV-PAY-034` | Organiser-cancel cleanup is re-drivable; the frozen per-child refund plan is never recomputed |
| `INV-PAY-035` | Organiser cancellation is a durable settlement fence, written under global `lock(1)` first |
| `INV-PAY-036` | Each group-cancel child's refund credit-note enqueue commits inside that child's cancel transaction |
| `INV-PAY-037` | A failed settlement refund stays durably owed; no interleaving may apply a child mirror twice |

## Member-Guest Consent

When a member added as somebody else's guest must be asked first, and what each
answer is recorded as.
File:
[`invariants/member-guest-consent.md`](invariants/member-guest-consent.md).
Prefix `INV-GUEST`.

| ID | Covers |
| --- | --- |
| `INV-GUEST-001` | Member-guest consent state lives in five `BookingGuest` columns, not a side table |
| `INV-GUEST-002` | MG1 shipped those columns inert; MG2 turns them on behind the `memberGuests` module |
| `INV-GUEST-003` | Two chosen behaviours: an approved stay extends without re-asking, and declining can be refused |
| `INV-GUEST-004` | `NULL` is not `CONFIRMED`: null means consent was never needed, and conflating them is irreversible |
| `INV-GUEST-005` | A consent never solicited is recorded as such; `consentRequestedAt` is the discriminator |
| `INV-GUEST-006` | A `DECLINED` row must name who declined; an unattributed decline is a broken row |
| `INV-GUEST-007` | Who answered is audited separately from who was asked, in one column |
| `INV-GUEST-008` | Nobody answers for a member who can sign in; the delegate rule gates actor and target |
| `INV-GUEST-009` | A delegate's answer is emailed to the member it was given for, carrying no money or booking link |
| `INV-GUEST-010` | A `PENDING` row holds the bed until `consentExpiresAt`; no expiry is not a legal shape |
| `INV-GUEST-011` | Consent is not transitive across bookings; a copy is re-stamped as an admin assignment |
| `INV-GUEST-012` | A merged-away member's guest rows keep their consent, and the survivor inherits it |
| `INV-GUEST-013` | A pending guest is not operationally present, via one explicit `OR` over the nullable column |
| `INV-GUEST-014` | A pending guest does hold a bed and a person-night; no capacity path may filter on consent |
| `INV-GUEST-015` | A data-subject export is not an operational surface and includes the member's pending rows |
| `INV-GUEST-016` | MG4 closes the edit path, admin parity and the booking-request pipeline; the officer picker gates NAME mode on `membership:view`, and a member's address never travels in a URL |
| `INV-GUEST-017` | Exactly eight column shapes are legal, and the table lists them |
| `INV-GUEST-018` | That table is generated from the code table by a test, so it cannot go stale |

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
| `INV-MOD-001` | Booking changes must not orphan or desynchronize guests, money, Xero, beds, audit or waitlist |
| `INV-MOD-002` | Deltas, credits, refunds and additional payments stay traceable to booking and modification |
| `INV-MOD-003` | A modification increase whose Stripe intent fails transiently is never lost silently |
| `INV-MOD-004` | Guest stay ranges sit inside the booking envelope; an outside range auto-expands the dates |
| `INV-MOD-005` | Nightly prices lock at booking time; only changed guests and nights price at current rates |
| `INV-MOD-006` | Every edit path passes the default group discount into pricing; locked nights win over it |
| `INV-MOD-026` | One club switch, applied at one chokepoint, decides whether a later edit's new nights earn the group discount; default on, locked nights untouched either way |
| `INV-MOD-027` | An officer may price a guest who is on the club's non-member rate at its member rate as a partner-lodge member; eligibility follows the RATE rather than `isMember`, is withheld from anybody owing a subscription under every lockout mode, changes the rate only, stores the flag only for guests pricing actually rated, and reprices exactly the guests whose tick changed |
| `INV-MOD-007` | Hut nightly rates key on membership type and optional age tier, never a member boolean |
| `INV-MOD-008` | An unpaid member repriced under `NON_MEMBER_PRICING` is `NON_MEMBER_DEFAULT`, not forced |
| `INV-MOD-009` | Membership, not the subscription, gates member-only promotions; a repriced member stays eligible |
| `INV-MOD-010` | Every priced guest stores a rate-type snapshot; a guest keeping a locked night keeps it stale |
| `INV-MOD-011` | Every reduction path returns money limited by the cancellation tier; a captured payment requires a settlement election |
| `INV-MOD-012` | A pre-payment reduction below applied credit refunds the over-consumed slice under the ledger lock |
| `INV-MOD-013` | A modification parked to AWAITING_REVIEW refunds no credit and auto-pays nothing until released |
| `INV-MOD-014` | Xero deallocation commits the clamp offset and its outbox op in one member-credit-locked transaction |
| `INV-MOD-015` | After verification the superseded allocation links are deactivated and replaced by Xero's real ids |
| `INV-MOD-016` | Deallocation crash/retry: resume checkpointed ids, never guess an ambiguous total; allocated credit comes from `MemberCreditNoteAllocation`, not the coarse `xeroCreditNoteId` stamp |
| `INV-MOD-017` | Legacy stamped applications are repaired under the same lock before clamp, cancel, expiry or read |
| `INV-MOD-018` | Every modification path applies the same lifecycle transitions, whichever endpoint made the change |
| `INV-MOD-019` | Self-service edits obey the date-window edit policy; an in-progress stay extends future nights only, and minimum stay is then evaluated over the whole contiguous stay |
| `INV-MOD-025` | An in-progress edit prices the nights a guest holds, not their envelope, sells only the nights it creates, and values each at the price it was sold for, never leaving a guest owing less than nothing; ordinary stays are unchanged and history is not repriced |
| `INV-MOD-020` | Minimum stay is the first exception-foundation consumer; only two soft reason codes exist |
| `INV-MOD-021` | The frozen violation explains a refusal, never authorises one; every member path stops server-side |
| `INV-MOD-022` | The admin exemption is not one predicate, and is stated per path |
| `INV-MOD-023` | Advisory surfaces report the same facts and gate nothing; no row is persisted, no capacity reserved |
| `INV-MOD-024` | Minimum-stay policy administration is versioned; a stale version is refused, not overwritten |

### Adult-member hosting

Whether a non-member guest-night must overlap an adult member who is actually
staying, and what happens when that cover is taken away.
File:
[`invariants/adult-member-hosting.md`](invariants/adult-member-hosting.md).
Prefix `INV-HOST`.

| ID | Covers |
| --- | --- |
| `INV-HOST-001` | A club may require every non-member guest-night to overlap an adult member actually staying |
| `INV-HOST-002` | One policy row per scope, `scopeKey` pinned by CHECK and unique index, every write versioned |
| `INV-HOST-003` | A lodge row replaces the club default; an unidentifiable scope is refused, never read as disabled |
| `INV-HOST-004` | Who may host: an active, unarchived ADULT member linked to a guest row on that exact night |
| `INV-HOST-005` | Nights come from sparse `BookingGuestNight` rows; older rows fall back to the guest's own envelope |
| `INV-HOST-006` | A #738 split booking borrows its same-member sibling's adults as host-only participants |
| `INV-HOST-007` | That borrowing is symmetric, so every mutation reconciles the booking and its live siblings |
| `INV-HOST-008` | Under `ADMIN_REVIEW_REQUIRED`: a review, not a refusal, in its own `Booking` columns, never blocking lodge check-in |
| `INV-HOST-009` | The admin exemption is stated per path; only a reasoned on-behalf create opens APPROVED |
| `INV-HOST-010` | Re-evaluation is idempotent and runs on every path that can change or create a party |
| `INV-HOST-011` | #2364 stops at configuration, the evaluator and these seams; request state belongs to #2365 |
| `INV-HOST-012` | The policy is two independent dimensions — consequence and host scope — resolved separately |
| `INV-HOST-013` | Three consequences: `DISABLED`, `ADMIN_REVIEW_REQUIRED`, and `ENFORCED`, which refuses the booking |
| `INV-HOST-014` | `INHERIT` stays lodge-only for the consequence; both host-scope columns are null or set together |
| `INV-HOST-015` | Two scopes only: same booking and same booking owner; the wider two were removed, not deferred |
| `INV-HOST-016` | The built-in default is same-booking only, which is what makes the upgrade a no-op |
| `INV-HOST-017` | Enabled scopes are OR-ed per night, and every non-member guest-night must be covered |
| `INV-HOST-018` | An active policy with no scope enabled is refused, never read as permissive or as universal |
| `INV-HOST-019` | Host identities are never disclosed to the booking owner; the officer's snapshot keeps them |
| `INV-HOST-020` | School and organisation approvals are review-only; the member whole-lodge approval is not exempt |
| `INV-HOST-021` | An explicit admin decision carrying a reason is an approval, even under `ENFORCED` |
| `INV-HOST-022` | The officer queue names the consequence from the frozen violation, never the live policy row |
| `INV-HOST-023` | Same-owner coverage reuses every same-booking definition and adds only where the host may be |
| `INV-HOST-024` | Cross-booking strand checks need same-owner scope; own-booking seams still queue under `ENFORCED`, and `ADMIN_REVIEW_REQUIRED` still re-reads dependents |
| `INV-HOST-025` | A member's change to their own booking is refused when it would strand another of theirs |
| `INV-HOST-026` | The refusal is gated on the ACTOR: a non-owner is allowed through, escalated, and told nothing |
| `INV-HOST-027` | "Newly" uncovered is the test, compared on the shared material-identity key |
| `INV-HOST-028` | An authorised officer is asked to confirm, then allowed and escalated, against a versioned digest |
| `INV-HOST-029` | A change to one person's standing enqueues the check it owes, under ordered member row locks |
| `INV-HOST-030` | Every confirming path re-reads the facts at confirmation; the census proves it two ways |
| `INV-HOST-031` | Coverage and member merge share one ordered handshake on a per-owner advisory lock |
| `INV-HOST-032` | An incident is only opened for a booking the club has accepted — confirmed active attendance |
| `INV-HOST-033` | One active incident per booking; owner notification is lease-fenced, at-least-once delivery |
| `INV-HOST-034` | Resolution is recorded as one of four causes, never inferred from a hazard's absence |
| `INV-HOST-035` | Three of the four resolutions close in the changing transaction; `COVERAGE_RESTORED` only via the post-commit drain |
| `INV-HOST-036` | The queue is at-least-once; database effects are idempotent, email has a stated ambiguity |
| `INV-HOST-037` | The officer queue sits above the admin bookings list, with no separate acknowledgement |
| `INV-HOST-038` | The inline drain is scoped to the booking just written; the cron drains everything |
| `INV-HOST-039` | Every path that can enqueue must also drain, asserted tree-wide by a census |
| `INV-HOST-040` | Dependent reads have their own ordered, logged ceiling, separate from the source read's |

### Booking requests

File:
[`invariants/booking-requests.md`](invariants/booking-requests.md). Prefix
`INV-REQ`.

| ID | Covers |
| --- | --- |
| `INV-REQ-001` | An officer's decision carries two notes, and which audience reads which is table-wide |
| `INV-REQ-002` | `adminNotes` is member-visible, on both request tables and both request kinds |
| `INV-REQ-003` | `internalNotes` is never member-visible, on either table or either kind |
| `INV-REQ-004` | Four structural properties hold that boundary, so no single call site has to remember it |
| `INV-REQ-005` | A private note never substitutes for the member-facing one; drafts are kept per request id |
| `INV-REQ-006` | The column is an expand-only nullable addition, so an older decision reads correctly as "none" |
| `INV-REQ-007` | The member's projection states only facts: capacity from the ledger, conflicts reported, no promises |

### Subscription-lockout pricing, admin date overrides and member-facing email

File:
[`invariants/subscription-lockout-pricing.md`](invariants/subscription-lockout-pricing.md).
Prefix `INV-LOCKOUT`.

| ID | Covers |
| --- | --- |
| `INV-LOCKOUT-001` | Owner rule: an unpaid member pays non-member rates, is told why, and needs a paid-up adult |
| `INV-LOCKOUT-002` | Three rules on one reused predicate: reprice, paid-up adult present, and the member-facing sentences |
| `INV-LOCKOUT-003` | `MembershipLockoutSettings.mode` picks `NO_BLOCK`, `HARD_BLOCK` or `NON_MEMBER_PRICING`, alone |
| `INV-LOCKOUT-004` | Independent booking failures are reported together, with both codes and one exception review |
| `INV-LOCKOUT-005` | Two migrations, one deploy: expand adds `mode`, contract backfills it and drops `enabled` |
| `INV-LOCKOUT-006` | The legacy mapping lives in the migration, not in a read-time fallback |
| `INV-LOCKOUT-007` | That drop is a windowed migration: the previous release reads `enabled` and cannot take a booking |
| `INV-LOCKOUT-008` | Bundle-format compatibility outlives the column; the legacy key maps to the mode it means |
| `INV-LOCKOUT-009` | The mode is resolved once per request and handed to both the gates and the pricing |
| `INV-LOCKOUT-010` | A failed mode read fails the request; it never quietly charges member rates |
| `INV-LOCKOUT-011` | The financial-year reseed is gated on the Xero module, not on the mode |
| `INV-LOCKOUT-012` | Only the refusals are mode-gated; the unpaid-member-guest lookups still run for the privacy rule |
| `INV-LOCKOUT-013` | There are six mode-gated refusal sites: the five routes plus the modify apply path |
| `INV-LOCKOUT-069` | The payment path carries no subscription gate by design, so a locked-out member can pay an on-behalf booking |
| `INV-LOCKOUT-070` | That journey's two non-payment edges: the 72-hour draft clock, and a $0 draft with no member pay step |
| `INV-LOCKOUT-014` | The paid-up-adult rule is evaluated on removals too; a consent decline or expiry is exempt |
| `INV-LOCKOUT-015` | The waitlist is the sixth money path: the offer states the reason, confirm re-checks without consuming |
| `INV-LOCKOUT-016` | D-12 applies on every path from the real consent column; a pending invite cannot be the paid-up adult |
| `INV-LOCKOUT-017` | The Xero line narrates the RATE from the snapshot, not the membership flag; no amount changes |
| `INV-LOCKOUT-018` | The reprice happens at the single pricing gate, not at the five write paths |
| `INV-LOCKOUT-019` | The paid-up-adult rule has two triggers: somebody repriced, or an unfinancial booking owner |
| `INV-LOCKOUT-020` | Both triggers use one owing test; the owner joins the facts batch, never the repriced set |
| `INV-LOCKOUT-021` | Why the owner trigger exists, and why it is gentler than `HARD_BLOCK` rather than stricter |
| `INV-LOCKOUT-022` | The requirement stays scoped; it never newly refuses bookings unrelated to subscriptions |
| `INV-LOCKOUT-023` | The rate notice follows the reprice, not the requirement, so it never describes an uncharged price |
| `INV-LOCKOUT-024` | The cross-lodge waitlist promotion is the seventh money path and reached none of the rule |
| `INV-LOCKOUT-025` | The two waitlist paths append one shared "you kept your place" sentence; the frozen message is unchanged |
| `INV-LOCKOUT-026` | Every write path passes the owner; a call-site census counts that argument file by file |
| `INV-LOCKOUT-027` | A missing paid-up adult is a 409 with a HOLD and an override door, carrying counts and no identities |
| `INV-LOCKOUT-028` | The frozen violation is unchanged; the member-facing response is audience-scoped on removals |
| `INV-LOCKOUT-029` | A violation must name the nights it holds; the owner arm falls back to the booking envelope |
| `INV-LOCKOUT-030` | A repriced member stops counting as a host, but their own nights never become uncovered |
| `INV-LOCKOUT-031` | `NON_MEMBER_PRICING` is a relaxation with exactly two narrow exceptions, both stated |
| `INV-LOCKOUT-032` | Both land on a reviewable 409 with the beds held; no `HARD_BLOCK` refusal becomes stricter |
| `INV-LOCKOUT-033` | The owner trigger adds no third exception: it replaces an outright `HARD_BLOCK` refusal |
| `INV-LOCKOUT-034` | Config transfer maps the legacy bundle key; unmapped, it would silently drop a real decision |
| `INV-LOCKOUT-035` | That hook derives only into an absent mode, and runs before the field-validation loop |
| `INV-LOCKOUT-036` | Reversal is a mode change: no migration, no code change, no already-taken booking repriced |
| `INV-LOCKOUT-037` | The admin-only date override: date-only, per-action notify, `pricingMode` `shift` — `recalculate` is `INV-LOCKOUT-053` |
| `INV-LOCKOUT-044` | The #1780 sweep extends the per-action notify choice to the remaining admin emails |
| `INV-LOCKOUT-045` | An account-deletion approval with bookings to cancel claims `APPROVAL_IN_PROGRESS` before cancelling |
| `INV-LOCKOUT-046` | That claim is taken only when there is something irreversible to protect |
| `INV-LOCKOUT-047` | `APPROVAL_IN_PROGRESS` is an OPEN state every outstanding-request reader must count |
| `INV-LOCKOUT-048` | A Full Admin may release a started approval back to `PENDING`, audited |
| `INV-LOCKOUT-049` | A released request is marked in the row, and rejecting one is gated and confirmed |
| `INV-LOCKOUT-050` | The flavour of `PENDING` a rejection was authorised against travels into the guarded claim |
| `INV-LOCKOUT-051` | The release and its audit record commit together, under that row's own lock |
| `INV-LOCKOUT-052` | A decision that loses its guard to a release is reported as exactly that |
| `INV-LOCKOUT-053` | The override's other `pricingMode` (`INV-LOCKOUT-037`): `recalculate` reprices in full, clamps lifted |
| `INV-LOCKOUT-038` | Under an override an over-capacity target is warn-and-confirm, recorded and audited |
| `INV-LOCKOUT-039` | Per-booking "No emails" withholds everything about that booking, enforced at the mailer |
| `INV-LOCKOUT-054` | Authenticated booking links follow the booking-detail read gate |
| `INV-LOCKOUT-055` | Admin-audience mail is never withheld; the registry's audience is the authority |
| `INV-LOCKOUT-056` | An unreadable switch withholds the send and records the row FAILED |
| `INV-LOCKOUT-057` | Every withhold writes a `SKIPPED_NO_EMAILS` `EmailLog` row with no retained body |
| `INV-LOCKOUT-058` | The retry cron re-reads the switch and the booking authority before every replay |
| `INV-LOCKOUT-059` | Waitlist candidacy excludes a silenced booking; two residual cases are surfaced, not denied |
| `INV-LOCKOUT-060` | A silenced waitlist entry keeps its place and the position quoted to others |
| `INV-LOCKOUT-061` | Xero-sent invoice emails are gated too, superseding the #1705 always-send carve-out |
| `INV-LOCKOUT-062` | Enabling the switch requires an acknowledgement; both set and clear are audited |
| `INV-LOCKOUT-063` | The acknowledgement is a two-button dialog, never a checkbox, gated on `bookings:edit` |
| `INV-LOCKOUT-064` | A persistent banner lists what was actually withheld, grouped per template with counts |
| `INV-LOCKOUT-065` | Two consequences nothing can record are stated in the acknowledgement dialog |
| `INV-LOCKOUT-066` | A member must never learn the switch exists, in the render or the RSC payload |
| `INV-LOCKOUT-067` | The per-action notify prompts are not offered while the switch is on |
| `INV-LOCKOUT-068` | The silenced path sends no `notifyMember` flag, never `false` |
| `INV-LOCKOUT-040` | Creation is today-or-future except an admin on-behalf retroactive create inside 365 days; the Xero period-lock guard reaches the modify paths too |
| `INV-LOCKOUT-041` | Shift overrides write no Xero documents; on-behalf over-capacity creates are warn-and-confirm |
| `INV-LOCKOUT-042` | A deliberately over-capacity booking is never destroyed by a later capacity re-check |
| `INV-LOCKOUT-043` | A finished stay's card obligation never lingers unseen: disjoint queues on one shared predicate |

### Booking-policy exceptions

File:
[`invariants/booking-policy-exceptions.md`](invariants/booking-policy-exceptions.md).
Prefix `INV-EXCEPT`.

| ID | Covers |
| --- | --- |
| `INV-EXCEPT-001` | The flow's scope — eligible SOFT failures only — and the immutable, self-proving proposal |
| `INV-EXCEPT-004` | The frozen evidence is authoritative; only reviewed, allowlisted violations can be stored |
| `INV-EXCEPT-005` | A held request's provisional reservation is per-night, directional and durable |
| `INV-EXCEPT-006` | Drift is set algebra over the frozen and the current violations of one proposal |
| `INV-EXCEPT-007` | `memberMessage` is required, trimmed, at most 1000 characters, normalised once |
| `INV-EXCEPT-008` | Only a `REQUESTED` request may move, once, under a guarded version claim |
| `INV-EXCEPT-009` | Every held bed carries an immutable deadline, and only a held bed does |
| `INV-EXCEPT-010` | Approval claims, releases and executes in one transaction |
| `INV-EXCEPT-002` | The request-creation half, and the dedicated store a new-booking proposal lives in |
| `INV-EXCEPT-011` | Violations are re-derived server-side; a proposal tripping none is refused |
| `INV-EXCEPT-012` | At most one open request per subject, enforced by a NULL-distinct unique index |
| `INV-EXCEPT-013` | Creation never changes a live booking |
| `INV-EXCEPT-014` | Cancel and supersede are guarded; a lost claim runs no side effect |
| `INV-EXCEPT-015` | The officer alert is fire-and-forget after commit, never in-band |
| `INV-EXCEPT-003` | The officer-decision half: approving executes in one transaction, never a status flip |
| `INV-EXCEPT-016` | The capacity recheck covers the full proposed party and excludes the live booking |
| `INV-EXCEPT-017` | The recheck window covers every frozen guest night, not the envelope alone |
| `INV-EXCEPT-018` | Capacity stays a hard refusal; an approving officer is not an override actor |
| `INV-EXCEPT-019` | Never a false keep-pending, including once the post-commit phase has begun |
| `INV-EXCEPT-020` | A kept-pending capacity conflict is always recorded, on either store |
| `INV-EXCEPT-021` | The live proposal is verified by replaying the frozen delta, not by trust |
| `INV-EXCEPT-022` | One implementation computes what the delta produces, for all four surfaces |
| `INV-EXCEPT-023` | Only the reviewed rules are overridden; ADMIN is never borrowed for guest authorisation |
| `INV-EXCEPT-024` | An approved hosting exception is recorded as decided in the same transaction |
| `INV-EXCEPT-025` | The adult-supervision review is never decided by proxy; it opens PENDING and BLOCKED |
| `INV-EXCEPT-026` | Reauthorization re-reads the officer's current roles inside the approval transaction |
| `INV-EXCEPT-027` | A decision is explicit, attributable and single-flight against the version shown |
| `INV-EXCEPT-028` | The officer decides a party they were shown, guest by guest |
| `INV-EXCEPT-029` | The settlement-method choice is asked on the decision form, never reported as pending |
| `INV-EXCEPT-030` | The member's own list returns the officer's note, the last conflict, and any booking |
| `INV-EXCEPT-031` | An approved new booking gets its own approval email after commit; a modification does not |
| `INV-EXCEPT-032` | One algorithm decides both request tables, so the two flavours cannot drift apart |
| `INV-EXCEPT-033` | A new booking is authorised as the requesting member, not merely created |
| `INV-EXCEPT-034` | A supersede carries the predecessor's attempt count forward |

### Additional-payment chasing, request holds and refund settlement

File:
[`invariants/additional-payment-chasing.md`](invariants/additional-payment-chasing.md).
Prefix `INV-ADDPAY`.

| ID | Covers |
| --- | --- |
| `INV-ADDPAY-001` | Who is owed an additional payment, tested on booking status and amount together |
| `INV-ADDPAY-023` | Who may pay one: every member surface excludes CANCELLED and BUMPED |
| `INV-ADDPAY-024` | At most two reminders per obligation, and the chase stops at check-out |
| `INV-ADDPAY-025` | Nothing raised before the derived cron cutover is chased; a read failure sends nothing |
| `INV-ADDPAY-026` | Guarded stamps claim before each send, read and fenced relative to the current episode |
| `INV-ADDPAY-027` | One clock: manual and automatic sends share both stamps and the cooldown, both ways |
| `INV-ADDPAY-028` | Only a transmitted message counts as sent; otherwise the stamps are given back |
| `INV-ADDPAY-029` | Silence is refused, not swallowed, and unreachability is checked before anything is claimed |
| `INV-ADDPAY-002` | Three side doors into the finished-unpaid state are closed at the door |
| `INV-ADDPAY-003` | A booking left with only non-adults needs admin approval however it got there |
| `INV-ADDPAY-004` | Any pending admin review blocks a paid or completed booking from lodge check-in, whatever its reason |
| `INV-ADDPAY-005` | The member edit panel collects that justification proactively; the server stays sole enforcer |
| `INV-ADDPAY-006` | A quote hold spans the whole quote lifecycle, from send through acceptance to release |
| `INV-ADDPAY-007` | An accepted-but-unpaid quote hold is not protected against a later capacity reduction |
| `INV-ADDPAY-008` | School approval re-checks per-night capacity for the final guest list on both branches |
| `INV-ADDPAY-009` | A converted booking keeps the held lodge, the negotiated price and its owning contact |
| `INV-ADDPAY-010` | An admin decline releases the capacity hold from any of the six declinable states |
| `INV-ADDPAY-011` | A DECLINED request is untouchable and its quote retired; the held owner is re-validated at conversion, and standard edits refuse a quoted booking rather than reprice it |
| `INV-ADDPAY-012` | The paid-name lock allows only identity-preserving spelling corrections, by four exact tests |
| `INV-ADDPAY-013` | Accepted residual: a one-edit short-name change is indistinguishable from a typo; audit mitigates |
| `INV-ADDPAY-014` | A reduction against an unpaid Xero invoice corrects the full net delta by modification credit note |
| `INV-ADDPAY-015` | Cancellation's refundable base is capped by the booking's worth, never the raw payment mirror |
| `INV-ADDPAY-016` | A credit-settled reduction allocates against captured transactions in the same transaction |
| `INV-ADDPAY-017` | A net-positive mixed edit bills Xero the signed components on one supplementary invoice; the repair pass sizes credit notes by stored evidence, whose failure mode is double-refund exposure |
| `INV-ADDPAY-018` | A cancellation's card-refund debt is durable before any external call, from frozen slices |
| `INV-ADDPAY-019` | Xero contact resolution makes every provider call outside any database transaction |
| `INV-ADDPAY-020` | Stepped Stripe refunds settle as per-delta credit notes summing exactly to the refunded total |
| `INV-ADDPAY-021` | For Stripe payments the local refund ledger is truth; inbound Xero may only raise it |
| `INV-ADDPAY-022` | Soft-delete may hide a duplicate only when no external money history must stay operator-visible |
| `INV-ADDPAY-030` | A soft-deleted booking is always CANCELLED and stays so; most routes refuse it only incidentally |
| `INV-ADDPAY-031` | House shape for a deleted-booking guard: 404 for every role, after the authorisation check |
| `INV-ADDPAY-032` | Superseded by `INV-ADDPAY-035`/`INV-ADDPAY-036`: two writes stay reachable on a soft-deleted booking |
| `INV-ADDPAY-033` | Superseded by `INV-ADDPAY-034`: two unguarded GETs still serve a deleted booking's own data |
| `INV-ADDPAY-034` | One shared "cancelled or removed" sentence for the surfaces that explain rather than 404 |
| `INV-ADDPAY-035` | A soft-deleted booking takes no member-guest consent answer, from any role, either arm |
| `INV-ADDPAY-036` | A modification payment captured on a deleted booking is recorded and queued for a human, never auto-refunded from that path |
| `INV-ADDPAY-037` | EITHER late-capture path's auto-refund on a cancelled booking leaves a DISMISSED refund task the finance queue shows, grouped by whether the booking was deleted, with two named exceptions and the refund staying automatic — widened from the booking-change path alone by #2773, and the hand-resolved exception kept by #2774 D1, both orchestrator decisions on those issues' Recommended options that the owner has not ruled on (see `INV-ADDPAY-039`) |
| `INV-ADDPAY-038` | That alert names what happened — which payment, which population — cannot be muted, resolves a real recipient rather than the bootstrap literal, and stays the event's only notification — extended from the booking-change alert alone to both paths by #2773, an orchestrator decision the owner has not ruled on (see `INV-ADDPAY-039`) |
| `INV-ADDPAY-039` | A late capture an operator has already paid back by hand is never refunded again: the automatic refund is withheld, audited and alerted, and a hand-back landing mid-refund is reported as a possible double payment — an orchestrator decision on #2774's Recommended option that the owner has not ruled on, so never cite it as owner-settled |

## Analytics And Privacy

Analytics loading and consent, what this application is allowed to send to
Google, what personal data may appear in a log, and who may read an audit row.
File:
[`invariants/analytics-and-privacy.md`](invariants/analytics-and-privacy.md).
Prefix `INV-PRIV`.

| ID | Covers |
| --- | --- |
| `INV-PRIV-001` | Google Analytics must not load unless all four stated conditions hold |
| `INV-PRIV-002` | With the banner enabled and no accepted choice recorded, nothing at all reaches Google |
| `INV-PRIV-003` | Banner disabled: the tag loads, a banner-era decline is invalidated once, and the preferences opt-out is always honoured |
| `INV-PRIV-004` | Advertising storage, user data and personalisation are denied in every signal, in both modes |
| `INV-PRIV-005` | Every page view carries origin and pathname only — never a query string, token, id or address |
| `INV-PRIV-006` | Exactly one page view per address across client-side navigation, de-duplicated |
| `INV-PRIV-007` | Both hold end to end only if the GA property's history-based enhanced measurement is off |
| `INV-PRIV-008` | Leaving the public website unmounts the runtime, sets the kill switch and queues a denial |
| `INV-PRIV-009` | The per-browser choice stores the consent revision and surface; only an explicit action bumps it |
| `INV-PRIV-010` | Every one of these fails closed, and the public website still renders normally |
| `INV-PRIV-011` | Which person fields the log/Sentry redactor strips by key, that key coverage is not exhaustive, and that audit rows deliberately keep name and street address |
| `INV-PRIV-012` | Audit category follows the affected domain; member visibility declared separately; rows already written are `INV-OPS-012` |
| `INV-PRIV-013` | `admin` writers move only to close a split; fifteen keeps, `lockers` settled (#2777) |
| `INV-PRIV-014` | Diagnostics page filters and typed search reach the provider, ungated by either tick |

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
| `INV-LIFE-002` | A cancellation credits a subscription invoice only when the leaver is its last uncancelled member |
| `INV-LIFE-003` | At most one cancellation ever credits a given subscription invoice, by a durable first-writer claim |
| `INV-LIFE-004` | The unpaid-invoice approval blocker excuses an invoice if and only if it is still about to be credited |
| `INV-LIFE-005` | Role, membership type, age tier, Xero group and committee are separate axes; admins cannot be stranded |
| `INV-LIFE-006` | Cancellation eligibility is an account-holder question, refusing exactly two record classes |
| `INV-LIFE-007` | The member-raised route adds only active and can-log-in; the family candidate query has no role filter |
| `INV-LIFE-008` | Both member-raised queries must select the role columns, or a person is misread as the kiosk |
| `INV-LIFE-009` | The kiosk test is a record-class test: refused only when `LODGE` is the whole classification |
| `INV-LIFE-010` | The `canLogin` term applies to `SCHOOL` alone; every other account class is cancellable |
| `INV-LIFE-011` | Both callers feed the rule one shape, so the page cannot offer an action the server refuses |
| `INV-LIFE-012` | Cancellation approval leaves access roles standing; `active: false` is the load-bearing flag |
| `INV-LIFE-013` | Two paths write `active: true`, and each refuses cancelled, archived and deleted members |
| `INV-LIFE-014` | A deleted account yields no session even with `active: true`; all three providers refuse |
| `INV-LIFE-015` | The deleted-account marker is a strong signal, not a schema invariant; one path overwrites both |
| `INV-LIFE-016` | Cancellation clears no roles and no JWT, so any admin-access route must re-read `active` |
| `INV-LIFE-017` | Application-approval mapping preserves login uniqueness and auth, and never double-charges coverage |
| `INV-LIFE-066` | The applicant MAP path's #1026 privileged-email gate is Full-Admin-only, fail-closed |
| `INV-LIFE-067` | On-behalf booking pickers are `bookings:edit`-scoped and never require `membership:view` |
| `INV-LIFE-068` | MG4's member-guest picker: email mode `bookings:edit`, name mode also `membership:view` |
| `INV-LIFE-069` | On-behalf creation matches modification, and no on-behalf actor may target themselves |
| `INV-LIFE-070` | A Booking Officer may inline-create a non-login non-member booking owner |
| `INV-LIFE-071` | Legacy `Member.role` reads, seasonal assignment storage, and age tiers stay separate axes |
| `INV-LIFE-072` | Built-in membership types never delete or merge; a custom merge has stated preconditions |
| `INV-LIFE-073` | `NOT_APPLICABLE` is resolved by one shared helper on a four-step precedence ladder |
| `INV-LIFE-018` | Guards for age-exempt types, N/A flips, season roll-forward and the Xero member import |
| `INV-LIFE-019` | `NOT_APPLICABLE` has no `AgeTierSetting` row and is out of every age-based automation; also committee presentation and contact routing, member-photo visibility, and EXIF/GPS stripping on every image path |
| `INV-LIFE-020` | With the 2FA module on, the JWT claim flips only via a server-minted single-use challenge |
| `INV-LIFE-021` | A `FamilyGroup` with no `FamilyGroupMember` rows is inert everywhere |
| `INV-LIFE-022` | Family-group facts: the guest-eligibility correction, billing recipients, and memberless groups |
| `INV-LIFE-023` | An unregistered partner is invited by a single-use hashed token, claimable only by that email |
| `INV-LIFE-024` | The declared partner link is a symmetric consented ordered pair; at most one CONFIRMED each |
| `INV-LIFE-025` | Parent/dependant links are limited to four generations and two parents |
| `INV-LIFE-026` | The depth cap is checked symmetrically at link time, by every writer of a parent link |
| `INV-LIFE-027` | Merge is a parent-link writer by consequence, and refuses depth and cycle violations |
| `INV-LIFE-028` | Admin member-create validates on the base client, leaving a millisecond over-deep window |
| `INV-LIFE-029` | The depth walks are level-bounded, report the longest path, and refuse on incomplete information |
| `INV-LIFE-030` | Parentage is recorded at any age; every real power is gated elsewhere, not on the parent link |
| `INV-LIFE-031` | Every row of that table lands on the family-group gate, which #2284 decided deliberately |
| `INV-LIFE-032` | Recording a young parent grants only a label and a mail-routing question, answered by walking past |
| `INV-LIFE-033` | The parent side still requires active, non-archived, and being a person not an organisation |
| `INV-LIFE-034` | Organisations are excluded by role, never by age tier, because N/A is carried by people too |
| `INV-LIFE-035` | The family group is the authorisation boundary, and every login-holding adult in it is equal |
| `INV-LIFE-036` | The dividing line is `canLogin`, not age; nothing changes at eighteen |
| `INV-LIFE-037` | The four powers over a non-login member, and the cancellation-request confirmation flag |
| `INV-LIFE-074` | Adding a non-login member to a booking notifies them or their family adults |
| `INV-LIFE-075` | A delegated details edit shows read-only provenance on the family cards |
| `INV-LIFE-076` | The one-step partner declaration keys on the voucher pointer, not a family-group role |
| `INV-LIFE-077` | Family-group membership carries no rank; membership is the only fact recorded |
| `INV-LIFE-038` | What one member may see about another member's parent: a deliberate two-layer whitelist |
| `INV-LIFE-039` | That whitelist is enforced server-side field by field; admin surfaces are unchanged |
| `INV-LIFE-040` | The admin link route's other requirements, including that the target not be the parent's ancestor |
| `INV-LIFE-041` | Candidate search and write-time guards are one predicate on identity only; request options, including the last-Full-Admin guard, are validated separately |
| `INV-LIFE-042` | Parent-candidate ranking puts non-minors first: a re-order of the eligible set, never a filter |
| `INV-LIFE-043` | Three load-bearing rules: nullable columns, required graph facts, no no-op unsatisfiable clauses |
| `INV-LIFE-044` | Four generations confirmed; transitive email inheritance dropped (owner, 9 Aug 2026) |
| `INV-LIFE-045` | Delete eligibility counts direct dependants only, which stays correct at four generations |
| `INV-LIFE-046` | Family links grant no billing or fee coverage, and a source contract enforces the isolation |
| `INV-LIFE-047` | Email inheritance is DIRECT-PARENT ONLY: a member inherits from a parent or from nobody |
| `INV-LIFE-048` | The accepted gap is surfaced: one definition of unreachable, read by both admin surfaces |
| `INV-LIFE-049` | Two columns: the choice that was made, and the terminal mailbox derived from it |
| `INV-LIFE-050` | An inherit source must be an adult with a real address who does not itself inherit, or it is refused |
| `INV-LIFE-051` | A stored pointer is re-read before it is trusted; a member who inherits is not a mailbox |
| `INV-LIFE-052` | Provenance, not identity, decides what unlinking clears |
| `INV-LIFE-053` | Pointers re-resolve on every address add, change or remove, in the write's own transaction |
| `INV-LIFE-054` | A daily convergence sweep is the guarantee behind those calls, and is safe to re-run |
| `INV-LIFE-055` | All four removal paths detach links aimed at the member, and never re-parent the dependants |
| `INV-LIFE-056` | All four read who they detach before nulling, through one shared helper, and audit the same members |
| `INV-LIFE-057` | The detach notice does not claim those members now receive club email at a working address |
| `INV-LIFE-058` | Pending nomination states must have a documented recovery path so applications never stall |
| `INV-LIFE-059` | Induction sign-off is one overall pass per signer; hut-leader eligibility is not an assignment |
| `INV-LIFE-060` | The trusted legacy induction baseline is a one-off exception with an exactly defined population |
| `INV-LIFE-061` | Applying that baseline needs a Full Admin and exact confirmations, and writes only new rows |
| `INV-LIFE-063` | Hard delete stays limited to records passing every durable-history eligibility check |
| `INV-LIFE-064` | Family Group identity screens show a calculated age: one helper, stored nowhere, NZ date-only |
| `INV-LIFE-065` | Member profile merge: Full Admin only, additive and master-wins, with a re-derived field patch |
| `INV-LIFE-078` | Every Member-referencing relation is classified move, resolve, cascade or snapshot |
| `INV-LIFE-079` | A meaningful loser subscription colliding on a season the master holds blocks the merge |
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
| `INV-INT-003` | External provider calls should not sit inside long database transactions without a reason |
| `INV-INT-004` | Email, Xero and payment failures affecting business outcomes must be visible and retryable |
| `INV-INT-005` | Logs, webhooks, Sentry events and PR comments must not expose secrets, tokens or personal data |
| `INV-INT-006` | One club-level mode governs Xero member auto-grouping; the rules live in one table |
| `INV-INT-007` | The system never deletes a Xero contact group; it only changes membership of the managed universe |
| `INV-INT-008` | `NONE` mode is a total no-op, on both the per-member sync and the cancellation path |
| `INV-INT-009` | A rule targets a canonical set of age tiers; the empty set is the all-tiers wildcard |
| `INV-INT-010` | Grouping resolution is pure and mode-driven, most-specific first, with deterministic tie-breaks |
| `INV-INT-011` | Add-suppression: a member already in a matched accepted group gets no spurious add |
| `INV-INT-012` | The cutover migration deactivates every pre-existing rule it did not backfill itself |
| `INV-INT-013` | Mode or rule changes never auto-resync the population; members re-group on their next trigger |
| `INV-INT-014` | The per-member sync keeps Xero calls outside transactions, ledgers each op, and adds before removing |
| `INV-INT-015` | The bulk re-sync is admin-triggered, dry-run-first, chunked, resumable, and never moves the watermark |
| `INV-INT-016` | `GET /api/bookings/rooms` keeps its no-`lodgeId` mode for FORKED/EXTERNAL consumers, excluding archived lodges; no `src/` client may use it |
| `INV-INT-017` | The Xero NZBN field carries the date of birth through ONE shared codec; never blank it, never overwrite what the decoder cannot read as a day, never write without an observed cache row, and the inbound direction only fills a gap |

## Operations

Raw SQL, advisory and row locking, production deployment including the worked
windowed column drop, changing what values already stored in a column mean, and
what may be used as test input.
File: [`invariants/operations.md`](invariants/operations.md). Prefixes `INV-OPS`
and `INV-LOCK` — the latter is the two-tier advisory-lock protocol, kept beside
the row-locking rules it is the sibling of.

| ID | Covers |
| --- | --- |
| `INV-OPS-001` | Raw SQL never declares its own result shape: lock raw and read typed, or validate the rows |
| `INV-LOCK-001` | The scoped tier is the default; the global key is deliberate |
| `INV-LOCK-002` | Global before per-lodge; one helper mints the per-lodge capacity key |
| `INV-LOCK-003` | Every global-lock call site is registered, by site, with its own reason |
| `INV-OPS-014` | Never interpolate or concatenate into `$queryRawUnsafe` / `$executeRawUnsafe` |
| `INV-OPS-013` | A `"use client"` module never imports server-only code at runtime |
| `INV-OPS-002` | Production deployment must respect `docs/BLUE_GREEN_MIGRATION_POLICY.md` |
| `INV-OPS-012` | An audit reclassification ships its backfill or files one, never neither — and states its MEASURED before/after audience per site |
| `INV-OPS-005` | A doomed column needs `@ignore`: static defaults and implicit `RETURNING` still name it |
| `INV-OPS-006` | Post-drop the compiler catches only `where`; `select` and `create` fail at runtime |
| `INV-OPS-007` | The surviving guard test pins the generated client's shape and raw SQL |
| `INV-OPS-008` | Payload readers must be gone before the drop, not just authorisation readers |
| `INV-OPS-009` | How the role-column drop actually shipped, and why the two-step plan was superseded |
| `INV-OPS-010` | A windowed drop: the `windowed` ledger row, `rollback.sql`, and the operator sequence |
| `INV-OPS-011` | The dropped column's stored values were meaningless rather than frozen |
| `INV-OPS-003` | Public CI and local validation must use test/demo credentials or placeholders |
| `INV-OPS-004` | Production data, backups, live provider accounts and live webhooks are not valid test inputs |

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
| `INV-CONFIG-002` | One persisted IANA club timezone is the sole civil-time authority; `TZ` seeds it, the browser never decides it, and changing it rewrites nothing |
| `INV-CONFIG-003` | One explicit `APP_ENVIRONMENT_ROLE` declaration decides production versus non-production; nothing is inferred, the database may only force the safer state, a missing declaration is UNKNOWN rather than either, and a production deploy cannot proceed without it |
| `INV-CONFIG-004` | Every application-controlled send passes ONE environment-aware boundary: confirmed production delivers, a confirmed copy suppresses terminally unless it has declared a capture mailbox, an unconfirmed role fails closed retryably, a live site in capture mode is refused, and all four are distinguishable from business suppression and from provider failure |
| `INV-CONFIG-005` | Every application-managed Xero contact write consumes the canonical role: production is byte-identical, a confirmed copy replaces the address with one deterministic, idempotent, non-deliverable form kept separate from the placeholder domains, an existing or restored link must be proved contained before any document is raised against it, and an unconfirmed role writes nothing to Xero at all |
