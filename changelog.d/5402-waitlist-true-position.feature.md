- **Waitlist positions are now always the member's true place in the queue
  (#5402).** The position a member saw on their booking, and officers saw on the
  waitlist board and the member's record, was worked out once when they joined
  and never updated, so it stayed at #3 after the two people ahead cancelled or
  were offered a bed. It is now worked out each time it is shown, from the same
  queue the waitlist uses to decide who is offered a bed next, and the waitlist,
  offer and expiry emails quote the same figure.

  A booking with **No emails** switched on is no longer counted in anyone's
  position and shows no number of its own; the members behind it move up while
  it is silenced, and it returns to its original place when the switch is turned
  off. The position counts entries at the same lodge on overlapping nights and,
  where the club orders the queues by join time alone, older entries from other
  lodges that opted into this one. It can move down as well as up, for example
  when a lapsed offer takes its place back. It is a guide rather than a promise:
  a smaller group further back can still be offered a bed a larger group ahead
  would not fit.

  AI Diagnostics no longer reports a waitlist position on its booking search.
  If you use AI Diagnostics, re-run `pnpm run diagnostics:provision-role` once
  after the upgrade, or its database tools refuse to run; the steps are in
  `docs/UPGRADING.md`.
