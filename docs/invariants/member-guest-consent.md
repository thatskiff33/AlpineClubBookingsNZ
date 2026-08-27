# Member-Guest Consent

Audience: Developer, Agent.

Prefix defined in this file: **`INV-GUEST`** — when a member added as somebody
else's guest must be asked first, what the answer is recorded as, and what a
row in each consent state does and does not do.

Read this file when you are changing a member bringing a guest, and consent to
do so.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`SCHEME.md`](SCHEME.md).

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused. **The text under each ID is a
verbatim move from the source document and must not be reworded in place** —
only the ID heading lines were added.

One rule that binds this domain is defined under a different prefix, because it
is cited alongside the deleted-booking rules rather than the consent ones: a
soft-deleted booking refuses **every** consent answer, from every actor, before
any of the transitions below is attempted — see
[`INV-ADDPAY-035`](additional-payment-chasing.md#inv-addpay-035) (#2700). Read it
before changing `respondToMemberGuestConsent` or the delegate answer path.

## INV-GUEST-001

A MEMBER added as somebody else's guest may need that member's agreement first
("+ Add Member Guest", epic #2305, decision D-7). The state lives in five
columns on `BookingGuest` — `consentStatus`, `consentRequestedAt`,
`consentRespondedAt`, `consentRespondedByMemberId`, `consentExpiresAt` — not in
a side table.

## INV-GUEST-002

**MG1 (#2306) shipped every one of these columns inert. MG2 (#2307) turns them
on.** With the `memberGuests` module enabled, a cross-family active member now
resolves and the row carries a real consent state; with it disabled — the shipped
default (D-2) — a cross-family add is refused with the byte-for-byte pre-feature
error and nothing writes a non-null `consentStatus`. The invariants below are now
live behaviour, not a forward contract.

## INV-GUEST-003

Two consequences of the owner's ticks are recorded here as **chosen behaviour**,
because both are surprising and neither should be discovered by a member:

- **An approved stay may be extended without asking again** (owner decision
  D-13). Consent covers the booking *however it later changes*, in both policy
  modes: no reset to `PENDING`, and no change notification in notify-only either.
  So a booker may add nights to a stay a member agreed to, and that member keeps
  holding the new nights without being asked. Their only exit is self-removal —
  which, per D-14 below, may itself be refused. The two ticks compound, and this
  is where that is written down.
- **A member who never consented can be refused the ability to come off the
  booking** (owner decision D-14). Declining is a self-removal, so it runs the
  ordinary blockers. A pending guest CAN decline when the booking status allows
  guest changes, check-in is strictly in the future, the booking has two or more
  guests, it is not quote-priced, and the reduction needs no refund-vs-credit
  election. They are TRAPPED — a plain-English 400, and the row survives as
  *blocked* on the admin exception list — when a captured payment's cancellation
  tier returns money (the common case, because member guests are charged up front
  on the mixed-party split), when they are the booking's only guest, when the
  booking was quote-priced, when check-in has started, or when the status forbids
  changes. The member is told who can help; MG2 adds no exemption, which is
  exactly what D-14 decides. See docs/STATE_MACHINES.md for the transition list.

## INV-GUEST-004

- **`NULL` is not `CONFIRMED`.** A null `consentStatus` means *no consent was
  ever needed* — a family-scope add (D-6) or a row written before the feature
  existed. `CONFIRMED` means *somebody said yes*. Conflating them is
  irreversible: once a family row is stamped `CONFIRMED`, nothing downstream can
  recover the fact that nobody was ever asked. A family-scope add must never
  write anything but nulls.

## INV-GUEST-005

- **A consent that was never solicited is recorded as such.** `consentRequestedAt`
  is the discriminator: it is set only when the club actually asked. Notify-only
  auto-confirms and admin/copy/pipeline rows are `CONFIRMED` with a null
  `consentRequestedAt`, and are still *not* written as all-nulls, because the
  guest genuinely is cross-family and that must stay visible. Neither shape is
  waiting for an answer, so neither carries a `consentExpiresAt`: a settled row
  with a live hold deadline on it is a broken row, not a variant.

## INV-GUEST-006

- **A refusal names who refused.** `DECLINED` requires a non-null
  `consentRespondedByMemberId`. Declining is an attributed act — MG4's audit
  reads that column to say who turned the add down — so an unattributed decline
  is not an anonymous decline, it is a row no writer should produce.

## INV-GUEST-007

- **Who answered is audited separately from who was asked.**
  `consentRespondedByMemberId` may equal the guest (self-approval), differ from
  them (a delegate approving for a target with no login, D-5/D-10), or name the
  acting admin (an admin assignment or a booking copy). MG4's admin-assigner
  audit rides this column; no extra column exists or is needed.

## INV-GUEST-008

- **Nobody answers for a member who can sign in** (owner decision D-5/D-10). The
  delegate rule has a target side as well as an actor side, and both are
  enforced: a delegate must be an active, login-holding ADULT sharing a family
  group with the target, AND the target must NOT hold a login of their own.
  Without the target conjunct, two members of one household who are both put on
  the same booking can answer for each other — including declining, which
  releases the other's bed and deletes their guest row. `canRespondForTarget`
  and `resolveNotificationRecipients` in `src/lib/member-guest-delegate.ts` share
  one predicate for it, so "who may act" and "who is told" cannot drift into two
  different rules. A consequence worth expecting: a login-holding target the club
  has no email address for is asked nobody and told nobody, because the household
  may not answer for them either — an unanswerable request emailed to a household
  would only strand the bed.

## INV-GUEST-009

- **A delegate's answer is told to the member it was given for.** A member
  answering for themselves needs no notice, but a delegate's answer is somebody
  else's decision about them, so the member — and the other adults who were sent
  the same request — receive the `member-guest-consent-answered` email naming who
  answered and what they said. It carries no money and no booking link: the
  recipient may have nothing to do with the booking, and D-11 grants booking-page
  access to a guest ROW, never to a delegate.

## INV-GUEST-010

- **A `PENDING` row holds the bed** (D-4) until `consentExpiresAt`, which is set
  from `MemberGuestSettings.pendingHoldExpiryDays` (default 7, bounds 1–60). A
  `PENDING` row without an expiry would be an unbounded capacity hold and is not
  a legal shape.

## INV-GUEST-011

- **Consent is not transitive across bookings.** A copied booking's guest never
  inherits the source row's approval: the copy is re-stamped as an admin
  assignment against the copying admin. Neither may it silently become
  consent-free.

## INV-GUEST-012

- **A merged-away member's guest rows keep their consent.** `BookingGuest.member`
  is classified `move` in `src/lib/member-merge-relations.ts`, so merging A into B
  re-points A's guest rows — consent columns included — onto B.
  `consentRespondedByMemberId` is an FK-less snapshot and keeps the id of
  whoever actually answered at the time, even after that member is merged away.
  The survivor therefore **inherits the consent the loser gave**, which is the
  accepted consequence of the existing `move` classification, and two shapes fall
  out of it that a reader should expect rather than discover: a merge can put two
  guest rows for the same person on one booking (a person-night conflict the merge
  path resolves), and a merge can leave a booking whose only guest is the
  survivor, i.e. in `LAST_GUEST` — so a later decline or lapse on that row lands
  on the admin exception list instead of releasing the bed.

## INV-GUEST-013

- **A pending guest is not operationally present** (owner decision D-12). Only
  `null` and `CONFIRMED` rows appear on the kiosk arrivals list, the arrive/depart
  gate, the chore roster and its print sheet, bed allocation and the admin bed
  board, the hut-leader pickers, the lodge display board, the week summary, the
  double-bed candidate sweep, and — because these are member-facing content, not
  just screens — the pre-arrival and check-in reminder emails. The single shared
  predicate is `OPERATIONALLY_PRESENT_GUEST_WHERE`, written as an explicit
  `OR: [{ consentStatus: null }, { consentStatus: "CONFIRMED" }]`. It must NEVER
  be written as `{ consentStatus: { not: "PENDING" } }`: on a nullable column that
  form is `UNKNOWN` for every `NULL` row, so it would silently drop every ordinary
  guest off the kiosk and out of the arrival emails in production.

## INV-GUEST-014

- **A pending guest DOES hold a bed and a person-night** (owner decision D-4), and
  every capacity path counts them. Capacity, month availability, the occupancy
  index, partner shared-admission and the person-night conflict guard must NOT
  gain a consent filter — a pending guest who did not hold their person-night
  could be placed in two beds on one night. The exclusion list and the freeze list
  are deliberate opposites, and each has its own test.

## INV-GUEST-015

- **A data-subject export is not an operational surface.** The member data export
  deliberately includes the member's own pending rows and exports
  `consentStatus` as a field. Excluding them would make the export incomplete
  about a commitment that exists.

## INV-GUEST-016

**MG4 (#2309) closes the last three paths.** MG1 provisioned the columns, MG2
turned them on for the member-facing add, MG3 built the finder, and MG4 covers
the edit path, admin parity and the booking-request pipeline. Its rules:

- **Adding a member guest while EDITING is the same act as adding one while
  creating.** The edit panel's section goes through the modification path, which
  resolves the family boundary and plans consent through the same single writer
  every other add uses. There is no second consent rule for the edit path, and a
  refusal on it is the same neutral D-8 sentence.
- **Every path that can place a member on a booking now records who did it and
  tells the member.** Four write points reach this: the member add, the admin
  add, the admin booking-copy, and the booking-request pipeline (owner decisions
  MG4-D-a and MG4-D-b). The pipeline has THREE such points, not the two the issue
  body named — the capacity hold's booking create, the approval-time guest swap,
  and the approval that runs with no hold behind it — and all three write
  `ADMIN_ASSIGNED` naming the approving officer. There is no exemption: MG4-D-b
  was ticked in the direction of bringing the pipeline under the rule, so this
  section records the rule rather than an exception to it.
- **A held booking's guest swap can substitute one person for another in place.**
  The approval preserves each guest row's id so pre-assigned beds survive
  (#1254), which means replacing a member on a row looks like an ordinary update.
  Both parties must be told: the newcomer that they are on the booking, the
  person dropped that they are not. A reused row's consent record is cleared when
  the person on it changes — a stale `ADMIN_ASSIGNED` would vouch for somebody
  who was never asked, which `classifyMemberGuestConsent` calls a broken row.
- **A member guest who comes OFF a booking is told, once, by whichever path
  removed them.** `member-guest-request-withdrawn` covers a request called off
  before anybody answered, a settled member guest taken off, and a pipeline
  substitution. It is sent by the single-guest removal route and the batch edit
  and by NOTHING else: a decline and a lapse each already have their own message
  for the same event, and a member removing themselves is not told what they just
  did. A row whose `consentStatus` is `NULL` owes nobody anything, because no
  message was ever sent about it.
- **"Always notify" beats the per-action tick and the member's preferences, and
  loses to the per-booking No-emails switch** (owner decision D-16, and the
  precedent D10 set over #1705's invoice email). None of the six member-guest
  senders consults `shouldSendEmail`, and no caller gates them on an admin's
  notify choice — being asked, being told you are on a booking, and being told
  you are off it are not courtesy messages. All six pass a real `bookingContext`,
  so a silenced booking withholds them and each withheld send lands on that
  booking's withheld-banner record where an operator can see what was held back.
- **The officer's member picker gates its NAME mode on `membership:view`, not on
  `bookings:edit`** (owner decision D-20). It is deliberately NOT bound by the
  club's two member-facing privacy switches: an admin holding `membership:view`
  can already browse the whole roll from `/admin/members`, so gating their
  booking-side picker on a member-facing setting protects nothing. The rider is
  what keeps #1376 true — a Booking Officer whose role carries no membership
  access gets a 404 on the NAME mode and falls back to exact-email resolve, which
  needs only `bookings:edit`. Every officer lookup is audited through the same two
  writers the member routes use, including the malformed-address and
  lookup-failed outcomes, so officers are not invisible in the trail that exists
  to make browsing detectable. The **email mode is a `POST` with the address in
  the body**, matching `POST /api/members/guest-candidates/resolve`: a member's
  address must never travel in a URL, where it would reach the access log, the
  browser history and the `Referer` of everything the page loads next.
- **Which reader gets which picker is decided by ONE predicate**
  (`resolveMemberGuestNameSearchAccess`), the same `viewerRole === "ADMIN"` the
  edit panel uses to choose its routes. Deciding "may this reader search by name"
  from a different permission than "which routes will this reader call" strands
  the read-only bookings viewer between them: with `membership:view` they get a
  name box that 404s on the member route, and without it they lose a search their
  club turned on for every member.
- **Exactly one file turns either open-search value into a decision about who is
  discoverable.** Routes declare the AUDIENCE they are serving;
  `member-guest-find-service.ts` decides what that means. A second decision site
  is how two surfaces come to disagree about whether the roll is browsable.

## INV-GUEST-017

The eight legal column shapes, and only those eight, are. In the four column
cells, **null** means the column must be `NULL`, **set** means it must be
non-`NULL`, and **any** means either is legal; where the responder's identity
also matters it is named instead.

| Sub-state | `consentStatus` | `requestedAt` | `respondedAt` | `respondedByMemberId` | `expiresAt` |
| --- | --- | --- | --- | --- | --- |
| `FAMILY_OR_LEGACY` | `NULL` | null | null | null | null |
| `AWAITING_TARGET` | `PENDING` | set | null | null | set |
| `TARGET_APPROVED` | `CONFIRMED` | set | set | the guest themselves | any |
| `DELEGATE_APPROVED` | `CONFIRMED` | set | set | someone other than the guest | any |
| `NOTIFY_ONLY_AUTO_CONFIRMED` | `CONFIRMED` | null | null | null | null |
| `ADMIN_ASSIGNED` | `CONFIRMED` | null | set | the acting admin | null |
| `DECLINED` | `DECLINED` | set | set | set | any |
| `EXPIRED` | `EXPIRED` | set | null | null | set |

## INV-GUEST-018

This table is the same data as `MEMBER_GUEST_CONSENT_SUB_STATES` in
`src/lib/member-guest-consent.ts`, whose `classifyMemberGuestConsent` returns
`null` for any other combination. It is not merely "kept in step" by hand:
`src/lib/__tests__/member-guest-consent.test.ts` GENERATES each row above from
the code table (one mapping of set / null / any / the responder words) and fails
unless this file contains it verbatim, so a shape that changes in code cannot
leave a stale row here.
