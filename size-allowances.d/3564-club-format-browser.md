# File-size allowances for #3564

Stage 2 of programme #3205 moves ten `"use client"` modules off the build-time
`APP_CURRENCY` / `APP_LOCALE` constants and onto a provider. Five of the files
it touches were already over budget, and each grows by the hook read plus the
comment saying why the read moved. Every one of those comments is the answer to
"why does this component take its currency from a context?", which is a
question asked at the read, so it is written at the read.

The growth is a handful of lines each and none of it is new logic. Splitting
any of these files would be a refactor of a 1,000-to-2,600-line admin surface
undertaken to accommodate a one-line change, which is the trade the allowance
directory exists to refuse.

`src/app/display/display-screen.tsx` deliberately does NOT appear here. It sat
at exactly its 700-line ceiling, and an allowance cannot carry a file over its
budget for the first time, so the club-format mount that would naturally live
in it was put in `src/app/display/page.tsx` instead — a fifty-line server
component with room, and the same file that already resolves the values. That
is recorded in both files, because a reader arriving at `DisplayScreen` will
otherwise wonder why the format provider is somewhere else.

file: src/app/(admin)/admin/audit-log/page.tsx
lines: 1123
reason: the audit formatter is memoised in a module-level Map keyed by zone,
  and #3564 makes the key the locale/zone PAIR because two clubs can share a
  zone and differ in locale. That is a correctness trap worth a comment at the
  cache, and the formatter cannot move out of this file without taking the
  timeline row that calls it.

file: src/app/(admin)/admin/fees/_components/hut-fees-section.tsx
lines: 1274
reason: one hook read at the top of the section component and the comment
  explaining that the nightly-rate labels now follow the recorded setting.
  The labels are inline in the form they belong to, so there is nothing here
  to lift out that would not separate a label from its input.

file: src/app/(admin)/admin/promo-codes/promo-codes-page-client.tsx
lines: 1764
reason: one hook read and its comment, feeding three currency labels inside
  the promo create/edit form. The alternative is threading a prop through a
  form that is already one component, which trades four lines here for a
  parameter on every intermediate render.

file: src/app/(admin)/admin/promo-codes/promo-redemptions-panel.tsx
lines: 815
reason: `formatCount` is a plain helper outside any component, so the locale
  becomes a parameter rather than a hook read, and the comment records why
  the grouping stopped following the build. Both belong at the helper.

file: src/components/admin/booking-requests/public-booking-requests-panel.tsx
lines: 2661
reason: one hook read at the top of the panel and its comment, for the single
  currency label on the school-quote total. This file is already the largest
  admin surface in the tree and splitting it is a lane of its own, not a
  side-effect of moving one label onto a context.
