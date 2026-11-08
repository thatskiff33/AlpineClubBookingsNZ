- **A credit note's allocation repair no longer sends Xero an allocation that
  was already made (#4767).** Before #4757 the booking repair tool could offer
  a plain retry of one allocation from a cancelled booking's invoice-clearing
  credit note, or a booking edit's credit note. That retry recorded the
  allocation without marking it as the note's own. The note's own repair then
  treated that invoice as still unallocated and sent the same allocation to
  Xero again, which Xero could refuse, leaving the note marked partial.

  The note's repair, and the repair report, now count such an allocation as
  done when it names the same credit note, invoice and amount, and allocate
  only the invoices left. An allocation for a different note, invoice or
  amount still does not count. Nothing changes in Xero, and no stored record
  is rewritten.
