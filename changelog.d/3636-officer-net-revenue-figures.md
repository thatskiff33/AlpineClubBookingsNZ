- **Officer money figures now subtract refunds and credits (#3372).** The
  dashboard's "Revenue This Month" card is now **"Net Collected This Month"**.
  It used to count only fully successful payments and never took a refund off,
  so a partly refunded payment was left out of it entirely. It now counts every
  payment recorded this month that has taken money, less the refunds and
  account credits on it. Because partly refunded payments are now counted at
  their net amount, this figure **may go up or down** compared with before. A
  payment counts in the month its record was created, and cancelled bookings
  are included. When anything has been refunded or credited, the amount paid
  and the amount refunded or credited appear beneath it, in exact cents.

  On the Payments page, the "Total Revenue" card is now **"Net Collected
  Cash"**, the name Reports already uses for the same calculation. It used to
  add up every payment in the list at its full amount, including pending and
  failed ones. It now counts only payments that were actually taken, less
  their refunds and credits, and still leaves out cancelled bookings, so this
  figure **only falls**. Each money card now says in small print what it
  covers.

  The booking change requests panel shows a partly refunded payment at its net
  amount, with the amount paid and the amount refunded or credited underneath.
  The refund requests page now labels its "Paid" figure "Gross paid", meaning
  the amount before any refund.

  Nothing stored has changed; only how these figures are worked out and
  labelled.
