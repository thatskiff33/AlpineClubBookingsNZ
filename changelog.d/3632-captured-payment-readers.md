- **Payment readers now share their captured-status definitions (#3632).** Xero
  invoice handling, finance figures, admin reports, modification-payment replay
  handling and webhook replay handling now use the aggregate `Payment` or
  individual `PaymentTransaction` definition that matches the row being read.
  This preserves the current cash, invoice and replay results while keeping the
  two meanings independent for a future status change.

- **The Internet Banking applied-credit audit now identifies cash loss from
  transaction evidence.** A repaired aggregate payment mirror alone no longer
  makes an unpaid bank-transfer row look realized; the read-only audit requires
  a captured payment transaction before it reports an already-realized strand.

- **The group-cancellation `SUCCEEDED`-only refund condition remains frozen for
  #3653.** Its refund plan is produced from the group settlement and recovered
  from the stored plan, so widening that condition here could claim a refund for
  organiser-settled children with no child payment mirror. #3653 owns the
  producer and recovery correction before the #3503 wave is merged.
