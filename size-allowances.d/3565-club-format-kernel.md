# File-size allowances for #3565 — every formatter takes the club's format

Stage 3 of programme #3205 makes the club's format a REQUIRED argument of every
money rendering, by the owner's decision of 23 Sep 2026, and moves all 528 call
sites in one change. 76 files that were already over their budgets grow
by between one and twenty-nine lines each, and every one of those lines is the
same line in one of three spellings:

- **a server entry point** — route handler, server page, cron, webhook or
  script — takes `const format = await clubFormatValues();` once, at the top,
  before any transaction or lock, and passes it down;
- **a browser component** takes `const format = useClubFormat();` at the top of
  the component that renders, because a hook can live nowhere else;
- **a library module, email template or Xero text builder** gains a
  `format: ClubFormat` parameter so that it never reads the setting for itself.

That is the shape the club-time kernel established in the same files, and it
has no seam: the binding has to be taken where the request is, and the parameter
has to be on the function that renders. Lifting either into a helper would put
the resolution somewhere a reviewer cannot see it, defeat the request-scoped
`cache()` that makes one read serve a whole page, and — for the parameter — hide
from the compiler exactly the argument it now proves is present everywhere.

No split was taken because none of these files is over budget *for this
reason*. Each carries pre-existing debt of hundreds of lines, and splitting any
one of them is its own change with its own review, not something to attach to a
migration that adds an argument to it.

file: src/app/(admin)/admin/bookings/page.tsx
lines: 834
reason: 1 line: `const money = await clubFormat()` once at the top of the page, beside
  the club-time binding it already opens with, and `money.cents(...)` or the
  bound format threaded to each amount and local helper below it. The binding
  has to be taken where the request is, which is this page; lifting it out
  would lose the request-scoped memo. The debt here predates this change.

file: src/app/(authenticated)/dashboard/page.tsx
lines: 989
reason: 5 lines: `const money = await clubFormat()` once at the top of the page, beside
  the club-time binding it already opens with, and `money.cents(...)` or the
  bound format threaded to each amount and local helper below it. The binding
  has to be taken where the request is, which is this page; lifting it out
  would lose the request-scoped memo. The debt here predates this change.

file: src/app/(authenticated)/profile/page.tsx
lines: 680
reason: 2 lines: `const money = await clubFormat()` once at the top of the page, beside
  the club-time binding it already opens with, and `money.cents(...)` or the
  bound format threaded to each amount and local helper below it. The binding
  has to be taken where the request is, which is this page; lifting it out
  would lose the request-scoped memo. The debt here predates this change.

file: src/app/api/admin/bookings/[id]/mark-paid/route.ts
lines: 255
reason: 4 lines: `const money = await clubFormat()` once at the top of the handler, beside
  the club-time binding it already opens with, and `money.cents(...)` or the
  bound format threaded to each amount and local helper below it. The binding
  has to be taken where the request is, which is this handler; lifting it out
  would lose the request-scoped memo. The debt here predates this change.

file: src/app/api/admin/refund-requests/[id]/route.ts
lines: 475
reason: 2 lines: `const money = await clubFormat()` once at the top of the handler, beside
  the club-time binding it already opens with, and `money.cents(...)` or the
  bound format threaded to each amount and local helper below it. The binding
  has to be taken where the request is, which is this handler; lifting it out
  would lose the request-scoped memo. The debt here predates this change.

file: src/app/api/bookings/[id]/refund-request/route.ts
lines: 260
reason: 1 line: `const money = await clubFormat()` once at the top of the handler, beside
  the club-time binding it already opens with, and `money.cents(...)` or the
  bound format threaded to each amount and local helper below it. The binding
  has to be taken where the request is, which is this handler; lifting it out
  would lose the request-scoped memo. The debt here predates this change.

file: src/app/(admin)/admin/book/page.tsx
lines: 1686
reason: 2 lines: `useClubFormat()` at the top of each component that renders an amount, and
  the club's format on every formatter call beneath it, including the module-level
  helpers that build amount strings, which take `format` rather than a hook they
  cannot call. A hook has to sit in the component that renders, so there is no
  seam to lift it through; the file was far over budget before this change.

file: src/app/(admin)/admin/fees/_components/hut-fees-section.tsx
lines: 1275
reason: 1 line: `useClubFormat()` at the top of each component that renders an amount, and
  the club's format on every formatter call beneath it, including the module-level
  helpers that build amount strings, which take `format` rather than a hook they
  cannot call. A hook has to sit in the component that renders, so there is no
  seam to lift it through; the file was far over budget before this change.

file: src/app/(admin)/admin/members/[id]/page.tsx
lines: 1354
reason: 2 lines: `useClubFormat()` at the top of each component that renders an amount, and
  the club's format on every formatter call beneath it, including the module-level
  helpers that build amount strings, which take `format` rather than a hook they
  cannot call. A hook has to sit in the component that renders, so there is no
  seam to lift it through; the file was far over budget before this change.

file: src/app/(admin)/admin/payments/page.tsx
lines: 1335
reason: 2 lines: `useClubFormat()` at the top of each component that renders an amount, and
  the club's format on every formatter call beneath it, including the module-level
  helpers that build amount strings, which take `format` rather than a hook they
  cannot call. A hook has to sit in the component that renders, so there is no
  seam to lift it through; the file was far over budget before this change.

file: src/app/(admin)/admin/promo-codes/promo-codes-page-client.tsx
lines: 1765
reason: 1 line: `useClubFormat()` at the top of each component that renders an amount, and
  the club's format on every formatter call beneath it, including the module-level
  helpers that build amount strings, which take `format` rather than a hook they
  cannot call. A hook has to sit in the component that renders, so there is no
  seam to lift it through; the file was far over budget before this change.

file: src/app/(admin)/admin/promo-codes/promo-redemptions-panel.tsx
lines: 816
reason: 1 line: `useClubFormat()` at the top of each component that renders an amount, and
  the club's format on every formatter call beneath it, including the module-level
  helpers that build amount strings, which take `format` rather than a hook they
  cannot call. A hook has to sit in the component that renders, so there is no
  seam to lift it through; the file was far over budget before this change.

file: src/app/(admin)/admin/refund-requests/page.tsx
lines: 882
reason: 2 lines: `useClubFormat()` at the top of each component that renders an amount, and
  the club's format on every formatter call beneath it, including the module-level
  helpers that build amount strings, which take `format` rather than a hook they
  cannot call. A hook has to sit in the component that renders, so there is no
  seam to lift it through; the file was far over budget before this change.

file: src/app/(admin)/admin/reports/page.tsx
lines: 779
reason: 6 lines: `useClubFormat()` at the top of each component that renders an amount, and
  the club's format on every formatter call beneath it, including the module-level
  helpers that build amount strings, which take `format` rather than a hook they
  cannot call. A hook has to sit in the component that renders, so there is no
  seam to lift it through; the file was far over budget before this change.

file: src/app/(admin)/admin/waitlist/page.tsx
lines: 1018
reason: 2 lines: `useClubFormat()` at the top of each component that renders an amount, and
  the club's format on every formatter call beneath it, including the module-level
  helpers that build amount strings, which take `format` rather than a hook they
  cannot call. A hook has to sit in the component that renders, so there is no
  seam to lift it through; the file was far over budget before this change.

file: src/app/(admin)/admin/work-parties/page.tsx
lines: 619
reason: 3 lines: `useClubFormat()` at the top of each component that renders an amount, and
  the club's format on every formatter call beneath it, including the module-level
  helpers that build amount strings, which take `format` rather than a hook they
  cannot call. A hook has to sit in the component that renders, so there is no
  seam to lift it through; the file was far over budget before this change.

file: src/app/(authenticated)/book/_components/review-step.tsx
lines: 1067
reason: 2 lines: `useClubFormat()` at the top of each component that renders an amount, and
  the club's format on every formatter call beneath it, including the module-level
  helpers that build amount strings, which take `format` rather than a hook they
  cannot call. A hook has to sit in the component that renders, so there is no
  seam to lift it through; the file was far over budget before this change.

file: src/app/api/admin/booking-exception-requests/[id]/route.ts
lines: 815
reason: 5 lines: `const format = await clubFormatValues()` once at the top of each handler
  that renders money, before its transaction or lock, and the argument threaded
  into the service, email and formatter calls below it. The handler is where the
  request is, so the resolution cannot move into a helper without losing the
  request-scoped memo; the debt here predates this change by hundreds of lines.

file: src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts
lines: 920
reason: 8 lines: `const format = await clubFormatValues()` once at the top of each handler
  that renders money, before its transaction or lock, and the argument threaded
  into the service, email and formatter calls below it. The handler is where the
  request is, so the resolution cannot move into a helper without losing the
  request-scoped memo; the debt here predates this change by hundreds of lines.

file: src/app/api/admin/bookings/[id]/force-confirm/route.ts
lines: 369
reason: 5 lines: `const format = await clubFormatValues()` once at the top of each handler
  that renders money, before its transaction or lock, and the argument threaded
  into the service, email and formatter calls below it. The handler is where the
  request is, so the resolution cannot move into a helper without losing the
  request-scoped memo; the debt here predates this change by hundreds of lines.

file: src/app/api/admin/bookings/[id]/return-to-waitlist/route.ts
lines: 417
reason: 4 lines: `const format = await clubFormatValues()` once at the top of each handler
  that renders money, before its transaction or lock, and the argument threaded
  into the service, email and formatter calls below it. The handler is where the
  request is, so the resolution cannot move into a helper without losing the
  request-scoped memo; the debt here predates this change by hundreds of lines.

file: src/app/api/admin/bookings/[id]/review/route.ts
lines: 358
reason: 5 lines: `const format = await clubFormatValues()` once at the top of each handler
  that renders money, before its transaction or lock, and the argument threaded
  into the service, email and formatter calls below it. The handler is where the
  request is, so the resolution cannot move into a helper without losing the
  request-scoped memo; the debt here predates this change by hundreds of lines.

file: src/app/api/admin/deletion-requests/[id]/route.ts
lines: 1288
reason: 5 lines: `const format = await clubFormatValues()` once at the top of each handler
  that renders money, before its transaction or lock, and the argument threaded
  into the service, email and formatter calls below it. The handler is where the
  request is, so the resolution cannot move into a helper without losing the
  request-scoped memo; the debt here predates this change by hundreds of lines.

file: src/app/api/admin/fee-configuration/route.ts
lines: 487
reason: 7 lines: `const format = await clubFormatValues()` once at the top of each handler
  that renders money, before its transaction or lock, and the argument threaded
  into the service, email and formatter calls below it. The handler is where the
  request is, so the resolution cannot move into a helper without losing the
  request-scoped memo; the debt here predates this change by hundreds of lines.

file: src/app/api/bookings/[id]/confirm-draft/route.ts
lines: 408
reason: 5 lines: `const format = await clubFormatValues()` once at the top of each handler
  that renders money, before its transaction or lock, and the argument threaded
  into the service, email and formatter calls below it. The handler is where the
  request is, so the resolution cannot move into a helper without losing the
  request-scoped memo; the debt here predates this change by hundreds of lines.

file: src/app/api/bookings/[id]/confirm-payment/route.ts
lines: 324
reason: 6 lines: `const format = await clubFormatValues()` once at the top of each handler
  that renders money, before its transaction or lock, and the argument threaded
  into the service, email and formatter calls below it. The handler is where the
  request is, so the resolution cannot move into a helper without losing the
  request-scoped memo; the debt here predates this change by hundreds of lines.

file: src/app/api/bookings/[id]/guests/[guestId]/route.ts
lines: 564
reason: 7 lines: `const format = await clubFormatValues()` once at the top of each handler
  that renders money, before its transaction or lock, and the argument threaded
  into the service, email and formatter calls below it. The handler is where the
  request is, so the resolution cannot move into a helper without losing the
  request-scoped memo; the debt here predates this change by hundreds of lines.

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1640
reason: 6 lines: `const format = await clubFormatValues()` once at the top of each handler
  that renders money, before its transaction or lock, and the argument threaded
  into the service, email and formatter calls below it. The handler is where the
  request is, so the resolution cannot move into a helper without losing the
  request-scoped memo; the debt here predates this change by hundreds of lines.

file: src/app/api/bookings/[id]/modify-dates/route.ts
lines: 378
reason: 5 lines: `const format = await clubFormatValues()` once at the top of each handler
  that renders money, before its transaction or lock, and the argument threaded
  into the service, email and formatter calls below it. The handler is where the
  request is, so the resolution cannot move into a helper without losing the
  request-scoped memo; the debt here predates this change by hundreds of lines.

file: src/app/api/bookings/[id]/modify/route.ts
lines: 519
reason: 5 lines: `const format = await clubFormatValues()` once at the top of each handler
  that renders money, before its transaction or lock, and the argument threaded
  into the service, email and formatter calls below it. The handler is where the
  request is, so the resolution cannot move into a helper without losing the
  request-scoped memo; the debt here predates this change by hundreds of lines.

file: src/app/api/bookings/[id]/waitlist-confirm/route.ts
lines: 576
reason: 5 lines: `const format = await clubFormatValues()` once at the top of each handler
  that renders money, before its transaction or lock, and the argument threaded
  into the service, email and formatter calls below it. The handler is where the
  request is, so the resolution cannot move into a helper without losing the
  request-scoped memo; the debt here predates this change by hundreds of lines.

file: src/app/api/bookings/route.ts
lines: 1494
reason: 7 lines: `const format = await clubFormatValues()` once at the top of each handler
  that renders money, before its transaction or lock, and the argument threaded
  into the service, email and formatter calls below it. The handler is where the
  request is, so the resolution cannot move into a helper without losing the
  request-scoped memo; the debt here predates this change by hundreds of lines.

file: src/app/api/payments/charge-saved-method/route.ts
lines: 647
reason: 6 lines: `const format = await clubFormatValues()` once at the top of each handler
  that renders money, before its transaction or lock, and the argument threaded
  into the service, email and formatter calls below it. The handler is where the
  request is, so the resolution cannot move into a helper without losing the
  request-scoped memo; the debt here predates this change by hundreds of lines.

file: src/app/api/payments/create-payment-intent/route.ts
lines: 825
reason: 8 lines: `const format = await clubFormatValues()` once at the top of each handler
  that renders money, before its transaction or lock, and the argument threaded
  into the service, email and formatter calls below it. The handler is where the
  request is, so the resolution cannot move into a helper without losing the
  request-scoped memo; the debt here predates this change by hundreds of lines.

file: src/app/api/payments/switch-to-internet-banking/route.ts
lines: 464
reason: 5 lines: `const format = await clubFormatValues()` once at the top of each handler
  that renders money, before its transaction or lock, and the argument threaded
  into the service, email and formatter calls below it. The handler is where the
  request is, so the resolution cannot move into a helper without losing the
  request-scoped memo; the debt here predates this change by hundreds of lines.

file: src/components/admin/booking-requests/public-booking-requests-panel.tsx
lines: 2662
reason: 1 line: `useClubFormat()` at the top of each component that renders an amount, and
  the club's format on every formatter call beneath it, including the module-level
  helpers that build amount strings, which take `format` rather than a hook they
  cannot call. A hook has to sit in the component that renders, so there is no
  seam to lift it through; the file was far over budget before this change.

file: src/components/admin/manual-refund-task-queue.tsx
lines: 2028
reason: 7 lines: `useClubFormat()` at the top of each component that renders an amount, and
  the club's format on every formatter call beneath it, including the module-level
  helpers that build amount strings, which take `format` rather than a hook they
  cannot call. A hook has to sit in the component that renders, so there is no
  seam to lift it through; the file was far over budget before this change.

file: src/lib/audit-query.ts
lines: 1353
reason: 29 lines: a `format: ClubFormat` parameter on the functions that render money, threaded
  to each formatter, template and Xero call, so this module never reads the setting
  for itself — never inside a transaction and never per amount. The argument is
  the mechanism the compiler checks; hiding it in a helper would defeat that, and
  the file's debt predates this change by hundreds of lines.

file: src/lib/booking-batch-modification-service.ts
lines: 2602
reason: 15 lines: a `format: ClubFormat` parameter on the functions that render money, threaded
  to each formatter, template and Xero call, so this module never reads the setting
  for itself — never inside a transaction and never per amount. The argument is
  the mechanism the compiler checks; hiding it in a helper would defeat that, and
  the file's debt predates this change by hundreds of lines.

file: src/lib/booking-cancel.ts
lines: 2524
reason: 19 lines: a `format: ClubFormat` parameter on the functions that render money, threaded
  to each formatter, template and Xero call, so this module never reads the setting
  for itself — never inside a transaction and never per amount. The argument is
  the mechanism the compiler checks; hiding it in a helper would defeat that, and
  the file's debt predates this change by hundreds of lines.

file: src/lib/booking-create.ts
lines: 2068
reason: 6 lines: a `format: ClubFormat` parameter on the functions that render money, threaded
  to each formatter, template and Xero call, so this module never reads the setting
  for itself — never inside a transaction and never per amount. The argument is
  the mechanism the compiler checks; hiding it in a helper would defeat that, and
  the file's debt predates this change by hundreds of lines.

file: src/lib/booking-date-modification-service.ts
lines: 2306
reason: 14 lines: this module's entry points — a cron run, a webhook, a job or a request-
  facing service — each call `await clubFormatValues()` ONCE at the top, before any
  transaction or lock, and thread the result to every formatter, template and Xero
  call below; the helpers inside it take `format` as a parameter and never read the
  setting for themselves. The entry point is where the run is, so the resolution
  cannot move without losing once-per-run; the debt here predates this change.

file: src/lib/booking-delete.ts
lines: 734
reason: 6 lines: this module's entry points — a cron run, a webhook, a job or a request-
  facing service — each call `await clubFormatValues()` ONCE at the top, before any
  transaction or lock, and thread the result to every formatter, template and Xero
  call below; the helpers inside it take `format` as a parameter and never read the
  setting for themselves. The entry point is where the run is, so the resolution
  cannot move without losing once-per-run; the debt here predates this change.

file: src/lib/booking-exception-approval.ts
lines: 1199
reason: 11 lines: a `format: ClubFormat` parameter on the functions that render money, threaded
  to each formatter, template and Xero call, so this module never reads the setting
  for itself — never inside a transaction and never per amount. The argument is
  the mechanism the compiler checks; hiding it in a helper would defeat that, and
  the file's debt predates this change by hundreds of lines.

file: src/lib/booking-guest-removal-service.ts
lines: 1510
reason: 6 lines: a `format: ClubFormat` parameter on the functions that render money, threaded
  to each formatter, template and Xero call, so this module never reads the setting
  for itself — never inside a transaction and never per amount. The argument is
  the mechanism the compiler checks; hiding it in a helper would defeat that, and
  the file's debt predates this change by hundreds of lines.

file: src/lib/booking-request-quotes.ts
lines: 2140
reason: 4 lines: this module's entry points — a cron run, a webhook, a job or a request-
  facing service — each call `await clubFormatValues()` ONCE at the top, before any
  transaction or lock, and thread the result to every formatter, template and Xero
  call below; the helpers inside it take `format` as a parameter and never read the
  setting for themselves. The entry point is where the run is, so the resolution
  cannot move without losing once-per-run; the debt here predates this change.

file: src/lib/booking-request.ts
lines: 2978
reason: 8 lines: this module's entry points — a cron run, a webhook, a job or a request-
  facing service — each call `await clubFormatValues()` ONCE at the top, before any
  transaction or lock, and thread the result to every formatter, template and Xero
  call below; the helpers inside it take `format` as a parameter and never read the
  setting for themselves. The entry point is where the run is, so the resolution
  cannot move without losing once-per-run; the debt here predates this change.

file: src/lib/config-transfer/bootstrap-import.ts
lines: 725
reason: 6 lines: this module's entry points — a cron run, a webhook, a job or a request-
  facing service — each call `await clubFormatValues()` ONCE at the top, before any
  transaction or lock, and thread the result to every formatter, template and Xero
  call below; the helpers inside it take `format` as a parameter and never read the
  setting for themselves. The entry point is where the run is, so the resolution
  cannot move without losing once-per-run; the debt here predates this change.

file: src/lib/config-transfer/categories/membership-fees.ts
lines: 1080
reason: 3 lines: a `format: ClubFormat` parameter on the functions that render money, threaded
  to each formatter, template and Xero call, so this module never reads the setting
  for itself — never inside a transaction and never per amount. The argument is
  the mechanism the compiler checks; hiding it in a helper would defeat that, and
  the file's debt predates this change by hundreds of lines.

file: src/lib/cron-confirm-pending.ts
lines: 1996
reason: 9 lines: this module's entry points — a cron run, a webhook, a job or a request-
  facing service — each call `await clubFormatValues()` ONCE at the top, before any
  transaction or lock, and thread the result to every formatter, template and Xero
  call below; the helpers inside it take `format` as a parameter and never read the
  setting for themselves. The entry point is where the run is, so the resolution
  cannot move without losing once-per-run; the debt here predates this change.

file: src/lib/cron-group-settlement-reaper.ts
lines: 780
reason: 11 lines: this module's entry points — a cron run, a webhook, a job or a request-
  facing service — each call `await clubFormatValues()` ONCE at the top, before any
  transaction or lock, and thread the result to every formatter, template and Xero
  call below; the helpers inside it take `format` as a parameter and never read the
  setting for themselves. The entry point is where the run is, so the resolution
  cannot move without losing once-per-run; the debt here predates this change.

file: src/lib/email/booking.ts
lines: 1751
reason: 23 lines: every template and sender in this module takes the club's `format` as a
  required parameter and passes it to the amounts it writes. The senders are the
  boundary between a job and the mail it sends, so the parameter has to be on
  them; a sender that resolved the setting itself would read it once per email
  in a batch. The file's debt predates this change by four times its ceiling.

file: src/lib/finance-report-mappings.ts
lines: 1064
reason: 14 lines: a `format: ClubFormat` parameter on the functions that render money, threaded
  to each formatter, template and Xero call, so this module never reads the setting
  for itself — never inside a transaction and never per amount. The argument is
  the mechanism the compiler checks; hiding it in a helper would defeat that, and
  the file's debt predates this change by hundreds of lines.

file: src/lib/group-booking.ts
lines: 1894
reason: 8 lines: this module's entry points — a cron run, a webhook, a job or a request-
  facing service — each call `await clubFormatValues()` ONCE at the top, before any
  transaction or lock, and thread the result to every formatter, template and Xero
  call below; the helpers inside it take `format` as a parameter and never read the
  setting for themselves. The entry point is where the run is, so the resolution
  cannot move without losing once-per-run; the debt here predates this change.

file: src/lib/group-cancel.ts
lines: 929
reason: 4 lines: a `format: ClubFormat` parameter on the functions that render money, threaded
  to each formatter, template and Xero call, so this module never reads the setting
  for itself — never inside a transaction and never per amount. The argument is
  the mechanism the compiler checks; hiding it in a helper would defeat that, and
  the file's debt predates this change by hundreds of lines.

file: src/lib/group-settlement.ts
lines: 1286
reason: 17 lines: this module's entry points — a cron run, a webhook, a job or a request-
  facing service — each call `await clubFormatValues()` ONCE at the top, before any
  transaction or lock, and thread the result to every formatter, template and Xero
  call below; the helpers inside it take `format` as a parameter and never read the
  setting for themselves. The entry point is where the run is, so the resolution
  cannot move without losing once-per-run; the debt here predates this change.

file: src/lib/ib-hold-clearing-audit.ts
lines: 801
reason: 6 lines: a `format: ClubFormat` parameter on the functions that render money, threaded
  to each formatter, template and Xero call, so this module never reads the setting
  for itself — never inside a transaction and never per amount. The argument is
  the mechanism the compiler checks; hiding it in a helper would defeat that, and
  the file's debt predates this change by hundreds of lines.

file: src/lib/member-credit.ts
lines: 1027
reason: 20 lines: this module's entry points — a cron run, a webhook, a job or a request-
  facing service — each call `await clubFormatValues()` ONCE at the top, before any
  transaction or lock, and thread the result to every formatter, template and Xero
  call below; the helpers inside it take `format` as a parameter and never read the
  setting for themselves. The entry point is where the run is, so the resolution
  cannot move without losing once-per-run; the debt here predates this change.

file: src/lib/member-guest-consent-service.ts
lines: 1225
reason: 18 lines: a `format: ClubFormat` parameter on the functions that render money, threaded
  to each formatter, template and Xero call, so this module never reads the setting
  for itself — never inside a transaction and never per amount. The argument is
  the mechanism the compiler checks; hiding it in a helper would defeat that, and
  the file's debt predates this change by hundreds of lines.

file: src/lib/member-guest-email-notes.ts
lines: 834
reason: 3 lines: a `format: ClubFormat` parameter on the functions that render money, threaded
  to each formatter, template and Xero call, so this module never reads the setting
  for itself — never inside a transaction and never per amount. The argument is
  the mechanism the compiler checks; hiding it in a helper would defeat that, and
  the file's debt predates this change by hundreds of lines.

file: src/lib/payment-reconciliation.ts
lines: 3046
reason: 15 lines: a `format: ClubFormat` parameter on the functions that render money, threaded
  to each formatter, template and Xero call, so this module never reads the setting
  for itself — never inside a transaction and never per amount. The argument is
  the mechanism the compiler checks; hiding it in a helper would defeat that, and
  the file's debt predates this change by hundreds of lines.

file: src/lib/payment-recovery.ts
lines: 3184
reason: 25 lines: this module's entry points — a cron run, a webhook, a job or a request-
  facing service — each call `await clubFormatValues()` ONCE at the top, before any
  transaction or lock, and thread the result to every formatter, template and Xero
  call below; the helpers inside it take `format` as a parameter and never read the
  setting for themselves. The entry point is where the run is, so the resolution
  cannot move without losing once-per-run; the debt here predates this change.

file: src/lib/payment-transactions.ts
lines: 1196
reason: 8 lines: a `format: ClubFormat` parameter on the functions that render money, threaded
  to each formatter, template and Xero call, so this module never reads the setting
  for itself — never inside a transaction and never per amount. The argument is
  the mechanism the compiler checks; hiding it in a helper would defeat that, and
  the file's debt predates this change by hundreds of lines.

file: src/lib/public-page-content-tokens.ts
lines: 771
reason: 6 lines: a `format: ClubFormat` parameter on the functions that render money, threaded
  to each formatter, template and Xero call, so this module never reads the setting
  for itself — never inside a transaction and never per amount. The argument is
  the mechanism the compiler checks; hiding it in a helper would defeat that, and
  the file's debt predates this change by hundreds of lines.

file: src/lib/school-booking-request.ts
lines: 2911
reason: 8 lines: this module's entry points — a cron run, a webhook, a job or a request-
  facing service — each call `await clubFormatValues()` ONCE at the top, before any
  transaction or lock, and thread the result to every formatter, template and Xero
  call below; the helpers inside it take `format` as a parameter and never read the
  setting for themselves. The entry point is where the run is, so the resolution
  cannot move without losing once-per-run; the debt here predates this change.

file: src/lib/stripe-webhook-service.ts
lines: 1794
reason: 28 lines: this module's entry points — a cron run, a webhook, a job or a request-
  facing service — each call `await clubFormatValues()` ONCE at the top, before any
  transaction or lock, and thread the result to every formatter, template and Xero
  call below; the helpers inside it take `format` as a parameter and never read the
  setting for themselves. The entry point is where the run is, so the resolution
  cannot move without losing once-per-run; the debt here predates this change.

file: src/lib/waitlist-cross-lodge.ts
lines: 984
reason: 4 lines: a `format: ClubFormat` parameter on the functions that render money, threaded
  to each formatter, template and Xero call, so this module never reads the setting
  for itself — never inside a transaction and never per amount. The argument is
  the mechanism the compiler checks; hiding it in a helper would defeat that, and
  the file's debt predates this change by hundreds of lines.

file: src/lib/waitlist.ts
lines: 1479
reason: 9 lines: a `format: ClubFormat` parameter on the functions that render money, threaded
  to each formatter, template and Xero call, so this module never reads the setting
  for itself — never inside a transaction and never per amount. The argument is
  the mechanism the compiler checks; hiding it in a helper would defeat that, and
  the file's debt predates this change by hundreds of lines.

file: src/lib/xero-credit-notes.ts
lines: 1097
reason: 10 lines: a `format: ClubFormat` parameter on the functions that render money, threaded
  to each formatter, template and Xero call, so this module never reads the setting
  for itself — never inside a transaction and never per amount. The argument is
  the mechanism the compiler checks; hiding it in a helper would defeat that, and
  the file's debt predates this change by hundreds of lines.

file: src/lib/xero-hardening-report.ts
lines: 1099
reason: 5 lines: a `format: ClubFormat` parameter on the functions that render money, threaded
  to each formatter, template and Xero call, so this module never reads the setting
  for itself — never inside a transaction and never per amount. The argument is
  the mechanism the compiler checks; hiding it in a helper would defeat that, and
  the file's debt predates this change by hundreds of lines.

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 1701
reason: 10 lines: a `format: ClubFormat` parameter on the functions that render money, threaded
  to each formatter, template and Xero call, so this module never reads the setting
  for itself — never inside a transaction and never per amount. The argument is
  the mechanism the compiler checks; hiding it in a helper would defeat that, and
  the file's debt predates this change by hundreds of lines.

file: src/lib/xero-invoice-rounding-audit.ts
lines: 803
reason: 4 lines: a `format: ClubFormat` parameter on the functions that render money, threaded
  to each formatter, template and Xero call, so this module never reads the setting
  for itself — never inside a transaction and never per amount. The argument is
  the mechanism the compiler checks; hiding it in a helper would defeat that, and
  the file's debt predates this change by hundreds of lines.

file: src/lib/xero-operation-outbox.ts
lines: 3301
reason: 9 lines: this module's entry points — a cron run, a webhook, a job or a request-
  facing service — each call `await clubFormatValues()` ONCE at the top, before any
  transaction or lock, and thread the result to every formatter, template and Xero
  call below; the helpers inside it take `format` as a parameter and never read the
  setting for themselves. The entry point is where the run is, so the resolution
  cannot move without losing once-per-run; the debt here predates this change.

file: src/lib/xero-operation-retry.ts
lines: 1553
reason: 6 lines: a `format: ClubFormat` parameter on the functions that render money, threaded
  to each formatter, template and Xero call, so this module never reads the setting
  for itself — never inside a transaction and never per amount. The argument is
  the mechanism the compiler checks; hiding it in a helper would defeat that, and
  the file's debt predates this change by hundreds of lines.

file: src/lib/xero-record-activity.ts
lines: 834
reason: 2 lines: a `format: ClubFormat` parameter on the functions that render money, threaded
  to each formatter, template and Xero call, so this module never reads the setting
  for itself — never inside a transaction and never per amount. The argument is
  the mechanism the compiler checks; hiding it in a helper would defeat that, and
  the file's debt predates this change by hundreds of lines.

file: src/lib/xero-refund-note-link-repair.ts
lines: 877
reason: 7 lines: a `format: ClubFormat` parameter on the functions that render money, threaded
  to each formatter, template and Xero call, so this module never reads the setting
  for itself — never inside a transaction and never per amount. The argument is
  the mechanism the compiler checks; hiding it in a helper would defeat that, and
  the file's debt predates this change by hundreds of lines.
