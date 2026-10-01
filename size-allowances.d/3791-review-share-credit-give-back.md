# File-size allowances for #3791

file: src/lib/member-credit.ts
lines: 1080
reason: the review share's give-back IS the clamp's give-back of applied credit
  (#3791 asks for one mechanism, not a second), so the shared core has to sit
  beside the clamp, `lockMemberCreditLedger` and `deriveBookingAppliedCreditCents`
  it is built from. Moving it out would import those back from here and split
  one ledger rule across two files; the review-only routing lives in
  `edit-financial-review-account-credit.ts` instead.
