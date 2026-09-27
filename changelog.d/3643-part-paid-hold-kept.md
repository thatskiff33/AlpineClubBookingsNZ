- **An internet banking hold that has started being paid is no longer
  cancelled (#3643).** When a held booking's deadline passed, the payment job
  cancelled it as if nothing had been paid, even when the member had already
  paid part of the Xero invoice — the member lost their beds and the money went
  untracked. The job now reads the booking's invoices from Xero first. If any
  payment is recorded against them, the booking stays confirmed with its beds
  held, and admins get one "Internet banking hold kept" email naming the
  booking, the invoice, and what has been paid and what is still owing. The
  booking is marked paid once the rest arrives, or an officer cancels it through
  the normal cancel path and decides the refund or credit there. A hold whose
  invoice cannot be read from Xero is kept too: one email when that first
  happens, and one last email if it still cannot be read on the check-in date.
  A fully unpaid hold is released exactly as before. The Xero repair tool no
  longer offers to queue or retry a full clearing credit note for an invoice
  with a payment recorded against it; it asks for a person to review instead.
