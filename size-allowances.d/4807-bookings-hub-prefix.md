# File-size allowances for the Bookings hub move (#4807)

Each of these files links a Bookings page, and now takes that link from the
hub registry (`adminHref`) instead of writing the URL by hand, so the link
follows the page when the switch goes on. The only growth in each is the one
line that imports `adminHref`; the links themselves stay the same length.

file: src/app/(admin)/admin/booking-desk/bookings/page.tsx
lines: 835
reason: one import line, so the page's own address and its links come from the
  hub registry. Splitting the bookings list is a refactor of its own and would
  not shrink this hunk.

file: src/app/(authenticated)/book/_hooks/use-booking-wizard.ts
lines: 2335
reason: one import line, so finishing the wizard opens Book on Behalf from the
  hub registry. Lifting the wizard out is a refactor of its own and would not
  shrink this hunk.

file: src/components/admin/booking-bed-allocation-panel.tsx
lines: 1111
reason: one import line, so the allocation board link comes from the hub
  registry. The link sits beside the booking it opens the board for.

file: src/components/admin/booking-requests/policy-exception-requests-panel.tsx
lines: 1015
reason: one import line, so the panel's address comes from the hub registry.
  Splitting the exception queue is a refactor of its own and would not shrink
  this hunk.

file: src/components/admin/booking-requests/public-booking-requests-panel.tsx
lines: 2722
reason: one import line, so the panel's address comes from the hub registry.
  Splitting the public-requests queue is a refactor of its own and would not
  shrink this hunk.

file: src/lib/xero-record-activity.ts
lines: 820
reason: one import line, so the Bookings links on a Xero record come from the
  hub registry. The links sit on the activity rows they explain.
