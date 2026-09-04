- **The rule that gives a booking-exception request its tamper-proof fingerprint
  is now written in one place instead of two, and is proved not to have changed
  in the move (#3218).** Nothing an administrator or member does is different,
  and nothing on screen changes. This is a tidy-up inside the system, recorded
  because of what it was careful about rather than what it altered.

  When a member asks for an exception to a booking policy, the system stores a
  short fingerprint of exactly what was asked for. When an officer later
  approves it, the system works the fingerprint out again from the frozen
  request and checks the two match, so a request cannot be quietly altered
  between being asked for and being carried out. The recipe for that fingerprint
  was written out twice in the code, for a reason that stopped being true a few
  releases ago. It is now written once.

  The care taken is the point. If the recipe had changed even slightly in the
  move, every exception request already waiting for a decision would have failed
  its check on approval and been treated as altered — a problem that would only
  have surfaced weeks later as an officer being unable to approve a request for
  no visible reason. So a set of tests pinning the exact fingerprints was written
  and deliberately broken first, to confirm they would catch such a change, and
  the tidy-up was only then made. The same pinned fingerprints pass afterwards,
  untouched, which is what makes "nothing changed" a measured fact rather than
  an expectation. Those tests stay in place, so any future change to this recipe
  will fail loudly instead of silently.
