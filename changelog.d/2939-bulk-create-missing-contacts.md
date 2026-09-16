- **You can now find every member with no Xero customer, and create the missing
  ones safely, from one place (#2939).** A club starting out — or coming back
  after a spell where members were added here but not in Xero — had no way to
  answer "how many members have no Xero contact?", let alone do anything about
  it without creating duplicates by hand. **Admin → Finance → Xero Sync → Members
  with no Xero contact** now answers it and does the work.

  It always starts with a **dry run**, which writes nothing here and sends
  nothing to Xero. It gives you counts and three lists: who is ready, who needs
  a decision first, and who is not eligible at all. Only then can you create
  anything; you are asked to confirm, and the confirmation says exactly how many
  brand-new contacts it will create and how many members it will link to
  contacts Xero already has. It works in small batches — so a run that is going
  wrong can be stopped after the first handful rather than the five hundredth.
  The batch size is worked out from what each member costs in Xero API calls, so
  it is smaller on a club that uses contact groups.

  Creating a contact **searches Xero first**. A member whose contact already
  exists there is linked to it rather than given a second one, and running the
  whole thing twice converges on the same contact instead of duplicating it.
  One member failing does not stop a batch, and if Xero's daily call limit is
  reached the run stops cleanly with everything outstanding unchanged.

  **If Xero cannot be asked properly, nothing is done.** A search that fails,
  and a name Xero already has a contact for, both leave that member exactly
  where they were rather than guessing — because a duplicate customer cannot be
  merged away in Xero, and a member silently linked to somebody else's old
  contact would have every invoice and reminder land on the wrong account. The
  result afterwards names every member it touched, says which Xero contact each
  one ended up on, and says what to do about each one it could not.

  **Nothing is guessed.** Members whose situation has more than one defensible
  answer — two members sharing an email address, an address that belongs to a
  school's own Xero customer, several Xero contacts on one address, a contact
  under a different name, or a member whose exact name Xero already has a
  contact for at another address — are listed with the reason and left alone for
  you to sort out. Schools' own records, anonymised accounts, people who lost an
  address they used to inherit, and walk-in placeholders never get a person
  contact created for them at all. The dry run also tells you how old its
  picture of Xero is, and warns you when that is old enough to be misleading.

- **A Xero contact can no longer be claimed by two records through the member
  import or an inbound contact sync (#2939).** Since schools became first-class
  organisations, a school's Xero customer and a person's are two different
  things — but a school's contact carries the school's own email address, which
  is routinely a teacher's. Two paths could still quietly hand that customer to
  a person: importing members from a Xero contact group, and the inbound contact
  sync backfilling member details. Both now refuse, saying which record already
  holds the contact, instead of linking it.
