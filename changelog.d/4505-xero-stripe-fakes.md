- **Payment tests can follow a whole provider journey (#4460).** Shared Xero
  and Stripe fakes remember invoices, payments, credits, captures and refunds.
  Repeatable tests check that sending and reading money preserves member totals,
  including refunds that fail later. Synthetic fixture contracts document the
  modeled behavior; sandbox conformance remains unverified.
