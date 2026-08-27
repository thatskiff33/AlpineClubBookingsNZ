# Lodge Scoping Contract

This contract records which data is lodge-scoped, which stays club-wide,
and the rules service code must follow. Update this file before changing
the scoping of any model, the same way `finance-dashboard/data-contracts.md`
is updated before metric definitions change.

## Lodge-Scoped Models

These carry a required `lodgeId` after phase 2 (see ADR-001 for migration
sequencing):

| Model | Scoping | Notes |
| --- | --- | --- |
| `LodgeRoom` | direct `lodgeId` | `name` unique per lodge, not globally |
| `LodgeBed` | via `LodgeRoom` | no direct FK |
| `BedAllocation` | via room/booking | no direct FK |
| `Locker` | direct `lodgeId` | `name` unique per lodge; lockers gain a lodge link for the first time |
| `Season` | direct `lodgeId` | lodges may have different season windows |
| `MembershipTypeSeasonRate` | via `Season` | keeps `[seasonId, membershipTypeId, ageTier]` uniqueness. Replaced the boolean-keyed `SeasonRate` at E4 (#1930); `SeasonRate` itself was dropped by `20260721120000_contract_drop_season_rate` (#2129 step 2) |
| `Booking` | direct `lodgeId` | denormalised for capacity/availability query performance; always matches the room's lodge when a room is assigned. `waitlistOfferedLodgeId` (nullable) names the alternate lodge of a live cross-lodge waitlist offer (ADR-004) and never changes the entry's own lodge |
| `BookingWaitlistAlternateLodge` | direct `lodgeId` junction | ADR-004 cross-lodge waitlist opt-in: lodges a waitlisted member would also accept; rows only widen what the processor may offer |
| `BookingGuest` / `BookingGuestNight` | via `Booking` | no direct FK |
| `GroupBooking` | via organiser `Booking` | one group = one lodge (ADR-001 open question 1) |
| `ChoreTemplate` | direct `lodgeId` | roster generation filters by lodge |
| `LodgeSettings` | per-lodge row | converted from singleton |
| `BedAllocationSettings` | per-lodge row | converted from singleton |
| `BookingDefaults` | per-lodge row | converted from singleton |
| `BookingRequestSettings` | per-lodge row | converted from singleton |
| Lodge identity fields (`lodgeName`, `doorCode`, `lodgeTravelNote`) | resolve from `Lodge` (default lodge when no `lodgeId` is in scope) | dropped from the `EmailMessageSetting` singleton (migration `20260709130000`) |
| `MaintenanceReport` | direct `lodgeId` | a reported physical fault belongs to one building (#2780); `onDelete: Cascade` — a deleted lodge takes its fault history with it |
| `LodgeMaintenanceReportToken` | direct `lodgeId` (`@unique`) | one live QR-sign bearer token per lodge (#2780); rotating overwrites in place, `onDelete: Cascade` |
| `MaintenanceReportAnswer` | via `MaintenanceReport` | no direct FK; answers store the question label as asked, so they carry the report's lodge |
| Model                                                              | Scoping                                                            | Notes                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LodgeRoom`                                                        | direct `lodgeId`                                                   | `name` unique per lodge, not globally                                                                                                                                                                                                                                                                                                                   |
| `LodgeBed`                                                         | via `LodgeRoom`                                                    | no direct FK                                                                                                                                                                                                                                                                                                                                            |
| `BedAllocation`                                                    | via room/booking                                                   | no direct FK                                                                                                                                                                                                                                                                                                                                            |
| `Locker`                                                           | direct `lodgeId`                                                   | `name` unique per lodge; lockers gain a lodge link for the first time                                                                                                                                                                                                                                                                                   |
| `Season`                                                           | direct `lodgeId`                                                   | lodges may have different season windows                                                                                                                                                                                                                                                                                                                |
| `MembershipTypeSeasonRate`                                         | via `Season`                                                       | keeps `[seasonId, membershipTypeId, ageTier]` uniqueness. Replaced the boolean-keyed `SeasonRate` at E4 (#1930); `SeasonRate` itself was dropped by `20260721120000_contract_drop_season_rate` (#2129 step 2)                                                                                                                                           |
| `Booking`                                                          | direct `lodgeId`                                                   | denormalised for capacity/availability query performance; always matches the room's lodge when a room is assigned. `waitlistOfferedLodgeId` (nullable) names the alternate lodge of a live cross-lodge waitlist offer (ADR-004) and never changes the entry's own lodge                                                                                 |
| `BookingWaitlistAlternateLodge`                                    | direct `lodgeId` junction                                          | ADR-004 cross-lodge waitlist opt-in: lodges a waitlisted member would also accept; rows only widen what the processor may offer                                                                                                                                                                                                                         |
| `BookingGuest` / `BookingGuestNight`                               | via `Booking`                                                      | no direct FK                                                                                                                                                                                                                                                                                                                                            |
| `GroupBooking`                                                     | via organiser `Booking`                                            | one group = one lodge (ADR-001 open question 1)                                                                                                                                                                                                                                                                                                         |
| `ChoreTemplate`                                                    | direct `lodgeId`                                                   | roster generation filters by lodge                                                                                                                                                                                                                                                                                                                      |
| `LodgeSettings`                                                    | per-lodge row                                                      | converted from singleton                                                                                                                                                                                                                                                                                                                                |
| `BedAllocationSettings`                                            | per-lodge row                                                      | converted from singleton                                                                                                                                                                                                                                                                                                                                |
| `BookingDefaults`                                                  | per-lodge row                                                      | converted from singleton                                                                                                                                                                                                                                                                                                                                |
| `BookingRequestSettings`                                           | per-lodge row                                                      | converted from singleton                                                                                                                                                                                                                                                                                                                                |
| `ServerNzSettings`                                                 | club-wide singleton (`id = "default"`)                             | NOT converted to a per-lodge row, deliberately: one club holds ONE connection to the central server (one base URL, one API key, one sync cursor), and the registry it exchanges is a list of other CLUBS rather than of this club's buildings. A per-lodge row would imply a lodge could sync independently, which the central server has no concept of |
| Lodge identity fields (`lodgeName`, `doorCode`, `lodgeTravelNote`) | resolve from `Lodge` (default lodge when no `lodgeId` is in scope) | dropped from the `EmailMessageSetting` singleton (migration `20260709130000`)                                                                                                                                                                                                                                                                           |

## Club-Wide Defaults With Per-Lodge Overrides

`CancellationPolicy`, `MinimumStayPolicy`, and `BookingPeriod` gain a
nullable `lodgeId` (ADR-001 resolved question 3). Resolution rule: rows
with null `lodgeId` are the club-wide defaults; if any rows exist for a
lodge, that lodge uses its rows instead of — never merged with — the
club-wide set for that policy type. Service code resolves a lodge's
policy through one shared helper so the replace-not-merge rule cannot
drift between the three policy types.

`LodgeInstruction` follows the same rule per document key (delivered
2026-07-03): null-`lodgeId` rows are the club-wide OPEN/CLOSE/DAY_TO_DAY
documents, and a `[lodgeId, key]` row replaces the club-wide document of
that key for that lodge — never merged. Readers resolve through
`getSanitizedLodgeInstructions(lodgeId)`; the kiosk surface derives its
lodge via `resolveKioskLodgeId`, and the admin editor edits one partition
at a time (omitted `lodgeId` means the club-wide partition, not the
default lodge) with an explicit `remove: true` flag to drop an override.
On the member reader (`GET /api/lodge-instructions?lodgeId=`), a hut leader
may only request a lodge they hold a current/upcoming assignment for
(assignment lodge set); an out-of-set `lodgeId` is `403`. Admins may request
any lodge. This keeps a lodge A hut leader from reading lodge B's
operational documents (which may carry door/emergency access details).

## Optional Lodge Restrictions

- `PromoCode`: restricted via a `PromoCodeLodge` junction table (phase 6),
  because a promo may apply at several lodges but not all. No junction
  rows = redeemable at every lodge.
- Member booking eligibility and lodge-operational staff access share the
  `MemberLodgeAccess` junction table (delivered in phase 4) with a `kind`
  enum. `BOOKING_RESTRICTION` rows mean the member may book only the
  listed lodges; no rows is default-open. Enforcement lives in the
  booking service (`assertMemberMayBookLodge`), and the same eligibility
  check (`isMemberEligibleToBookLodge`) also gates the read-side
  availability/pricing surfaces so a restricted member cannot discover a
  forbidden lodge's data: `/api/availability`, `/api/availability/check`,
  `/api/bookings/quote`, and `/api/bookings/rooms` return `403` when a
  restricted lodge is named. `/api/bookings/rooms` also has a no-`lodgeId`
  mode that lists room config across lodges; that listing is **filtered** to
  the member's eligible lodges **and to lodges that are still `active`** (empty
  when none match) rather than returning
  `403` — a listing omits what the member cannot see. Both the named-lodge
  gate and the listing filter derive from `getEligibleLodgeIdsForMember`
  (which `isMemberEligibleToBookLodge` also derives from), so the two are the
  same eligibility set by construction. Those two modes serve **discovery**:
  a member choosing where to book. They are not the right shape once a booking
  exists — see the booking-scoped read below. **No production surface asks the
  no-`lodgeId` mode any more** (#2664, create side): the booking wizard always
  names the lodge it is booking, because `LodgeSelect` normalises even a
  single-lodge club to a concrete id on the wizard's opening step. It used to
  fire the unscoped request on every mount while waiting for that
  normalisation, and — with no cancellation guard on the effect — a reply
  landing after the one that superseded it left the wrong lodge's rooms in the
  "Preferred room (optional)" picker for the rest of the session, where
  `resolveBookingLodgeId` (`booking-create.ts:153-174`) would then refuse the
  choice. Two consequences are worth stating rather than leaving implicit.
  First, that mode's filter was `Room.active` and the member's booking
  restrictions — **not** the lodge's own `active` flag — so until #2727 an
  unrestricted member's cross-lodge listing included archived lodges' rooms,
  which is why it was never safe to describe as "the lodges this member may
  book". It is now filtered on `Lodge.active` as well, in both eligibility
  shapes (a default-open member's club-wide listing, and a restricted member
  whose `BOOKING_RESTRICTION` rows name a lodge archived afterwards), because
  eligibility and service state are different questions and a discovery listing
  must ask both — that exclusion is part of what retaining the mode means, and
  is stated as a rule in `INV-INT-016`. The named-lodge mode is unchanged and
  still answers for a lodge the caller names explicitly, archived or not: naming
  a lodge is not discovery. Second, the
  wizard now offers **nothing** while its selection is null, and that null is
  permanent when `/api/lodges` is down or a club's only lodge is inactive (that
  route filters `active: true`, while `getDefaultLodgeId` deliberately falls
  through to a lodge of any state). Offering nothing there is the deliberate
  choice: a client that cannot know which lodge the server will stamp on the
  booking must not guess at an optional preference. The unscoped mode is
  retained **because consumers outside this repository need it** — see
  `INV-INT-016`. It is the pre-multi-lodge signature, and forked booking wizards
  and external integrations still call it that way, so requiring `lodgeId` would
  break them for no internal gain; the eligibility filtering is what makes
  retaining it safe, not the reason for retaining it. (An earlier revision of
  this sentence said the opposite — "retained as an eligibility-filtered
  discovery contract, not because a client needs it" — which reads as an
  invitation to delete a branch a fork depends on.) No client in `src/` may use
  the mode, which is a separate rule and is pinned by a test; see
  `INV-INT-016`. Admin on-behalf bookings and quotes
  bypass it as the audited override path. `STAFF` rows bind a kiosk account to its lodge;
  exactly one grant binds, zero grants fall back to the default lodge, and
  **two or more grants are ambiguous and denied** (`getStaffLodgeBinding`
  returns `{ kind: "ambiguous" }`; `resolveKioskLodgeId` throws
  `AmbiguousKioskLodgeError` and every kiosk data route maps it to a clean
  `403` via `kioskLodgeAuthErrorResponse`, while PIN login returns `403`
  directly, rather than serve the default lodge's data on the wrong property).
  Hut-leader assignments carry their own `lodgeId` and PINs match only at
  the bound lodge's kiosk. `ADMIN` access is club-wide and never
  lodge-filtered.
- **Editing a booking that already exists is scoped by that booking, not by
  the editor's own eligibility** (#2664). A booking already has a lodge and the
  server owns it, so a read that feeds an editor on that booking derives its
  lodge from `Booking.lodgeId` server-side and authorises on the booking's own
  boundary — never from a client-supplied `lodgeId`, and never from the caller's
  personal `isMemberEligibleToBookLodge` result. The requested-room picker is
  the worked example: `GET /api/bookings/[id]/requested-room/options` resolves
  the booking, refuses anyone who is not its owner, a Full Admin, or a
  `bookings:edit` Booking Officer, and returns only **that lodge's active
  rooms**. Reusing the discovery-shaped eligibility here got it wrong in both
  directions — it offered another lodge's rooms to a member eligible for both (a
  choice `writeRequestedRoom()` then refused under its lock, so the control
  looked broken), and it filtered a Booking Officer's choices by that officer's
  own booking restrictions even though their write runs under `bookings:edit`.
  The writer's same-lodge validation stays authoritative regardless: the scoped
  read is UX correctness, not a substitute for the write guard.
  One consequence is deliberate and worth stating plainly: a member who owns a
  booking at a lodge they are **later** restricted away from can still read that
  booking's room names through this route, where the discovery endpoint would
  now filter them out. That is correct. `writeRequestedRoom()` never consults
  `assertMemberMayBookLodge`, so the member can still change the requested room
  on the booking they already hold — and refusing the read while permitting the
  write would recreate the exact broken control this contract exists to remove.
  A booking restriction governs making NEW bookings, not operating one the club
  already accepted. Any future read added under this rule inherits the same
  reasoning: match the read to the write it feeds, not to the discovery gate.
- **The admin bed-allocation board obeys the same rule when a booking is named**
  (#2678). `GET /api/admin/bed-allocation` still supports a genuine club-wide
  mode — `ADMIN` access is club-wide and never lodge-filtered, so an omitted
  `lodgeId` legitimately means "the whole club" and that is unchanged. Since
  #2701 that mode is **deliberately selectable and read-only**; see the entry
  below. But when the request names a `bookingId`, the lodge comes from that
  booking's `Booking.lodgeId` server-side and a contradicting `lodgeId` on the
  query string is **refused** (#2701 — it used to be silently ignored, as
  `requested-room/options` still does; the divergence and its reason are in the
  entry below). This was the last booking-scoped read still taking its lodge
  from the caller, after #2673 (the requested-room picker) and #2677 (the
  booking wizard).
  The path that made it worth fixing was not a hand-crafted request. Because
  `ADMIN` is club-wide, a caller pairing booking A with lodge B learned nothing
  they could not have asked for outright, and every cross-lodge write was
  already refused (`assertGuestAndBedForAllocation`, and `LODGE_MISMATCH` in
  `bed-allocation-move.ts`). The reachable problem was that
  `AdminBookingToolsCard` deep-linked the board with `bookingId` and **no**
  `lodgeId`, so an admin two clicks from a booking page landed on a club-wide
  board focused on that booking, whose four bed pickers — the bucket "Select
  bed", the allocation chip's "Move to bed", drag-and-drop onto a cell, and
  `BedRangeAssignDialog` — all offered every lodge's beds for that booking's
  guests. Offer-then-refuse is the same broken control #2664 is about.
  Two details are deliberate. The booking lookup does **not** filter on status:
  the lodge is a fact about the row whatever its status, and a cancelled
  booking's board still has to be readable, while `focusedBooking` keeps its own
  stricter allocatable/non-deleted filter for the window it snaps onto. And an
  unresolvable `bookingId` changes nothing — the caller's own scope still
  applies, because a stale deep link must not turn a valid board load into an
  error.
  `BookingBedAllocationPanel.lodgeId` is now `string`, not `string | null`. It
  was safe only because its single caller passes `booking.lodgeId`, a NOT NULL
  column; the nullable type invited a future caller to turn a booking-scoped bed
  picker into a club-wide one with nothing to catch it.
  **The client half is load-bearing and is now pinned.** Server-side derivation
  reaches the board only because the board names the booking on its own request
  (`admin/bed-allocation/page.tsx`, `fetchDashboard`); delete that one line and
  every server-side test still passes while the four pickers go club-wide again,
  so `src/lib/__tests__/bed-allocation-board-booking-scope.test.tsx` asserts it
  directly.
  **A focused booking pins the lodge, so choosing another lodge drops the
  focus.** Because the API does not take its scope from a `lodgeId` sent beside
  a `bookingId`, an
  admin who arrived on the deep link and then picked a different lodge from the
  board's own selector would have been served the _booking's_ lodge under a
  selector reading the lodge they chose. The board therefore clears the focused
  booking when the admin replaces one non-null lodge with a different one — the
  "Focused booking" badge goes with it, so the change is visible. `LodgeSelect`'s
  own `onChange` calls are deliberately excluded — they are not the admin
  browsing away, and the outage case is precisely the state in which derivation
  from `bookingId` is the only thing keeping the board off a club-wide read.
  Since #2701 the component **reports** which it was (`source: "user" | "auto"`)
  rather than leaving the page to infer it from the values, which could not tell
  a default apart from a deliberate pick landing on the same lodge.
- **A failed lodge list is a state every lodge-scoped surface must be able to
  express, not just the bed board** (#2701). `useLodgeOptions` reports `failed`
  and `forbidden` beside its list, because an empty list used to mean three
  different things and `LodgeSelect` renders nothing below two lodges (ADR-002)
  — so on **twenty-two admin surfaces** a failed request looked exactly like a
  club with no lodges. That was never cosmetic: the selection normalises to `null`, and a
  `null` lodge was resolved server-side to the club's DEFAULT lodge, so the next
  thing the operator saved landed somewhere they were never shown. Eight ordinary
  editors could write to the default lodge that way, while work parties and promo
  codes could silently make a lodge-specific choice club-wide; two of those ten
  surfaces are money paths. Five more
  policy editors — default cancellation, minimum stay, booking periods,
  adult-member hosting and lodge instructions — treated the same unresolved
  `null` as club-wide, leaving club-wide reads and writes reachable. All fifteen
  edit surfaces now close their transport and action boundaries.
  The shared treatment is `LodgeOptionsUnavailableNotice` — one explanation and
  one working retry — plus, on each surface, suppression of the lodge-keyed
  fetch and of every write control while the scope is unknown. **The suppression
  is the half that matters**; a message alone leaves the wrong write reachable.
  A 403 is deliberately NOT described as an outage: `ADMIN_MEMBERSHIP` and
  `FINANCE_ADMIN` hold `bookings` and no `lodge` permission, so a refusal is
  their normal answer and a retry could only refuse again. A surface that must
  know a concrete policy partition still suppresses its downstream request and
  actions and explains that lodge access is needed; the bed board's separate
  read-only all-lodges exception is documented below.
  The five policy editors make a deliberate club-wide choice a settled
  `club-wide` state, distinct by construction from `resolving` and
  `unavailable`. They issue no policy GET until that settled state or a concrete
  `lodge` exists, and show no Edit, Save, Create, Remove, Delete or toggle action
  before then. Their shared behavioral test renders all five and proves that a
  cosmetic notice without the transport/action gate fails.
  Three surfaces are deliberately left to degrade quietly, and that is a
  decision rather than an omission: `reports`, the promo-redemptions panel and
  the public booking-requests panel already default to a genuine all-lodges
  read where every figure stays correct, so the lodge is a filter over content
  that stands alone. Forcing an error there would be worse than the ambiguity
  it removed.

  Quiet degradation means the DATA degrades quietly, never the LABEL (#2887).
  The original wording here — "the lodge picker is only an optional filter" —
  did not describe two of the three, and that is how the miss survived review:
  - the public booking-requests panel **has no lodge picker at all**. Its lodge
    identity is a per-row badge, and it was gated on `activeLodges.length >= 2`,
    which is also false for a failed or forbidden list. `/admin/booking-requests`
    is in the **bookings** area, and `ADMIN_MEMBERSHIP` and `FINANCE_ADMIN` hold
    `bookings: "view"` with no `lodge` entry, so for those shipped presets the
    badge was permanently absent while `lodgeName` sat in the payload — an
    officer pricing and approving a stay with no lodge on screen, on a mutation
    surface;
  - `reports` dropped its `occupancyScopeLabel` in the same states, so a
    club-wide occupancy figure became indistinguishable from one lodge's.
    `/admin/reports` is in the **finance** area, where `FINANCE_ADMIN`,
    `FINANCE_USER` and `ADMIN_MEMBERSHIP` all get a permanent 403 on the lodge
    list.

  **The root cause was NOT fixed there — it is #2925, and it is now delivered.**
  `GET /api/admin/lodges` required `lodge:view`, and `ADMIN_MEMBERSHIP` and
  `FINANCE_ADMIN` hold no `lodge` entry, so a 403 was their permanent answer and
  every admin surface that needs only the lodge NAMES lost content it does not
  need permission for. The fix is at the route, where one gate serves all
  twenty-two consumers:
  [Admin Lodge List Access And Payload](#admin-lodge-list-access-and-payload).

  They are also fixed at the surface, and the difference between the two is the
  point.

  The booking-requests badge no longer consults the lodge list at all. ADR-002's
  count rule is applied SERVER-side — `serializeBookingRequestForAdmin` takes
  the active-lodge count and nulls `lodgeName` below two — and the panel renders
  whatever name it is handed. A client cannot honestly apply a count rule using
  a list it may be forbidden to read, and counting client-side was wrong in both
  directions: too closed for the two presets above, and too open once this PR
  made the whole-lodge form always send the sole lodge id, which gives new
  single-lodge rows a real name.

  `reports` still decides client-side and fails OPEN on `failed`/`forbidden`
  only, labelling the occupancy scope "All lodges" when it cannot tell. Two
  honest limits on that: while the list is still LOADING the qualifier is
  absent, which is transient and read-only; and on a genuinely single-lodge club
  whose list is forbidden it says "All lodges" where ADR-002 would say nothing —
  accurate about the data, since the API does return all-lodge figures, but more
  verbose than the rule prefers. Fixing it properly needs a plurality signal on
  the reports payload, the same shape as the booking-requests fix. Recorded
  rather than guessed at.

  The census is exact, not “roughly twenty”. There are eighteen production
  `useLodgeOptions` call sites in the admin tree; the shared policy selector is
  used by five editors, so replacing that one call site with its five rendered
  surfaces gives **twenty-two admin consumers**. The member booking wizard is a
  twenty-third product consumer outside the admin tree and is listed separately
  because its failed-list response is governed by `INV-CAP-034`.

  A second exact census covers the eleven production consumers that fetch a
  lodge list directly rather than through `useLodgeOptions`: display builder,
  devices, reference, setup wizard and templates; the lodge list, lodge detail
  and lodge setup pages; the whole-lodge request form; lodge details panel; and
  notice audience picker. The census fails on an added or removed direct fetch
  so a new consumer cannot silently inherit default-lodge behaviour. It matched
  three exact literal spellings until #2887, which meant a consumer written as
  a template literal or with a query string was invisible to it; the match is
  now any `fetch` of the endpoint in any quote style, still anchored to a call
  or a named endpoint constant so route tables and prose do not register. Display
  authoring/preview and whole-lodge requests now require an explicit recovered
  lodge even for a single-lodge club. Devices, the lodge list and notice picker
  show an honest failed state with retry and suppress the affected create or
  audience controls; no non-OK response is rendered as “No lodges”.

  | Admin consumer(s)                                                                             |  Count | Failed-list treatment and reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
  | --------------------------------------------------------------------------------------------- | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Bed-allocation board                                                                          |      1 | Required explicit error/retry; no dashboard request. A lodge-forbidden viewer gets the separately labelled read-only all-lodges board.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
  | Admin booking on behalf                                                                       |      1 | Required visible warning and an always-visible lodge name. The admin may continue through the form, but the strict create boundary refuses an unknown lodge instead of defaulting it.                                                                                                                                                                                                                                                                                                                                                                                                                               |
  | Seasons, chores, lockers, hut fees, roster, hut leaders, rooms/beds, lodge capacity           |      8 | Required total settled-scope gate. Loading, failure, forbidden and successful-empty states issue no downstream GET and expose no action. Only a lodge id validated by the successful options response is transported.                                                                                                                                                                                                                                                                                                                                                                                               |
  | Work parties, promo codes                                                                     |      2 | Required total settled-scope gate. Their legitimate club-wide state is represented by an explicit sentinel, never inferred from an empty list; the same four unresolved states issue no downstream GET and expose no action. A list OUTCOME beats the sentinel, deliberately (#2887): both gate their lodge-RESTRICTION control on `lodges.length > 1`, and the options hook empties the list on a 403 and on any other failure, so treating the sentinel as an answer there would unlock the create while hiding the control that scopes it — a promo code redeemable at every lodge, a work party at every lodge. |
  | Default cancellation, minimum stay, booking periods, adult-member hosting, lodge instructions |      5 | Required policy gate. A deliberate club-wide choice or validated lodge is settled; resolving/unavailable states issue no policy GET and expose no policy action.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
  | Member lodge-access card                                                                      |      1 | Required error/access explanation; its lodge-access GET and every assignment control stop until options resolve.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
  | Lodge kiosk accounts                                                                          |      1 | Required explanation, because a failure hides the lodge-binding controls. The club-wide kiosk-account list remains valid and continues to load; create/rebind controls cannot appear without the real options.                                                                                                                                                                                                                                                                                                                                                                                                      |
  | Reports, promo-code redemptions, public booking requests                                      |      3 | Deliberate quiet degradation of the DATA, never of the label (#2887). Each already reads a genuine all-lodges dataset whose figures stay correct without the options. Reports keeps its occupancy scope qualifier and the public booking-requests panel keeps its per-row lodge badge in the failed/forbidden states — both of which previously vanished there, and the booking-requests panel has no picker to call an "optional filter" in the first place.                                                                                                                                                       |
  | **Total admin surfaces**                                                                      | **22** | Every consumer is classified; none silently treats a failed list as evidence that the club has no lodges.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

  The ten ordinary-editor transport gates are exercised through the real
  components in
  `src/lib/__tests__/ordinary-admin-lodge-scope-behavior.test.tsx`: all forty
  editor/state pairs (ten editors times loading, failed, forbidden and empty)
  assert zero downstream requests and no action. All ten exact action labels
  have settled-scope positive controls, so a misspelled matcher cannot make any
  negative group pass vacuously. Replacing a production guard with a no-op makes
  its negative cases fail.

  Stateful consumers have additional response-ownership rules. A capacity
  GET or PUT started for Lodge A cannot overwrite Lodge B after a selector
  change, including the success message. The member lodge-access card issues no
  grants GET in loading, failed, forbidden or successful-empty states and only
  renders populated grants after a successful two-lodge recovery. The member
  booking Dates step mounts neither its availability calendar nor any
  lodge-dependent read/write until its selected id belongs to the successful
  options response; retry returns to Dates, reloads the list and lets the selector
  establish a fresh concrete id. Seasons, chores, hut fees, lockers, roster and
  rooms/beds clear Lodge A rows and edit drafts synchronously when Lodge B is
  selected; late A reads and post-action refreshes cannot repopulate them, and a
  save keeps the scope it captured rather than pairing A data with B. The same
  sequence/abort ownership applies to lodge instructions and admin quotes.

  The ref that names the scope currently on screen is written in the COMMIT,
  never in the render body and never in a passive effect (#2887). A render-body
  write also moves for a render React abandons; a passive write lands after
  paint, leaving a window in which a late Lodge A response still reads A as
  current. Every one of the seven refs is therefore set in a `useLayoutEffect`,
  which `src/lib/__tests__/lodge-scope-committed-ownership.test.tsx` pins for
  each file — that test also carries the full reasoning and is the one home for
  it.

- **The board's lodge scope is five named states, the set is TOTAL, and `null`
  means exactly one thing** (#2701). It used to mean three: a deliberate
  club-wide view, a selector that had not resolved, and a failed
  `/api/admin/lodges` — and the board's four bed pickers were club-wide in all
  three, offering every lodge's beds in the two nobody chose. The states are
  `lodge`, `all`, `empty`, `resolving` and `unavailable`, decided in one place
  (`deriveBoardLodgeScope`), and everything on the page derives from which is
  active:
  - **`all` carries the reason it was reached** — `chosen`, or
    `no-lodge-permission`. `LodgeSelect` gained an opt-in `ALL_LODGES` sentinel
    option (`allowAllLodges`, set only by this page) that its normalising effect
    leaves alone. A single-lodge club never reaches it: ADR-002 still normalises
    to the sole lodge, sentinel or not.
  - **A 403 on the lodge list is not an outage.** `/admin/bed-allocation` is
    gated on `bookings`, and `GET /api/admin/lodges` then needed `lodge:view`.
    The shipped `ADMIN_MEMBERSHIP` and `FINANCE_ADMIN` presets hold
    `bookings: "view"` and no `lodge` entry at all, so for them the refusal was
    the normal answer and club-wide read-only was the only view they could have
    — the view they had before #2701. `useLodgeOptions` therefore reports
    `forbidden` separately from `failed`, and this board maps it to `all` /
    `no-lodge-permission` with its own banner. Collapsing the two handed those
    roles a permanent error and a retry that could only 403 again.

    **#2925 relaxed that route** (see
    [Admin Lodge List Access And Payload](#admin-lodge-list-access-and-payload)),
    so those two presets now get a real list here. The state and the banner stay: a
    club-edited or custom role holding `bookings: "view"` with `overview: "none"`
    is still refused, and `failed` is unchanged.
  - **`empty` is a real state.** A successful lodge list with no ACTIVE lodge is
    neither club-wide nor an outage nor a state that resolves; without it the
    board sat on a "Choosing which lodge to show" spinner for ever with Refresh
    disabled and no error.
  - **`resolving` fetches nothing.** The board asks for no dashboard at all
    until it holds a concrete lodge, a deliberate All lodges, or a focused
    booking that the server scopes for it — so the transient club-wide read on
    every direct visit is gone rather than tidied up.
  - **`unavailable` is distinguishable by construction.** With no options there
    is nothing to select, so All lodges cannot have been chosen; the page shows
    an error with a retry rather than a club-wide board. It is not an error
    message bolted onto an ambiguous state.
  - **`all` is READ-ONLY.** Every allocation control that needs a concrete lodge
    — the four bed pickers, Run Auto Allocation, Approve Visible (which used to
    approve the whole club's visible window with no lodge at all), Reset
    allocations, Remove allocation and the preferences section — is disabled,
    with one explanation at the top of the board and the same sentence as each
    control's tooltip. `Remove allocation` in particular was a clickable silent
    no-op without a lodge, since its handler simply returned.
- **A booking deep link lands on that booking's own lodge, and the server is
  what says so** (#2701). `GET /api/admin/bed-allocation` echoes
  `scopedLodgeId` — the lodge it actually scoped to, null for a deliberate
  club-wide read — and the board adopts it while a booking is focused. The
  field is read tolerantly: an old-colour payload during a deploy drain carries
  none, which reads as "the server did not say", never as a club-wide answer.
  **While a booking is focused, `LodgeSelect`'s default is held off entirely**
  (`deferDefaultSelection`), not merely until the first payload arrives. This
  is load-bearing and it is the single most important line in the whole change,
  so it is worth stating why in full. The ADR-002 normaliser fires whenever
  fewer than two ACTIVE lodges are offered, and that effect runs even though the
  same condition makes the component render nothing. Left running it overwrites
  the lodge the server just derived — which changes the scope key, refires the
  request, re-adopts, and loops: a reviewer measured **62 dashboard reads in
  about a second**, paced by round trips, so React never sees a synchronous
  cycle, nothing crashes, and the only symptom is a flickering page hammering
  the database for as long as the tab is open. Any club with fewer than two
  active lodges reached it, including a **successful but empty** list, which
  does not even raise the error banner.
  The same overwrite is what fires the 409 below on honest navigation. A booking
  at a **deactivated** lodge is filtered out of the options, so the normaliser
  substitutes the surviving active lodge and pairs it with the booking — on the
  exact URL `AdminBookingToolsCard` builds. And because the deferral used to
  clear on any dashboard error, a single transient 500 was enough to convert a
  recoverable blip into a permanent, wrong mismatch screen.
  While a booking is focused there is nothing left to default: the server has
  already answered from `Booking.lodgeId`. The deferral lifts when a deliberate
  lodge change clears the focus.
- **The board-level `LODGE_MISMATCH` backstop, and why this route diverges from
  ignoring a contradiction** (#2701). `requested-room/options` and the
  hut-leader bed picker IGNORE a `lodgeId` that contradicts their named row.
  This route refuses it with a 409 carrying `code: "LODGE_MISMATCH"` — the same
  spelling as the writer's own refusal in `bed-allocation-move.ts`, which is
  untouched and remains the thing that actually protects the data. The board is
  different in one way that matters: it renders the focused booking and a lodge
  selector side by side, so quietly serving lodge A's board for a lodge-B
  booking under a selector reading "Lodge A" is an internally contradictory
  screen rather than a redundant parameter. The refusal is affordable **because**
  the selection fixes above mean the client cannot produce the pair — it sends
  the booking's own lodge, or sends no lodge and adopts the echo. An
  unresolvable `bookingId` still refuses nothing: the caller's own scope
  applies, because a stale deep link must not turn a valid board load into an
  error. The predicate lives in `src/lib/bed-allocation-board-scope.ts`, a
  client-safe module, so `bed-allocation-board-lodge-scope.test.tsx` can drive a
  fake server through the SAME function the route calls — which is what makes
  "the 409 cannot fire on normal navigation" a proof rather than a restatement,
  and is how the deactivated-lodge case was found.
  The board also offers a way OUT of the refusal — a control that drops the
  link's lodge and lets the server scope from the booking — because a hand-made
  URL should not be a dead end, and that is the only recovery that can succeed.
- **Stateful booking responses and queue positions keep their lodge owner**
  (#2701/#2887). The admin booking wizard owns each availability response by
  request and lodge, so a late Lodge A response cannot advance or resize a Lodge
  B booking. Initial waitlist positions are counted under the selected lodge's
  capacity lock using only older overlapping entries at that lodge, matching
  every later waitlist position calculation and the member's confirmation email.
- **Booking admission and lodge deactivation share one lodge lock** (#2701).
  Draft, confirmed and waitlist creation take the selected lodge's immutable
  capacity key before re-reading active status, member access and requested-room
  ownership. Deactivation takes config-import then the same capacity key and
  re-reads both the target and the “another active lodge remains” predicate.
  This prevents admission at a lodge that became inactive while the request was
  waiting and prevents concurrent last-two-lodge deactivations from leaving no
  active lodge.
- **The hut-leader bed picker obeys the same rule when an assignment is named**
  (#2678). `GET /api/admin/hut-leaders/available-beds` took `assignmentId` and
  `lodgeId` as unrelated parameters and never reconciled them, so a request
  naming assignment A at lodge B was answerable and returned lodge B's beds.
  `HutLeaderAssignment.lodgeId` is NOT NULL, so a named assignment already fixes
  the lodge: it is now derived server-side and a contradicting `lodgeId` is
  **ignored**, matching `requested-room/options` and the board above. The
  CREATE form is untouched — it has no `assignmentId`, so the lodge the admin
  chooses is the lodge it uses — and the writer's own cross-lodge refusal
  (`custodian-assignment.ts`, `BED_WRONG_LODGE`) stays as defence in depth. A
  derived lodge is still validated as active, which is identical to what the
  honest caller already got, because the row-edit form was already sending that
  same lodge. Pinned by
  `src/app/api/admin/hut-leaders/available-beds/__tests__/assignment-lodge-scope.test.ts`.
  Nothing here was exploitable: the reason it was safe was a guard on the write
  rather than the read being correct, which is the shape #2664 was filed about.
- **The hut-leader admin workspace is one selected lodge end to end** (#2887).
  Its assignment list, uncovered-night calculation, occupancy overlay and
  eligible-member search all require the same validated `lodgeId`; the create
  route refuses an omitted or inactive lodge before member lookup. The domain
  helpers make widening explicit: interactive coverage uses `{ kind: "lodge" }`,
  while the two genuine club dashboards must spell `{ kind: "all" }`. Lodge A
  responses are fenced after a switch to Lodge B and lodge-keyed in-memory
  overlays are cleared, so old assignments or red nights never inherit the new
  selector label. Two-lodge route/domain tests pin all four read filters and the
  create refusal. Coverage and eligibility use each guest's explicit `nights`
  rows when present, falling back to the legacy contiguous envelope only when
  none exist; a sparse stay on the 10th and 12th neither occupies nor suggests
  the 11th. Club-wide uncovered-night aggregation retains lodge identity, so an
  assignment at Lodge A does not suppress the same date at Lodge B.
  **An uncovered night is one row PER LODGE** (#2917): `getUnassignedHutLeaderDates`
  returns `{ date, lodgeId, lodgeName, lodgeActive, bookingCount, guestCount }`
  ordered by
  date then lodge name then id, so a night on which two lodges both lack a
  leader is two rows with each lodge's own counts, and every club-wide consumer
  — the dashboard attention card, the officer card, the sidebar badge and the
  stuck-state tile — counts lodge-nights and can name the lodge. The per-lodge
  trigger is a guest **active on that night** (`isGuestActiveOnNight`), which is
  deliberately not the auto-assign cron's operational-day, consent-filtered
  predicate: a departure-morning guest is not a night here, and a consent-pending
  member guest raises a row here that the cron will not auto-assign for. A
  `{ kind: "all" }` read is **not** filtered to active lodges: deactivating a
  lodge that still has future bookings is permitted with `force` and does not
  cancel them, so those guest nights stay visible with `lodgeActive: false` and
  are labelled as archived rather than disappearing from every surface at once.
  A single-lodge club's dates, counts and wording are unchanged; the lodge name
  and the lodge-night noun appear once the club has **more than one active
  lodge** — `countActiveLodges`, per the Presentation Rule below, never inferred
  from how many lodges a result happens to span — or once a row belongs to an
  archived lodge. Assignment
  creation serializes on the lodge key and repeats member, overlap and optional
  bed checks after acquiring it; overlapping same-lodge role-only/different-bed
  requests cannot both commit, while different lodges remain independent.

## Club-Wide Models (No Lodge Dimension)

These intentionally stay club-wide. Do not add `lodgeId` to them without a
new ADR:

- Membership: `Member`, `MemberAccessRole`, `MembershipType`, family
  groups, applications, subscriptions, lifecycle requests.
- Payments: `Payment`, `PaymentTransaction`, `PaymentRefund`, Stripe
  references. Payments attach to bookings; the booking carries the lodge.
- Xero and finance: all `Xero*` models, `FinanceSnapshot`,
  `FinanceReportCategory*`, item/account mappings. One club-wide ledger and
  one operational Xero connection, consistent with
  `finance-dashboard/decisions/ADR-005-single-operational-xero-connection.md`.
- Email, notifications, audit log, webhooks, cron state, page content,
  media, committee, module settings (`ClubModuleSettings` stays one row).
- Inductions (`InductionChecklistTemplate`/`MemberInduction*`, all kinds
  including `HUT_LEADER`): inductions certify the member, not a building
  (recorded 2026-07-03). If hut-leader inductions ever diverge per lodge,
  that is a new ADR.
- `GroupDiscountSetting` and `BookingDefaults.nonMemberHoldDays` /
  `waitlistCrossLodgeOrder`: booking policy knobs that are club fairness
  decisions, edited club-wide on the booking-policies page.
- Skifield conditions (`WhakapapaReportCache`, the `skifieldConditions`
  module): public-website content, not lodge UI. A per-lodge/per-field
  conditions widget would be a future enhancement, not a scoping change.
- Maintenance-report policy and questions (`MaintenanceReportSettings`
  singleton, `MaintenanceReportQuestion`): the club asks the same bounded
  question set at every lodge, and the photo/retention/anonymous-QR policy is a
  club decision (#2780). The reports and their per-lodge QR signs above are
  lodge-scoped; the questions asked and the policy governing them are not.
- Member message board (`ClubPost`, `ClubPostImage`, `ClubPostReport`, the
  `commsPortal` module): a post carries no `lodgeId`, decided as D-C1 on epic
  #2992 and delivered by #2993. Two reasons, and the first is the binding one.
  A post can be **shared onto the central-server network**, whose registry is a
  list of other CLUBS and which has no concept of this club's buildings — so a
  lodge on the row would have nowhere to travel to and nothing to mean at the
  far end. That is the same reasoning already recorded above for
  `ServerNzSettings`. Second, the board is club conversation rather than
  building operation: `Notice` next to it is club-wide on the same footing,
  while `MaintenanceReport` is lodge-scoped precisely because a physical fault
  belongs to one building. If a club ever wants a per-lodge board — a
  Whakapapa-only noticeboard — that is a new ADR and not a widening of this
  model, because the shared half would still have nowhere to put the lodge.

## Known Not-Yet-Scoped Surfaces (open)

Audited 2026-07-03; these are lodge-relevant but still club-wide or
default-lodge-pinned. Each needs an owner decision before work starts —
record the outcome here when decided:

(none — the 2026-07-03 audit list is fully resolved; see below)

## Resolved 2026-07-03 (delivered on `feature/multi-lodge-support`)

- **`BookingRequest.lodgeId` (nullable).** Null = the club's default lodge
  (all pre-migration rows); readers resolve `request.lodgeId ?? default`.
  The public general and school forms offer a required lodge choice when
  a second active lodge exists (the public settings endpoint exposes
  active lodges as id/name only); indicative pricing, capacity guards,
  holds, quote acceptance, approval, and the created booking all follow
  the request's lodge, and request emails carry that lodge's identity.
- **`BookingRequestSettings` stays club-wide.** Its three fields (pricing
  visibility, quote TTL, reminder lead) are booking-policy knobs like
  `BookingDefaults`, not per-property values; recorded club-wide rather
  than converted. A new ADR is needed to change this.

- **`WorkPartyEvent.lodgeId` (nullable).** Null = club-wide event (the
  pre-migration meaning). A lodge-bound event's internal promo resolves
  only for bookings at that lodge; the booking form filters events by the
  chosen lodge and labels lodge-bound ones.
- **`LodgeSettings` / `BedAllocationSettings` per-lodge rows.** A lodge's
  row is keyed by its lodge id (`id = lodgeId`); the legacy "default" row
  keeps serving the lodge it was soft-linked to in the phase-2 backfill
  (and single-lodge clubs). Resolution is own row → legacy row when unlinked
  or linked to the same lodge → code defaults; a legacy row linked elsewhere
  is never inherited, so one lodge's values cannot leak to another.
  `LodgeSettings` retains its existing first-write compatibility behavior and
  `hutLeaderLookaheadDays` remains a club-wide knob on its legacy row.
  `BedAllocationSettings` reads the same compatibility chain, but its admin
  API always requires one active lodge: a write updates `default` only when no
  lodge-id row exists and that legacy row is already linked to this lodge;
  otherwise it creates/updates the lodge-id row and leaves the legacy fallback
  untouched. Its
  `autoAllocationEnabled` and strict ordered `allocationPriorityOrder` apply to
  that lodge's board and booking lifecycle only; `[]` is a valid explicit
  neutral order. Config transfer writes authoritative per-lodge settings by
  lodge slug and keeps the legacy singleton path for older bundles. These
  settings soft-links keep a nullable `lodgeId` by design (the `NOT NULL`
  tightening applies only to the six entity tables; see
  `contract-release.md`).
- **CMS `{{lodge-capacity}}` token.** Gains an optional slug parameter
  (`{{lodge-capacity:lodge-slug}}`) for per-lodge figures; the bare token
  keeps resolving the default lodge. No cross-lodge total token — the
  capacity summing ban above applies to content tokens too.
- **Kiosk lodge identity.** The kiosk access payload includes the
  operating lodge's name (null for single-lodge clubs, ADR-002) and the
  kiosk header displays it.
- **Per-lodge kiosk accounts (admin surface).** The Lodge Kiosk admin
  page lists every LODGE-role account with its bound lodge, creates
  additional kiosk accounts bound via a STAFF grant in one step, and
  rebinds/unbinds (unbound = default lodge). The binding mechanism is
  `getStaffLodgeBinding`, which returns `none` (unbound → default lodge),
  `bound` (one grant → that lodge), or `ambiguous` (two or more grants).
  An `ambiguous` binding is **denied, never defaulted**: `resolveKioskLodgeId`
  throws `AmbiguousKioskLodgeError`, which every kiosk data route maps to a
  `403` (via `kioskLodgeAuthErrorResponse`, so a one-click misconfiguration
  is a clean deny rather than a 500) and PIN login returns `403` directly
  ("assigned to multiple lodges — an admin must fix the assignment"), so an
  accidental double-grant cannot silently serve the default lodge's guest
  list/roster or accept its hut-leader PINs on a shared screen. Lodge controls render
  only with a second active lodge (ADR-002).

## School-Group Soft Cap

The school-group soft cap (the bed count above which a school group is
warned it needs a club member to host — a warning only; the hard limit
is the lodge's capacity) is per-lodge on `LodgeSettings.schoolGroupSoftCap`,
resolving via the default lodge in a single-lodge club (ADR-002) and
falling back to the code default (`DEFAULT_SCHOOL_GROUP_SOFT_CAP`) when
unset. It is editable on the lodge-settings card (both `/admin/setup`
and, per-lodge, the lodge hub). The public school form measures against
the selected lodge's cap (the booking-request settings endpoint returns
each lodge's cap plus a top-level default for the single-lodge case).

## Capacity Configuration

Each lodge's capacity resolves in this order (`getLodgeCapacityStatus`):
active configured beds when the Bed Allocation module is on, else the
per-lodge `LodgeSettings.capacity` override, else the club-config bed
total for the default lodge only (additional lodges resolve to 0 until
beds or an override exist, so an unconfigured lodge can never be
overbooked). The per-lodge override is editable in core lodge config on
the lodge hub (`/admin/lodges/[id]`) regardless of the Bed Allocation
module, and on `/admin/setup`. Public and admin booking surfaces cap
guests against the _selected_ lodge's capacity (the public booking-request
settings endpoint returns each active lodge's capacity), and the server
re-validates per lodge.

## Service Rules

- Capacity is per lodge: "beds available on date D at lodge L". No code
  path may sum beds across lodges into one number.
- **`lodgeId` is `NOT NULL` on the six entity tables** (LodgeRoom, Locker,
  Season, Booking, ChoreTemplate, HutLeaderAssignment), enforced without an
  outage via a `default_lodge_id()` column default (migration `20260708001100`):
  an old colour's omitted-column insert auto-fills the default lodge, so no null
  is written mid-cutover. `lodgeNullTolerantScope` is now a strict `{ lodgeId }`.
  Policy/settings tables keep a nullable `lodgeId` (null = club-wide default) and
  scope via `resolvePolicyRowsForLodge`. See `contract-release.md`.
- **The club default lodge is the `Lodge.isDefault`-flagged row**, not the
  earliest-`createdAt` one (#1656 / #1627 option b, migration
  `20260709120000`). `getDefaultLodgeId()` and the `default_lodge_id()` SQL
  function both resolve `isDefault` first (then oldest active, then oldest of
  any state, as a defensive fallback), and the two sides are a mirror contract —
  changing one requires a paired migration for the other. The old
  `createdAt`-ordering resolution inverted on non-UTC databases when a lodge was
  created inside the seed's TZ-skew window; the flag removes that class. A slug
  pin was rejected because both the seed and the admin rename route regenerate a
  lodge's slug from its name, so no slug stays stable. Exactly one lodge is
  default, enforced by a partial unique index (`Lodge_isDefault_key`,
  `WHERE "isDefault"`). The migration backfills the flag onto the current
  default; there is no admin UI yet, so **to change the default, unset the
  current row and set the new one in a single transaction** (the partial unique
  index rejects a transient two-default state). Reassign the default before
  deactivating a lodge — a flagged-but-inactive lodge deliberately stays the
  default.
  - **Retired third resolver (#1656 review note, resolved by #1982):**
    `isDefaultLodge()` in `src/lib/lodge-capacity.ts` used to gate the
    club-config capacity fallback with its own oldest-active logic. #1982 removed
    that runtime fallback (capacity is now DB-only), so the resolver — and the
    divergence risk it carried — is gone. Any remaining default-lodge resolution
    routes through `getDefaultLodgeId()` (the flag-aware resolver).
  - **Documented exception — reporting occupancy denominator.** The admin
    reports occupancy view and the finance booking-metrics occupancy summary
    may sum the capacity of all active lodges to form the "all lodges"
    denominator (`resolveMetricsCapacityAndScope` in
    `src/lib/finance-booking-metrics.ts`, reused by `/api/admin/reports`).
    This is the only sanctioned cross-lodge capacity aggregate: a reporting
    read that never feeds availability, booking, or capacity-enforcement
    logic. The surface labels the figure as covering all lodges and offers a
    per-lodge selector; selecting a lodge scopes both the bookings and the
    denominator to that lodge.
- A booking's guests, nights, bed allocations, and requested room must all
  belong to `booking.lodgeId`. Enforce in service logic; add DB constraints
  where practical. Manual bed allocation rejects a bed whose room belongs
  to a different lodge than the booking, and the bed-allocation board,
  auto-allocator, and range approval all operate within one lodge scope.
- Pricing lookups (`findRateForNight`, `calculateBookingPrice`) operate on
  the seasons of exactly one lodge. Callers pass lodge-filtered season
  data; the pure calculation functions stay lodge-agnostic.
- The booking-creation capacity check locks per lodge, not club-wide.
  Two bookings at different lodges must not contend.
- Roster/chore generation for a date runs per lodge and only sees that
  lodge's templates and staying guests.
- Uniqueness-style date checks are per lodge: season overlap validation
  and the hut-leader assignment overlap check compare only rows of the
  same lodge (each lodge runs its own season windows and its own hut
  leader). Rows still missing a lodgeId during the expand release
  conservatively conflict at every lodge.
- Money stays in integer cents and booking dates stay NZ date-only,
  unchanged by lodge scoping.

## Admin Lodge List Access And Payload

`GET /api/admin/lodges` is the vocabulary every admin screen draws on to say
WHICH lodge it means, so its gate is a scoping decision and belongs here.
Delivered by #2925 (owner decision, 17 Aug 2026); the route's own docblock
carries the implementation reasoning and is not repeated.

**Access.** Any admitted administrator, expressed as the explicit requirement
`permission: { area: "overview", level: "view" }` — the documented "any admitted
admin" shape in this codebase. It must stay EXPLICIT. A bare `requireAdmin()`
does not mean "any admin": `inferAdminAccessRequirement` reads the `x-pathname`
and `x-request-method` headers `proxy.ts` stamps on this route and resolves them
through `getAdminRouteRequirement`, which maps `/api/admin/lodges` to
`area: "lodge"` — so the old requirement returns by inference and nothing
changes. That is exactly what happened on PR #2885, whose tests passed anyway
because the shared `requireAdmin` mock fell back to `hasAdminPortalAccess` when
given no options, a semantic the real guard has never had. The gate is therefore
proved in `admin-lodges-access-gate.test.ts`, which mocks neither the guard nor
the headers.

The presets this changed, all of which hold `overview: "view"` and no `lodge`
entry: **`ADMIN_MEMBERSHIP`**, **`FINANCE_ADMIN`** and **`ADMIN_CONTENT`**. No
preset was edited — adding `lodge:view` to them would have widened eighteen
other read endpoints on upgrade. A 403 is still the answer for a caller who is
not an admitted admin, and for a club-edited or custom role holding
`overview: "none"`, which is why `useLodgeOptions` keeps its `forbidden` state.

**Payload, decided from nothing rather than trimmed from `lodgeSelect`.** A
caller WITH `lodge:view` keeps the whole record. A caller without it receives
`id`, `name`, `slug`, `active` and nothing else:

| Field | Out? | Why |
| --- | --- | --- |
| `id` | yes | the value every lodge-scoped request sends back |
| `name` | yes | the label in every selector, badge and heading |
| `slug` | yes | URL identifier, derived from `name`, so it discloses nothing more |
| `active` | yes | load-bearing: consumers filter on `active !== false`, and without it a deactivated lodge is offered as an option |
| `doorCode` | **no** | a physical-access secret, already kept out of audit metadata by `redactLodgeForAudit` |
| `address` | **no** | the lodge's physical location |
| `travelNote` | **no** | arrival instructions; its only vocabulary consumer is the MEMBER wizard, which reads `/api/lodges` |
| `createdAt`, `updatedAt` | **no** | record metadata no vocabulary consumer reads |
| `isDefault`, `displayConfig`, `displayNotice`, `displayNameGranularity`, `showGuestPhonesOnScreens` | **no** | never in either payload; listed so the enumeration is complete |

The narrowing is what makes the relaxation safe, so the two move together: a
future column is excluded by default because `lodgeIdentitySelect` names what
goes out rather than what stays in, and `serializeLodgeIdentity` names the same
four again so a planted select cannot leak through it either.

**Reading it: key on the absent FIELDS, never on a 403.** A narrowed payload is
a permissions answer wearing a 200, so a surface that needs the detail fields has
to notice they are missing. `lodge-details-panel.tsx` does, and renders its
explanation rather than a form whose address, travel note and door code are
silently blank. It tests `"doorCode" in row`, not `row.doorCode != null` — a
lodge with no door code SET sends `doorCode: null`, which is an ordinary editable
value.

**Writing it: the door-code wipe cannot happen, and the reason is the level
ranks, not a page gate.** The worry is real in shape: `PATCH
/api/admin/lodges/[id]` reads an absent key as "leave unchanged" and a `null` as
"clear it", so an editor seeded from a narrowed record and then saved would blank
a door code nobody was shown. But the PATCH requires `lodge:edit`, this route
narrows below `lodge:view`, and `edit` outranks `view` — so **every caller who
can write has already been served the full record.** The wipe is closed at the
server for every editor, present and future, without any of them cooperating.

The Lodges list editor additionally omits detail fields it was never given from
its PATCH body. That is belt-and-braces over the argument above, kept because it
is cheap and directly tested. It was deliberately NOT replicated in the lodge
setup wizard: a second copy bought no reachable safety, pushed a 913-line file
past its size ceiling, and made the wizard reject any incomplete test fixture —
it broke a passing back-link test on a lodge row that simply had not bothered to
include `doorCode`.

## Presentation Rule

When exactly one active lodge exists, member and admin UI must not show
lodge selectors, lodge columns, or lodge names in flows where they would
be redundant (ADR-002). APIs still require and return `lodgeId`; the rule
is presentation-only.

Lodge management is core and always available (ADR-005 removed the former
`multiLodge` Admin Module flag; the lodge routes are ungated). Runtime
booking, capacity, and pricing logic never branch on any lodge flag —
lodge count and `lodgeId` are the only lodge signals service code reads.
