- **Officer money figures now subtract refunds and credits (#3372).** The
  dashboard's "Revenue This Month" card is now **"Net Collected This Month"**.
  It used to count only fully successful payments and never took a refund off,
  so a partly refunded payment was left out of it entirely. It now counts every
  payment recorded this month that has taken money, less the refunds and
  account credits on it. Because partly refunded payments are now counted at
  their net amount, this figure **may go up or down** compared with before. A
  payment counts in the month its record was created. When anything has been refunded or credited, the amount paid
  and the amount refunded or credited appear beneath it, in exact cents.

  On the Payments page, the "Total Revenue" card is now **"Net
  Collected"**, the name Reports uses for the same calculation. It used to
  add up every payment in the list at its full amount, including pending and
  failed ones. It now counts only payments that were actually taken, less
  their refunds and credits, so this figure can **go up or down**. Each money
  card now says in small print what it covers. On a partly refunded payment, the line under each row's amount now
  reads "refunded or credited" rather than "refunded", because the amount
  taken off may have gone back as account credit instead of to the card.
  When a payment the card counts records an addition as collected with no
  matching ledger record, a warning beneath the cards now says how much Net
  Collected may understate, the same warning Reports shows.

  All four "Net Collected" figures (the dashboard card, the Payments card,
  Reports' Net Collected and the Finance dashboard's card, #3637) now count the same bookings: every booking
  that has not been deleted, whatever its status. A cancelled booking counts
  only what the club kept of what was actually paid on it: money not refunded,
  credited back or owed back by hand, plus any account credit the
  cancellation kept. So **Reports and the Payments card now include money the
  club kept when a booking was cancelled** (before, both left cancelled
  bookings out, and Reports also left out bumped ones), and the dashboard card
  now leaves deleted bookings out. A booking cancelled before anything was
  paid adds nothing to any of the four, whatever its cancellation policy would
  charge. When a booking paid by hand is cancelled, the refund the club still
  owes is taken off straight away, before an officer marks it paid back. A
  refund recorded against one payment never comes off another booking's
  money. When the dashboard card counts money owed back or credit kept, the
  line beneath it says so. Reports' other figures keep their booking list, and
  its lodge and date filters still apply to Net Collected.

  Reports' card, which was titled "Net Collected Cash", is now titled **"Net
  Collected"**, like the Payments and Finance dashboard cards, because the
  figure now includes account credit a cancellation kept as well as cash
  ([owner decision](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3372#issuecomment-5967932154)).
  Only the dashboard card has a breakdown line beneath it; besides the amount
  paid and the amount refunded or credited, it now also shows any money owed
  back and any account credit kept on a cancellation. The Finance card's small
  print now says the figure is worked out from this app's own payment, account
  credit and refund records, not from Xero revenue.

  The booking change requests panel shows a partly refunded payment at its net
  amount, with the amount paid and the amount refunded or credited underneath.
  The refund requests page now labels its "Paid" figure "Gross paid", meaning
  the amount before any refund, and the "Remaining" figure beside it
  "Remaining refundable", the amount that can still be refunded.

  Nothing stored has changed; only how these figures are worked out and
  labelled.
