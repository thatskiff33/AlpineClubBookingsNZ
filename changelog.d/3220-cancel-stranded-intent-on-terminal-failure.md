- **Ending an automatic payment retry is now one step, in one place (#3220).**
  Some card payments cannot be set up at the moment a booking is edited — the
  card provider is briefly unavailable — so the system records what is owed and
  retries it in the background. When those retries run out, that fact matters
  well beyond the retry itself: it is what tells the booking-versus-Xero repair
  tool to stop waiting and raise the invoice for the change.

  Three separate places in the code could end a retry, each written slightly
  differently, and two of them could go wrong in ways an operator would never
  see. One ended the retry by updating the record directly, which fails outright
  if an administrator has since reversed that booking's payment by hand — and
  because that happened inside the code handling the original failure, the error
  escaped and **abandoned every remaining payment retry in that run**. The same
  route could also mark a retry as failed after it had actually succeeded, if
  the worker was still holding an out-of-date copy of it.

  All three now go through a single step that ends a retry properly: it leaves a
  reversed or already-finished record alone instead of failing, sends the admin
  alert whenever a retry is genuinely out of attempts, and never leaves a
  finished retry with a future retry time still on it.

  Nothing about when a retry gives up has changed and no money moves
  differently. What changes is that a batch is never abandoned half done, a
  finished retry cannot be reopened, and anything the system needs to do when a
  retry dies now has exactly one place to be done.
