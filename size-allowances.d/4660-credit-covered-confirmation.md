# File-size allowances for #4660

file: src/lib/booking-create.ts
lines: 2074
reason: the confirmation post sits in the existing PAID write, beside the payment row it plans from, and splitting it out would separate the ledger post from the status claim.

file: src/app/api/payments/create-payment-intent/route.ts
lines: 918
reason: the journal context is resolved before the existing settle transaction opens, which is where INV-LOCK-004 requires it, and lifting that read out is a refactor of the route.

file: src/app/api/bookings/route.ts
lines: 1873
reason: the comment on the existing pre-transaction journal read now names the confirmation as well as the charge, and there is no seam to split that read out.

file: src/lib/group-booking.ts
lines: 1968
reason: the comment on the join's existing pre-transaction journal read now names the $0 confirm, beside the create it feeds, and splitting the read out is its own refactor.

file: src/lib/waitlist-cross-lodge.ts
lines: 1012
reason: the journal context is resolved beside the club-zone read that already sits outside the create's transaction, and moving that pair would separate it from the create it feeds.
