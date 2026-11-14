# Size allowances for #5102

file: src/app/(authenticated)/dashboard/page.tsx
lines: 1006
reason: adds heading levels and tab-title metadata to member screens, plus new
  layout files; those lines sit inside this file, which was already over its
  limit before this change, and lifting it apart is a refactor of its own, not
  part of this fix.

function: src/app/(public)/pay/[token]/page.tsx#PayByLinkPage
lines: 436
reason: adds heading levels and tab-title metadata to member screens, plus new
  layout files; those lines sit inside the function `PayByLinkPage`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.

function: src/app/(website-dynamic)/booking-requests/booking-request-form.tsx#BookingRequestForm
lines: 454
reason: adds heading levels and tab-title metadata to member screens, plus new
  layout files; those lines sit inside the function `BookingRequestForm`,
  which was already over its limit before this change, and lifting it apart is
  a refactor of its own, not part of this fix.

function: src/app/(website-dynamic)/join/[code]/member-group-join-panel.tsx#MemberGroupJoinPanel
lines: 371
reason: adds heading levels and tab-title metadata to member screens, plus new
  layout files; those lines sit inside the function `MemberGroupJoinPanel`,
  which was already over its limit before this change, and lifting it apart is
  a refactor of its own, not part of this fix.

function: src/app/(website-dynamic)/school-bookings/school-booking-form.tsx#SchoolBookingForm
lines: 503
reason: adds heading levels and tab-title metadata to member screens, plus new
  layout files; those lines sit inside the function `SchoolBookingForm`, which
  was already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.
