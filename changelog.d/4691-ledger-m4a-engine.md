- **The member-money journal can now record which debt a payment or refund
  pays, but nothing in the app uses that yet (#4691).** The release adds two
  empty tables for a refund reservation and its release, and checks that a
  payment is not applied for more than it is worth. No screen, charge, card
  payment, refund or Xero document changes, and no extra deploy step is
  required.
