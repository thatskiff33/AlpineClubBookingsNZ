- **The expected arrival time on a booking is retired, and the times already
  entered are deleted (#2621).** Under the motel-stay rule everyone who stays a
  night is at the lodge from midday on their arrival date to midday on their
  departure date, so the system no longer collects travel times. The field is
  gone from both booking wizards, admin book-on-behalf, the booking page, the
  lodge kiosk and the pre-arrival reminder email; a guest who needs different
  timing arranges it with the hut leader.

  **The stored arrival times are deleted with the column and cannot be
  recovered afterwards** — this is a deliberate committee decision, and the
  rollback script restores an empty column only, saying exactly that. A club
  that wants a record of the entered times must take a copy before upgrading;
  the production upgrade runbook now includes the copy commands.

  A club that customised its pre-arrival email keeps exactly the wording it
  wrote: the two arrival placeholders remain valid forever and simply print
  nothing, so saved templates keep validating and sending. The built-in
  default gains one sentence — for clubs that run chore rosters only — telling
  guests they are on the roster on their check-out morning and to talk to the
  hut leader beforehand if leaving early. An out-of-date app or integration
  that still sends the old field on booking create is accepted and the value
  ignored.

  **For operators: this release cannot be deployed blue/green.** The previous
  release breaks the moment the column is dropped, so the old version and all
  its background workers must be stopped first. The deployment guide and
  upgrade runbook carry the exact sequence.
