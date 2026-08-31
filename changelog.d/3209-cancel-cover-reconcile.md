- **Two ways of cancelling a booking now re-check that a qualifying adult is
  still on the club's other bookings (#3209).** At a club that requires an adult
  member on a stay, one adult can also cover a second booking belonging to the
  same person. When something takes that adult away the system is meant to
  notice: it re-checks the bookings that were relying on the cover, opens a
  compliance incident, emails the owner and puts a task in the officer queue.

  Cancelling a group trip as the organiser, and letting an internet-banking
  payment run past its hold, both skipped that check entirely. Both freed the
  beds correctly, which is what made it easy to miss — the cancellation looked
  fully tidied up while another booking of the same member quietly stopped
  satisfying the rule, with the member never told and nothing showing in the
  officer queue.

  Both now run the same check every other change already runs, as part of the
  cancellation itself, and raise the same incident, email and officer task. The
  cancellation can never be held up or refused by that check: a cancellation is
  authoritative, and there is nobody to ask when the system is the one doing it.
