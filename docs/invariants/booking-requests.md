# Booking Requests

Audience: Developer, Agent.

Prefix defined in this file: **`INV-REQ`** — which of a Booking Officer's two
notes a member reads, what the member's own request area is allowed to say about
a request's state, and what an officer may correct on a request before it is
converted.

Read this file when you are changing booking-request notes, the member's own
request area, or the officer's correction of an unconverted request.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`SCHEME.md`](SCHEME.md).

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused. **The text under each ID is a
verbatim move from the source document and must not be reworded in place** —
only the ID heading lines were added.

## The officer-note split on booking requests (#2562)

### INV-REQ-001

A Booking Officer's decision carries **two** notes, and which audience reads which
is an invariant, not a convention. It is **table-wide**, which means all three
officer surfaces that decide a request on these tables and not just the
policy-exception one: `BookingChangeRequest` holds both kinds of row, and its
LOCKED_PERIOD half is decided from a different panel
(`booking-change-requests-panel.tsx` → `PATCH
/api/admin/booking-change-requests/[id]`) that writes the same column.

### INV-REQ-002

- `adminNotes` is **member-visible**, on both request tables and for both kinds of
  `BookingChangeRequest` row. It is the decision explanation, written for the
  member: rendered on their own request list, on their booking page under "Change
  Requests", and interpolated into the approval and refusal emails. Every officer
  screen labels it as member-visible *before* the decision is submitted, so nobody
  discovers the audience afterwards. A box headed only "Admin notes" over this
  column is a defect — it is what let an officer type a judgement about a member
  into the sentence that member then read verbatim.

### INV-REQ-003

- `internalNotes` is **never member-visible**, on either table or either kind. It is
  the officer's private commentary — a judgement about the member, a reference to
  somebody else's booking, a note for the next officer — and is read only by
  admin-guarded surfaces (the two officer queues and the per-request detail
  endpoint, all behind `requireAdmin`). Every officer surface that offers the
  member-facing field offers this one beside it, because an officer with no private
  field writes private things in the public one.

### INV-REQ-004

Four structural properties hold that boundary, so it does not depend on any single
call site remembering it:

1. **The member DTO has no slot for it.** `toMemberExceptionRequestItem`
   (`src/lib/member-exception-requests.ts`) is a strict allowlist that never spreads
   a row, and its INPUT type does not accept `internalNotes` — handing the private
   note to the member projection is a typecheck failure, not a privacy incident.
2. **Every member-reachable read names its columns and omits the column.**
   `readMemberExceptionRequests` does, and so does every handler on
   `/api/bookings/[id]/change-requests` — GET **and** POST — through the shared
   manifest in `booking-change-request-member-view.ts`, whose census test proves the
   two halves of the manifest cover the whole scalar enum. So a column added to the
   model fails that test until somebody decides in writing whether a member may read
   it, and on the member path there is nothing in memory for a later mapper edit to
   leak. The member's booking page selects `adminNotes` and not `internalNotes`.
3. **No email, notification or member-facing template names it.** The approval and
   refusal emails compose their optional line from `adminNotes` alone.
4. **The audit log records its EXISTENCE, never its text**
   (`internalNoteRecorded: boolean`). The audit trail is read by more surfaces than
   the officer queue, and copying the text there would make it private in one place
   and not the other.

### INV-REQ-005

**A private note is never a substitute for the member-facing one.** Refusing a
policy-exception request still requires `adminNotes`, and so does approving an
adult-member hosting exception (D-R4's reason-for-the-record): a refusal the member
cannot read is a refusal they cannot act on. The exception decision route says so
in its own 400 message rather than silently accepting an internal note in its
place, and the locked-period panel keeps BOTH decision buttons disabled until that
request's own member-facing field is filled in. "That request's own" is part of the
rule, and it is held STRUCTURALLY rather than by a marker: the panel draws every
open request's form at once and keeps **one draft per request id**
(`decisionDrafts[request.id]`), which each field reads, writes and submits from, so
a note begun against one request is neither submitted with another nor able to
unlock another's buttons — whichever field is typed in, in whatever order. Two
earlier shapes both failed that: the original guard read
`reviewingId === request.id && !adminNotes.trim()`, which left every untouched row
decidable with no explanation at all; the shared-slot repair that followed still let
the internal-note and modification-id handlers move the ownership marker while the
previous row's sentence sat in the shared slot, so a keystroke on one card put
another member's explanation into this card's field, unlocked its buttons and posted
it under that member's request. The sibling policy-exception queue is an accordion
(one `openId`, one mounted form, draft reset on open) and its decision path refuses
to act for any card that is not the open one.

### INV-REQ-006

The column is an expand-only addition
(`20260803040000_add_policy_exception_internal_notes`), nullable with no backfill on
both tables, so a decision written by an older deployment carries `internalNotes`
NULL — which reads correctly as "the officer left no private note", because that
deployment had no field to write one in.

## The member's own request area (#2562)

### INV-REQ-007

The member-facing projection of an exception request states only facts, never
intentions:

- **Capacity comes from the reservation ledger, never from the policy's capacity
  mode.** `capacityHeld` is true only where live `PolicyExceptionReservationNight`
  rows exist. It is therefore false for **every** new-booking request whatever its
  mode says (the ledger keys to an existing `BookingChangeRequest`, and there is no
  booking yet), and false for a modification whose incremental footprint came out
  empty — a pure shrink. The generic sentence "your beds are held while we review"
  is false for the whole new-booking population and appears nowhere.
- **A recorded conflict is reported, not hidden.** A `REQUESTED` row with
  `lastConflictAt` set reads as "an officer tried and the lodge was full", never as
  "nobody has looked". Those are different facts and the second is one the member
  would act on.
- **Approval is never described as the moment beds are secured**, on either the
  pending or the approved sentence. An approval creates the booking the member's own
  wizard would have created (PENDING or PAYMENT_PENDING), which holds nothing until
  it is paid, so a pending new-booking row says availability is rechecked at review
  *and* that an approved new booking still holds no beds until it is paid.
- **The created booking is described from TWO facts about its own row**, both
  established by the caller and neither derived from the other:
  `createdBookingHoldsCapacity` (`bookingHoldsCapacity`) and
  `createdBookingAwaitsPayment` (still inside `ACTIVE_BOOKING_STATUSES`). "Holds no
  beds" is equally true of an unpaid booking and of a cancelled or reaped one, so the
  instruction to open it and pay it is conditional on the second fact; a closed
  booking gets a sentence that says it is no longer live, and an unreadable one gets
  the rule with no instruction at all.
- **Withdraw and replace are offered only where the API would accept them**,
  derived from the same `status = REQUESTED` condition the cancel and supersede
  services' guarded claims name.
- **The request action is offered only where the SERVER classified the refusal as
  reviewable.** One shared rule (`readExceptionOffer`,
  `src/lib/booking-exception-offer.ts`) decides it for both wizards, and it fails
  closed: an allowlist of reviewable refusal codes that can never contain a
  hard-stop code, a required non-empty `exceptionReview`, the server's own
  `exceptionEligible: true` on every violation, and a known capacity mode. One
  unrecognised violation disqualifies the whole refusal, because a request can only
  override the rules it froze.

## Correcting a request before it is converted (#2936)

### INV-REQ-008

**Correcting an unconverted request re-opens it, in the claim's own
transaction.** `correctBookingRequest` (`src/lib/booking-request-corrections.ts`)
is the one writer; every price and every quote on a request was computed from
the shape it corrects, so none of them may outlive the correction.

- **Every `DRAFT` and `SENT` quote becomes `SUPERSEDED`**, `priceCents`,
  `pricedByMemberId` and `pricedAt` are cleared and the status returns to
  `VERIFIED`, all in the transaction that claims the row. There is no edit small
  enough to skip it. `SUPERSEDED` rather than `CANCELLED` because an officer
  retired it, and flipping it off `SENT` is also what kills the requester's live
  link — `loadSentQuoteByToken` requires `SENT`.
- **An accepted quote refuses the correction (`409`) on either evidence**: a
  quote row at `ACCEPTED`, or the request's own `acceptedQuoteId`, which the
  accept re-arm sets before conversion runs and which therefore survives a
  conversion that did not finish. Re-opening an agreement is the officer's
  deliberate act — decline it or issue a fresh quote — never a side effect of an
  edit.
- **The guarded claim fences on all four together** — `version`, a correctable
  status, `convertedBookingId: null` and `acceptedQuoteId: null` — so each
  refusal holds under a race as well as at the guard, and a lost claim writes
  nothing.
- **Correctable is the six live, undecided states**
  (`CORRECTABLE_BOOKING_REQUEST_STATUSES`). `NEW` is excluded because the
  requester has not confirmed their own address yet, so nobody has asked for a
  correction.
- **A row whose stored party cannot be read back is refused, not guessed**
  (#2342's rule): the officer's corrected list would silently become the whole
  truth about a party nobody can compare it against.

Pinned by `src/lib/__tests__/booking-request-corrections.test.ts`.

### INV-REQ-009

**A corrected school name is stored only against the school record the officer
was actually shown.** Since #3367 approval resolves `schoolName` to an
`Organisation` inside its own transaction, and that record owns the school's
durable Xero customer (`INV-INT-018`, `INV-INT-020`) — so correcting the name is
a choice about which school the club is about to invoice, not a spelling fix.

- **The correction carries an acknowledgement, not a tick**: `outcome`
  `"existing"` naming the record's id, or `"new"` naming none.
  `assertSchoolRecordOutcomeAcknowledged`
  (`src/lib/school-organisation-preview.ts`) refuses every other pairing —
  including the right outcome pointed at the wrong record — with a `409` that
  names the school.
- **It is checked against a preview re-read INSIDE the claim transaction**,
  under `pg_advisory_xact_lock(1)`, never against the one the screen rendered.
  With approvals excluded by that key no record can appear in between, which is
  what makes the confirmation a fence rather than a courtesy. It catches two
  things: another approval minting the record while the form was open, and the
  officer editing the name after reading the preview.
- **The preview only ever reads.** `resolveOrCreateSchoolOrganisation` may run
  only inside the approval transaction; the preview asks the same question of
  the same filter (`schoolOrganisationNameClaim`) with the same ordering, so the
  claim and the preview cannot drift apart.
- **The name is normalised once** (`normaliseSchoolNameForStorage`), so the
  string previewed is the string stored.
- **A correction never writes the link.** It changes what approval will resolve,
  not what it has resolved; minting a record for a request nobody approves is
  what moving the resolve earlier would cost.

Pinned by `src/lib/__tests__/school-organisation-preview.test.ts` and
`src/lib/__tests__/organisation-reader-contract.test.ts`.

### INV-REQ-010

**A corrected request never keeps beds held for the shape it no longer has.** A
hold is a whole `AWAITING_REVIEW` booking built from the request's nights, guest
rows and owner, so every corrected field except the catering preference
invalidates it.

- **A catering-only correction keeps the hold**: that is the one corrected field
  a hold never reads, because it selects quote options, not beds.
- **Every other correction releases it**, through the shared `cancelBooking`
  path with the requester's cancellation email suppressed (an officer correcting
  a request, not a requester cancelling a booking) and `requireRequestHold: true`,
  so a hold a requester accepted in between is refused rather than clobbered.
- **The release runs AFTER the claim has committed and outside every
  transaction.** `cancelBooking` takes `pg_advisory_xact_lock(1)` and opens
  transactions of its own, so nesting it self-deadlocks. This is
  `declineBookingRequest`'s composition exactly, its member-guest read included.
- **A release that fails is reported as a correction that SAVED**
  (`BookingRequestCorrectionCommittedError`), never as a failed save and never
  as a clean success, and **the audit row is written before that error is
  rethrown** (`holdOutcome: "releaseFailed"`) — the one case where beds are left
  held for the old shape is the one case an officer must be able to find. The
  caller must not retry: a retry would refuse on the bumped version. The worst
  case is a request pointing at a hold covering more than it needs, with its own
  Release button; never one that has quietly lost beds.
- **A pointer to a hold no longer live is detached**, the Release-hold route's
  own repair.
- **Availability is re-measured after the release and is ADVISORY.** A
  correction is never refused for it: recording what the requester asked for is
  the officer's job whether or not the lodge can take it.

Pinned by `src/lib/__tests__/booking-request-corrections.test.ts`.
