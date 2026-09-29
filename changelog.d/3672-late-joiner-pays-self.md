- **Someone who joins an organiser-paid group after it is paid now pays for
  their own place, instead of being stuck unpaid (#3672).** When an organiser
  pays one combined bill for their group, anyone who joined afterwards could
  never be paid for: the organiser's payment was already settled, and the
  joiner could not pay either, so their booking never confirmed and an officer
  had to sort it out by hand.

  Now, once the organiser has paid, a new joiner gets an ordinary booking they
  pay for themselves, by card or, where the club offers it, Internet Banking,
  like a group where each person pays their own way. The join page tells them
  so before they join. A joiner who joined while the bill was open but was not
  on the one the organiser paid is switched to paying for themselves when the
  payment comes in, and the switch is recorded on their booking's history. If
  they are waiting to pay and their stay has not started, they are emailed a
  link to pay. If their stay has already started they are not emailed
  mid-stay: the treasurer gets one email per group, linking each joiner's
  booking, to collect by hand and record it with Record manual payment under
  Admin tools. A mail outage does not multiply that email: a copy that failed
  is re-sent once by the usual email retry. If no admin can receive it at all,
  it is tried again a day later. The treasurer's email about an overdue
  Internet Banking hold on a stay that has started (#3663) follows the same
  rule. The organiser is never
  charged for them, and the organiser's group card lists them as paying for
  themselves. Groups where each person pays for themselves are unchanged.

  Joiners already stuck this way are fixed automatically by the first run of
  the group-settlement clean-up after this release, in the same way.

  An organiser closing or reopening their group can no longer undo a
  cancellation that happens at the same moment.
