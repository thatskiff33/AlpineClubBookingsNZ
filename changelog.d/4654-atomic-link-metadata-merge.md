- **Two updates to one Xero link at the same moment no longer lose a detail
  (#4445).** When the app adds details to a stored Xero link, such as a refund
  credit note's status or an invoice's payment count, it used to read the
  stored details and write them back with the new ones. Two updates landing
  together could each read the old details, and the later one then wiped out
  the earlier one's addition. A later repair or recount could then judge that
  link wrongly.

  The new details are now added to the stored ones in a single database step,
  so both updates keep what they wrote. Nothing changes in what is shown, and
  there is nothing to do. One detail stored outside this path, a treasurer's
  note on a voided bank-refund credit note, is no longer masked when a later
  update merges into the same link.
