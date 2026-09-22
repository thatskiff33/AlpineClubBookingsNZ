# File-size allowances for #3565 — the club-format kernel's first server group

Six already-over-budget files grow, by thirteen lines between them. Every one of
those lines is the same line: **the club's format, obtained once at the top of
the request or render, so that everything below renders through it** —
`const money = await clubFormat();` in five of them, and one extra threaded
argument where a local helper does the rendering.

That is exactly the shape the club-time kernel established in the same files
(`const club = await clubTime();`), and it has no seam available. The binding has
to be taken where the request is, which is the function these files already open
with; lifting it into a helper would put the resolution somewhere a reviewer
cannot see it and would defeat the request-scoped `cache()` that makes one read
serve the whole page.

No split was taken because none of these files is over budget *for this reason*.
Each carries pre-existing debt of hundreds of lines — the admin bookings list and
the member dashboard are each three to four times their ceiling — and splitting
one of them is its own change with its own review, not something to attach to a
migration that adds one line to it.

file: src/app/(admin)/admin/bookings/page.tsx
lines: 834
reason: one line — the club's format, bound beside the club's time binding the
  file already opens with. There is no seam: both have to be resolved inside the
  page function, which is where the request is.

file: src/app/(authenticated)/dashboard/page.tsx
lines: 989
reason: the binding, plus the promo-benefit helper gaining the format as an
  argument. That helper renders two amounts and is called once; threading it is
  what keeps the helper pure and testable instead of making it reach for a
  server read of its own.

file: src/app/(authenticated)/profile/page.tsx
lines: 680
reason: the same pair as the dashboard above, for the same reason — the binding
  and the promo-benefit helper's new argument.

file: src/app/api/admin/bookings/[id]/mark-paid/route.ts
lines: 255
reason: the binding, plus the format threaded into the two note builders that
  write the admin's toast. Those builders are deliberately outside the handler
  so the sentences they compose can be read on their own, and a parameter is the
  only way to reach them without giving each a server read.

file: src/app/api/admin/refund-requests/[id]/route.ts
lines: 474
reason: one line — the binding, taken beside the params the handler already
  awaits. Three refund amounts below it render through it.

file: src/app/api/bookings/[id]/refund-request/route.ts
lines: 260
reason: one line — the binding, for the two amounts the refund appeal reports
  back to the member.
