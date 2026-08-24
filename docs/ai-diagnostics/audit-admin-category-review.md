# The `admin` audit category, reviewed site by site (#2730)

**What this page is.** A record of every production audit writer that recorded
`category: "admin"`, read one at a time against the owner's rule that **the
category follows the business domain the event affected, never who performed
it**. Twenty-two were wrong and were moved, eighty-seven were read and kept, and
nine were held for a decision because moving them would publish rows on a
member-facing surface. This page says why for each, rather than leaving `admin`
to look like the absence of a decision.

**One of the nine has since been resolved, and the resolution went the other
way.** #2755 unified the three writers of *an officer editing somebody else's
member record* on `admin` by moving the two bulk-screen branches IN, rather than
moving the member-page writer out into a member-visible category. Eight of the
nine remain held. `admin` therefore reads 101 sites now, not 96, and the rule that
came out of it is `INV-PRIV-012` — which is also where the fifteen lodge-gated
sites and the `lockers` group (unresolved then, settled by #2777) are now
recorded, instead of only in the open-question section at the foot of this page.

**And the open question at the foot of this page is closed: they stay (#2765).**
The test that decided it — *did this site split a subsystem*, not *does it name a
lodge* — is `INV-PRIV-013`, and the fifteen are pinned per site in
`LODGE_GATED_ADMIN_CATEGORIES_2765` so the keep no longer depends on the next
author reading this page. `lockers` went back as its own filed decision, **#2777**,
not as a sentence here, and was decided on 11 August 2026: the four stay `admin`.
#2765 records why in terms that can be re-measured rather than re-argued.

**What this page is not.** It is a record of where the platform FILES new rows. It
changed no row already in the database, which left bed-allocation history split by
date — a separate reviewed decision, taken in
[#2751](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/2751), whose
one-off exact-action migration has since moved the stored rows as well.
See [Rows already written](#rows-already-written-moved-too-by-2751).

**Why it exists.** `AuditLog.category` is a permission decision, not a label.
It decides which AI Diagnostics correlation entry can return the row — and
therefore which admin areas an operator must hold — and whether the member the
row concerns sees it on their own activity list. [#2581](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/2581)
gave every writer a category; PR #2676 classified the 82 that had none and
**explicitly did not read the 118 that already said `admin`**, which is the
platform's catch-all. #2581's own readiness note said those classifications
"cannot be assumed correct". This is the pass that checked.

For the taxonomy itself, and which permission each category sits behind, see
[the support tool pack](tool-pack-support.md) and
[`src/lib/audit-categories.ts`](../../src/lib/audit-categories.ts). For the
operator's view of the same table, see [the audit log guide](../guides/audit-log.md).

## The two readerships every verdict below is measured against

| | Who can correlate it in AI Diagnostics | Can the member it concerns see it? |
| --- | --- | --- |
| `admin` | `support:view` alone | **No** |
| `lodge` | `support:view` **+ `lodge:view`** | **No** |
| `family`, `account`, `privacy`, `communication` | `support:view` **+ `membership:view`** | **Yes** |
| `security` | `support:view` alone | **Yes** |
| `booking` | `support:view` **+ `bookings:view`** | Yes |
| `payment`, `xero` | `support:view` **+ `finance:view`** | payment yes, xero no |

Two consequences run through everything below.

1. **Moving out of `admin` into any non-member category is a narrowing.** A
   support-only operator loses evidence they can correlate today. They can still
   read the row in **Admin → Audit Log**, which needs `support` and nothing else,
   so nothing becomes unreadable — but the AI Diagnostics channel closes.
2. **Moving out of `admin` into a member-visible category is a widening**, and it
   is the direction this pass would not take on its own. Every writer in this
   population passes the acting administrator's own member id as `memberId`, and
   `buildMemberVisibleAuditLogWhere` matches on it, so *any* such move at minimum
   publishes the row on the acting administrator's own activity page — and where
   `subjectMemberId` names a different member, it publishes to that member too.
   The member projection withholds metadata, request id, IP and drill-downs, but
   it returns `action`, `summary` and — whenever `details` is not a JSON object —
   `details` **verbatim**.

Retention is the third axis and it is quiet. `classifyAuditRetention` reads the
category, so a reclassification can silently change how long a row is kept.
Every verdict below states whether it does.

## Moved: 22 sites, `admin` → `lodge`

Both a **narrowing** on the AI Diagnostics axis and **retention-neutral**:
`classifyAuditRetention` returns `critical` (7 years) for all 22 under both the
old and the new category, measured rather than assumed. Neither category is
member-visible, so **no row reached a member who could not read it before**.

### Bed allocation — 21 sites

| File | Sites |
| --- | ---: |
| `src/app/api/admin/bed-allocation/allocations/bulk/route.ts` | 2 |
| `src/app/api/admin/bed-allocation/allocations/route.ts` | 2 |
| `src/app/api/admin/bed-allocation/auto-allocate/route.ts` | 1 |
| `src/app/api/admin/bed-allocation/beds/[id]/route.ts` | 2 |
| `src/app/api/admin/bed-allocation/beds/route.ts` | 1 |
| `src/app/api/admin/bed-allocation/rooms/[id]/route.ts` | 2 |
| `src/app/api/admin/bed-allocation/rooms/bulk/route.ts` | 1 |
| `src/app/api/admin/bed-allocation/rooms/import-from-config/route.ts` | 1 |
| `src/app/api/admin/bed-allocation/rooms/route.ts` | 1 |
| `src/app/api/admin/bed-allocation/settings/route.ts` | 1 |
| `src/lib/bed-allocation-approval.ts` | 1 |
| `src/lib/bed-allocation-manual-writes.ts` | 2 |
| `src/lib/bed-allocation-range-audit.ts` | 2 |
| `src/lib/bed-allocation-removal.ts` | 2 |

**Why.** This was the clearest violation in the repository, and it was written
down: the automatic path in `bed-allocation-lifecycle.ts` carried a comment
arguing that because "there is no acting member … this is a 'lodge' system event
rather than an 'admin' action". That is classification by initiator, and the
three admin-initiated writers of the **same action name** took it at its word.
`BED_ALLOCATION_PARTNER_PROMOTED` and `BED_ALLOCATION_PARTNERS_PROMOTED` were
each written into two different permission gates, with the same `entityType`,
the same `targetId` shape and near-identical summaries.

**What went wrong for a real person.** A Lodge Manager holding Support + Lodge
asked AI Diagnostics to correlate bed-allocation promotions for a night. The
Lodge entry read only `lodge`, so it returned the automatic promotions, omitted
every manual, bulk and range one, and reported that nothing else matched — an
answer that reads as a bounded absence rather than a partial one. A support-only
operator got the mirror image. Bed allocation is now wholly `lodge`: 28 sites,
one gate.

**Who loses.** A support-only operator, and a Booking Officer holding
`support` + `bookings` but not `lodge` — worth naming, because the routes that
*write* these rows are gated on `bookings:edit`, not `lodge:edit`. They keep full
access through Admin → Audit Log. The comment that caused the split has been
replaced with one that states the affected-domain reason instead.

### `LODGE_DISPLAY_CONFIG_UPDATED` — 1 site

`src/app/api/admin/display/lodge-config/route.ts`. The last writer under
`/api/admin/display/**` still saying `admin` while its ten siblings said
`lodge`. Nine of the ten siblings were among #2676's 82, so that sweep is what
turned a uniformly `admin` subsystem into a split one. An operator with Support +
Lodge could see every layout, template and device change for a misbehaving kiosk
but not the config change that caused it.

**The rule this was moved on, stated because other writers pass the same
surface tests and were NOT moved.** It is not "does it name a Lodge" and not "is
the route gated `lodge:edit`": `LODGE_CREATED`, `LODGE_UPDATED`,
`LODGE_SETTINGS_UPDATED` and `LODGE_INSTRUCTION_UPDATED` all carry
`entityType: "Lodge"` or sit on a `lodge:edit` route, and all of them stay
`admin`. The test is **whether the site split a subsystem** — whether some other
writer of the same objects already answered to a different gate, so that no
operator could get a complete answer. That was true here (ten `lodge` siblings,
one `admin`) and true of bed allocation (two action names written into two
gates). It is not true of the `LODGE_*` records-and-settings group, which is
uniform at `admin`: moving it is a readership change of its own size rather than
the closing of a split, and it is recorded as the open question below. The rule
is repeated in a comment at the writer so the next author does not have to find
this page.

## Rows already written: moved too, by #2751

**The 22 edits changed where the platform files a NEW row, and nothing more.**
`buildAuditCategoryWhere` (`src/lib/audit-query.ts`) ORs its legacy action-name
guess in only for rows whose `category` is NULL, so a bed-allocation row written
before that release carried a hard `"admin"`, matched neither
`{category: "lodge"}` nor the legacy `LODGE_`/`lodge` clause, and was returned
under the Admin filter alone. Bed-allocation evidence was therefore split by
**date** rather than by initiator: in Admin → Audit Log, filtering by Lodge got
rows from the release forwards and filtering by Admin got the older ones, with
neither answering a question that spanned the date; in AI Diagnostics the Lodge
entry returned the newer half and the System entry the older half.

**[#2751](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/2751) closed
that, and this is the shape of the fix.** One migration,
`prisma/migrations/20260810020000_backfill_bed_allocation_audit_category`, rewrites
`category` from `admin` to `lodge` on rows matched by an EXACT literal list of the
18 distinct action names these 22 sites write — never a prefix, which could not be
reviewed against the census and would sweep up whatever is added next. `category`
is the only column in the `SET` clause, so the date, the actor, the subject, the
summary, the stored details, `retentionClass` and `expiresAt` are all untouched;
the counts before and after are recorded as one `AUDIT_CATEGORY_BACKFILLED` row in
the club's own history; and the statement is idempotent, so it can be run again
after cutover for the rows the draining old colour wrote during the upgrade window.

Two things the backfill did **not** change, and both were checked in the code
rather than assumed:

- **Retention.** `pruneExpiredAuditLogs` and `archiveEligibleAuditLogs` select on
  the stored `retentionClass`, `expiresAt`, `severity`, `createdAt` and
  `archivedAt` columns and never read `category` at all — and
  `classifyAuditRetention` returns `critical` for every one of these actions under
  both values anyway, so no row's expiry moved in either direction and none was
  brought forward for deletion.
- **What a member sees.** Neither `admin` nor `lodge` is in
  `MEMBER_VISIBLE_AUDIT_CATEGORIES`, so no row crossed onto a member's own
  activity list, in either direction.

What the backfill **did** change is who can correlate the older rows in AI
Diagnostics, and it is the same narrowing this page's 22 moves applied to the new
ones: a Support-only operator, and a Booking Officer holding Support and Bookings
but not Lodge, lose them from the System entry and do not gain them in the Lodge
entry. Everyone with Support access still reads every one of those rows in full in
Admin → Audit Log, which is why this is a projection change rather than a loss of
evidence. Both correlation entries' `scope` and `description` are inverted to
match, and the pack test that used to pin the split now pins its absence.

The generalised rule this produced is **`INV-OPS-012`**: a pull request that
reclassifies an audit category either ships the backfill for the rows already
written or files it as an issue — never neither, and never as prose — and a
backfill that would cross the member-visible boundary in either direction needs
its own owner decision rather than following the rule automatically. It carries
the honest limit too, that only the pinned population can be checked
mechanically.

## Kept: 87 sites

Each group states the affected domain that makes `admin` right, and — where the
alternative reading is real — what taking it would have cost.

### Platform, club and section configuration — 20 sites

AI assistant and AI Diagnostics settings; club contact and club identity; module
toggles; member-field settings; notification delivery policies; admin
notification preferences; public-content settings; email message settings and
both email-template override writers; membership cancellation, lockout and
nomination settings; member-guest settings; internet-banking payment settings;
both booking-message override writers; `booking_request.settings_updated`.

**Kept because the affected domain *is* administration.** These change the club's
own configuration, not a booking, a member or a payment. This is what `admin`
means when it is not being used as a catch-all, and a taxonomy with no home for
"an administrator changed a platform setting" would need to invent one.

Three of these have a live alternative reading and were kept deliberately:

- **`INTERNET_BANKING_PAYMENT_SETTINGS_UPDATED`** could read as `payment`. It
  configures how money is taken, but takes none; `payment` is reserved for
  movements of money, which is what makes the Finance entry's answers about a
  charge trustworthy. The existing model-facing description already names this
  trap to operators.
- **The two booking-message writers and `booking_request.settings_updated`**
  could read as `booking`, and the booking-policy writers #2676 classified *did*
  go to `booking`. The distinction kept here is that a booking policy is a rule
  the booking engine evaluates, whereas message wording and request-form settings
  are presentation and workflow configuration. **This is the weakest keep on the
  page** and a reasonable reviewer could move all three; it is recorded as a
  judgement rather than a certainty.
- **The two email-template writers** could read as `communication`. They were
  kept because `communication` is member-visible and these writers pass the
  acting administrator's `memberId`, so moving them would publish template edits
  on that administrator's own activity page for no operator benefit.

### Access-role definitions — 3 sites

`src/app/api/admin/access-roles/**`. The affected object is the club's admin
permission model itself. `security` is the alternative and is retention-identical
(`sensitive_access`, 24 months, because the action contains the word "access")
and readable by the same `support:view` — but `security` **is** member-visible,
so the move would publish role-definition edits on the editing administrator's
activity page and buy nothing.

### Committee roles and assignments — 6 sites

`src/app/api/admin/committee/**`. Club governance structure. `account` was
considered for the assignment writers, since an assignment names a member; it was
rejected because the affected record is the committee, and `account` is
member-visible.

### Configuration import and export — 3 sites

`config-transfer/apply`, `config-transfer/export`, `src/lib/config-transfer/apply.ts`.
Whole-platform configuration movement. Unambiguously administration.

### Site content and presentation — 15 sites

Page content (4), site banners (3), site content, site style and logo (2), image
library (2), notices (3). The affected domain is the club's published content.
`communication` was considered for notices and rejected: the notice *record* is
content, and the notice *email* already writes `notice.emailSent` under
`communication` from `src/lib/notices-email.ts` — two events, correctly two
categories.

### Lodge-gated operational configuration — 15 sites

Chores (3), lockers (4), lodge instructions (2), lodge settings (1), the `LODGE_*`
lodge records themselves — `LODGE_CREATED` and the `LODGE_UPDATED` /
`LODGE_ACTIVATED` / `LODGE_DEACTIVATED` writer (2) — and work parties (3).

**Kept in this pass, but this is the group most likely to move next, and it is
recorded as an open question rather than a settled keep.** Every one of these
routes except lockers is gated on `lodge:*`, their affected objects are lodge
artefacts, and at least one has a sibling split of exactly the shape this pass
fixed elsewhere: `lodge.chore.completed` is written `lodge` from
`src/app/api/lodge/roster/[date]/route.ts`, while `CHORE_TEMPLATE_UPDATED` — the
change that alters the roster somebody is completing — is `admin`.

They were not moved here because no decision on #2730 covers them: the issue
named four defects and gave each a direction to tick, and moving fifteen more
sites out of the support-only gate is a readership change of its own size. It
would be a narrowing, member-invisible in both directions, and retention-neutral
(`critical` either way, and `locker.*` and `workparty.*` contain no access-event
word). The lockers writers are the odd ones out: their routes are gated
`membership:*` and a locker is allocated to a named member, so `lodge` is not
obviously their answer either.

**Both halves of that were decided on #2765 (11 August 2026), and the group is now
pinned per site.** The fifteen stay `admin` under the rule they were always
measured against — *did this site split a subsystem* — which is written down as
`INV-PRIV-013` and enforced by `LODGE_GATED_ADMIN_CATEGORIES_2765`
(`scripts/audit/audit-writer-census-manifest.ts`), measured from the tree, so a
third pass that disagrees fails CI instead of landing the change and finding the
argument afterwards. **`lockers` was decided for `membership`, the move was
refused on measurement — the intended destination turned out to be
member-visible, reaching the acting officer's own activity page — and the
question went back as its own filed decision, #2777, which the owner settled on
11 August 2026: the four stay `admin`.** The measurement, the declined
extend-the-taxonomy alternative and the accepted cost are recorded once, in
`INV-PRIV-013`, with the full option set on #2777 itself.

**Why `LODGE_DISPLAY_CONFIG_UPDATED` moved and `LODGE_UPDATED` did not**, since
both name a Lodge on a `lodge:edit` route: the display writer was closing a
**split** — ten siblings in the same subsystem already said `lodge` — whereas
this group is uniform at `admin`, so moving it would not remove a
two-gates-for-one-thing defect but open a new readership question. That is the
rule the whole pass ran on, and it is repeated in a comment at the display
writer.

**The cost while they stay here is a silent absence, and it is closed.** Before
this pass the Lodge correlation entry's `scope` named chores, lockers, work
parties and lodge settings as `admin` but not lodge instructions and not the
`LODGE_*` records — so "when was this lodge deactivated" returned nothing from
the Lodge entry with no warning that the answer was in another tool. Both
entries' `scope` and the Lodge entry's `description` now name the whole set.

### Induction templates — 4 sites

`src/app/api/admin/induction-templates/**`. The sibling reading is real —
induction *records* are `lodge` (`induction.ts`, `induction-baseline.ts`), and
both the support pack and the audit-log guide already warn operators that
induction is filed under `lodge` even though the screen sits under Membership.
Kept because the template is the club's induction *policy* document rather than
any lodge's operations, and because the routes are gated `membership:*`, so a
move to `lodge` would put the evidence behind a permission the people who create
it do not need. Grouped with the lodge-gated question above for whoever takes the
next pass.

### Calendar events — 4 sites

`src/app/api/calendar/events/**`. Club calendar administration, gated to calendar
managers. `calendar.event.join` mints a MiroTalk **host** credential, which makes
`security` arguable; it was kept because `security` is member-visible and the row
would then appear on the minting manager's own activity page.

### Membership types — 6 sites

Create, update, delete, reorder and merge. These are the club's membership
*product definitions* — price bands and eligibility rules — not any member's
membership. `account` would be wrong for that reason and member-visible besides.

### Member merge — 2 sites

`MEMBER_MERGED` and `MEMBER_MERGE_REFUSED` in `src/lib/member-merge.ts`. Kept,
and this one is pinned elsewhere: `INV-LIFE-083` records the refusal row as
`category admin, outcome blocked`, so moving it is a documented-invariant change
rather than a reclassification. The support pack's model-facing description also
names "member merges are recorded under admin" to stop an operator reading an
empty membership-entry result as absence.

### Member import and lodge access — 2 sites

- `member.imported` (`admin/members/import`): a bulk administrative import.
- `MEMBER_LODGE_ACCESS_UPDATED` (`admin/members/[id]/lodge-access`): **kept, with
  a retention reason.** The action contains the word "access", so
  `classifyAuditRetention` returns `sensitive_access` — 24 months — *because* the
  category is `admin`. Under `lodge` or `account` the same row becomes `critical`
  and is kept for **seven years**. Moving it is therefore a data-lifecycle change
  as well as a permission change, and needs to be decided as one.

(The third writer on this surface — the dynamic one in
`admin-member-detail-service.ts` — was moved out of this section on review. It is
**held for an owner decision** below.)

### Seasonal membership assignments — 4 sites

`src/lib/seasonal-membership-assignments.ts`. Bulk administrative assignment of
season membership tiers.

**Kept because the affected record is the club's seasonal roll-forward, not any
one member's account** — three of the four writers act on a whole season at once
and the fourth records one assignment inside that same mechanism. `account` is
the live alternative and is not dismissed lightly: `saveSeasonalMembershipAssignment`
carries `subjectMemberId`, so under `account` the row would appear on that
member's own activity page. That makes the move a **widening**, which is why it
is not taken here — but the domain argument above is the reason it is filed as
`admin`, not the fact that the support pack's model-facing description already
names it that way. (It does, and that description would need updating with any
move.) Grouped with the held decisions below for whoever takes the next pass.

### Xero member-import membership types — 1 site

`src/lib/xero-member-import.ts`. The affected object is the membership-type
catalogue the import creates, not the Xero link — `xero` would file a
membership-configuration change behind Finance.

### Analytics integration — 2 sites

`ANALYTICS_SETTINGS_UPDATED` and `ANALYTICS_CONSENT_REVISION_BUMPED`. `privacy`
is a genuine alternative — consent is the privacy domain (`INV-PRIV`) — but
`privacy` is member-visible and these rows carry no member subject, so the move
would publish a settings change on the acting administrator's activity page and
narrow the operator gate at the same time. Kept, and flagged as re-decidable.

## Held for an owner decision: 9 sites, of which 8 are still held

Two of #2730's own findings, plus one the sweep turned up, that this pass **did
not** apply. Every destination is member-visible, so each move publishes rows on
a member-facing surface. A widening is not a refactor and is not this lane's to
take.

**One of the three has since been resolved, and not by widening.** The
member-record writer below (`admin.member.*`, 1 site) was closed in #2755 by
moving the OTHER TWO writers of the same act — both branches of
`bulk-update/route.ts` — **into** `admin`, rather than by moving this one out.
The split is gone and nothing crossed onto a member-facing surface. Its section
below is kept and updated in place rather than deleted, because the comparison it
sets out is the reasoning, and the **eight** remaining held sites — the six
`member_lifecycle` sites and the two family-suggestion sites below — are still
held on exactly the grounds it states. `INV-PRIV-012` is the rule that came out of
it.

### `member_lifecycle.delete_*` and `archive_*` — 6 sites

`src/lib/member-lifecycle-actions.ts`. All six pass
`subjectMemberId: <the member being deleted or archived>`, so filing them under
`privacy` (or `account` for the archive trio) publishes them **to that member**,
not merely to the acting administrator. The row's `details` is `cleanedReason` —
free text an administrator wrote to justify the request — and the member
projection returns `details` verbatim whenever it is not a JSON object. The
acting administrator is rendered as "Club admin" only if their role is `ADMIN`;
any officer holding the permission through an access role is **named in full**.

The case for moving is strong and unchanged: the member-initiated equivalents
(`member.deletion_requested` / `_rejected` / `_approved`) are already `privacy`,
so the same act answers to two gates depending on who started it, and
`audit-query.ts` files `member_lifecycle.delete*` under `privacy` on the read
side in two places. It is also retention-neutral. But it is a widening, and it
wants the owner's explicit answer to a plain question: **should a member be able
to see, on their own activity page, that their deletion was requested, who
requested it, and the reason they gave?**

### `FAMILY_SUGGESTION_HIDDEN` and `FAMILY_SUGGESTIONS_RESET` — 2 sites

`admin/family-suggestions/hide` and `.../reset`. Checked at the writers as #2730
asked: `targetId` is a suggestion signature rather than a member id and
`subjectMemberId` is unset, so **no third-party member** is published to. But
both pass `memberId: guard.session.user.id`, which the member-timeline filter
matches, so moving them to `family` publishes each row on the **acting
officer's** own activity page. The names in the row travel in `metadata`, which
the member projection withholds. It is the smallest widening on this page and
still a widening.

### `admin.member.updated` / `.deactivated` / `.reactivated` — 1 site — RESOLVED in #2755

`src/lib/admin-member-detail-service.ts`. **Not one of #2730's four findings —
the sweep turned it up, and it was the weakest `admin` left in the tree.** It was
filed by the SCREEN the officer used, which is initiator reasoning wearing a
different hat:

| The same business act | Where #2730 left it | Where #2755 files it |
| --- | --- | --- |
| Deactivate one member from the member page | `admin` — this site | `admin` |
| Deactivate the same members from the bulk screen (`member.bulk-deactivate`) | `account` | `admin` |
| Change one member's access roles from the member page | `admin` — this site, as `admin.member.updated` | `admin` |
| Change the same roles from the bulk screen (`member.bulk-set-role`) | `security` | `admin` |
| The member edits the same profile fields themselves (`/api/profile`) | `account` | `account` — unchanged |

The comparison was inside the platform, not imported: `bulk-update/route.ts` set
out the rule in its own comment — the account itself is `account`, what a member
is permitted to do is `security` — and named picking by who acted as "the exact
thing the owner rule forbids". The consequence for a member was visible: they saw
a bulk deactivation on their own activity list and saw **nothing** when an
officer deactivated them from the member page.

**#2755 closed it by moving the bulk screen's two branches to `admin`, not by
moving this site out.** The rule is that category follows the business domain
affected, and editing, activating, deactivating or re-roling somebody's member
record is one domain: the administration of that record, however many screens
reach it. Both alternatives were member-visible and all three rows reach the
subject member's own timeline, so unifying on either would have published an
officer's edits **to the member the record is about** — and audit rows are
append-only, so that is not quietly reversible. (Only the detail writer passes
`subjectMemberId`; the two bulk writers pass none and reach the member through
`buildMemberAuditLogWhere`'s null-subject `targetId` leg. "Has no subject" is not
a reason to think a move is invisible.) Whether a member should see a given event
is meant to become an explicit per-event declaration at the writing site, denied
by default, rather than a consequence of which label a classification sweep
reached for — #2695 decided that on 9 Aug 2026 and it is **not built yet**, so in
the meantime the category is the only lever and these two events are simply
invisible to the member.

**The rule that came out of this is scoped to those six actions, not to "an
officer acted".** Other officer-driven writers file member-visible categories on
purpose and stay that way: the member-photo pair (#2581's own worked example,
`account` on the on-behalf branch deliberately — and the photo editor renders on
this very screen in `mode="admin"`) and the officer-driven cancellation writers.
`INV-PRIV-012` names them, and
`OFFICER_DRIVEN_MEMBER_VISIBLE_WRITERS_2755` pins them from the tree, so citing
the unification to sweep them into `admin` fails CI with the withdrawal named.

**The last row of the table did not move, deliberately.** `/api/profile` is the
member editing their own record: actor IS subject, no on-behalf path, so it is
self-service rather than administration. Filing it `admin` would hide a member's
own action from their own timeline. #2755's issue body listed it among the split
sites and gave an anchor (`api/admin/members/[id]/profile/route.ts`) that does not
exist in the tree; the `security` site it meant is the bulk screen's set-role
branch.

**What the resolution costs, since it is a narrowing in two directions.** The
subject member stops seeing a bulk deactivation or bulk role change of their own
account (they already saw nothing when an officer used the member page, so the
result is uniform invisibility rather than visibility decided by screen), and the
two bulk rows move from `support` + `membership` to `support` alone — the gate
this site has always answered to. Retention is untouched: all six action names
classify `critical` under the old and new values alike. And as with bed
allocation it moved the WRITERS, not the stored rows, so bulk member-record
evidence recorded before the release is still `account`/`security`, still in the
membership correlation entry and still on the member's own timeline. Both
correlation entries' prose says so. The backfill question is **#2763**, filed
separately from #2751 rather than folded into it: #2751's bed-allocation rows move
between two member-invisible categories, so no member's view changes either way,
while rewriting these rows would **withdraw** entries a member can see about their
own account today. That is a different decision, and it is the recommendation on
#2763 to leave them alone.

Pinned in `MEMBER_RECORD_ADMIN_CATEGORIES_2755` (per site),
`MEMBER_RECORD_ADMIN_ACTIONS_2755` (by action name, with one level of same-file
`const` indirection resolved and a corpus gate over every file that names one of
the six literals) and `MEMBER_RECORD_ADMIN_SURFACES_2755` (every member-visible
writer on the officer member-record surfaces must be a reviewed exception). So a
fourth screen for the same act fails CI if it reuses one of the six action names
however it assembles the string, or if it invents a new name on those surfaces and
files a member-visible category. What is still a review question rather than a
mechanical one is a new name for the same act written somewhere else entirely.
Rule: `INV-PRIV-012`.

## The open question this pass did not have a decision for

The **fifteen lodge-gated operational sites** in the keeps above (chores, lockers,
lodge instructions, lodge settings, the `LODGE_*` records, work parties) are
recorded as an open question rather than a settled keep, and the reasoning is in
that section. Moving them would be a **narrowing** — member-invisible in both
directions and retention-neutral — which is a materially easier question than the
three widenings above, but it is still fifteen more sites out of the support-only
gate and no ticked option on #2730 covers it.

While they stay `admin`, the model-facing prose has to say so or an empty lodge
correlation reads as absence: the Lodge entry's `scope` and `description` both
name chores, lockers, work parties, lodge instructions, lodge settings **and the
lodge records themselves** as `admin`, and the System entry's `scope` names the
same set. That was a real gap — "when was this lodge deactivated" returned
nothing from the Lodge entry with no warning — and it is fixed whichever way the
decision goes.

**#2765 closed this open question, and the answer was "they stay".** The rule that
decided it is now `INV-PRIV-013` and the fifteen are pinned per site in
`LODGE_GATED_ADMIN_CATEGORIES_2765`, so the keep is enforced rather than argued
each time. `lockers` was the one subgroup that needed its own decision, for a
measured reason rather than a stylistic one; it was carried as a filed decision
(**#2777**) rather than as an open question on a page, and decided on 11 August
2026: the four stay `admin` — see the section above. Read the two paragraphs
below as the history of how it got there.

**#2755 promoted both halves of that from a page note to an invariant, and left
them at `admin`.** `INV-PRIV-012` records the fifteen as a deliberate keep with
the rule they were measured against — *did this site split a subsystem*, not *does
it name a lodge* and not *is the route gated `lodge:edit`* — and records that
`lockers` (4 of the fifteen) was, at that point, **unresolved rather than settled**, because its
routes are gated `membership:*` and a locker is allocated to a named member, so
`lodge` is not obviously its answer either. The point of moving it into the
invariant is that a decision recorded only in a page attached to a closed issue is
a decision the next author will not find; the fifteen were nearly re-swept twice
already. The census distribution alone cannot protect them — it counts `admin`
without saying which sites are in it — so if a later pass moves any of them, that
is a readership change to argue for and the invariant is where the argument has to
land.

## How to check this page is still true

`npm run audit:census` prints the live distribution, and
`src/lib/__tests__/audit-writer-census.test.ts` fails CI if it moves without the
manifest moving with it. The numbers this page was written against:

```
row-producing sites:  455
uncategorised:        0
category values: admin 104, booking 101, xero 34, family 35, payment 37,
                 lodge 65, account 19, security 22, privacy 19,
                 communication 14, system 4
```

`admin` was 96 when this page was written for #2730 (87 kept + 9 held) and is 98
after #2755 moved the two `bulk-update/route.ts` branches in, against `account`
20 → 19 and `security` 19 → 18. #2755 moved categories and added no writer;
#2760 then added the late-capture auto-refund record writer (`payment` 34 → 35),
taking the total from 428 to 429. Since then #2749 added the three Other Lodges
admin CRUD writers (`admin` 98 → 101, 429 → 432) and #2773/#2774 added the two
late-capture writers this page's own subject depends on (`payment` 35 → 37,
432 → 434). Since then #2822 added the email-inheritance effective-source change
event (`family` 34 → 35, 434 → 435). Since then four separate changes landed on top of 435 and they
are DISJOINT, so the merged figure is the sum of all of them rather than either
branch's own total. The Alpine Central Server integration (PR #21) added four:
the manual Other Clubs upload and download plus the shared sync-failure row
(`lodge` 52 → 55) and the connection-settings save (`admin` 101 → 102), taking
435 → 439. The #2949 review added the refused-base-URL-change record
(`security` 18 → 19, 439 → 440). Local database backups added three
(`security` 19 → 22, 440 → 443): a restore over the live database records
started, completed AND failed, because the row written before the attempt is the
only one guaranteed to survive a restore that dies part-way — which is exactly
the incident someone would need to reconstruct. And #2780 added the ten
maintenance-report writers (`lodge` 55 → 65, 443 → 453). Since then CT-1
(#2989) added the club-timezone change record (`admin` 102 → 103, 453 → 454) —
one writer, because the timezone change is a single audited event and a
re-save of the unchanged zone deliberately records nothing at all. Since then
ENV-SAFETY 1 (#3034) added the environment-safety override record
(`admin` 103 → 104, 454 → 455) - again one writer, and again a no-op
records nothing, because that route's dirty gate counts an absent settings row
as "override off". That is the figure above, and it was taken from
`npm run audit:census` on the merged tree rather than by adding one branch's
delta to the other's total. The category values sum to 454 rather than 455
because one site forwards its category rather than naming one.

The 22 moves are pinned **per site**, not only by that
distribution: `REVIEWED_ADMIN_CATEGORIES_2730` in
`scripts/audit/audit-writer-census-manifest.ts` records each one, and the census
contract test measures the tree against it. A distribution cannot see a swap —
send one of these back to `admin` and one `admin` site into `lodge` and every
count is identical while both rows change who may read them — so the per-site pin
is what makes a reversal a named diff. The same test asserts that none of the 22
lands in a member-visible category, which is the property that made the move a
narrowing rather than a decision for the owner.

The sentences that tell the model where bed-allocation history lives are pinned in
`src/lib/diagnostics/tools/packs/__tests__/support-correlation.test.ts` ("tells the
model that bed allocation is WHOLLY lodge now, older rows included"). They were
pinned in the opposite direction while the date split was real, and #2751 inverted
them in the same change that closed it — a reclassification that shipped no
backfill would put the overclaim straight back. The backfill's own action list is
pinned against `REVIEWED_ADMIN_CATEGORIES_2730` by
`src/lib/__tests__/bed-allocation-audit-category-backfill.test.ts`, so a 23rd
bed-allocation writer added here cannot re-open the split silently (`INV-OPS-012`).
