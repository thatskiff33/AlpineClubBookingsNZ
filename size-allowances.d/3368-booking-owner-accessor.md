# File-size allowances for #3368

Fifty-four already-over-budget files gain the one import line that routes their
reads of a booking's owner through `bookingOwner()` — the accessor #3368 exists
to introduce. Two of them gain two lines, where the call no longer fitted on the
line it was on.

**Splitting is not available for any of them, and that is the point of a sweep
rather than a refactor.** The growth is not this change's subject: the subject is
that five hundred reads of `booking.memberId` and `booking.member` stop being
five hundred independent answers to "who owns this booking" and become one. A
file is on this list because it asked that question and is already over its
ceiling, not because #3368 added anything to what it does. Splitting fifty-four
modules to pay for fifty-four import lines would be a far larger, far riskier
change than the one being reviewed, and it would bury the property this stage
has to prove — that the output is byte-identical.

Four more files sat at exactly their ceiling, where an allowance is not
permitted (`size-allowances.d/README.md`, and the gate refuses it by name). They
are not listed here: each paid for its import by collapsing one two-name import
block in the same header, which leaves them under budget.

Each entry records the file's length after the import.

file: src/app/(admin)/admin/bookings/page.tsx
lines: 776
reason: one line: the `bookingOwner` import this route page shell needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/app/(admin)/admin/dashboard/page.tsx
lines: 909
reason: one line: the `bookingOwner` import this route page shell needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/app/(admin)/admin/xero/_components/health-diagnostics-panel.tsx
lines: 728
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out. RE-MEASURED by #2934, which added a second one-line import for the same reason in the same file: `xeroSectionId`, so the id this panel writes onto its section cards and the id `use-xero-connection.ts` reads back to reveal them are one string rather than two (`INV-SSOT-001`). The number is re-measured here rather than declared in a second fragment, because two live entries for one path is refused by the gate and is an unusable input rather than a redundant one.

file: src/app/api/admin/bookings/[id]/exclusive-hold/route.ts
lines: 423
reason: one line: the `bookingOwner` import this route handler needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/app/api/admin/bookings/[id]/return-to-waitlist/route.ts
lines: 413
reason: one line: the `bookingOwner` import this route handler needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/app/api/admin/bookings/search/route.ts
lines: 277
reason: one line: the `bookingOwner` import this route handler needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/app/api/admin/hut-leaders/eligible-members/route.ts
lines: 345
reason: one line: the `bookingOwner` import this route handler needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/app/api/admin/refund-requests/[id]/route.ts
lines: 473
reason: one line: the `bookingOwner` import this route handler needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/app/api/admin/xero/force-sync/route.ts
lines: 327
reason: one line: the `bookingOwner` import this route handler needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/app/api/bookings/[id]/arrival-time/route.ts
lines: 373
reason: one line: the `bookingOwner` import this route handler needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/app/api/bookings/[id]/change-requests/route.ts
lines: 584
reason: one line: the `bookingOwner` import this route handler needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/app/api/bookings/[id]/confirm-draft/route.ts
lines: 403
reason: one line: the `bookingOwner` import this route handler needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/app/api/bookings/[id]/confirm-payment/route.ts
lines: 318
reason: one line: the `bookingOwner` import this route handler needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/app/api/bookings/[id]/exception-requests/route.ts
lines: 293
reason: one line: the `bookingOwner` import this route handler needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/app/api/bookings/[id]/guests/[guestId]/route.ts
lines: 552
reason: one line: the `bookingOwner` import this route handler needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1549
reason: one line: the `bookingOwner` import this route handler needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/app/api/bookings/[id]/refund-request/route.ts
lines: 259
reason: one line: the `bookingOwner` import this route handler needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/app/api/bookings/[id]/waitlist-confirm/route.ts
lines: 571
reason: one line: the `bookingOwner` import this route handler needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/app/api/payments/charge-saved-method/route.ts
lines: 641
reason: one line: the `bookingOwner` import this route handler needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/app/api/payments/create-payment-intent/route.ts
lines: 815
reason: one line: the `bookingOwner` import this route handler needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/app/api/payments/switch-to-internet-banking/route.ts
lines: 459
reason: one line: the `bookingOwner` import this route handler needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/components/edit-booking-panel.tsx
lines: 2136
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/lib/admin-bookings-service.ts
lines: 1415
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/lib/adult-member-hosting-review.ts
lines: 4509
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/lib/bed-allocation-removal.ts
lines: 792
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/lib/booking-batch-modification-service.ts
lines: 2522
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/lib/booking-cancel.ts
lines: 2487
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/lib/booking-create.ts
lines: 2062
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/lib/booking-date-modification-service.ts
lines: 2240
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/lib/booking-delete.ts
lines: 728
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/lib/booking-exception-approval.ts
lines: 1188
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.
  #2721 then added sixty-three lines: the own-dependant guard re-run at
  execution, its officer-facing error, and the comment saying why it fails
  closed there rather than asking a question the officer cannot answer. It
  cannot move out of this function — it reads the normalised party, the
  linked-member map and the frozen snapshot, all of which exist only here. The
  length recorded here is the length after that.

file: src/lib/booking-exception-request-service.ts
lines: 2393
reason: 2 lines: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.
  #2721 then added a hundred and twelve lines: the own-dependant guard at
  submit time, its typed domain error, and the note on why the frozen answers
  sit beside the proposal rather than inside the hashed part of it. This is the
  service both request routes go through, so the guard has to be here or one
  door would keep the hole. The length recorded here is the length after that.

file: src/lib/booking-guest-removal-service.ts
lines: 1439
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/lib/booking-modify-plan.ts
lines: 3016
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/lib/cron-confirm-pending.ts
lines: 1987
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/lib/cron-group-settlement-reaper.ts
lines: 769
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/lib/diagnostics/tools/packs/booking-evidence.ts
lines: 2228
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/lib/diagnostics/tools/packs/finance-evidence.ts
lines: 859
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/lib/group-cancel.ts
lines: 924
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/lib/lodge-display-state.ts
lines: 932
reason: RE-MEASURED at 923 on the eighth `main`-into-epic sync (#2725), which made this file 115 lines SHORTER than this entry recorded. RE-MEASURED AGAIN at 932 by #3391: nine lines, all comment, above the whole-lodge heuristic's `isOrganisation` read — the record of why it must read `bookingOwner()`'s absent age tier as an organisation, because the bare comparison it replaced had stopped drawing a small school's booking as a blockout once the backfill moved schools off their invented member. The read is two lines; the comment is what stops the next reader "simplifying" it back. #2942 extracted `reduceName`, `namesAllowedForBooking`, `bookingLabel` and the minor-tier predicate into `src/lib/display-name-granularity.ts` so the member lodge roster could import the same rules, and #3369's edit to those functions moved with them. The number is re-measured in this entry rather than declared in a second fragment, because two live entries for one path is refused. The original reasoning stands: one line here is the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column.

file: src/lib/member-guest-consent-service.ts
lines: 1207
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/lib/payment-reconciliation.ts
lines: 2948
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/lib/payment-recovery.ts
lines: 3156
reason: 2 lines: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/lib/seasonal-membership-assignments.ts
lines: 1737
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/lib/stripe-webhook-service.ts
lines: 1765
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/lib/stuck-state-dashboard.ts
lines: 1148
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/lib/waitlist-cross-lodge.ts
lines: 980
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/lib/waitlist.ts
lines: 1470
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/lib/xero-applied-credit-deallocation.ts
lines: 1019
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/lib/xero-credit-notes.ts
lines: 1003
reason: thirty lines, and twenty-four of them are comment. Two contact resolutions move from `findOrCreateXeroContact(memberId)` to `findOrCreateXeroContactForInvoicedParty(booking)` and two retries gain `invoicedPartyContactRepair`, which is #3367's leftover — a returning school's earlier credit note resolved through a member that no longer holds a Xero contact link and was refused. The comments carry why, because the mechanism is invisible at the call site: the failure is a provider refusal on a school that has booked before, and a reader who does not know that will read the change as a rename. There is no seam to split here — both halves belong to the credit note they raise.

file: src/lib/xero-inbound/credit-note-repairs.ts
lines: 1002
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 1691
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/lib/xero-record-activity.ts
lines: 843
reason: one line: the `bookingOwner` import this domain module needs to ask who owns a booking through the one accessor instead of reading the column. Nothing else in the file changed shape, so there is no seam here that #3368 created and could split back out.

file: src/app/(admin)/admin/waitlist/page.tsx
lines: 1016
reason: one line: the `bookingOwner` import. A waitlist entry in this product IS a booking row in a `WAITLIST_*` status — the table links its own id to `/admin/bookings/<id>` — so its owner is a booking's owner and the link to the member's record is read through the one accessor like every other. Splitting a route page shell for one import line is the worse answer; the page's own size debt predates this change and is untouched by it.
