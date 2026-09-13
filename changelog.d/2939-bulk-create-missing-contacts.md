- **You can now find every member with no Xero customer, and create the missing
  ones safely, from one place (#2939).** A club starting out — or coming back
  after a spell where members were added here but not in Xero — had no way to
  answer "how many members have no Xero contact?", let alone do anything about
  it without creating duplicates by hand. **Admin → Finance → Xero Sync → Members
  with no Xero contact** now answers it and does the work.

  It always starts with a **dry run**, which writes nothing here and sends
  nothing to Xero. It gives you counts and three lists: who is ready, who needs
  a decision first, and who is not eligible at all. Only then can you create
  anything, and you do it in batches of at most 25 — so a run that is going
  wrong can be stopped after the first handful rather than the five hundredth.

  Creating a contact **searches Xero first**. A member whose contact already
  exists there is linked to it rather than given a second one, and running the
  whole thing twice converges on the same contact instead of duplicating it.
  One member failing does not stop a batch, and if Xero's daily call limit is
  reached the run stops cleanly with everything outstanding unchanged.

  **Nothing is guessed.** Members whose situation has more than one defensible
  answer — two members sharing an email address, an address that belongs to a
  school's own Xero customer, several Xero contacts on one address, a contact
  under a different name — are listed with the reason and left alone for you to
  sort out. Schools' own records, anonymised accounts and walk-in placeholders
  never get a person contact created for them at all.

- **A Xero contact can no longer be claimed by two records through the member
  import or an inbound contact sync (#2939).** Since schools became first-class
  organisations, a school's Xero customer and a person's are two different
  things — but a school's contact carries the school's own email address, which
  is routinely a teacher's. Two paths could still quietly hand that customer to
  a person: importing members from a Xero contact group, and the inbound contact
  sync backfilling member details. Both now refuse, saying which record already
  holds the contact, instead of linking it.
