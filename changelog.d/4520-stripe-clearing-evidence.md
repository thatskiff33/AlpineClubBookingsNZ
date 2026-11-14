- **The database can hold Stripe balance transactions and payouts, and the app does not write them yet (#4520).**
  Two empty tables are added. One is insert-only. The payout row can change status later. Bookings, payments, refunds and Xero are unchanged, and no provisioning step is needed.
