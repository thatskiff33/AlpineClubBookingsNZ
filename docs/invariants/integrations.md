# Integrations

Audience: Developer, Agent.

Prefix defined in this file: **`INV-INT`** — webhooks and cron idempotency,
provider callback verification, what may appear in logs and webhook records, and
Xero member contact-group grouping.

Read this file when you are changing a webhook, a cron job, a provider callback,
what is logged about an integration, or Xero contact-group grouping.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`SCHEME.md`](SCHEME.md).

`INV-XERO` is deliberately not a prefix: the `INV-` namespace already carries
Xero invoice-number test fixtures, so the Xero grouping rules take `INV-INT`
alongside the rest of Integrations. See §1.2.1 of the scheme.

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused. **The text under each ID is a
verbatim move from the source document and must not be reworded in place** —
only the ID heading lines were added.

## INV-INT-001

- Webhooks and cron jobs must be idempotent.

## INV-INT-002

- Provider callbacks must verify signatures, state, or expected origin before
  local mutation.

## INV-INT-003

- External provider calls should not be placed inside long database
  transactions unless there is a documented reason.

## INV-INT-004

- Email, Xero, and payment failures that affect business-critical outcomes must
  be visible and retryable.

## INV-INT-005

- Logs, webhook records, Sentry events, and PR comments must not expose secrets,
  OAuth codes/states, action tokens, client secrets, or personal data beyond the
  minimum needed for diagnosis.

## Xero member grouping (E8, #1934)

### INV-INT-006

- A single club-level mode governs member auto-grouping: `NONE`,
  `MEMBERSHIP_TYPE`, or `MEMBERSHIP_TYPE_AND_AGE` (`XeroGroupingSettings`
  singleton). Grouping rules live in one table, `XeroContactGroupRule`
  (`MANAGED` = the group the sync adds; `ACCEPTED` = tolerated, never removed).

### INV-INT-007

- The system NEVER deletes a Xero contact group. It only adds/removes a
  contact's *membership* of groups in the "managed universe" = groupIds
  referenced by ACTIVE rules that are applicable under the current mode.
  Xero groups not referenced by any active rule are never touched.

### INV-INT-008

- `NONE` mode is a total no-op — the per-member sync short-circuits before any
  Xero call, and the cancellation path performs no managed removals.

### INV-INT-009

- A rule targets a **set** of age tiers (`ageTiers`, #2093): the EMPTY set is
  the "all age tiers" wildcard (the migrated null "Any age"); a non-empty set
  matches a member whose tier is IN the set. Sets are stored canonical-sorted and
  a full-tier selection collapses to the empty set, so each shape has exactly one
  canonical form and the DB partial unique index dedupes reordered sets. In
  `MEMBERSHIP_TYPE` mode a non-empty tier set makes the rule inert.

### INV-INT-010

- Resolution is pure and mode-driven (`resolveMemberGrouping`): most-specific
  MANAGED match wins on the ladder `type + tiers` > `type-only` > `tiers-only`;
  among tiered rules **fewer tiers is more specific**, and an all-tiers (`[]`)
  rule is the LEAST specific in the tier dimension (a naive ascending
  tier-count comparator would wrongly invert this). Exact ties break
  deterministically by `sortOrder` then group id. ACCEPTED is the union
  of matching accepted rules plus the matched managed group. The effective
  membership type is resolved by the ONE shared policy helper
  (`resolveMembershipTypePolicyForMember`) at the CURRENT season year — pricing
  resolves per stay-night season, grouping resolves at "now"; the two must not
  be merged.

### INV-INT-011

- Add-suppression: the managed group is added only when the contact is in NONE
  of (matched MANAGED ∪ matched ACCEPTED), so members parked in an accepted
  group get no spurious add. A member matching no rule is left untouched (no
  removals); when such a member sits in managed-universe group(s) they surface
  as an information-only entry in the dry-run snapshot (never iterated by the
  bulk re-sync) for deliberate admin cleanup in Xero.

### INV-INT-012

- The cutover migration deactivates every pre-existing `XeroContactGroupRule`
  row it did not backfill itself, so only tier-only backfill rules are live at
  deploy; dormant legacy rules require a deliberate admin re-enable via the
  grouping UI.

### INV-INT-013

- Mode/rule changes NEVER auto-resync the population. Deactivating or deleting a
  rule shrinks the managed universe, so members already in that group are never
  removed by the system. Members re-group on their next trigger (age-tier
  change, current-season membership-type change, cron age-up) or via the
  explicit admin bulk re-sync.

### INV-INT-014

- The per-member sync keeps Xero calls outside DB transactions, ledgers each
  operation with an idempotency key (the per-add key carries a per-operation
  nonce so a legitimate later re-add is never swallowed by Xero's 24h
  idempotency window), adds before removing, and refreshes the contact cache
  from the post-write contact. A remove-404 is idempotent success recorded as
  already-absent — never counted as a removal; an add-404 is a ledgered
  failure.

### INV-INT-015

- The bulk re-sync is admin-triggered, dry-run-first, cache-pre-filtered to
  mismatched members, chunked and resumable by member-id cursor, and never
  advances the CONTACT delta-sync watermark. Members without a Xero contact are
  reported as skipped, never silently omitted.

### INV-INT-017

- **A Xero contact's `CompanyNumber` (NZBN) field carries the member's date of
  birth, in `dd/mm/yyyy`, and exactly one module encodes and decodes it**:
  `src/lib/xero-contact-date-of-birth.ts`. Four divergent copies of that parser
  had grown before #2859 — two of them local-midnight and wrong — so a new
  reader or writer imports this module rather than matching the pattern again.
  The stored value is a date-only `Date` at UTC midnight [INV-DATE-024], so the
  parse is `parseDateOnly` and the render is `formatDateOnly`, both UTC.
- **The sync is two-directional and neither direction erases the other.** The
  app SENDS a date of birth it holds, on contact create and on contact update.
  The Xero→app direction (`xero-inbound/contact.ts`, `xero-member-import.ts`)
  only ever FILLS A GAP — it writes a date of birth onto a member who has none —
  so the pair cannot loop.
- **Three things the outbound write must never do**, all enforced in
  `buildXeroContactCompanyNumberPatch`. That field is the NZBN, and an
  organisation or school account may carry a real business number in it, so
  every one of these is somebody else's data:
  1. **Never send `""`.** A member with no date of birth contributes no
     `companyNumber` key at all. Absence is expressed by omission, never by
     blanking.
  2. **Never overwrite a value the DECODER cannot read as a calendar day.** The
     test is `parseXeroContactDateOfBirth`, not a `dd/mm/yyyy` shape match. The
     two disagree — `12/34/5678`, `31/02/1990`, `00/00/0000`, `99/99/9999` and
     the US-ordered `06/15/1985` all match the pattern and are all refused by
     the decoder — and a value this app would not import is a value it must not
     overwrite. A shape test here was a live defect (#2867 review).
  3. **Never write when nothing is known about the field.** "Known" means an
     observed `XeroContactCache` row for that contact. No row means no
     observation, and no observation means no write — not "the field must be
     empty". The app links contacts it did not create: `findOrCreateXeroContact`
     resolves a member onto a PRE-EXISTING contact by email match and then by
     exact-name match, writing no cache row, so a contact holding a genuine NZBN
     presents to an update as "no row". A cache row that exists and holds `null`
     is the opposite — a positive observation that Xero's field is empty — and
     is writable. Nothing may manufacture that state: erasure DELETES the cache
     row rather than nulling the field, precisely so it cannot be read as an
     observation (`deletion-requests/[id]/route.ts`,
     `member-lifecycle-actions.ts`).
- **There is no backfill, and its absence is a decision rather than an
  oversight.** The outbound write fires only when a contact is created or
  updated, so members already on file populate the NZBN field the next time
  something on their record changes; the owner chose that over a bulk push
  (15 August 2026).
- Because the outbound payload now carries a date of birth, `companyNumber` is
  redacted out of anything stored or logged; see [INV-PRIV-011].

## Endpoint modes external consumers still call (#2678)

### INV-INT-016

**`GET /api/bookings/rooms` keeps its no-`lodgeId` mode because CONSUMERS
OUTSIDE THIS REPOSITORY still call it that way** — not because anything in
`src/` needs it (#2678 surface 4).

The unscoped signature is the **pre-multi-lodge** one. This repository is a
template that other clubs fork and run, and their booking wizards and external
integrations still call the endpoint without a `lodgeId`. Requiring one would
break them for no internal gain. Since #2677 no page in `src/` uses the mode, so
from inside this repository it looks like an oversight and a tidy-up will
propose deleting it. It is not: the reason cannot be re-derived from the code,
which is why it is written here rather than left in a closed issue.

Four things follow, and all four are load-bearing:

- **Do not make `lodgeId` required, and do not delete the branch.** Changing the
  mode is a breaking change to a published contract with no internal benefit.
  The eligibility filtering is what makes retaining it SAFE — a named forbidden
  lodge answers `403`, an unscoped listing is filtered to the member's eligible
  lodges — but it is not the reason for retaining it.
- **No client in `src/` may call it without a `lodgeId`.** Doing so is the
  #2664 defect (a picker offering another lodge's rooms for a booking whose
  lodge is already fixed), and internal reuse of the mode is what made that
  defect possible. Pinned by
  `src/app/api/bookings/__tests__/rooms-unscoped-mode-has-no-internal-caller.test.ts`.
- **The unscoped listing EXCLUDES ARCHIVED LODGES** (#2727). It filters on
  `Room.active`, on the member's booking restrictions, and on the LODGE's own
  `active` flag, in both eligibility shapes: a default-open member's club-wide
  listing, and a restricted member whose `BOOKING_RESTRICTION` rows name a lodge
  that was archived afterwards. This is part of what "retained" means, not a
  separate nicety — the mode is discovery ("where could I book?"), and a club
  archives a lodge when it is closed, sold, out of service or seasonally shut,
  so offering its rooms invites a member to try somewhere the club has
  deliberately withdrawn. Eligibility and service state are different questions
  and both must be asked. The named-lodge branch is deliberately NOT filtered
  this way: naming a lodge is not discovery, and the caller already holds the
  id. Pinned by
  `src/app/api/bookings/rooms/__tests__/rooms-route-lodge-scope.test.ts`, which
  covers both branches because nothing in `src/` walks the unscoped one.
- **Describing the mode counts as documenting it.** A comment in `src/` that
  discusses this endpoint and archived lodges must cite `#2727` or
  `INV-INT-016`. This exists because #2727's own review caught two comments
  still asserting, in the present tense, that the unscoped mode has no
  lodge-`active` filter — after the route and three docs copies had been
  corrected. A stale description of a leak reads as a live one, and no lint,
  typecheck or index gate looks at prose. Pinned by the third case in
  `src/app/api/bookings/__tests__/rooms-unscoped-mode-has-no-internal-caller.test.ts`.
- **This retention covers the DISCOVERY READ, and nothing else** (#2701). It is
  not a general licence for an omitted `lodgeId`, and specifically it does not
  extend to `POST /api/bookings`, which now REFUSES a create that names no
  lodge (`INV-CAP-034`) rather than resolving one. The two are consistent, and
  the distinction is the same one this entry already draws when it says the
  named-lodge branch is deliberately not filtered because "naming a lodge is not
  discovery": an unscoped READ answers a real question — *where could I book?* —
  whereas an unscoped CREATE answers none, because nobody books "somewhere".
  Retaining a published read mode for forks costs those forks nothing; filling a
  blank on a write cost a member a paid booking at a lodge they were never
  shown. Said here because a reader who arrives holding only this invariant will
  otherwise read it as blessing both.

History, because the rule reads as obvious once it is written down and was not:
until #2727 this listing filtered on `Room.active` and booking restrictions but
not on the lodge's `active` flag, so an unrestricted member's cross-lodge
listing included archived lodges' rooms
(`docs/multi-lodge/lodge-scoping-contract.md` recorded it as behaviour rather
than as a defect). Pinning the mode with a rule while it carried that leak meant
the rule protected the leak too, which is why #2727 amended this rule rather
than only patching the route. Removing rows from a published response is a
visible change for an external consumer, and it was taken as a compatibility
note rather than a breaking change on the ground that no consumer can
legitimately depend on being offered an out-of-service lodge.

### INV-INT-018

- **A Xero contact id has at most ONE local home.** Since
  [#3366](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3366) two
  columns can hold one: `Member.xeroContactId` and
  `Organisation.xeroContactId`. Each is unique within its own table and nothing
  can express "at most one of the two", because no database constraint spans two
  tables that way. If both hold it the club's books say a school and a person
  are the same customer, and whichever path runs next decides which one wins.
- **Every writer that links a contact id refuses rather than guesses.** Before
  writing the link it establishes that the OTHER table has no claim on that id,
  and throws `XeroContactTwoHomesError` naming the record that holds it —
  `src/lib/xero-contact-home.ts` is the one home for both the check and the lock.
  The three writers are `findOrCreateXeroContact`'s phase-2 link,
  `commitManualXeroContactLink`, and the organisation-keyed resolve.
- **It is reachable on purpose, not only under concurrency.** A school's
  organisation contact carries the school's contact email, which is the same
  address the invented school member carries, and the member resolve asks Xero
  `EmailAddress="…"` FIRST. So a credit note or supplementary invoice on a school
  booking — paths that still read the booking's member — would deterministically
  find the organisation's contact and link it to the member. That is why the
  refusal is symmetric rather than sitting only on the organisation writer.
- **A contact-scoped advisory lock closes the concurrent half.** Key
  `hashtext('xero-contact-home:<contactId>')`, a domain-keyed lock in its own
  keyspace, joining neither the global lock(1) cohort nor the per-lodge capacity
  key. It is always acquired LAST — the writer's own entity key first
  (`INV-LOCK-002`) — and no provider call runs inside the transaction holding it.
- **The organisation resolve never searches Xero by email.** Its only adoption
  path is a contact Xero itself refused to duplicate because the NAME is taken,
  and even that is subject to the refusal above. A school's recorded address is
  routinely a teacher's own, so an email search would adopt that person's
  personal contact — the one thing
  [#2912](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/2912)
  settled must never happen.
- **The returning school is an expected outcome, not a failure.** A school that
  has booked before already has a person-shaped contact under its own name, so
  the create is refused by Xero for the duplicate name and the adoption is
  refused here. The organisation stays unlinked, the sync operation is closed
  `CANCELLED` with a populated reason rather than `FAILED`, and the invoice is
  raised against the contact the school already has. Classifying that contact as
  the school's is
  [#3369](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3369)'s
  census, which requires zero ambiguous rows.
- **This is bounded.** #3369 removes the invented school member, which is the
  other home. The overlap opens when
  [#3367](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3367) first
  links an organisation and closes there. Nothing here is meant to be permanent;
  what it must be is real while it lasts.
- **What is NOT guarded, and why.** `xero-member-import.ts` links members onto
  pre-existing Xero contacts in bulk from mapped contact GROUPS, and does not
  take this refusal. A school's organisation contact reaches it only if an
  operator puts that contact into a membership group, and bulk contact seeding is
  [#2939](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/2939)'s
  subject. Stated here rather than left to be discovered, and pinned by the
  reader census in
  `src/lib/__tests__/organisation-reader-contract.test.ts`.
