- **Officer money figures now subtract refunds and credits (#3372).** The
  dashboard's "Revenue This Month" card is now **"Net Collected This Month"**.
  It used to count only fully successful payments and never took a refund off,
  so a partly refunded payment was left out of it entirely. It now counts every
  payment recorded this month that has taken money, less the refunds and
  account credits on it. Because partly refunded payments are now counted at
  their net amount, this figure **may go up or down** compared with before. A
  payment counts in the month its record was created. When anything has been refunded or credited, the amount paid
  and the amount refunded or credited appear beneath it, in exact cents.

  On the Payments page, the "Total Revenue" card is now **"Net Collected
  Cash"**, the name Reports already uses for the same calculation. It used to
  add up every payment in the list at its full amount, including pending and
  failed ones. It now counts only payments that were actually taken, less
  their refunds and credits, so this figure can **go up or down**. Each money
  card now says in small print what it covers. On a partly refunded payment, the line under each row's amount now
  reads "refunded or credited" rather than "refunded", because the amount
  taken off may have gone back as account credit instead of to the card.
  When a payment the card counts records an addition as collected with no
  matching ledger record, a warning beneath the cards now says how much Net
  Collected Cash may understate, the same warning Reports shows.

  All four "Net Collected" figures (the dashboard card, the Payments card,
  Reports' Net Collected Cash and the Finance dashboard's card, #3637) now count the same bookings: every booking
  that has not been deleted, whatever its status. A cancelled booking counts
  only money that was actually paid on it and not refunded or credited back,
  so **Reports and the Payments card now include money the club kept when a
  booking was cancelled** (before, both left cancelled bookings out, and
  Reports also left out bumped ones), and the dashboard card now leaves
  deleted bookings out. A booking cancelled before anything was paid adds
  nothing to any of the four, whatever its cancellation policy would charge,
  and a refund recorded against one payment never comes off another booking's
  money. Reports' other figures keep their booking list, and
  its lodge and date filters still apply to Net Collected Cash.

  The booking change requests panel shows a partly refunded payment at its net
  amount, with the amount paid and the amount refunded or credited underneath.
  The refund requests page now labels its "Paid" figure "Gross paid", meaning
  the amount before any refund, and the "Remaining" figure beside it
  "Remaining refundable", the amount that can still be refunded.

  Nothing stored has changed; only how these figures are worked out and
  labelled.
