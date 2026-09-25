# File-size allowances for #3566 (`3566` is a placeholder until the PR number is known)

Every entry below grows by one to seven lines for ONE reason: stage 4 of programme
#3205 made the club's date format a REQUIRED argument of every date rendering
(owner decision 1 on #3566), so each already-oversized module that renders a date
gains the parameter, the value it is threaded from, or a line-wrap where a call
got longer. The comments this change added in these files were trimmed to one
line first, and the three modules this would have carried over budget for the
first time were trimmed back under it instead. Splitting any of these is a
refactor of its own and would move no date rendering closer to the kernel.

file: src/app/(admin)/admin/book/page.tsx
lines: 1690
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/app/(admin)/admin/dashboard/page.tsx
lines: 911
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/app/(admin)/admin/fees/_components/hut-fees-section.tsx
lines: 1276
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/app/(admin)/admin/lockers/page.tsx
lines: 746
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/app/(admin)/admin/member-applications/page.tsx
lines: 818
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/app/(admin)/admin/members/[id]/_components/member-dependent-dialog.tsx
lines: 714
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/app/(admin)/admin/promo-codes/promo-codes-page-client.tsx
lines: 1766
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/app/(admin)/admin/reports/page.tsx
lines: 783
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/app/(admin)/admin/roster/page.tsx
lines: 588
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/app/(authenticated)/book/_hooks/use-booking-wizard.ts
lines: 2344
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/app/(authenticated)/book/page.tsx
lines: 699
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/app/(authenticated)/dashboard/page.tsx
lines: 996
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/app/(lodge)/lodge/kiosk/page.tsx
lines: 1424
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/app/(lodge)/lodge/roster/[date]/setup/page.tsx
lines: 926
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/app/api/bookings/[id]/modify-quote/route.ts
lines: 2371
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/app/api/bookings/quote/route.ts
lines: 485
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/app/api/display/state/route.ts
lines: 371
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/app/api/member/data-export/route.ts
lines: 380
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/components/admin/booking-policies/minimum-night-stay-section.tsx
lines: 842
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/components/admin/manual-refund-task-queue.tsx
lines: 2029
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/components/calendar/event-dialog.tsx
lines: 1035
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/lib/booking-batch-modification-service.ts
lines: 2619
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/lib/booking-create.ts
lines: 2112
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/lib/booking-modify-plan.ts
lines: 3148
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/lib/booking-request-quotes.ts
lines: 2160
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/lib/booking-request.ts
lines: 3041
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/lib/finance-report-mappings.ts
lines: 1069
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/lib/school-booking-request.ts
lines: 2944
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.

file: src/lib/xero-record-activity.ts
lines: 838
reason: the required club date format threaded through an already-oversized
  module (#3566); splitting it is a separate refactor that would not remove
  the parameter.
