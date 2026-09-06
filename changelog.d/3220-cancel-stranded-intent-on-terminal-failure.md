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

- **A booking change's card request is now withdrawn when the club gives up on
  it (#3220).** Some card requests cannot be set up at the moment a booking is
  changed, so the system records what is owed and keeps retrying in the
  background. When those retries run out, the invoice for the change is raised
  in Xero as unpaid and collected the ordinary way.

  Until now, if a card request had nevertheless ended up sitting against that
  change, it was left live. The member could still pay it - and then the club
  held both a payment and an unpaid invoice for the same money, with no way to
  tell which was right except by someone noticing and working it out.

  The system now withdraws that card request at the moment it gives up. A
  request the member has already paid is never touched, and neither is one that
  has already been withdrawn, so nothing is taken back and no member is charged
  or refunded by this. Nothing is written off either: the money is still owed
  and the invoice still stands - what goes away is the second way to pay it.

  There is one case where the request is deliberately left live: when the Xero
  invoice for that same change is itself still queued and waiting for that exact
  payment. Nothing has been invoiced in that situation, so there is no second
  way to pay anything - and withdrawing the request would remove the only live
  way to collect the money while leaving the queued invoice waiting for a
  payment that can never come. The member can still pay it, which is the tidy
  ending; if nobody does, the queued invoice is retired after fourteen days and
  the booking-versus-Xero repair tool raises the invoice the ordinary way.

  If the card provider refuses to withdraw the request - it will not cancel one
  it is already processing - that is now recorded in the audit log against the
  booking, with what an officer needs to do about it, instead of being left for
  somebody to find. A refusal never stops the retry being closed off properly.
