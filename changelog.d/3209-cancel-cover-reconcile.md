- **Four ways of cancelling a booking now re-check that a qualifying adult is
  still on the club's other bookings (#3209).** At a club that requires an adult
  member on a stay, one adult can also cover a second booking belonging to the
  same person, or the other half of a split booking. When something takes that
  adult away the system is meant to notice: it re-checks the bookings that were
  relying on the cover, records the problem on them, opens a compliance incident,
  emails the owner and puts a task in the officer queue.

  Cancelling a group trip as the organiser, and letting an internet-banking
  payment run past its hold, both skipped that check entirely. Both freed the
  beds correctly, which is what made it easy to miss — the cancellation looked
  fully tidied up while another booking of the same member quietly stopped
  satisfying the rule, with the member never told and nothing showing in the
  officer queue. Two more were found the same way while writing the guard for it:
  voiding a card payment because the beds had gone in the meantime, and undoing a
  replacement booking whose price moved between the offer and the confirmation.

  All four now run the same check every other change already runs, as part of the
  cancellation itself, and raise the same record, incident, email and officer
  task. The cancellation can never be held up or refused by that check: a
  cancellation is authoritative, there is nobody to ask when the system is the one
  doing it, and a refusal would simply repeat on the next run — so instead of
  stopping the cancellation the check writes down what the cancellation cost.

  A guard now finds any future cancellation path that forgets this. It looks for
  the status change itself rather than for a helper such a path might happen to
  use, because the helper the first version of the guard looked for is used by
  only about half of them.
