- **A booking change's Xero documents now itemise what changed (#3530, stage 2
  of 3).** The supplementary invoice for a price increase, and the credit note
  for a reduction, used to carry one line — "Booking modification - price
  adjustment" — at the net figure. They now list the lines the change recorded
  (stage 1): which guest category, at which rate, for which nights, and any
  change to a promotion, for example
  "1 x Non-member Adult added - 1 night - 14 Aug 2026 - 15 Aug 2026" at
  1 × $80.00. Added nights post to hut-fee income with the guest's own item
  code, exactly as the original invoice codes them; removed nights post to the
  hut-fee refunds account; on a credit note the removed nights are the credit.
  The change-fee line, the refund-method wording (stage 0) and every document
  reference are unchanged.

  A document is itemised only when the recorded lines add up exactly to what
  it bills. When they do not — a change whose money a person had to price, a
  follow-on ask for part of a change, a refund the club kept part of, a
  re-stated amount, or a change made before stage 1 — the document reads
  exactly as it did before, and the operation records why. No amount, Xero key
  or retry behaviour changes.
