# File-size allowances for CT-4 group D (#2870) — admin pages on club time

Every entry below is the same change: a screen that was reading dates and times
through the environment's timezone now reads them through the club's persisted
one, or — where what it holds is a calendar date — through no timezone at all.

The growth is not new behaviour. It is an import pair, a hook read, and a
sentence or two saying WHICH of the two temporal concepts a given value is,
because confusing them is the defect this epic exists to close and the
distinction is invisible in the code without it. Where a file grew by more than
a few lines, the reason says what the extra lines are.

Splitting any of these page shells is a real refactor with its own review, and
none of them would be made shorter by it — the hunks are spread through the
render rather than concentrated in an extractable section.

file: src/app/(admin)/admin/audit-log/page.tsx
lines: 1101
reason: the audit stamp keeps its seconds-bearing shape (owner decision, #2264),
  which is not one of the kernel's house shapes — so the formatter stays here,
  and because the club's zone now reaches the browser as data rather than as a
  build-time constant it is memoised per zone instead of frozen at module
  scope. That is the whole increase. Splitting the audit console is a refactor
  of its own and would not shrink this hunk.
  #3123 adds ONE line, and it is a comment correction rather than code. The
  owner decision recorded above names `formatNZDateTime` as the shape not to
  migrate to, and this branch retires that helper — so the note now names its
  successor and keeps the old name in parentheses, because a decision recorded
  against a symbol that no longer exists is a decision nobody can look up.

file: src/app/(admin)/admin/backups/backups-client.tsx
lines: 851
reason: one import pair, two hook reads, and a sentence saying the backup stamps
  are instants rather than lodge nights. The card boundaries here are already
  the natural split.

file: src/app/(admin)/admin/bed-allocation/page.tsx
lines: 1961
reason: the board's opening night now comes from the club's day rather than the
  operator's browser, and the note explaining why is worth more than the four
  lines it costs. The date arithmetic it replaces got shorter; the growth is
  comment.

file: src/app/(admin)/admin/book/page.tsx
lines: 1491
reason: the retroactive-stay rule was reading the BROWSER's calendar day, which is
  a live defect for an admin abroad, and the lodge-night formatters beside it
  were projecting calendar dates through a zone. Both are explained where they
  are, because the next person to touch this page needs to know which of its
  dates are days and which are moments. Splitting a 1,491-line booking form is
  a separate job with its own review.

file: src/app/(admin)/admin/bookings/page.tsx
lines: 756
reason: this page renders a calendar date and an instant in adjacent columns and
  used to treat them alike; the docblock on `stayDay` is what stops the next
  edit merging them again. The night count also moved off a millisecond
  division onto calendar arithmetic.
  CT-4 REVIEW: the consent chip's response stamp beside them was still
  `APP_TIME_ZONE`'s, reached through a shared helper that pins the zone at
  module scope. Its year-less shape is locked to the signed-off #2307 mockups
  and is not a kernel house shape, so it is rebuilt here, memoised per zone, the
  way the audit console builds its own — thirty lines, most of them the note
  saying why the two dates three lines apart are different kinds of thing.

file: src/app/(admin)/admin/config-transfer/page.tsx
lines: 649
reason: four lines: the club's day for the export filename, and why it is not the
  operator's.

file: src/app/(admin)/admin/dashboard/page.tsx
lines: 906
reason: `getStats` now derives its month bounds with calendar arithmetic instead of
  string slicing plus `Date.UTC(y, m + 1, 0)`, and says which of the values it
  hands Prisma are date-only bounds and which are instants. The dashboard's
  seam is `getStats` itself, which this change is inside.

file: src/app/(admin)/admin/deletion-requests/deletion-requests-client.tsx
lines: 1493
reason: two hook reads and one sentence; the four stamps this page renders are all
  instants and now say so.

file: src/app/(admin)/admin/display/devices/page.tsx
lines: 536
reason: one import pair, one hook, one sentence about `lastSeenAt`.

file: src/app/(admin)/admin/display/setup/display-wizard-steps.tsx
lines: 1449
reason: the pairing-code expiry and the last-seen stamp are instants in two
  different wizard steps, so each step takes its own binding.

file: src/app/(admin)/admin/fees/_components/hut-fees-section.tsx
lines: 958
reason: a season edge is a calendar date and was being projected through a zone;
  the shared explanation sits once at the top of the file rather than at each
  of the three call sites.

file: src/app/(admin)/admin/hut-leaders/page.tsx
lines: 1179
reason: the two clock reads moved onto the club's zone, and the import block now
  states plainly which of the remaining date helpers are zone-free arithmetic
  and why they stay — without that, the next reader has to work out for
  themselves whether the file is half-migrated.

file: src/app/(admin)/admin/image-manager/image-manager-client.tsx
lines: 731
reason: one import pair, one hook, one sentence about the file modification time.

file: src/app/(admin)/admin/lodge/page.tsx
lines: 562
reason: one hook read and one sentence, inside the account card that renders the
  created and updated stamps.

file: src/app/(admin)/admin/member-applications/page.tsx
lines: 814
reason: a family member's DATE OF BIRTH shared a formatter with the submission and
  review INSTANTS, so one of the two was always wrong; the split is the fix and
  the docblock on each half is what keeps them apart. A birthday rendered a day
  early is a named regression anchor on this issue.

file: src/app/(admin)/admin/membership-cancellations/page.tsx
lines: 1216
reason: one import pair, one hook, and the shared note on the stamp formatter.

file: src/app/(admin)/admin/membership-types/page.tsx
lines: 1858
reason: SUPERSEDED IN PLACE. Group D added a twelve-line note recording why the
  season-year derivation was left on its host-local clock; CT-4 group F1 has since
  migrated it to `clubSeasonYear(clubTime.zone)` and replaced that note with a
  shorter one, so the file is now SHORTER than this allowance was written for. Kept
  rather than deleted so the number stays true to the tree, and corrected so the
  prose does not assert a decision that has been reversed on purpose.

file: src/app/(admin)/admin/mountain-conditions/_components/mountain-conditions-panel.tsx
lines: 903
reason: the fetch, freeze and update stamps are instants; the formatter takes the
  club binding and the parse is now guarded, which is what stops one bad
  payload blanking the panel.

file: src/app/(admin)/admin/payments/page.tsx
lines: 1305
reason: two adjacent columns, one an instant read host-locally by date-fns and one
  a calendar date, both rendering the same shape and neither saying which was
  which. The comment between them is the point of the change.

file: src/app/(admin)/admin/promo-codes/promo-redemptions-panel.tsx
lines: 807
reason: the hand-rolled parts-to-UTC-midnight dance is gone and the export
  filename now carries the club's day; the note explains why a lodge night
  needs no zone at all.
  CT-4 REVIEW: the on-screen "Redeemed" stamp still went through the CSV
  module's environment-zone formatter while this same hunk had already moved
  the export FILENAME onto the club's day. It reads the club's zone now, and the
  note records the one half that cannot be fixed from here — the CSV cell
  formats internally and would need a `src/lib` signature change.
  #3123 adds six, and they close the half the CT-4 review note above says
  cannot be fixed from here. `buildPromoRedemptionsCsvContent` takes the
  club-time binding now, so the CSV's own "Redeemed" cell is on the club's
  persisted zone like the filename and the on-screen stamp already are. The
  growth is the two-line comment and the call going multi-line; the `src/lib`
  signature change that note said would be needed is what this issue made.

file: src/app/(admin)/admin/refund-requests/page.tsx
lines: 885
reason: a booking's check-in and the request's review stamp are different concepts
  and now have different helpers, each with a sentence saying so.

file: src/app/(admin)/admin/reports/page.tsx
lines: 740
reason: the range bounds come from the URL and used to reach date-fns through a
  local-midnight parse that threw a RangeError on a malformed one, blanking the
  report; the replacement is guarded and says why the encoding it builds is
  host-local on purpose.
  CT-4 REVIEW: the printed range bounds were on a date-fns `"d MMM yyyy"`
  pattern, which IS the house medium shape — and a pattern string hard-codes
  English month names where the kernel formats through `APP_LOCALE`. They move
  onto `formatClubDate` (byte-identical for `en-NZ`), which also settles a
  contradiction this change had otherwise shipped: two other pages in it had
  already moved that exact shape. The growth is the docblock stating the rule
  and naming which patterns stay on date-fns and why.
  #3123 adds two: `generateReportPDF` takes the club binding, so the exported
  report's cover date and filename day come from the club's persisted zone
  rather than the container's. This component already held the binding, so the
  cost is one argument and the two-line note saying what it decides.

file: src/app/(admin)/admin/roster/page.tsx
lines: 586
reason: the roster's opening day moved onto the club's zone, and the long-date
  heading is now pinned to UTC over the date-only encoding — an identity for
  every club rather than a projection. The note explaining that pin is most of
  the growth.

file: src/app/(admin)/admin/subscriptions/page.tsx
lines: 845
reason: `paidAt` was read with host-local getters, and that part is group D's.
  SUPERSEDED IN PLACE for the rest: group D's addition was a note explaining why the
  season-year derivation beside it was deliberately not moved, and CT-4 group F1 has
  moved it. This file carried a LOCAL `getSeasonYear` — host-local getters AND a
  hard-coded April, at module scope in a `"use client"` file, which group D
  correctly identified as two problems rather than one. Both are closed: the
  derivation is now `clubSeasonYear(clubTime.zone)` inside the component, so it uses
  the persisted zone and follows the configurable year-end. The note that remains
  records what was wrong and what the measurement was, because that is the part a
  future reader needs; the note explaining why it was left is gone with the reason
  for it.

file: src/app/(admin)/admin/waitlist/page.tsx
lines: 1014
reason: the offer-expiry and delivery stamps run through three module-level
  helpers, each of which now takes the club binding.

file: src/app/(admin)/admin/work-parties/page.tsx
lines: 598
reason: five lines, all comment: the stored day is rendered as itself and no longer
  projected through the environment zone.

file: src/app/(admin)/admin/xero/_components/health-diagnostics-panel.tsx
lines: 726
reason: this panel renders a stay's calendar dates and the booking's creation
  instant on adjacent lines, which is exactly the pair the epic exists to tell
  apart, so the explanation belongs where they are. Four components in the file
  each take their own binding.

file: src/app/(admin)/admin/xero/member-grouping/page.tsx
lines: 698
reason: one import pair, one hook read, and a sentence naming the cache-refresh
  stamp as an instant. Three lines, and no seam here that a split would follow.

file: src/app/(admin)/admin/family-groups/page.tsx
lines: 871
reason: CT-4 REVIEW found this page unmigrated: the partner-invite expiry and the
  group creation stamp are real instants and were rendered through a shared
  helper pinned to `APP_TIME_ZONE`. Eight lines — one hook read, one import pair
  and a note — for a screen whose own existing comment already calls a
  misread expiry "a real operational hazard". Splitting an 871-line queue page
  is a separate refactor and would not shrink this hunk.

file: src/app/(admin)/admin/members/[id]/page.tsx
lines: 1352
reason: two lines. `lifeMemberDate` is a `@db.Date` calendar day and was going
  through the member-detail INSTANT formatter, so a club behind UTC named the
  day before someone became a life member. The change is the decoder swap plus
  the sentence saying which of the two kinds this field is.
