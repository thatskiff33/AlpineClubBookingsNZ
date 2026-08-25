- **A test or staging copy of the club's site can no longer have the accounting
  system email real members either (#3036).** The previous change stopped a copy
  sending its own mail. It could not stop Xero sending: when an invoice is
  outstanding, Xero's own reminders go out from Xero's servers to whatever email
  address is stored on the contact, and this application is not involved at all.
  A copy restored from the live database holds every member already linked to their
  real Xero contact, so raising a single test invoice on a copy was enough to start
  Xero chasing a real member for money they do not owe.

  So on a copy, the first time a Xero contact is needed, the email address on that
  contact is replaced with one that can never be delivered. After that Xero has
  nobody to email. Every member's real address is still correct in the database and
  on the club's live site; it is only the copy's view of Xero that changes.

  What an operator will notice, on each kind of installation:

  - **The club's live site behaves exactly as before.** Nothing is transformed,
    nothing is recorded, and every invoice, credit note and contact goes to Xero
    unchanged.
  - **A copy keeps raising invoices and credit notes**, deliberately — an invoice
    that is never raised cannot be paid, settled or reconciled, so a copy that
    stopped raising them would be useless for testing the very thing people
    restore a copy to test. Invoices stay approved and settlement behaves as it
    does live. What changes is that the contacts they are raised against can reach
    nobody.
  - **An installation nobody has declared writes nothing to Xero at all** — no
    invoice, no credit note, no contact, no payment, no credit allocation.
    Reading from Xero still works, so the Xero screens keep loading and somebody
    can work out what has happened. This is stricter than the email rule and on
    purpose: the answer decides what address may sit on a contact, the member's
    real one on the live site and a replaced one on a copy, and guessing wrong in
    one direction emails real members while guessing wrong in the other rewrites
    the club's real accounting. Declare the role and Xero work resumes; anything
    refused can be re-driven from **Admin → Xero**, because the refusal happens
    before the first call and nothing is left half-written.

  **The one thing to know before pointing a copy at Xero.** If a copy is connected
  to the club's *real* Xero organisation, replacing those addresses is a real edit
  to real accounting records. Point a copy at a separate demo or trial
  organisation wherever you can. If one has already been connected to the real
  organisation, **Admin → Environment** now shows how many contacts have been
  contained and, separately, how many of those were holding a working address that
  was overwritten — the second number is the one that means act now — and it
  **lists those contacts**: whose they are, a link straight to each one in Xero,
  and when it happened. Putting an address back is a manual job in Xero, and the
  screen and the operator guide both say so plainly and say why: a copy is not
  allowed to write a real address to a Xero contact, and the live site has no
  record of what the copy changed. The figures report "not available" rather than
  a reassuring zero if they cannot be read.

  **Switching the "treat this as a copy" override on does not stop this — it
  starts it.** Replacing addresses is what an installation does once it is
  confirmed to be a copy, so on an installation that was resolving *production*
  and is connected to the club's real Xero organisation, switching the override on
  begins editing real contacts. It stops email to members. To stop Xero work,
  disconnect Xero there or point it at a different Xero organisation. An earlier
  draft of the operator guide had this exactly the wrong way round.

  **The replacement address is deliberately recognisable and deliberately not a
  "no email address" marker.** It looks like
  `contained-<letters and numbers>@xero-sandbox.invalid`, always the same for the
  same person so a contained contact can be told apart from one edited by hand, and
  the real address cannot be read back out of it. It is a different kind of address
  from the `no-email.invalid` one used for a walk-in guest who never gave an
  address: that one marks a member as unreachable and makes the app skip their
  reminders, and a contained member is not unreachable — they can be reached
  perfectly well by the club, from the live site. Keeping the two apart is what
  lets a copy go on behaving like the real thing.

  Two smaller consequences on a copy. The "import this Xero contact as a member"
  tools now refuse a contact whose address has been contained, and say why — a
  member created from one would look reachable on every screen and be able to
  receive nothing. And the bulk contact sync, which matches members to contacts by
  email address, simply stops matching contained ones and reports them as
  unmatched.

  Finally, the mock-Xero test harness now takes the deployment's own declaration
  as the first word on whether this is the live site, rather than working it out
  from the build mode alone. The old check is kept underneath it, so nothing that
  used to be blocked becomes possible — an installation that has declared nothing
  is still caught the way it always was.
