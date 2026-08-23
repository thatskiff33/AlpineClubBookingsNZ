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
lines: 1100
reason: the audit stamp keeps its seconds-bearing shape (owner decision, #2264),
  which is not one of the kernel's house shapes — so the formatter stays here,
  and because the club's zone now reaches the browser as data rather than as a
  build-time constant it is memoised per zone instead of frozen at module
  scope. That is the whole increase. Splitting the audit console is a refactor
  of its own and would not shrink this hunk.

file: src/app/(admin)/admin/backups/backups-client.tsx
lines: 851
reason: one import pair, two hook reads, and a sentence saying the backup stamps
  are instants rather than lodge nights. The card boundaries here are already
  the natural split.

file: src/app/(admin)/admin/bed-allocation/page.tsx
lines: 1959
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
lines: 728
reason: this page renders a calendar date and an instant in adjacent columns and
  used to treat them alike; the docblock on `stayDay` is what stops the next
  edit merging them again. The night count also moved off a millisecond
  division onto calendar arithmetic.

file: src/app/(admin)/admin/config-transfer/page.tsx
lines: 647
reason: four lines: the club's day for the export filename, and why it is not the
  operator's.

file: src/app/(admin)/admin/dashboard/page.tsx
lines: 895
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
lines: 1176
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
lines: 1865
reason: no code changed here. The addition is a twelve-line note recording why the
  season-year derivation was left on its host-local clock — a measured
  decision, not an oversight, and this epic has already fixed the same thing
  the wrong way once.

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

file: src/app/(admin)/admin/promo-codes/promo-codes-page-client.tsx
lines: 1756
reason: one line. The two promo-window decoders collapsed onto the shared payload
  decoder, which is a net simplification of this file rather than an addition
  to it; there is nothing here that splitting would help.

file: src/app/(admin)/admin/promo-codes/promo-redemptions-panel.tsx
lines: 782
reason: the hand-rolled parts-to-UTC-midnight dance is gone and the export
  filename now carries the club's day; the note explains why a lodge night
  needs no zone at all.

file: src/app/(admin)/admin/refund-requests/page.tsx
lines: 885
reason: a booking's check-in and the request's review stamp are different concepts
  and now have different helpers, each with a sentence saying so.

file: src/app/(admin)/admin/reports/page.tsx
lines: 712
reason: the range bounds come from the URL and used to reach date-fns through a
  local-midnight parse that threw a RangeError on a malformed one, blanking the
  report; the replacement is guarded and says why the encoding it builds is
  host-local on purpose.

file: src/app/(admin)/admin/roster/page.tsx
lines: 592
reason: the roster's opening day moved onto the club's zone, and the long-date
  heading is now pinned to UTC over the date-only encoding — an identity for
  every club rather than a projection. The note explaining that pin is most of
  the growth.

file: src/app/(admin)/admin/subscriptions/page.tsx
lines: 821
reason: `paidAt` was read with host-local getters. The rest of the addition is the
  note recording why the season-year derivation beside it was deliberately not
  moved, which is the more useful half for whoever picks that up.

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

