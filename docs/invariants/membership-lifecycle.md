# Membership Lifecycle

Audience: Developer, Agent.

Prefix defined in this file: **`INV-LIFE`** — membership applications and
nomination, cancellation, archive and deletion, access roles and the admin
lock-out guards, seasonal membership type and age tier, family groups, partner
and parent/dependant links, email inheritance, inductions, and member profile
merge.

One `INV-LIFE` rule does not live here: `INV-LIFE-062`, the custodian bed hold,
was re-homed to
[`booking-dates-and-capacity.md`](booking-dates-and-capacity.md) by #2706. It
keeps its number and its prefix; the index is authoritative for ID → file.

Read this file when you are changing how a membership starts, changes or ends,
who may act for whom inside a family, how a member's roles or age tier are
resolved, or how two member records are merged.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`SCHEME.md`](SCHEME.md).

The two blocks that sat here under a domain heading that did not describe them
have both been re-homed by #2706: the custodian bed-occupancy block
(`INV-LIFE-062`) to
[`booking-dates-and-capacity.md`](booking-dates-and-capacity.md), and the
`FamilyGroupMember.role` column-drop narrative that was nested inside
`INV-LIFE-037` to [`operations.md`](operations.md) as `INV-OPS-005` to
`INV-OPS-011`. Neither move changed a word of either rule.

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused. **The text under each ID is a
verbatim move from the source document and must not be reworded in place** —
only the ID heading lines and the bracketed cross-file `[INV-*]` pointers
registered in the PR were added.

## INV-LIFE-001

Membership application, nomination, cancellation, archive, delete, family, and
dependent changes must preserve financial history, booking and guest history,
audit history, required family/dependent history, privacy preferences, and Xero
contact/link history where required.

## INV-LIFE-002

A membership cancellation never credits money owed for a membership that
continues (#2400). One Xero subscription invoice covers every member of a family
or billing group, its lines are per fee component rather than per member, and the
cancellation credit note is for the invoice's whole `amountDue` — so it is raised
only when the leaving member is the last member that invoice covers who has not
themselves been cancelled. "Covered" is the union of
`MemberSubscription.xeroInvoiceId` and the charge's ACTIVE
(`releasedAt IS NULL`) coverage claims: either one can be the only record of a
covered member — a member already PAID when the invoice was raised carries the
coverage claim alone, because `createXeroMembershipSubscriptionInvoice` never
overwrites a PAID subscription, and rows predating coverage claims carry the
invoice link alone — and an uncertain covered set must never authorise wiping a
balance. The coverage half resolves its member through `subscription.memberId`, a
real foreign key, never through the row's own denormalised `memberId`, which is
on member-merge's FK-less snapshot list and is left pointing at a deleted loser.
The union only ever SHRINKS over the life of a cancellation, because a covered
member leaves it when `cancelledAt` is set and nothing in the app writes
`cancelledAt: null` (see the reactivation constraint below) — so an approval
decided on "the leaver is last" cannot be falsified before the outbox drains.

## INV-LIFE-003

**At most one cancellation ever credits a given subscription invoice.** Several
different cancellations can each reach the "last covered member" state (a whole
family leaving), and the outbox claims per operation, so overlapping drains could
otherwise each raise a full-balance credit note under different Xero idempotency
keys. The right to credit one invoice is a durable first-writer-wins claim — a
`XeroObjectLink` row keyed on the invoice, inserted with `skipDuplicates` before
any Xero call — and a cancellation that loses it raises nothing at all. See
`docs/CONCURRENCY_AND_LOCKING.md`.

## INV-LIFE-004

Paired with it: the unpaid-invoice approval blocker (#2392) excuses the member's
own subscription invoice **if and only if** the approval is still about to credit
its full balance. Both sides derive that from
`loadMembershipCancellationSubscriptionCreditPlansByMemberId`, so the excused set
is by construction the cleared set, and no cancellation can archive a Xero
contact with a balance nobody is going to credit. "Still" is load-bearing: the
credit-note operation is one-shot and completes even when it deliberately skips,
so once a whole family is cancelled the recomputed answer flips back to "would
credit in full" for members whose credit note already ran and skipped. The
exclusion therefore also consults that operation's RECORDED outcome, and an
invoice whose credit note has settled is never excused again.

## INV-LIFE-005

Access role, seasonal membership type, age tier, Xero contact-group rule, and
committee assignment are separate axes. `MemberAccessRole` controls application
access via the legacy enum values (`USER`, `ADMIN`, `ADMIN_READONLY`,
`ADMIN_BOOKINGS`, `ADMIN_MEMBERSHIP`, `ADMIN_CONTENT`, `LODGE`,
`FINANCE_USER`, `FINANCE_ADMIN`, `ORG`) and/or a link to a club-editable
`AccessRoleDefinition` (label, description, per-area permission matrix).
`ADMIN`, `LODGE`, `USER`, and `ORG` are protected system roles: code-defined,
never editable or deletable, and Full Admin always keeps full permissions.
Deleting a definition is blocked while any member holds it. Custom
definition-backed roles are privileged for the Full-Admin
separation-of-duties gate, exactly like the seeded bundles;
`Member.role` is limited to `USER`, `ADMIN`, `LODGE`, `NON_MEMBER`, and
`SCHOOL`, and `financeAccessLevel` is a compatibility field. Neither field may
be used as a runtime permission gate or for new membership-category semantics.
Bundled and definition-backed rows are composed by the central admin
permission matrix (maximum level per area); they must not be projected into
legacy `Member.role = ADMIN`. Finance portal access derives from the merged
`finance` area level, never from the enum values or `financeAccessLevel`.
"User Type" (User / Organisation / Admin / Lodge) is a derived presentation
concept over access-role tokens, not a stored field: the Edit Member screen's
User Type select and the members-list Access column derive it via
`deriveUserType` (any privileged token other than `LODGE` ⇒ Admin; `LODGE` ⇒
Lodge kiosk; `ORG` ⇒ Organisation; otherwise User) and save it back as plain
`accessRoles` tokens — the Admin type's "Also a club member" checkbox is the
`USER` token. No new stored classification field may be introduced for it,
organisations cannot hold admin roles, and the server-side Full-Admin gates
on access-role writes remain the authority (the UI only mirrors them).
The admin population is protected against lock-out on the seven member-write
paths that can deactivate, de-login, or archive an EXISTING account (#1604,
extended by #1622): member edit, bulk update, lifecycle archive,
deletion-request approval, membership-cancellation approval, family-group
login-holder transfer (`POST /api/admin/family-groups/[id]/login-holder`), and
linking a member as a dependent with `disableLogin`
(`POST /api/admin/members/[id]/dependents/link`). On those paths the last
active, login-enabled Full Admin can never be deactivated, de-logined, or
archived — by anyone, including another Full Admin — and only a Full Admin may
deactivate, de-login, or archive an account holding a privileged role. Both
guards are enforced server-side; the last-admin count runs inside each
mutation's transaction, and "Full Admin" means an active, login-enabled member
with the `ADMIN` access-role row (the runtime grant), not a bare legacy
`Member.role`. The login-holder transfer both revokes and grants `canLogin` in
one operation, so it counts active Full Admins on its post-write read view — the
incoming holder's grant is part of the evaluated end-state. This is a
closed-world guarantee: every other `canLogin` writer in the codebase either
CREATES a brand-new member (booking-request/school/group/Xero-import contacts,
nomination and family-request dependants, plus admin member-create and CSV
member-import rows — whose `canLogin` value seeds a new row, never de-logins an
existing one), GRANTS `canLogin` on an existing member without ever revoking it
(the application-approval mapping **promotion path** — mapping an applicant onto
a non-login member sets `canLogin: true`, a fresh password, and
`emailVerified: true`, and cannot strand an admin because it only ever adds a
login), or passes `canLogin` only as a read/token filter
(`normalizeAssignableAccessRoleTokens`, list/where clauses), and so cannot
strand an existing admin. The one remaining path that can clear `canLogin` on an existing
admin and is NOT guarded is indirect — the age-down cron, where editing a date
of birth to a minor tier can indirectly clear `canLogin` (informational).

## INV-LIFE-006

Membership-cancellation eligibility is an account-holder question, never a
permissions one (#2383). `isMembershipHolderRecord` (`src/lib/member-roles.ts`)
is the single rule, shared by `createAdminMembershipCancellationRequest`, the
admin member page's gate (pinned to that call site by the #2354 AST contract
test), and — since #2391 — the member-raised route in
`loadCancellationCandidates`: its own eligibility gate, and the per-candidate
verdict for every member of the requester's family groups. It refuses exactly
two record classes, both of which are not account holders: the lodge kiosk
device login, and booking-request contact records (`NON_MEMBER`, plus non-login
`SCHOOL` — the school flow's owner contact and teacher records).

## INV-LIFE-007

The member-raised route adds exactly two further conditions, and they are about
being able to operate your own profile, never about what class of account it is
(#2391): the requester must be `active` and `canLogin`. Both are retained
deliberately — a closed account or one with no login of its own cannot raise
anything from its own profile — and neither narrows what is cancellable, because
those memberships remain reachable from a relative's family request and from the
member page. The family candidate query therefore carries NO role filter: a
relative who is also an admin, or an organisation account sharing the family
group, is listed and eligible, and the two non-holder classes are listed with a
reason rather than dropped silently. A self-raised participant is the requester,
so `requiresOwnConfirmation` is false and the row is created `REQUESTED` with
`confirmedAt` set — structurally identical to an admin-raised participant, and
never waiting on a confirmation email nobody would action (which matters most
for an organisation account, where there is no "adult participant" in the human
sense).

## INV-LIFE-008

Both member-raised queries select `role`, `canLogin`, `financeAccessLevel` and
the `accessRoles` rows (`cancellationCandidateSelect`), for the same reason the
admin path does: an unselected column arrives `undefined` and would misclassify
a person as the kiosk device. Unit tests cannot catch that — Prisma is mocked —
so the query shape itself is asserted.

## INV-LIFE-009

The kiosk test is a record-CLASS test, never a "holds lodge access" test.
`LODGE` is a freely tickable checkbox in the member editor ("Can use lodge kiosk
and lodge operations tools") with no exclusivity guard, so a Booking Officer who
also runs the lodge screen carries a `LODGE` row while being an ordinary
fee-paying person. Refusing on the presence of the token would hide the
cancellation action from such a person silently — the #2354 failure mode this
rule exists to eliminate. The rule is therefore `deriveUserType(...) === "lodge"`
over the record's login-blind stored tokens: refused only when `LODGE` is the
record's ENTIRE classification, which is exactly when the admin UI labels its
User Type "Lodge (kiosk account)". A record whose only tokens are `USER` and
`LODGE` is still refused, and is correct to be: it is indistinguishable from a
kiosk, and the refusal agrees with the User Type the operator is shown.

## INV-LIFE-010

The `canLogin` term applies to `SCHOOL` alone and must not be generalised:
`SCHOOL` is the legacy role of BOTH a real organisation account (User Type
"Organisation", which stores an `ORG` row; the admin UI only ever sets it on a
login-capable account, though `createMemberSchema` does not enforce that on
write — an API caller could store `role: "SCHOOL"` with `canLogin: false`) and
every school booking-request contact (always created `canLogin: false`);
non-login is the line `MAPPABLE_CONTACT_SCOPE`
(`src/lib/non-member-contact.ts`) already draws between them. Every other
account is cancellable, including admins of every class — the rule this replaced
was legacy `role === "USER"`, which refused only the Full Admin bundle while
accepting all four scoped admin classes, and swept up organisations that hold
real fee-paying memberships. The privileged-target and last-Full-Admin guards
above are what make widening this safe: they run inside the approval
transaction, so a cancellation can never strand the club with no active,
login-enabled Full Admin, and only a Full Admin may approve one against a
privileged account. Separation of duties holds on the self-cancellation case a
widened rule newly reaches — `assertCancellationApprovalIsIndependent` refuses
an approval by the member who raised the request — so a club's sole Full Admin
must appoint a successor before their own cancellation can be approved. That
guard fails CLOSED on a null `requestedByMemberId` (the FK is
`onDelete: SetNull`, so hard-deleting the raiser nulls it): "we cannot tell who
raised this" means "not you", never "anyone". Rejection is unaffected, so such
a request is never stuck. The approval queue also surfaces, per participant,
whether the target holds privileged access (the guard's own predicate) and
whether it is an organisation account, so an approval that is permitted but
mistaken has a human check in front of it.

## INV-LIFE-011

Both callers of the rule must feed it the same shape. The admin member page is
served `resolveAccessRoleTokens` output, which is EMPTY whenever
`canLogin === false`; the server reads the stored `MemberAccessRole` rows, which
are NOT cleared when login is disabled (the family login-holder transfer
de-logins cluster members and leaves their rows). `isMembershipHolderRecord`
therefore accepts raw rows and resolved tokens interchangeably and applies the
same login-clearing to both — the rows are consulted only for a login-capable
record — so the page can never offer an action the server answers with a 422.
The legacy `role` column is exempt from that clearing and still identifies a
de-logined kiosk. The AST contract test pins the call site, not the shape, so
this property is pinned by unit tests over the helper instead
(`src/lib/__tests__/member-roles.test.ts`).

## INV-LIFE-012

Cancellation approval does NOT clear `MemberAccessRole` rows,
`financeAccessLevel`, or the legacy `role` column (#2383, confirming existing
behaviour). Archive approval, deletion anonymisation, and bulk deactivate all
leave them too. **`active: false` is the load-bearing flag**, not
`canLogin: false`: `requireAdmin` (`src/lib/session-guards.ts`) rejects an
inactive member, and it does not select `canLogin` at all, while
`getAdminPermissionMatrix` zeroes the matrix only on an explicit
`canLogin === false` — pass it a row set without that field and the full bundle
resolves. De-logined accounts that still hold live rows therefore exist today
(the login-holder transfer again), so nothing may be built on "no login means no
permissions". The dormant rows are what keep the account inside the
canLogin-blind `memberHoldsPrivilegedRole` guard for any later archive, and
deleting them on cancellation would be novel and would weaken that later guard.
The corollary is a hard constraint on any future work: **a path that reactivates
a member who kept privileged roles would silently restore every one of them.**
Any path that is added must clear or re-grant the roles deliberately.

## INV-LIFE-013

What refuses reactivation today, precisely. Two paths write `active: true` onto
an existing member — bulk update (`action: "reactivate"`,
`src/app/api/admin/members/bulk-update/route.ts`) and the member edit service
(`updateAdminMember`, `src/lib/admin-member-detail-service.ts`). Every other
`active: true` in the codebase is on a `member.create` (or the schema's
`@default(true)`), i.e. a brand-new row that can resurrect nobody. Each of the
two refuses **three** states, with a 409 naming which:

- **Cancelled** (`cancelledAt` set) and **archived** (`archivedAt` set) — and
  nothing in the application writes `cancelledAt: null` or `archivedAt: null`, so
  those two states are terminal.
- **Deleted** — a member an approved deletion request has anonymised (#2620).
  This one is NOT covered by the `cancelledAt`/`archivedAt` refusal and was
  wrongly documented here as if it were. Anonymisation
  (`POST /api/admin/deletion-requests/[id]`) sets `active: false` but stamps
  **neither** flag, so a deleted account passed both guards, and `active` is
  exactly what bulk Reactivate flips. Because anonymisation also retains
  `canLogin`, `googleSub`, `emailVerified` and the second factor, `active: false`
  was the only thing between the erased person and a working session carrying
  their retained admin roles — and a deleted row is `active: false,
  cancelledAt: null`, i.e. squarely inside the members list's **Inactive**
  lifecycle filter, so an officer undoing a mistaken bulk deactivate could
  restore one without intending to. Deletion is recognised by the anonymisation
  markers it writes — the `DELETED_ACCOUNT` password-hash sentinel and the
  `@deleted.invalid` address — through the single shared predicate
  `isDeletedAccountRecord` (`src/lib/deleted-account.ts`). Every path that must
  recognise a deleted account consults that one predicate; a second copy of the
  marker test is the drift the module exists to prevent.

## INV-LIFE-014

Reactivation refusal is not the whole defence for a deleted account, because it
protects only the application's own write paths. **A deleted account yields no
session even with `active: true`** (#2620): all three sign-in providers refuse on
the same predicate, independently of `active` — password and magic-link
`authorize` return null (the password path still burns its dummy bcrypt compare,
so the refusal stays timing-identical to an unknown email), and
`resolveGoogleProfile` returns `refused`. The Google path is the one that most
needs it: it resolves on `googleSub` alone, never on email, and anonymisation
does not clear `googleSub`. Behind all three, the per-request token refresh in
the `jwt` callback sets `sessionInvalidated` for a deleted member, so `auth()`
nulls the session on the member's next request — which also covers a session
minted *before* the deletion, since deletion revokes no tokens today. The
members list surfaces the state as a distinct "Deleted" lifecycle chip and takes
the row out of bulk selection, so the mistake is hard to make as well as
refused.

## INV-LIFE-015

The marker predicate is a strong signal, not a schema invariant: it holds because
the anonymisation write is the only producer of either marker and nothing else
clears them. One path does overwrite both — the membership-application approval
MAP branch (`src/lib/nomination.ts`) rewrites `email` to the applicant's real
address and, on the non-login→login promotion, writes a fresh `passwordHash` — so
a mapped-over deleted row stops being recognisable as one. That path writes no
`active`, so it cannot itself mint a session for an inactive member. Stamping
`cancelledAt` (or a dedicated `deletedAt`) at anonymisation time would make the
state structural instead of inferred; it is deliberately still open, because it
would also change how deleted members appear in every lifecycle filter and count.

## INV-LIFE-016

The same fact constrains session-authenticated routes: cancellation neither
clears the rows nor invalidates the JWT (`auth()` invalidates only on
`passwordChangedAt`, and re-stamps `token.accessRoles` from the retained rows on
every request), so any route that resolves admin access from a member row must
re-read `active` rather than trusting the rows. `requireAdmin` does; the display
preview branch of `GET /api/display/state` did not, and now does (#2383) — it
was unreachable before, because a cancelled member could not previously hold an
`ADMIN` row.

## INV-LIFE-017

Application-approval mapping (link + overwrite of an existing member at approval
time) preserves the login-uniqueness and auth invariants: it never creates a
second `canLogin: true` member for an email (the create-path `canLogin` guard is
relaxed only when the sole login holder for the applicant email IS the mapped
target; a different login holder still 409s), and it never writes
`passwordHash`/`canLogin`/2FA/`emailVerified` on any target except the defined
non-login→login applicant promotion above — a login-capable target (applicant or
family) keeps its existing auth untouched, and a mapped family member's email is
never rewritten. Mapped targets keep their existing season membership coverage:
a target already holding a seasonal assignment or subscription for the season is
excluded from new-member subscription billing (surfaced as a note), so mapping
never double-charges or overrides an existing coverage arrangement. Confirmation
timestamps on a mapped target are set only when currently null and are never
regressed, and the overwrite is bound to a previewed HMAC token so any drift in
the computed outcome refuses the approval.

## INV-LIFE-066

The applicant MAP path also carries the #1026 privileged-email gate: when the
mapping would change the login email of a login-capable target holding a
privileged access role, only a Full Admin may approve it — a scoped admin's
preview shows a blocking error, and because the acting admin's roles are
recomputed inside the approval transaction (part of the tokenized outcome), a
Full-Admin-minted preview replayed by a scoped admin fails closed with a 409
token mismatch. Same-email mappings and the non-login promotion path (where
`hasPrivilegedAccess` is canLogin-aware and therefore false) are unaffected.

## INV-LIFE-067

On-behalf booking must not depend on `membership:view`: a Booking Officer
(`bookings:edit`) reaches the booking owner's or target member's family group
through the bookings-scoped pickers
(`GET /api/admin/bookings/[id]/eligible-family`, resolving the owner from the
booking server-side, and `GET /api/admin/bookings/eligible-family?forMemberId=`),
each gated on `bookings:edit` and returning exactly one member's family group
via the shared `resolveMemberFamily` helper. This decoupling means a club that
customises the Booking Officer role to drop `membership:view` can still attach
the correct member identity — and therefore correct member pricing — instead of
silently re-adding the member as a mispriced non-member. The member-scoped
`GET /api/admin/members/[id]/family` remains gated on `membership:view` for
membership surfaces.

## INV-LIFE-068

MG4 (#2309) adds a **third** bookings-scoped picker, and it is the one
exception to the sentence above — stated here rather than left for a reader to
discover, because the exception is deliberate and owner-decided (D-20).
`/api/admin/bookings/[id]/member-guest-candidates` finds a member to add as a
**member guest** on the booking being edited, and it has two modes with two
different gates. The **email mode** (`POST`, the address in the body so it never
reaches an access log or a `Referer`) behaves exactly like the two pickers above:
`bookings:edit` only, no membership access required. The **name mode** (`GET`,
a name fragment) **does require `membership:view`**, and a Booking Officer
without it gets a 404 on that mode alone — the same answer the member route
gives when open search is off — and falls back to the exact-email box. That
preserves #1376 in full: the officer keeps every capability, including correct
member identity and member pricing, and loses only a type-ahead over the
membership roll they were deliberately not given access to. A picker that
browsed the whole roll from inside a booking would have undone #1376 through a
door nobody thought to look at. The same decision statement governs whether the
club's member-facing open-search setting binds an officer (it does not) — see
the member-guest consent cluster above [INV-GUEST-016].

## INV-LIFE-069

On-behalf CREATION is aligned with modification (#1313/#1442): `/api/bookings`,
`/api/bookings/quote`, and `/api/promo-codes/validate` authorize a
`forMemberId` via `bookingManagementAuthorizationRole` (`bookings:edit`), so a
Booking Officer and a Full Admin drive identical on-behalf behaviour. A
`forMemberId` from a caller without `bookings:edit` is rejected (403) — a quote
or promo check must never silently price the caller instead of the target. No
on-behalf actor may target themselves (separation of duties): an admin's or
officer's own stays go through the member `/book` flow and normal member
payment paths. Portal context determines intent: a dual-hat account
(`USER` token + admin roles) self-books as a plain member with NO admin
bypasses — email verification, Xero-link, subscription, guest-subscription,
and minimum-stay gates all apply to self-bookings; the gate bypasses are keyed
to authorized on-behalf bookings only. Only admin-only accounts (no `USER`
token) are redirected from the member wizard to `/admin/book`.

## INV-LIFE-070

A Booking Officer may also inline-create a **non-member booking owner** on
`/admin/book` (#1935): `POST /api/admin/bookings/non-member-contact`
(bookings:edit — the #1376 on-behalf scope) mints a non-login owner identical to
what the public booking-request approval creates, with SERVER-FORCED
`role: NON_MEMBER`, `canLogin: false`, `ageTier: ADULT`, and — unlike the
booking-request pipeline, whose verified public address justifies `true` —
`emailVerified: false` (an officer-typed address is unverified). The input
accepts only name/email/phone, so those forced fields cannot be tampered via
payload. Dedupe is suggest-and-pick and never silent reuse: several non-login
contacts may legitimately share an email (the `Member_email_login_unique`
partial index only covers `canLogin: true`), so reuse requires the officer's
explicit pick and is validated by `assertMappableOwnerContact` (non-login
NON_MEMBER/SCHOOL, active, not archived); a login-capable exact-email match is
never reusable and blocks creation with a "pick them in the member search"
error. A walk-in with no email stores a club-internal placeholder on the
reserved `.invalid` domain (`Member.email` stays non-nullable — no schema
change): all outbound email to that owner is suppressed at the `sendEmail`
chokepoint, and the placeholder is excluded from Xero contact email-matching
(`findOrCreateXeroContact` skips the email search and sends an empty address) so
it is never used to match or pushed to Xero as a real address. Non-member
booking owners are priced identically to public booking-request non-members
(both feed the shared pricing engine with non-member guests).

## INV-LIFE-071

Legacy membership lifecycle/classification code may read `Member.role` only to
distinguish compatibility categories such as non-login/non-member records until
that workflow is fully represented by seasonal membership type.
`SeasonalMembershipAssignment` stores per-season membership policy, including
the source of the assignment and an optional date-only `applyFrom` changeover.
Age tiers remain separate because the same tier can be Full, Life, Associate,
Family, School, or another
configured type. Age-tier Xero groups and membership-type Xero groups may both
exist; duplicate exact rules and multiple managed rules for the same scope are
not valid.

## INV-LIFE-072

Built-in membership types can never be deleted or merged. A custom type may be
deleted only when it has zero `SeasonalMembershipAssignment` rows; a custom type
that still has assignments must be merged into another type first. A merge
requires an active (non-archived) target that is not the source and whose
allowed age tiers cover every affected member's current age tier. A member on
`NOT_APPLICABLE` merges cleanly only when the target type also allows N/A
(`membershipTypeAgeExemption` FORCED or ALLOWED); the sole exception is
organisation members, whose N/A is a global org force independent of the type's
tiers, so they merge onto any target (#2106). It reassigns every source
assignment to the target and
deletes the source in one transaction, writing both a `MEMBERSHIP_TYPE_MERGED`
and a `MEMBERSHIP_TYPE_DELETED` audit record. Because reassigning an
assignment's membership type never changes its `(memberId, seasonYear)`, the
merge cannot violate the per-season uniqueness constraint. Merges (like every
other seasonal assignment change) do not synchronously resync Xero contact
groups; reassigned members reconcile through the existing periodic/mismatch Xero
tooling, and the admin is warned before confirming when the source and target
Xero rules differ.

## INV-LIFE-073

The `NOT_APPLICABLE` age tier is the single "no age" classification, driven by
two independent forces resolved by one shared helper
(`resolveEnforcedAgeTier`, `src/lib/age-tier-enforcement.ts`) applied at each of
the enumerated `Member.ageTier` write sites: admin member edit, self-service
profile, delegated family details, seasonal-assignment save, roll-forward into
the current season, and bulk set-role. (The Xero member-import is a separate
write path (#2108): for NEWLY-created members it sets the tier directly — a
FORCED type forces N/A, else the explicit mapped tier, else the DOB-derived
tier, else ADULT — and for matched-EXISTING members it routes through the
seasonal-assignment save above, so this same helper applies.) Precedence,
highest first:

1. **Org force.** Organisation-type members (the `ORG` access role or the legacy
   `SCHOOL` role) always carry `NOT_APPLICABLE`, on every create/update.
2. **Type force.** A member's CURRENT-season membership type is age-exempt when
   its configured `allowedAgeTiers` (`MembershipTypeAgeTier`, #2069) classify as
   `membershipTypeAgeExemption(...)`: **FORCED** = the set is exactly
   `{NOT_APPLICABLE}` — every member on the type is N/A, like an org; **ALLOWED**
   = N/A appears alongside real person tiers, so an admin may hand-pick N/A per
   member while others keep a real tier; **DISALLOWED** = N/A is absent and no
   member on the type may hold it. `ageGroupsApply` (a pricing-shape flag) is
   deliberately NOT consulted.
3. **Manual N/A.** Only accepted when the type is ALLOWED; a previously
   hand-picked N/A is preserved when a later edit submits no tier. A manual N/A
   is rejected for any other member.
4. **DOB-derived restore.** Otherwise the member holds a real person tier: the
   DOB-derived tier via `computeAgeTier` when a DOB exists, else `ADULT`. This is
   what un-forces a member reclassified away from org, or moved onto a
   DISALLOWED type.

## INV-LIFE-018

Configuration and lifecycle guards:

- Age-exempt config (any `allowedAgeTiers` containing `NOT_APPLICABLE`, FORCED or
  ALLOWED) is valid ONLY on types whose subscription behaviour is
  `NOT_REQUIRED`, so N/A can never bypass the subscription lockout on a paying
  type. Enforced on type create/edit.
- A type allowed-tiers edit is blocked while it would strand a
  current/future-season assignee: either becoming FORCED while a person-tier
  member is assigned, or removing `NOT_APPLICABLE` while a NON-ORG member is
  still on N/A (org members are exempt — the global org force keeps them N/A
  regardless of the type). This mirrors the merge coverage rule; the admin
  reassigns/reclassifies those members first. The offending-assignee check is
  repeated inside the config-write transaction so a concurrent change cannot slip
  a stranded member past the guard (#2106).
- A change that flips a member TO N/A is blocked while they are still a linked
  guest on someone else's future booking. This block is uniform across every
  N/A-flip site: the seasonal-assignment save (the change preview lists those
  bookings for removal first), the admin member edit (manual N/A pick and org
  grant), and the bulk set-role ORG grant (blocked members are reported as
  per-member failures — like not-found ids — so the rest of the batch still
  applies). A FORCED/org flip that leaves `ADULT` sweeps the member's future
  shared-double placements (#1756). The seasonal-assignment save surfaces the
  old/new age tier in its critical audit record, and binds the resulting tier
  into the preview's HMAC token so a tier-relevant drift is stale-detected. The
  same seasonal-assignment save also backs the members-page BULK membership-type
  change (#2107, `bulkSaveSeasonalMembershipAssignments`): each member is
  previewed and saved individually with its own HMAC token and its own critical
  per-member audit row (the run adds one important-severity summary audit), a
  stale token or a linked-guest block isolates that member as a per-member
  outcome without aborting the rest, and the up-to-100 per-member Xero
  contact-group syncs are suppressed in favour of one deferred batched reconcile
  of the changed members after the loop.
- Roll-forward into the current season reconciles each copied member's age tier
  AFTER the copy commits, in bounded chunks (one transaction per chunk, each
  re-reading member + type state) so no single transaction spans the whole
  membership; a failed chunk is logged and skipped (the enforcement sites
  self-heal). The reconcile phase writes one critical summary audit row with the
  reconciled/swept counts and a bounded per-member before/after sample (#2106).
- The Xero member-import (#2108) only ever CREATES current-season assignments,
  never modifies an existing one. That never-overwrite invariant is enforced by a
  PRE-READ skip, not by the save path: when a mapped group carries a
  `membershipTypeId`, a matched-EXISTING member who already holds a current-season
  assignment is filtered out and reported before any write (remediation is the
  bulk-assign tool). A matched-existing member WITHOUT a current-season assignment
  is routed through `saveSeasonalMembershipAssignment` (`source` `IMPORT`;
  existence check, age-exemption force, shared-double sweep, per-member audit; the
  preview-token staleness 409 is a race backstop). The newly-created members'
  `createMany` batch — never the save path — is what is exempt from the
  change-preview gate; it writes an `IMPORT`-source assignment with
  `skipDuplicates`. A membership-type mapping additionally requires
  `membership:edit` on top of the route's inferred `finance:edit` — a
  finance-only admin cannot open the assignment write path. The import writes
  one `important` summary audit row and never triggers a synchronous whole-group
  Xero resync.

## INV-LIFE-019

`NOT_APPLICABLE` never has an `AgeTierSetting` row: it has no age range, is
displayed as "N/A", and is excluded from every age-based automation — the season
age-up cron, age-tier Xero contact-group sync (N/A members are never added to a
managed age group; a leftover membership is surfaced as a mismatch instead), and
age-based subscription requirements. N/A members are also exempt from membership
entrance fees: both Xero entrance-fee invoice paths (direct and outbox) skip them
before any amount — including an explicit override — is considered. Booking
guests are always people with a real age tier: `NOT_APPLICABLE` is not a bookable
tier, and an N/A account (organisation or age-exempt human) cannot be linked as a
booking guest.
Committee assignment controls public committee/contact presentation
only. Do not add committee positions to access roles or `Member.role`.
`CommitteeRole` master records and `CommitteeAssignment` member links can be
active/inactive independently of access role and seasonal membership type, and
newly linked assignments are hidden until explicitly published by an admin.
A member photo (`Member.photoImageId` → a `kind = MEMBER_PHOTO` `MediaImage`) is
served only through the scoped `/api/members/[id]/photo` endpoint, never the
public `/api/images/[id]` content path — that content route enforces the split
in code by returning 404 for any non-`CONTENT` row, so the invariant holds even
if a `MEMBER_PHOTO` id is learned. A photo is public **only** when the member
is active, holds an active, published `CommitteeAssignment`, **and** the club has
`PublicContentSettings.committeePhotoDisplay != NONE` — the same two conditions
`/api/committee` applies, so every publicly-rostered member is the set whose
photo is servable; otherwise it is visible solely to the member or a
`membership:view` admin, resolved through the same shared session guards the
upload/remove methods use (`requireActiveSessionUser` / `requireAdmin`), so the
serving path cannot skip the force-password-change or two-factor gates (#2242).
Every refusal on that path is the same 404, whatever the reason, so an
unauthorised caller cannot tell a real member id from one that does not exist.
The photo rule is those two conditions alone: the roster
endpoint additionally applies a pathological `take: 500` backstop
(`src/app/api/committee/route.ts`) against a misconfigured or hostile admin
publishing an absurd number of assignments on an unauthenticated public route.
That backstop is far above any real committee (typically <30) so it never trims
a genuine roster, but it is a display bound, not a narrowing of the predicate —
past 500 published assignments the roster would list fewer members than have
servable photos, which is the safe direction (a photo is never made public by
being trimmed off the roster). The committee-public ETag is
an opaque digest, never the raw `MediaImage` id. `committeePhotoDisplay` governs
both halves together — it decides whether the roster renders photos AND whether
the bytes are anonymously servable — so switching it to `NONE` genuinely takes
the images off the public internet. It only ever narrows: it never makes a photo
public that the assignment predicate does not already allow, and it never hides a
photo from the member themselves or a `membership:view` admin (those responses
switch to `private, no-store` instead of the short public cache).
Every stored image has its EXIF/XMP/comment metadata (camera GPS) stripped
first, on every path that stores image bytes: the member-photo upload, the
admin image library, the image manager's batch upload into `public/images`, the
config-transfer bundle import, and the inline club logo held as a base64 data URI
on `ClubTheme.logoDataUrl` (written by the site-style save and by the bundle
import, and rendered inline on every public page). The member-photo path fails
**closed** (an unconfirmable strip rejects the upload, because it is personal
data on a narrow purpose-built path); the others fail **open** through
`storableImageBytes` / `storableLogoDataUrl` — they store the original and log a
warning — because blocking a legitimate admin content upload, a site-style save,
or an operator's whole configuration restore is the worse outcome there. `gif`,
`avif` and `svg+xml` have no stripper and are always reported as unconfirmed, so
they log rather than claim a clean strip. `POST /api/admin/site-style/logo` needs
no strip step: it re-encodes through sharp, which drops metadata unless asked to
keep it.
Committee contact routing is chosen per assignment via
`CommitteeAssignment.contactEmailMode` (`ROLE`, `MEMBER`, or `CUSTOM`, default
`ROLE`). `ROLE` uses the role email alias stored on `CommitteeRole`, `MEMBER`
uses the linked member's own email, and `CUSTOM` uses
`CommitteeAssignment.contactEmailOverride` (required and email-validated when
the mode is `CUSTOM`; forced null under `ROLE`/`MEMBER`). If the selected mode's
address is missing or deactivated, delivery falls back to the role email and
then the member's email so public contact mail is never black-holed.
Booking pricing, booking block checks, and effective subscription lockout may
depend on the member's seasonal membership type for the
booking season; application access and committee presentation must not.
Seasonal membership type changes require a guarded admin preview and reasoned
audit record. Existing future bookings are not automatically repriced by a type
change, and raw subscription, payment, and Xero history must remain intact even
when the effective subscription status is `NOT_REQUIRED`.

## INV-LIFE-020

When the global two-factor module is enabled, password login is not sufficient
for protected app access. The Auth.js JWT must carry `twoFactorVerified=false`
until a server-side two-factor verification or enrollment endpoint flips it.
The Auth.js session-update trigger is reachable by any authenticated client
(POST `/api/auth/session`), so the jwt callback must never trust a
client-supplied `twoFactorVerified` flag. The claim flips only after the
callback consumes a single-use, short-lived challenge token minted server-side
by the verification and enrollment endpoints and stored hashed in
`TwoFactorSessionChallenge`. Route-group layouts and API guards must enforce
that claim; login form code must not be the only 2FA gate. TOTP secrets, email
OTP codes, recovery codes, and session challenge tokens must never be stored
in plaintext.

## INV-LIFE-021

A `FamilyGroup` with zero `FamilyGroupMember` rows is inert: it never affects
booking eligibility, pricing, or any member-visible UI, because family
visibility and eligibility everywhere derive from `familyGroupMemberships`
(`getMemberFamily`, `resolveMemberFamily`), never from bare `FamilyGroup` rows.

## INV-LIFE-022

*(Corrected by the member-guest epic, #2305. "Eligibility everywhere derives from
`familyGroupMemberships`" is no longer true of BOOKING-GUEST eligibility: with
the `memberGuests` module on, a member outside the booker's family group may be
added as a guest, and `familyGroupMemberships` then decides only whether that add
needs the other member's CONSENT — see "Member-Guest Consent". Everything else in
this paragraph — pricing, family billing, the memberless-group rule — is
unchanged, and the family boundary remains the single definition of "family" that
the consent planner, the authorization check and the D-8 collapse all read.)*
Family billing never infers a recipient from group role, login holder, or email
inheritance. In `BILL_FAMILY_VIA_BILLING_MEMBER` mode the explicit billing
member must be an active, unarchived member of that family; missing or removed
recipients are visible exceptions and those families are omitted from invoice
generation. In `BILL_MEMBERS_INDIVIDUALLY` mode there is no family-billing
surface: no billing member is required, requested, or flagged, because every
member is invoiced directly.
Memberless groups are created intentionally ahead of approval — the member
"create group from scratch" flow (#1681) files a memberless group with a
`PENDING` `GROUP_CREATE` request, and the legacy request-join flow leaves a
target-anchored group behind on rejection — and they may accumulate; they must
not be deleted casually because `FamilyGroupJoinRequest.familyGroup` is
`onDelete: Cascade`, so deleting the group destroys the request history. The
only paths from memberless to membered are admin approval of the `GROUP_CREATE`
request (which creates the requester's membership with role `ADMIN` and
auto-files any partner `ADULT_INVITE`) or the legacy target-anchored join flow.
A `CHILD_REQUEST` targeting a group with zero memberships must not be
approvable (422) until that group's creation request is approved.

## INV-LIFE-023

When a `GROUP_CREATE` request names a partner by an email that matches no
registered member, that partner is invited with a single-use, hash-at-rest
`PartnerInviteToken` (#1682) instead of an `invitedMemberId`, modelled on
`NominationToken` (sha256 hash at rest, single use via `confirmedAt`, expiry,
reminder fields). The token carries `familyGroupId`, `invitedEmail`, and
`createdById`. The invitee registers through the normal membership process and
then claims the token, which files an already-accepted `ADULT_INVITE` into the
group — but only once the group is membered (approved); a claim against a
still-memberless group is refused. The claim is only honoured for a signed-in
member whose own email matches `invitedEmail`, so a forwarded link cannot join
a stranger's group. The create-group route returns the same success response
whether the partner email is a registered member or not, so it cannot be used
to probe membership. Outstanding tokens are visible and revocable to admins;
the inviter of a declared partner may also cancel their own outstanding
invitation from the profile Partner card (#1754) — own `createPartnerLink`
tokens only, unclaimed only, audited — and an idempotent daily cron sweep
hard-deletes expired tokens (TTL 30 days, longer than the 7-day nomination
TTL because the invitee must complete the membership process first).

## INV-LIFE-024

The declared Partner/Husband/Wife relationship (#1742) is a `MemberPartnerLink`
row: a symmetric, consent-based link between two ADULT members, stored as a
canonical ordered pair (`memberAId < memberBId`, DB CHECK constraint — which
also makes self-partnering unrepresentable) with a `PENDING -> CONFIRMED`
lifecycle. It is independent of family groups and is the eligibility signal for
double-bed shared occupancy (#1741). Invariants: **at most one CONFIRMED
partner per member at a time**, enforced in `src/lib/member-partner-link.ts`
under `pg_advisory_xact_lock` on both member ids (sorted order, so pair
transactions cannot deadlock) and backstopped by two raw partial unique indexes
(`MemberPartnerLink_memberA/B_confirmed_unique WHERE status = 'CONFIRMED'`,
documented in `prisma/partial-unique-indexes.tsv`); both members must be ADULT
and active; consent is required from the other member unless (a) an admin
assigns the link directly (`assignedByAdminId` recorded, CONFIRMED
immediately; both members are then emailed unless the assigning admin chose
not to notify — the suppression is audited `notifyMember: false`, #1769a),
(b) the target has **no login** and the initiator is the adult currently
recorded as the target's details voucher (`detailsConfirmedByMemberId`) in a
group containing the target ("one login manages the family" — #2284 (S4)
replaced the old family-group-ADMIN gate; that voucher is self-assignable by any
adult login co-member sharing the group, so this one-step path is open to every
adult in the group, not a designated one. A login-holding target always consents
personally, and the no-login target's address is emailed that the link was
recorded), or (c) the link
forms on a `PartnerInviteToken` claim minted with `createPartnerLink` — the
claim itself is the consent, so the claim page discloses the partnership
before the claimer accepts, and both parties' eligibility (including the
inviter's login standing) is re-validated inside the claim transaction.
Confirming a stale request re-validates the initiator too — a link is never
confirmed that a fresh request could not create. Declined, withdrawn, and
dissolved links are
hard-deleted — history lives in the audit log — so the same pair can re-form
later without tripping the pair-unique constraint; either partner may dissolve
a CONFIRMED link unilaterally (the other is emailed); an admin removing a
CONFIRMED link likewise emails both members unless the admin chose not to
notify (suppression audited `notifyMember: false`, #1769a), while a
still-PENDING admin removal emails no one. When a link becomes
CONFIRMED, all other PENDING requests involving either member are pruned in the
same transaction. A member may have at most one outstanding outgoing PENDING
request. The member-facing request API accepts an arbitrary target only by
email (mirroring the family ADULT_INVITE flow); a memberId target must share a
family group with the requester so the endpoint cannot probe foreign member
ids. A by-email request must not disclose the target's confirmed-partner
status (D9, owner decision 2026-07-11): whether or not the target is already
partnered, the reply is the same generic "request sent if eligible" body —
same message, no link id or status — with the suppressed attempt audited
(`MEMBER_PARTNER_LINK_REQUEST_SUPPRESSED`) and no email sent; the target's
confirmed-partner check runs only after every requester-side conflict so no
error ordering re-opens the probe. Unknown-email (404) and
not-adult (422) feedback stays distinguishable, and the family memberId path
keeps its specific conflict errors. A link claim conflict on token claim (either side already has a confirmed
partner, inviter no longer eligible) skips the link without failing the
family-group join, and the skip is audited.

## INV-LIFE-025

Parent/dependant links (`Member.parentMemberId` and `Member.secondaryParentId`)
are limited to **four generations and two parents**: a member may have at most
two parents recorded, and the longest root-to-leaf chain of parent links may be
at most three links long — great-grandparent → grandparent → parent → child.

## INV-LIFE-026

The cap is checked **symmetrically** at link time, which is what makes it
independent of the order links were created in. Linking child C under parent P
joins two chains, so the rule is

```text
ancestorGenerations(P) + 1 + descendantGenerations(C) <= 3
```

and that total, not either half, is what must fit. `src/lib/member-family-link-depth.ts`
owns the constants, the two bounded graph walks, the shared 422 message, and the
Prisma `where` builders that express the same cap in SQL as bounded relation
nesting. **Every writer of a parent link enforces it**: the admin link route
(`POST /api/admin/members/[id]/dependents/link`), admin member-create
(`POST /api/admin/members` with `parentMemberId`), the family-group
`CHILD_REQUEST` approval on both its link-existing and create-child branches,
the membership-application/nomination family-member approval on both its
map-existing and create branches, and **member merge**. The last four never saw
the previous rule at all.

## INV-LIFE-027

Merge is a parent-link writer by consequence rather than by intent, which is how
it went ungated: it never creates a link, but re-pointing the loser's inbound
links onto the master collapses two nodes into one and JOINS their family
chains. Two things the link-time cap forbids become reachable that way — a
merged node spanning six generations, and a cycle when master and loser are
already related by parentage in either direction (`nullSelfRelationCycles` does
not catch the second: it only nulls MASTER columns equal to the loser id, so a
loop closed through a third member survives it). `evaluateMemberMergeGuards`
therefore refuses both, as the `family_link_cycle` and `family_link_depth`
blockers, telling the admin to unlink first. Refusing is deliberate: which link
to drop is a statement about who is responsible for whom, and that belongs to
the admin.

## INV-LIFE-028

The one writer that validates on the base client and writes in a later
transaction is admin member-create, so under READ COMMITTED a concurrent link
could deepen the parent's chain between its walk and its insert. The window is
milliseconds and the worst outcome is an over-deep chain rather than lost data;
every interactive link writer walks inside its own transaction and has no such
window.

## INV-LIFE-029

The walks are deliberately robust on data that predates the cap. They are
level-bounded (so a cyclic or over-deep graph terminates rather than hanging),
they report the **longest** path rather than the shortest (a member reachable at
two depths counts at its deeper one, because that is the chain that would grow),
and a walk that hits the bound reports "at least bound+1", which refuses the new
link rather than accepting it on incomplete information.

## INV-LIFE-030

**Parentage is recorded at ANY age; responsibility is not** (#2282, owner
decision 2026-07-26). A 16 or 17 year old can genuinely be a parent, and the
system previously could not record it: the admin link route refused a non-adult
parent, the candidate search never offered one, and the only workarounds were to
leave the child apparently parentless or to hang them off a grandparent —
both of which misstate who the parent is. The age rule turned out to be in the
wrong place. **The parent link is close to a labelling artefact:** every
substantial power is gated on family-group co-membership plus being an active
adult with a login, and none of those checks reads the parent columns —

| Power | Actually gated by |
|---|---|
| Booking on someone's behalf | `getAllowedGuestMemberIds` / `isActiveLoginAdultMember` (`src/lib/booking-guests.ts`) |
| Answering a consent request for someone | `familyAdultDelegateResolver` (`src/lib/member-guest-delegate.ts`) |
| Editing or confirming another member's details | active + login + ADULT + shared group (`/api/members/family/[memberId]/details`) |
| Being the contact of record for their mail | `validateInheritEmailSource` + `isUsableEmailSource` |
| Being billed | `billingFamilyGroupId` — group-based; no billing path reads a parent link |

## INV-LIFE-031

Every row of that table lands on the same gate — family-group co-membership plus
an active adult with a login — and **#2284 asked whether that gate is too broad**
(today every adult in a family group has identical powers over every non-login
member in it) and **decided it deliberately** — see *The family group is the
authorisation boundary* below. Nothing in #2282 pre-empted that: this issue moved
no power onto the group gate, it only recorded that the powers were already
there rather than on the parent link.

## INV-LIFE-032

So the only things recording a young parent grants are the word "Parent" on an
admin card and a mail-routing question — and since #2716 that question is
**unanswerable** rather than answered. There is no transitive resolver to walk
past a young parent any more: `isUsableEmailSource` requires `ageTier === "ADULT"`,
inheritance is one hop, so a dependant whose only parent is young inherits
**nobody** and appears on the unreachable surface for an admin to resolve. That
is the accepted cost recorded in `INV-LIFE-047`, not a defect. The
lowering of the ADULT tier's minimum age to 16 was considered and **rejected**:
the boundaries are admin-configurable, but moving them would change fees,
subscription requirements and booking rules for every 16–17 year old in the club
to solve a records problem.

## INV-LIFE-033

What remains on the parent side is `active`, `archivedAt`, and whether the
record is a PERSON at all — whether it is CURRENT and real, never capacity to
take responsibility — shared by both write paths, by the "Add Parent" candidate
search and by the admin UI as `dependentParentStateBlocker` /
`dependentParentEligibleWhere` in `src/lib/dependent-link-eligibility.ts`. An
inactive or archived member, and an organisation or school account, therefore
shows "Add Dependent" **disabled with the reason** ("This member is inactive —
reactivate them to add dependents") on both the create and link paths, rather
than the control vanishing or failing on save.

## INV-LIFE-034

**Organisations are excluded by ROLE, never by age tier.** Dropping the ADULT
clause dropped the only thing keeping organisation and school accounts off the
parent side, and a school is nobody's parent — but `NOT_APPLICABLE` is the
age-EXEMPT tier (#1440, #2106), carried by age-exempt *people* as well as by
organisations, so filtering on it would bar real members and tell them they are
an organisation. `isOrganisationMember` (the ORG access token, or the legacy
`SCHOOL` role for a non-login account whose token is cleared) is the
classification, on the write routes and in the search's SQL alike. This is a
restoration of what the ADULT clause excluded by accident, not a narrowing of
"any age": every real age tier, INFANT included, may be recorded as a parent.

## INV-LIFE-035

**The family group is the authorisation boundary, and every login-holding adult
in it is equal** (#2284, owner decisions 2 Aug 2026). When the system asks "may
this person act on that person?", the question it answers is *do they share a
family group, and does the actor hold a login* — never *which* adult is acting,
whether they are the target's parent, or whether the target agreed. The parent
link is a label, not a permission (the #2282 table above). This is now a recorded
decision rather than an accident of implementation: for a club of small,
mutually-trusting families it is the intended model, and the four protections
below are where it is deliberately softened for the members who cannot speak for
themselves — those with **no login of their own**, who since #2255 can sit up to
four generations from the adult acting for them. The investigation's original
"can see every co-member's data including parents' emails" power is **not**
restated here: #2424 [INV-LIFE-038] has since closed the parent-email exposure,
so the family read is now a whitelist, not an open book.

## INV-LIFE-036

**The dividing line is `canLogin`, not age, and that is deliberate.** The age-up
job withholds a login from any member whose email is inherited from someone else
(`src/lib/cron-age-up.ts`), so an ADULT can remain a non-login member
indefinitely — and every gate here keys on `canLogin`, so such an adult stays
subject to the same powers a child is, and is exactly who the one-step partner
declaration below can target. Nothing changes *at* 18; the protections below
apply to every non-login member whatever their age.

## INV-LIFE-037

The four powers over a non-login member, and how #2284 settled each
[INV-LIFE-074, INV-LIFE-075, INV-LIFE-076]:

- **Requesting cancellation of their membership (S1, owner decision: flag, not a
  second signature).** A non-login member is written already-confirmed on a
  cancellation request because they have no login to confirm with
  (`requiresOwnConfirmation` in `src/lib/membership-cancellation-requests.ts` is
  true only for a login-holder acting on someone else). Rather than add a
  second-adult signature, the admin reviewer is shown an explicit **"included
  without their own or a second adult's confirmation"** flag on any such
  participant (`includedWithoutOwnOrSecondAdultConfirmation` in
  `src/lib/membership-cancellation-admin.ts`), so an auto-stamped confirmation is
  never mistaken for a personally-given one and the judgement moves to the admin.
  Candidate eligibility is read through `isMembershipHolderRecord`, not
  re-derived. The request still executes only on admin approval.

## INV-LIFE-074

- **Adding them to a booking (S2, owner decision: notify, module-independent).**
  A family-scope add now tells the added member — directly if they hold a login,
  otherwise the group's login-holding adults — reusing
  `familyAdultDelegateResolver.resolveNotificationRecipients`
  (`src/lib/member-guest-delegate.ts`), the same rule MG2 already ships. It is
  the missing half of #2250 self-removal: you can only take yourself off a
  booking you find out about. This is **general family behaviour, sent regardless
  of the `memberGuests` module switch**, registered with the booking
  `EmailBookingContext` so the #2258 per-booking "No emails" switch withholds it,
  and it carries a personal opt-out in `NotificationPreference` (it is an FYI, not
  a consent request).

## INV-LIFE-075

- **Editing their details (S3, owner decision: read-only provenance).** A
  delegated edit was audited but never shown to the family. A read-only
  **"Details last confirmed by X on date"** line now renders on the member's
  family/onboarding cards from the already-stamped `detailsConfirmedByMemberId` /
  `detailsConfirmedAt` (`src/lib/member-family-service.ts`), added to the
  member-facing payload by the same deliberate whitelist the #2424 rule uses —
  the confirmer's NAME only, and they are already a listed family adult.

## INV-LIFE-076

- **The one-step partner declaration (S4, owner decision: retire the role
  reliance) — formerly the one role-differentiated power, now aligned with the
  equal-adults boundary.** Declaring a CONFIRMED partner link over a non-login
  adult co-member in one step was the *only* thing that ever read
  `FamilyGroupMember.role` (it required the actor to hold `role: "ADMIN"`), and
  who held ADMIN was an accident of which flow created the group. It is now
  re-anchored onto `Member.detailsConfirmedByMemberId` — the adult recorded as
  having vouched for that member's details — plus a still-shared family group
  (`src/lib/member-partner-link.ts`). **That voucher pointer is self-assignable
  by any adult login co-member sharing the group**: `PUT
  /api/members/family/[memberId]/details` stamps it to whoever confirms the
  member's details, gated only on being an active adult login co-member with a
  complete profile (no admin or group-lead requirement) and overwriting any prior
  voucher. So the one-step power is **not** a lone designated "responsible
  adult" — it is available to every adult login co-member, which is exactly the
  "every login-holding adult in the group is equal" boundary above, and
  deliberately so; no code may treat `detailsConfirmedByMemberId` as naming a
  single, lead-appointed responsible adult. With the role reader gone,
  **`FamilyGroupMember.role` no longer gates authorisation anywhere** — and #2520
  finished the job in two halves: PR #2565 removed every writer (the
  group-creating flows, the join/invite/nomination/partner and Xero-import paths,
  and the demo seed), removed member-merge's vestigial `maxFamilyRole` upgrade,
  narrowed every `FamilyGroupMember` query with an explicit `select`, and marked
  the field `@ignore`; then
  **`20260803030000_contract_drop_family_group_member_role` DROPPED the column and
  removed the field from `prisma/schema.prisma`.** There is now no rank on a
  family-group membership at any level: not in the database, not in the generated
  Prisma Client, and not in the schema. **Membership in a group is the only fact
  the join table records.**

## INV-LIFE-077

No code may treat family-group membership as carrying a rank: **membership in a
group is the only fact the join table records**, and every adult login
co-member of a group is equal (the boundary above). Relatedly, the family-group
join request no longer materialises a group around a consentless target with any
role at all (`src/app/api/members/family/request-join/route.ts`).

## INV-LIFE-038

**What one MEMBER may see about another member's parent** (#2424, owner decision
2026-08-01). `GET /api/members/family` and `GET /api/member/onboarding` both
list, for every member of the viewer's family groups, the parents recorded
against them — and a parent link carries no shared-group requirement of its own,
so a listed parent can be somebody the viewer has no family relationship with at
all. The member-facing link is therefore built by WHITELIST, in two layers:

- **Always, however the viewer is related: `id`, `firstName`, `lastName`,
  `parentLinkType`, `inheritEmailFromId` — and nothing else.** That is the
  literal always-list, not a summary of one. Name and link type are what let a
  family see who the club believes their child's parents are;
  `inheritEmailFromId` is what the "(notifications)" marker on the family page
  is matched on, and an id pointing at whoever holds the mailbox is not itself a
  contact detail.
- **Only when the VIEWER shares a family group with that parent: `email`, plus
  the status fields `ageTier`, `active` and `canLogin`.** For a parent in none
  of the viewer's groups all four are ABSENT from the JSON — for the viewer's
  own parents as much as for anyone else's. The address is the point, but the
  status fields go with it because they are facts about a person the viewer has
  no family relationship with, and `ageTier` in particular would say whether a
  named stranger is a child. #2282 made that materially wider by allowing
  parentage at any age, so what this payload could reach stopped being other
  adults' details and started including children's. No member-facing client
  reads any of the three: the family page renders a parent as a name plus the
  notifications marker, and the onboarding wizard does not read parent links at
  all.

## INV-LIFE-039

The rule is enforced server-side in `buildMemberFacingParentLinks`
(`src/lib/member-parent-links.ts`) and never by a client declining to render a
field: the JSON payload is the exposure, whatever the screen shows. Because the
visible link is assembled field by field rather than by deleting from a spread,
a column added to the query later cannot leak by default — and the tests pin
each branch's key set exactly, so widening either one has to be deliberate. Both
payloads read each parent's own `familyGroupMemberships` to decide — the family
service inside `FAMILY_MEMBER_PROFILE_SELECT`, onboarding through
`MEMBER_ONBOARDING_FAMILY_SELECT`, which exists so the onboarding GATE select
(run on every authenticated page render) does not pay for two joins it never
reads. **Admin surfaces are unchanged** — the admin member detail payload builds
its links from `buildParentLinks`, which still carries the email, because an
administrator's view of a member's contact details is not what this narrows.

## INV-LIFE-040

Alongside the cap, the admin link route requires: the parent must be active,
non-archived and not an organisation account (**at any age tier**); the target
must not be archived, must not already be linked to that parent, must not
already have two parents, and **must not be an ancestor of the parent**. That
last one is now stated in its own right. Under the old
two-generation rule it was enforced only as a side effect — every ancestor of
the parent necessarily has a dependant, so the "already has dependants" clause
excluded the whole ancestor set — and relaxing the cap removed that cover. The
same explicit cycle check was added to the family-group `CHILD_REQUEST`
approval, which previously had no ancestry guard of its own for exactly that
reason. An **inactive** target is deliberately still linkable — only the parent
side requires `active` — and the dialog badges such a candidate "Inactive"
rather than hiding them.

## INV-LIFE-041

The admin candidate SEARCH
(`GET /api/admin/members?dependentLinkEligibleFor=…`) and those write-time
guards are one predicate, `src/lib/dependent-link-eligibility.ts`, so a
candidate the search offers is a candidate the write route accepts **on
identity grounds** — subject to the request's own options, which the route
still validates separately (family groups the parent does not belong to, an
invalid inherit-email source, and the privileged-target and last-full-admin
guards when "disable login" is ticked). The mirror-image "Add Parent" search
(`parentLinkEligibleFor`) filters `active: true`, `archivedAt: null` and "not an
organisation account" through the same `dependentParentEligibleWhere` the write
route's predicate mirrors — and, since #2282, **no age clause at all**, matching
what that route now accepts — then applies the cap the other way round: the
member's own
dependants eat into the budget, the candidate parent's ancestors must fit in
what is left, and the member's descendants are excluded outright so the dialog
cannot offer a cycle.

## INV-LIFE-042

**Ranking is presentation; eligibility is not** (#2425, owner decision 1 Aug
2026). That "no age clause at all" is a statement about who is ELIGIBLE, and it
still holds exactly. What #2282 also did, though, was let a family's children
compete for the picker's eight rows with the adult being searched for: ordered
by `lastName` then `firstName`, a household of children with a shared surname
filled every slot, and the adult was unreachable without extra typing the admin
had no way of knowing was needed. So the parent-candidate search now returns
**ADULTS first, then everyone else**, at the same page size — a re-ORDER of the
same set, not a filter. It is implemented as two complementary queries
(`ageTier: { in: [ADULT, NOT_APPLICABLE] }` and the matching `notIn`) over one
shared `where`, rather than an `orderBy`, because Prisma has no computed sort
key and sorting on `ageTier` itself would depend on the enum's declaration
order. **The line is drawn at MINOR / not minor, not at ADULT / not adult**, and
that is deliberate: `NOT_APPLICABLE` is the age-EXEMPT tier (see above), so a
row carrying it in THIS search is a real person — usually an adult on a FORCED
or N/A-allowing membership type — because organisations are excluded here by
ROLE and never by tier. Ranking them with `not ADULT` would have interleaved
them alphabetically among the household's children and left them crowded off
exactly the page this rule exists to fix. They sort among the adults by name
instead; nothing about the split claims they ARE adults, only that they are not
minors. `Member.ageTier` is NOT NULL, so `in` and `notIn` are exact complements
and the two halves are the same set, and the same count, an unranked query would
return. The split is windowed
correctly for pages beyond the first — this is a general list endpoint, and a
ranking that reshuffled on page 2 would drop and duplicate rows — and the
`total` the response carries is still the count of the WHOLE eligible set, which
is what lets the dialog say the page was cut short ("Keep typing to narrow this
down.", the #2308 member-guest finder's own sentence). Both surfaces DRAW that
sentence under the list and ANNOUNCE it (#2460), each through a live region that
is registered before there is anything to say and has only its content gated,
since a polite region injected already populated is silently dropped by some
screen-reader/browser pairings — the same house rule `PolicyFeedback` and the
view-only banners follow. The booking panel announces it on the end of the result
count its existing status line already reads out, rather than from a second
region of its own, so it is announced ONCE: two polite regions mutating in the
same commit are queued in no guaranteed order and one can be dropped outright.
The dialog, which has no such line, keeps its own `sr-only` region ABOVE the
results — above, because an invisible LAST child of a `space-y-*` stack still
moves the visible content above it, Tailwind hanging the gap off
`:not(:last-child)`. That region goes with the dialog when it closes, so what it
guarantees is "registered empty before the first search answers", which is the
case that matters. On both surfaces the sentence stays reachable twice in browse
mode, once from the region and once as the visible hint under the list: only the
ANNOUNCEMENT is deduplicated, because hiding the on-screen copy from assistive
technology would take the sentence away from the place the list actually stops.
The announced words are the drawn words, verbatim: the sentence must never grow
a count of who was left out, so it does not grow one for a screen reader either.
The ranking is scoped to the `parentLinkEligibleFor` parameter, so every other
caller of `GET /api/admin/members` — the members table, the exports, the other
pickers — issues exactly the query it did before.

## INV-LIFE-043

Three rules about that predicate are load-bearing. First, the parent columns are
**nullable**, so every "not this parent" clause must be written as
`{ OR: [{ col: null }, { col: { not: id } }] }` — Prisma compiles a bare
`{ not: id }` to `"col" <> $1`, and SQL's `NULL <> 'x'` is UNKNOWN, which
silently hid every parentless member from the search (#2254). Second, the two
graph-shaped facts (is the candidate an ancestor of the parent, and how deep is
the candidate's own chain) cannot be read off a single row and are therefore a
**required argument** to `dependentLinkBlockers`, so a caller that forgets them
fails to compile — the same protection the old required relation probes gave,
which had to go because `take: 1` returns an arbitrary child and depth needs the
deepest. Third, an unsatisfiable depth budget must be expressed as a clause no
row can match, never as an omitted filter: `{ NOT: {} }` is a no-op in Prisma
and would fail open.

## INV-LIFE-044

Two decisions here were taken by the delivering agent under D9's remit rather
than by the owner, and the owner has now ruled on both (2026-08-09, #2708 →
#2716). **The depth number stands: four generations.** **Transitive email
inheritance does not** — it is narrowed to the direct parent, and the rule is
stated in `INV-LIFE-047` below. The two are independent, which is the point of
recording them together: the cap governs how deep the family TREE may run, and
never governed how far an ADDRESS may travel.

## INV-LIFE-045

Delete eligibility counts **direct** dependants only, and that stays correct at
four generations. A middle generation holding dependants is still blocked, so a
delete can never strand a member whose only recorded parent it was; a
grandparent is blocked while their child is still linked to them, and becomes
deletable once that one link is cleared, at which point the grandchildren are
untouched because they were never linked to the grandparent. Counting
descendants transitively would instead block deleting a great-grandparent who
has no remaining link to anyone.

## INV-LIFE-046

Family links grant **no billing or fee coverage**. Money-side coverage derives
from `FamilyGroup`/`FamilyGroupMember`, `Member.familyGroupId`,
`Member.billingFamilyGroupId`, `SeasonalMembershipAssignment` and the fee
schedules — never from the parent columns — so a three- or four-generation chain
bills exactly as the same members with no links at all. That isolation is
enforced by a source contract,
`src/lib/__tests__/family-link-billing-isolation.test.ts`, because it is one
`include: { dependents: … }` away from quietly ceasing to hold and the symptom
would be a mis-invoiced family.

## INV-LIFE-047

**Email inheritance is DIRECT-PARENT ONLY** (#2716, owner decision on #2708,
2026-08-09). A member with no address of their own inherits from a **parent**
and from nobody else — never from a grandparent or great-grandparent through a
middle generation that also has no address. Resolution reads one row: the chosen
parent qualifies (an **adult**, not archived, holding a real address rather than
a club-internal `.invalid` placeholder, and not themselves inheriting) or the
dependant inherits nobody.

The reasoning the owner gave: an address that travels an arbitrary number of
hops is unpredictable to the person whose address it is. A grandparent who
supplies an email for one grandchild does not thereby expect notifications for a
branch of the family they may have no involvement with. One hop is explainable
to a member in a sentence; three is not.

**The cost is real and was accepted.** Where a middle generation has no address,
the descendant inherits nobody and the club has to ask for one. That is the
correct failure direction — a gap somebody can see beats a message going
somewhere nobody chose — but it is only correct while the gap is VISIBLE, which
is why the admin surface in `INV-LIFE-048` is part of the rule rather than a
convenience beside it.

## INV-LIFE-048

**The gap is surfaced, not merely permitted.** `unreachableMemberWhere`
(`src/lib/member-email-inheritance.ts`) is the single definition of "the club
has no way to reach this member", and both admin surfaces read it: the members
list filter (`/admin/members?contactability=unreachable`) and the stuck-states
dashboard item that links to it. It reports two distinct reasons, and the
distinction matters more than it looks — one is a job for the office, the other
is a data repair:

- **a choice that resolves to nobody** — somebody was chosen and currently
  nobody receives the mail. This is the one a placeholder-address test would
  MISS, because a dependant's own `email` column is routinely a copy of the
  address they used to inherit: after the pointer clears they look perfectly
  reachable while their notifications would go to somebody else's mailbox.
- **no address at all** — no inheritance and their own address is a
  club-internal `.invalid` placeholder.

It is scoped to people the club is supposed to be able to reach: active, not
archived, not cancelled, and not an organisation, school or lodge account. A
walk-in contact with a placeholder address is not a fault to fix, and listing
them would bury the members who are.

## INV-LIFE-049

**Two columns, and the difference is the whole feature.**
`Member.inheritEmailChoiceId` is WHO WAS CHOSEN — a direct parent for a derived
pointer, the adult an admin named for a hand-picked one. `inheritEmailFromId` is
WHO ACTUALLY RECEIVES THE MAIL, and is never written by hand: it is
`effectiveEmailSourceId` of the choice and nothing else.

Keeping them apart is what makes "re-resolve when an address is ADDED" possible
at all. Collapse them and a REMOVED address erases the record of who was chosen,
so the pointer can never come back when the address does, and the member sits
unreachable until somebody notices by hand — a new silent failure introduced by
the fix for a silent failure.

What the pointer stores is still the **terminal** source: it always points
straight at the mailbox, never at a middleman. That is what lets every
reader (`getMemberEmail`, `member-email.ts`, the roster, the age-up cron, Xero
contact sync, the preference resolver in `email/core.ts`) keep its single
`inheritEmailFrom` join and stay correct at any depth. Do not "simplify" this by
storing a pointer at the direct parent — and note that **every writer must go
through the resolver**, not just the ones that felt like link operations: the
nomination approval and admin member-create both stored one-hop pointers until
#2255, and the Xero contact import wrote one with no validation at all.

## INV-LIFE-050

`validateInheritEmailSource` enforces the guarantees that follow: the source is
an adult, with a real address, who does not itself inherit. The **adult** clause
there — and the matching one in `isUsableEmailSource`, which is the single
predicate every resolution, query and backfill applies — is deliberate and
survived #2282: a 16-year-old may be recorded as a parent, but being the club's
contact of record for someone else's notifications is a responsibility function,
so the link is **refused** rather than quietly making the minor the family's
contact. Since #2716 that refusal is the whole answer: a minor parent's child
inherits NOBODY rather than routing on up to the young parent's own parent. The
admin member detail page resolves and displays the source
(`dependentEmailSource`) with the same rule the writes use, so the routing is on
screen before the dependant is added — and both link dialogs resolve the parent
the admin picks in the notification-recipient list the same way
(`GET /api/admin/members/[id]/dependent-email-source`). Its former "must point to
a **primary** adult member" rule (the source must have no parents) stays retired:
that clause was about where in the TREE a mailbox owner sits, which the one-hop
rule does not constrain — a parent who is themselves somebody's child is a
perfectly good source for their own children. The "inherit email from" candidate
search mirrors the same predicate, so the picker can neither hide a source the
write route accepts nor offer one it refuses. "Real address" means neither
club-internal `.invalid` domain: a walk-in `@no-email.invalid` (#1935, silently
dropped by `sendEmail`) or a deletion-anonymised `@deleted.invalid` (which
hard-bounces). Both are matched by `isPlaceholderContactEmail`; the second was
added in #2255 because a grandchild could otherwise keep resolving to an
anonymised grandparent forever. If resolution finds nobody, the link is
**refused** rather than quietly stored as "no inheritance": the admin asked for
the dependant's mail to reach a parent, and silently leaving it on the
dependant's own address is how a family stops hearing from the club without
anyone noticing. The family-group create-child branch keeps the explicit opt-out
(`inheritEmailFromId: ""`, "use the child's own email") its sibling branch has,
so that refusal never becomes a dead end.

## INV-LIFE-051

A stored pointer is a snapshot of a past decision, so nothing trusts it without
**re-reading the member it names**, and it resolves to nobody if that member has
since been archived, anonymised, left with a placeholder address, or
**themselves started inheriting**. That last one is not optional politeness: a
member who inherits is not a mailbox, and their own `email` column is typically a
stale copy of the very address they inherit, so honouring such a source would
deliver a dependant's notifications to a third party while every screen showed a
valid inheritance in place.

"Themselves started inheriting" tests the **choice** column as well as the
pointer, and that is what makes reconciliation order-independent. After #2716 a
member whose chosen source has gone unreachable holds a live choice beside a NULL
pointer; testing the pointer alone would read them as a mailbox of their own, and
a sweep would then reach different answers depending on which member it happened
to visit first.

## INV-LIFE-052

**Provenance, not identity, decides what unlinking clears.** Every pointer this
system derives from a parent link carries `inheritParentEmail: true`; a
hand-picked source carries `false`. The unlink route reads that flag rather than
asking whether the stored pointer names the parent being removed — a one-hop
test that was correct only while resolution was one hop, and that (before it was
fixed in #2255) left a member with no parent link and a permanent inheritance
from a great-grandparent, while reporting `clearedEmailInheritance: false`.

## INV-LIFE-053

**Pointers re-resolve whenever an address is added, changed or removed** (#2716,
owner decision on #2708, 2026-08-09). Automatically, with no admin prompt: a
confirm-each-re-point variant was put to the owner and declined, because with
inheritance limited to one hop re-resolution is a direct parent-to-child lookup
rather than a walk up a tree, so there is nothing for a human to arbitrate, and a
queue of pending confirmations is a slower version of the defect it replaces.

The two halves of the decision compose, and the order is load-bearing: the
prompt-free design is defensible only because the tree walk is gone. Automatic
re-pointing across a multi-hop walk would be worse than the bug.

The mechanism is **convergence, not event handling**.
`reconcileEmailInheritanceForMemberChange` does not ask what happened; it
recomputes what should be true from `effectiveEmailSourceId`, so ADD, CHANGE and
REMOVE are one code path. A removed address is the case most likely to be missed
and the one that leaves a pointer naming a mailbox nobody reads — it needed no
special handling at all, which is the argument for the shape.

It runs **inside the transaction that made the change**, so a rolled-back address
write rolls the re-resolution back with it and a committed one cannot commit
without it. Age-up is one of these events rather than the only one: it moves a
member across the usable-source line in the helpful direction, and it now uses
the same call as every other writer instead of a sweep of its own.

## INV-LIFE-054

**A daily sweep is the guarantee behind the per-write calls, and it is
re-runnable by design.** `reconcileAllEmailInheritance`, scheduled as
`email-inheritance-reconcile` at 06:45 NZT — deliberately just after age-up —
converges every member who holds a choice or a pointer.

It exists because "every write re-resolves" is a claim about a codebase, and this
one decides which adult receives a minor's notifications. That claim was false
when first made — several age-tier writers did not call the reconciler (#2821) —
so the age-tier half is now mechanically enforced by
`src/lib/__tests__/age-tier-writers-reconcile-census.test.ts`, which discovers
every member write that SETS the age tier — however the value was derived, so the
age-up cron and the nomination promotion are caught alongside the writers that
resolve an enforced tier — and fails if any does not invoke
`reconcileEmailInheritanceForMemberChange`. That guard is the age-tier subset
only. #2821 also wired an adjacent email-source site by hand — the dependant
`link` route, which changes who is a usable source without writing a tier, so the
census does not see it and never will. Read the census as proof that every
age-tier WRITE re-resolves, not that every email-source change does. The specific
hazard is a
re-resolution that fires on the wrong event or fails partway, which would leave a
pointer naming somebody nobody chose: the original defect with extra steps.
Because the rule is a pure, total function of the family tree, a second run always
moves the database towards the same fixed point and never away from it — so a
partial failure is repaired by running it again rather than by working out what it
did. That property is what made prompt-free re-pointing safe to ship.

The sweep writes `inheritEmailFromId` and nothing else, with ONE exception: where
it finds a pointer with no choice beside it — the shape a draining blue/green old
colour writes, since that colour knows only the pointer — it adopts the pointer as
the choice **if and only if it names a direct parent**, and clears it otherwise.
That is one hop enforced at the last door: a transitive pointer written mid-deploy
cannot survive it, while an ordinary link made mid-deploy is preserved intact.

What it never does is rewrite a choice somebody made. `inheritParentEmail` is
sound as PROVENANCE where a writer set it deliberately (`INV-LIFE-052`) and
unsound as a universal test, because it carries `@default(true)` and therefore
reads true for every member who was never a dependant at all. A "derived pointers
must name a direct parent" rule applied on that flag would fire on a family-group
login cluster — adults who share one login and are pointed at the holder by hand,
none of whom is anyone's parent — and disconnect the whole cluster from its own
mailbox on the next sweep. The one-hop constraint therefore lives where choices
are CREATED (every writer, the migration backfill, and the adoption rule above),
never in the convergence step.

## INV-LIFE-055

**Removing a member detaches, and declares.** All FOUR removal paths —
cancellation approval, archive approval, deletion anonymisation, and the
two-admin hard delete — clear links pointing at the member being removed. With four generations that member is often a middle generation, so the
sweep leaves their dependants without a parent link and anyone inheriting their
address without a mailbox. Those dependants are deliberately **not** re-parented
onto the grandparent: who is responsible for a member is a real-world fact, and
promoting it as a side effect of someone else leaving the club would record a
relationship nobody asserted.

## INV-LIFE-056

All four therefore read who they are about to detach BEFORE nulling the columns
— afterwards there is no record of the links at all — through the one shared
helper, `src/lib/member-family-link-orphans.ts`. Cancellation, archive and hard
delete return `orphanedLinks` (always present, empty arrays when nothing was
linked), the admin page states who was detached, and all four name the same
members in their audit metadata. The hard delete is the one that leaves the
clearing itself to the database (`onDelete: SetNull`), which nulls the columns
but leaves `inheritParentEmail: true` standing beside a NULL pointer — a
combination no writer produces and no reader expects — so it also clears that
flag, guarded on the pointer already being null so it can never touch a live
inheritance. Deletion anonymisation additionally **sweeps the inheritance
pointers aimed at the member**, which it previously did not: it overwrites the
member's address with `@deleted.invalid` and nulled only their own pointer, so
dependants and grandchildren kept resolving club email to an address that hard
bounces on every send. Its parent LINKS are deliberately left in place — the row
survives for history, so the family structure is still true; it is only the
mailbox that must stop being used.

## INV-LIFE-057

The notice deliberately does **not** claim the affected members now receive club
email at a working address. Several paths (`confirm-email-change`, the
family-group login-holder route, nomination) COPY a source's address into an
inheritor's own `email` column, so "their own address" is frequently a copy of
the removed member's, and it may be a placeholder that receives nothing. The copy
says so and asks the admin to check.

## INV-LIFE-058

Pending nomination states must have an expiry, reminder, admin refresh,
replacement, rejection, or other documented recovery path so applications do
not remain permanently blocked by stale action links.

## INV-LIFE-059

Lodge induction sign-off is a single overall Pass per signer. Checklist items
remain the reference material for the induction, but runtime sign-off does not
store per-item Yes/No/N/A results or member self-assessment levels. New-member
inductions created from approved applications should explicitly assign the
application nominators as signers while preserving the application nominator
fallback for historical records. Completing a Hut Leader Induction sets
`Member.hutLeaderEligible`; it does not create or date a `HutLeaderAssignment`,
which remains an admin-controlled roster/coverage record and issues a dedicated
lodge kiosk PIN (its plaintext is shown only once, at issue or reset).
Assignment additionally requires the member to hold the standard
`USER` access role: a member whose only roles are custom definition-backed rows
(`role = null`) cannot be assigned as a hut leader, and the booking-derived
picker only surfaces adult `USER` members with an operational booking
overlapping the assignment range, while the "Any member" tab rosters a
booking-less custodian directly (see CONFIGURATION.md → "Hut Leaders").

## INV-LIFE-060

The trusted legacy induction baseline (#2361) is a one-off maintenance
exception, not a replacement for ordinary sign-off. Its population is exactly
the active, non-archived, non-cancelled real-member rows whose legacy member
role is `USER` or `ADMIN`; this classification reuses the canonical member
import role set. Login is not required, so a non-login `USER` dependant remains
in scope, while `LODGE`, `NON_MEMBER`, and `SCHOOL` rows do not. Every
configured person age tier participates; Infant, Child, Youth, and Adult are
all included, while an in-scope `N/A` is reported separately and never
changed. The age-tier partition must come from valid stored configuration —
the command must not silently substitute application fallbacks. A completed
induction of **any** kind makes the member historical and therefore skip-only.
A `DRAFT` or `IN_PROGRESS` induction makes the member an apply blocker,
including when another completed row also exists. Voided history alone does
not count as completion.

## INV-LIFE-061

Apply requires an active, login-enabled Full Admin actor, one valid active
`NEW_MEMBER` template, an exact effective-club-name confirmation, exact parsed
database host and database-name confirmations, one New Zealand date-only
value no later than the current New Zealand date, and stable provenance. It
creates only new `NEW_MEMBER` / `COMPLETED` / `ADMIN_OVERRIDE` rows.
`inductionDate` and `completedAt` are the same supplied date, and every row
stores the actor, template, and provenance. It creates no signers, sign-offs,
email, or `hutLeaderEligible` side effect; existing induction rows are never
updated or deleted. The rows and audit event are one transaction, an open
workflow visible after the direct-`MemberInduction` DML lock aborts the whole
apply, and an identical rerun writes nothing. That table lock does not freeze
the member population or a composed writer before it reaches this table, so
the final dry run and apply require the operator write freeze in
`docs/INDUCTION_BASELINE_RUNBOOK.md`.

## INV-LIFE-063

Hard delete must remain limited to records that pass the eligibility checks for
no durable booking, financial, family, Xero, or membership-history blockers.

## Calculated age on identity-sensitive Family Group workflows (#2568)

### INV-LIFE-064

An administrator linking, approving, creating, editing or removing a Family Group
member sees that member's **calculated age** beside their name. The invariants:

- **One helper.** `src/lib/member-age.ts` is the only place age is derived, and
  `src/lib/__tests__/member-identity-age-surfaces.test.ts` pins the complete list
  of modules that call it or carry its `ageLabel` output. A new screen showing an
  age fails that census first.
- **Nothing is stored.** Age changes on its own every day, so there is no age
  column and no cached value; it is recomputed on every read. `Member.ageTier`
  remains a separate, deliberately stored classification and is never used to
  infer an age.
- **Date-only on the New Zealand calendar.** A date of birth is a calendar day.
  `Date` inputs are read through the club time zone, exactly as the family-group
  screens already RENDER a date of birth, and the default reference date is the
  club's calendar day — never the UTC or browser date, which would move a
  birthday by one day for half of every NZ day. The reference date is injectable
  so tests are deterministic.
- **A 29 February anniversary clamps to the last day of the month**, so a
  leap-day member turns over on 28 February in a non-leap year. A future or
  unparseable date of birth has no age and reads `Age unavailable` — never
  "0 years", which would look like a real infant.
- **Under five shows completed years AND months**; five and over shows completed
  years only.
- **Age is as at today; an age tier is as at the season start.** The two sit side
  by side on these screens and are deliberately computed against different
  reference dates: `formatMemberIdentityAge` defaults to the club's current
  calendar day, while `Member.ageTier` (and a child request's derived
  `requestedAgeTier`) is `computeAgeTierWithSettings(dob, getSeasonStartDate(...))`
  and holds until the next rollover in `cron-age-up.ts`. A member whose birthday
  falls between the season start and today therefore reads, correctly, "5 years"
  beside "Infant (0-4)". Wherever a tier label carrying a numeric range is
  rendered next to an age, the UI states the season-start basis
  (`request-review-card.tsx`) — the pairing must never read as a corrupt record.
  Neither figure is derived from the other: age is never inferred from a tier,
  and a tier is never recomputed from a label.
- **The browser is sent the age, not the birth date.** Every family-group payload
  that needs identity information carries a finished `ageLabel` string and no
  `dateOfBirth`. The one date of birth still rendered is the value the REQUESTER
  declared on a child or adult request — the request's own data, which the admin
  checks a candidate record against, not a stored member record.
- **Membership permission, verified server-side, on every request.**
  `GET /api/admin/family-groups/member-search` and
  `GET /api/admin/family-groups/[id]` both name `membership:view` explicitly
  rather than inferring it from the request path. An administrator whose role
  covers an unrelated area receives no identity information at all.
- **Routine views stay routine.** The `GET /api/admin/family-groups` list — the
  ordinary Family Group overview — carries neither a date of birth nor an age,
  and no member-facing or public surface carries either.

## Member profile merge (E11 #1937)

### INV-LIFE-065

Two duplicate member records may be merged into one by a **Full Admin only**. The
admin picks the **master** (the record that survives); the other is the **loser**
and is hard-deleted at the end. The merge is **additive and master-wins**:

- **Field merge.** The master's populated scalar fields always win; a blank
  master field is filled from the loser (contact/identity/address groups —
  phone and each address block fill as a whole, never field-by-field, so a merged
  record never mixes one member's street number with another's city).
  `requiresInduction` and `hutLeaderEligible` are OR-ed (and
  `hutLeaderEligibleAt` becomes the earliest); `joinedDate` becomes the earliest.
  **Login and identity are never merged** — `email`, `passwordHash`,
  `emailVerified`, `canLogin`, `role`, `financeAccessLevel`, every 2FA field, and
  `xeroContactId` always stay the master's. (Login-email uniqueness is a partial
  unique index `WHERE canLogin = true`, so two login rows on one email can never
  coexist mid-transaction.)
  **The FIELD PATCH only** is derived from a read of both members taken
  immediately before the write, never from the snapshot the transaction opened
  with (#2243). Everything else in the merge — the guard matrix, the confirmation
  phrase, the preview-token check, and the self-relation cycle nulling — still
  runs on that opening snapshot. Every value in the patch is copied off the
  loser, and two of them are real foreign keys — `photoImageId` (→ `MediaImage`)
  and `familyGroupId` (→ `FamilyGroup`) — so a stale value can name a row that a
  writer outside the `member-lifecycle` lock deleted mid-merge and fail the write
  outright, rolling the entire merge back. Both member rows are row-locked
  (`SELECT … FOR UPDATE`, id-ordered) immediately before that read, so neither
  can move again before the write. If the fresh derivation disagrees with the
  previewed one on any field, the merge **refuses**: a 409
  (`merge_drift_in_transaction`) naming the drifted fields, nothing written, and
  the operator re-runs the preview — the same "what was previewed is exactly what
  is applied" promise the rest of the preview/confirm flows make. The original
  bug is fixed either way, because the stale value is caught from the fresh read
  *before* it reaches Postgres. A row lock does not protect the rows these FKs
  point at, so a concurrent `FamilyGroup` delete can still abort the merge (as a
  deadlock rather than a stale-value error); the master is still unlocked during
  the guards and the self-relation pass, which is why the Member self-relation
  moves exclude the master's own row. The four **family-link** columns
  (`parentMemberId`, `secondaryParentId`, `inheritEmailFromId`,
  `detailsConfirmedByMemberId`) are protected in three places (#2437): step 1
  nulls a master pointer at the duplicate **value-conditionally** (a pointer
  that moved since the opening snapshot refuses right there, instead of being
  overwritten and read back as "unchanged"); the step-3 sweeps are
  **id-bounded** to the rows captured by the in-transaction token
  re-derivation (a link written after that capture is never absorbed onto the
  master unvetted — it stays pointing at the duplicate); and the step-5
  under-lock re-read checks all three arms — either member's own outgoing
  links beyond the merge's own rewrites, and any other row still referencing
  the loser after the moves — refusing with the same 409 on any drift. Two
  invariants follow: a merge never **creates** a self-referencing family link
  (step 1 clears a master→duplicate pointer, the moves exclude the master's
  own row, and every mid-merge divergence refuses — note this does NOT forbid
  a **pre-existing** self-reference: `detailsConfirmedByMemberId` equal to the
  member's own id is the legitimate self-confirmed state gating
  `canBeBookedAsMember` (`member-profile-completeness.ts`), and a merge
  carries it through untouched), and a family link saved while the merge runs
  is never silently lost or silently absorbed — the merge refuses, nothing is
  written, and the operator's re-run previews the up-to-date links, including
  an explicit warning when the master's own link at the duplicate will be
  cleared (owner decision on #2437, 1 Aug 2026: detect and refuse; no new
  advisory-lock participants, no DB CHECK constraint).

### INV-LIFE-078

- **Relation buckets.** Every Member-referencing relation is classified into
  exactly one bucket by `MEMBER_MERGE_RELATION_SPECS`, enforced complete by a
  DMMF/schema test that fails CI if a new relation is added unclassified:
  - **move** — history re-points loser → master (`updateMany`): bookings, guests,
    credits, refunds, redemptions, committee/hut-leader/lodge-access-created,
    actor and reviewer back-references, and the five Member self-relations
    (parent / secondary parent / email-inheritance / details-confirmed-by), whose
    self-cycles are nulled on the master first.
  - **resolve** — a unique constraint means a per-model resolver dedupes before
    moving: `MemberSubscription`/`SeasonalMembershipAssignment` (per season),
    `MemberAccessRole`, `MemberLodgeAccess`, `CommitteeAssignment`,
    `PromoCodeAssignment`, `PromoRedemptionAllocation` (both uniques),
    `MembershipCancellationRequestParticipant`, `GroupBookingJoin`,
    `NotificationPreference` (1-1), `MemberInductionSignOff` (earliest sign-off
    wins), `MemberInductionAssignedSigner`, `FamilyGroupMember` (keep the
    master's row and re-point the family's billing membership at it; #2520
    removed the old `MAX(ADMIN > MEMBER)` role upgrade and then dropped the
    column it wrote), and `MemberPartnerLink` (canonical
    `memberAId < memberBId` pair, self-pairs and duplicates deleted, and at most
    one CONFIRMED partner kept for the master).
  - **cascade** — the loser's auth identity and ephemeral tokens
    (password-reset / email-verification / email-change tokens, all 2FA rows,
    partner-invite tokens) are never moved; they die with `member.delete(loser)`.
  - **snapshot** — FK-less scalar member-id columns
    (`MemberLifecycleActionRequest.memberId`, `BookingModification.memberId`,
    `MemberApplication` nominator/reviewer ids, `NominationToken`,
    `IssueReport.resolvedById`, `AuditLog` columns, the settings-audit
    `updatedByMemberId` columns, `CalendarEvent`/`CalendarEventSeries.createdById`,
    …) are **left pointing at the loser's id by design** as immutable history;
    the same historic audit rows that reference the loser keep its id and stored
    names on purpose. These carry no `@relation`, so the relation walk above
    cannot see them and they used to be listed by hand and non-exhaustively —
    which is how the two calendar columns escaped both (#2243). They are now
    enumerated mechanically as well: any FK-less `String` column whose name is
    used elsewhere in the schema as a Member FK column must appear in
    `MEMBER_MERGE_SNAPSHOT_SCALAR_COLUMNS`, and `member-merge-dmmf.test.ts` fails
    on the next one that does not. Columns with bespoke names
    (`MemberApplication.nominator1Id`, `RefundRequest.reviewedBy`,
    `IntegrationCredential.updatedByUserId` — a misnomer, it holds a member id —
    and the like) are invisible to that scan and stay hand-documented, so that
    part of the list is explicitly **best-effort, not exhaustive**.
    One column found by the same review is deliberately **moved, not
    snapshotted**: `BookingRequest.convertedMemberId` is the identity pointer to
    the member a booking request converted into, replayed as a live member id by
    the idempotent approval path, so the merge re-points it loser → master
    alongside its FK twin `requestedByMemberId` (#2243).

### INV-LIFE-079

- **Subscription-collision blocker.** If the loser holds a *meaningful*
  `MemberSubscription` (any invoice/payment/charge-coverage signal) for a season
  the master holds **any** subscription row for — meaningful or not — the merge
  is **blocked**: the keep-master resolver drops the loser's colliding row, so a
  paid/invoiced loser row must never collide, even with a meaningless
  `NOT_INVOICED` master row (dropping it would delete payment history, and a
  charge-coverage-backed row would fail on its `onDelete: Restrict` FK). A
  meaningless loser subscription for a season the master also holds is dropped;
  otherwise it moves.

### INV-LIFE-080

- **Xero teardown (ENTRANCE_FEE_INVOICE re-point rule).** Inside the transaction
  and with **no Xero API calls**, the loser's contact-identity `XeroObjectLink`
  rows are deactivated and its `xeroContactId` nulled (mirroring the delete path).
  The exception is the loser's active `ENTRANCE_FEE_INVOICE` (joining-fee) link:
  it is **re-pointed** (its `localId` set to the master) so the paid-joining-fee
  evidence survives — otherwise E5's invoice-idempotency check would treat the
  master as never-invoiced and risk a double charge. If the master already holds
  an active `ENTRANCE_FEE_INVOICE` link (the partial unique forbids two), the
  loser's is deactivated instead and the preview says so. The loser's Xero
  **contact** is not touched in Xero — the preview warns the admin to archive or
  merge it there manually (residual risk: no post-merge Xero contact-group or
  invoice re-sync, consistent with the periodic-reconciliation stance).

### INV-LIFE-081

- **Xero contact participants are lifecycle-fenced.** Member-scoped contact
  UPDATE (including operator retry and bulk name repair) reserves from the
  complete Member row only after taking that member `FOR KEY SHARE`; the
  provider request is built from that locked snapshot, so a surviving master
  sends fields filled by a merge that committed first rather than stale
  pre-merge PII. Inbound webhook reconciliation, bulk contact sync, group
  import, historical canonical-link backfill, and managed contact-group
  completion take the stronger exact Member `FOR UPDATE` before any local
  contact pointer, blank-field PII fill, or FK-less CONTACT link is committed.
  Pointer, link, and operation ledger share that transaction.
  Merge/deletion-first therefore makes the inbound, backfill, or group-sync
  completion refuse; writer-first is followed by the normal teardown, so no
  active CONTACT link remains for a deleted member or merge loser. Every Xero
  provider call remains outside these short transactions.

### INV-LIFE-082

- **Guards, preview and confirmation.** Full Admin only; master ≠ loser; both
  exist; master active and not archived; loser ≠ the acting admin; the loser may
  not hold any admin access role (and the last-Full-Admin backstop applies); no
  PENDING/REQUESTED lifecycle, deletion, or family-join request on either member.
  The whole merge runs in one transaction under the dual `member-lifecycle`
  advisory lock (see CONCURRENCY_AND_LOCKING.md), re-runs the guards, and
  re-verifies an HMAC preview token (over both ids, both `updatedAt`, and an
  outcome digest) so a drifted preview 409s. The admin must type
  `MERGE <loser full name>` (whitespace-normalised) to confirm, and one critical
  `MEMBER_MERGED` audit records the loser snapshot, field outcome (the values
  actually applied), per-relation counts, collision resolutions, and a bounded
  500-row moved-id sample. The token pins the state at the moment the transaction
  opened, so it catches drift **before** the merge starts but cannot see a change
  that lands during it; that residual window is closed by the second patch
  derivation above, which 409s on any disagreement — so a committed merge never
  carries drift, and there is no drift field in the audit to read.

### INV-LIFE-083

- **Refused attempts are audited too (#2498).** Every refusal — self-merge,
  missing member, `merge_blocked`, wrong confirmation phrase, `preview_drift`,
  the #2595 `partner_share_lodge_drift` arm, and the
  `merge_drift_in_transaction` field/family-link arms — throws from
  inside the transaction and rolls it (and the `MEMBER_MERGED` audit) back. A
  single boundary in `executeMemberMerge` then writes one best-effort
  `MEMBER_MERGE_REFUSED` audit (category `admin`, outcome `blocked`) on the base
  client, outside the rolled-back transaction, recording the actor, both member
  ids, the refusal code/status, and a non-PII structural summary of what drifted
  or blocked (field/column names and guard codes only — never member values,
  names or emails). The write is best-effort: a failed audit is logged and
  swallowed, so it can never turn a clean 4xx/409 refusal into a 500, and one
  refusal produces at most one row.
