# Size allowances for #5102

file: src/app/(authenticated)/dashboard/page.tsx
lines: 1006
reason: adds the `metadata` export that gives the page its tab title and a
  heading level to each card title declared in the page. Both sit inside this
  file, which was already over its limit before this change; lifting it apart
  is a refactor of its own, not part of this fix.

function: src/app/(public)/pay/[token]/page.tsx#PayByLinkPage
lines: 429
reason: adds the sr-only h1 for the loading state, heading levels on its card
  titles (the redirect-return answer card included) and the one shared heading
  constant. Those lines sit inside `PayByLinkPage`, which was already over its
  limit before this change; lifting it apart is a refactor of its own, not
  part of this fix.

function: src/app/(website-dynamic)/booking-requests/booking-request-form.tsx#BookingRequestForm
lines: 454
reason: marks two card titles `headingLevel="none"`, each with a comment
  saying why: the form is also embedded in CMS pages, so its place in the
  outline varies by caller. Those lines sit inside `BookingRequestForm`, which
  was already over its limit before this change; lifting it apart is a
  refactor of its own, not part of this fix.

function: src/app/(website-dynamic)/join/[code]/member-group-join-panel.tsx#MemberGroupJoinPanel
lines: 371
reason: adds an sr-only h1 for the loading state and level 1 to two card
  titles, because the page has no h1 of its own in any state. Those lines sit
  inside `MemberGroupJoinPanel`, which was already over its limit before this
  change; lifting it apart is a refactor of its own, not part of this fix.

function: src/app/(website-dynamic)/school-bookings/school-booking-form.tsx#SchoolBookingForm
lines: 503
reason: marks two card titles `headingLevel="none"`, each with a comment
  saying why: the form is also embedded in CMS pages, so its place in the
  outline varies by caller. Those lines sit inside `SchoolBookingForm`, which
  was already over its limit before this change; lifting it apart is a
  refactor of its own, not part of this fix.
