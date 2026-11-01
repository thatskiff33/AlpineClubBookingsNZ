- **The member-money ledger gains its posting command and a GST setting, with
  nothing posting yet (#4626).** This is the first of three steps that will
  record booking charges in the app's own double-entry ledger. It adds the one
  command every later step posts through. That command records each business
  event as a single balanced entry, and it refuses an entry that does not
  balance before writing anything. Replaying the same event changes nothing,
  and replaying it with different amounts is refused rather than skipped.

  It also adds a record of the club's GST treatment: whether the club is
  GST-registered, the rate, and the date it applies from. Until a club records
  otherwise, the app uses the treatment its Xero invoices already show: GST
  included in every price at 15%. The ledger will split tax out of each charge
  in whole cents on that basis.

  Nothing changes for members or officers in this release. No booking, payment
  or screen uses the ledger yet, and there is no screen for the GST setting.
