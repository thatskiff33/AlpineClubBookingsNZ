- **Hut Fee Refunds can now be mapped to an expense account as well as a
  revenue account (#5235).** On **Xero Setup → Account mapping**, the **Hut Fee
  Refunds** list now offers both kinds, under **Revenue accounts** and
  **Expense accounts** headings. A revenue account shows refunds as a reduction
  of hut fee income; an expense account shows them as their own cost line and
  leaves income gross. The same account takes the nights a booking edit
  removes, so with an expense account an edit that swaps nights shows a cost
  and new income, not one net figure. Which is right is your treasurer's call.
  The default is unchanged (`200`), so a club that changes nothing sees no
  change.

  Refund credit notes carry the same GST whichever account you choose. Xero
  decides which tax rates may be used on an expense account, so for a
  GST-registered club the save refuses an expense account on **Hut Fee
  Refunds** when Xero says a tax rate refund notes can still carry cannot be
  used on expenses, because Xero would reject those credit notes; the refusal
  shows on that row. The Xero check on **System Health** warns if that changes
  later in Xero. A failed card refund's reversal invoice is now coded like the
  card refund note it undoes, even after the mapping changes.

  Saving a mapping now checks the kind of account, for every mapping: a code
  you set or change that your chart of accounts shows is the wrong kind, such
  as a bank, asset or liability account on **Hut Fee Refunds**, or that is not
  an active account, is refused with a message naming the mapping, and nothing
  is saved. When the app's copy of the chart is over an hour old the save reads
  it from Xero first, and says to try again if Xero cannot be reached; only
  while Xero is not connected is a code saved unchecked. Revenue mappings now
  accept sales and other-income accounts too. A configuration import is held
  to the same rules; with a stale copy it asks you to refresh the reference
  data first. A code already stored is left alone when you save
  other mappings; the setup checklist and the mapping row point it out instead.
  The **Subscription account code** list on the subscription lockout screen
  now offers revenue accounts only, the kind that mapping accepts.

  Saving the account mappings is now one step that either saves everything or
  nothing (#5391). If someone else changes the same account code while your save is
  running, you are asked to reload and try again, and two saves at once can no
  longer leave **Opening Credits** sharing an account with another mapping.
