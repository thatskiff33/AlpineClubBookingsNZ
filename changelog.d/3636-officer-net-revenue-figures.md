- **Officer revenue figures now subtract refunds (#3372).** The dashboard's
  "Revenue This Month" card counted only fully successful payments, and it never
  took a refund off. A partly refunded payment disappeared from it entirely. The
  card now shows what the club holds from payments taken this month, less the
  refunds on them. When anything has been refunded, the amount paid and the
  amount refunded appear beneath.

  On the Payments page, the "Total Revenue" card is now **"Net Revenue"**. It
  used to add up every payment in the list at its full amount, including pending
  and failed ones. It now counts only payments that were actually taken, less
  their refunds, and still leaves out cancelled bookings. Each money card now
  says in small print what it covers.

  The booking change requests panel shows a partly refunded payment as its net
  amount, with the amount paid and the amount refunded underneath. The refund
  requests page now labels its "Paid" figure "Gross paid", meaning the amount
  before any refund.

  Nothing stored has changed; only how these figures are worked out and
  labelled. Expect them to come out lower than before by the refunds involved,
  which brings them closer to Xero.
