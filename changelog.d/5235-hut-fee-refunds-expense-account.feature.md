- **Hut Fee Refunds can now be mapped to an expense account as well as a
  revenue account (#5235).** On **Xero Setup → Account mapping**, the **Hut Fee
  Refunds** list now offers both kinds, under **Revenue accounts** and
  **Expense accounts** headings. A revenue account shows refunds as a reduction
  of hut fee income; an expense account shows them as their own cost line and
  leaves income gross. Which is right is your treasurer's call. The default is
  unchanged (`200`), so a club that changes nothing sees no change.

  Refund credit notes carry the same GST whichever account you choose. Xero
  decides which tax rates may be used on an expense account, so the Xero check
  on **System Health** now warns a GST-registered club when **Hut Fee
  Refunds** is on an expense account and Xero says the club's tax rate cannot
  be used on expenses, because Xero would reject those credit notes. Read it
  after choosing an expense account.

  Saving a mapping now checks the kind of account, for every mapping: a code
  you set or change that your chart of accounts shows is the wrong kind, such
  as a bank, asset or liability account on **Hut Fee Refunds**, is refused with
  a message naming the mapping, and nothing is saved. A configuration import is
  held to the same rule. A code already stored is left alone when you save
  other mappings; the setup checklist and the mapping row point it out instead.

  Saving the account mappings is now one step that either saves everything or
  nothing (#5391). If someone else changes the same mapping while your save is
  running, you are asked to reload and try again, and two saves at once can no
  longer leave **Opening Credits** sharing an account with another mapping.
