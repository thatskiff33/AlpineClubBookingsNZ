- **A bank-transfer refund whose Xero credit note is voided comes back to the
  refund list, with one question (#4162).** Before, voiding the credit note
  for a bank refund left the club's records disagreeing with each other: the
  payment's total said one thing, its refund history another, and nothing told
  the treasurer. Now each night the app takes that refund back out of the
  payment's records and puts it back on **Money to settle** as owed, asking:
  has the money gone to the member? The answers are **Yes, raise a fresh credit
  note** (one new note, dated today), **Yes, I already recorded it in Xero
  myself** (type the note's number; the app checks Xero has it, live, for the
  right amount, and keeps track of it), **Not yet** (leave it on the list) or
  **No, the club keeps it** (with a reason). The member is not emailed and
  nothing is raised in Xero until someone answers. A voided note that was only
  a duplicate changes nothing. A note the app cannot match to one refund is
  listed on **Stuck States** for a person to check instead.

  What you need to do: this ships switched off, reporting only. Before turning
  it on, run `pnpm run xero:bank-refund-void-count` to see how many voided
  bank-transfer refund notes there already are and what will happen to each,
  then set `XERO_ENABLE_BANK_REFUND_VOID_WRITES=true`. The first night after
  that puts each older void on the refund list too.
