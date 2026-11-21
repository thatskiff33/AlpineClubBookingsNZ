file: src/lib/xero-booking-invoices.ts
lines: 1580
reason: The shared external-settlement predicate extends the existing invoice fence to imported free stays; moving this guard away from its handler would reopen the provider call.
