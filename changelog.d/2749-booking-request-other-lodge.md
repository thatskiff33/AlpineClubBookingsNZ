- **A booking requester can now say which other lodge they belong to (#2749).**
  The public booking request form gains an **"Are you a member of another
  lodge?"** drop-down, on the line after Check-in and Check-out. It lists the
  lodges from the **Other lodges** registry (Admin → Setup & Configuration →
  Lodges) and **defaults to "No"**. Leaving it on "No" behaves exactly as before
  — the value is blank, so requests made before this existed, and anyone who
  doesn't pick a lodge, are unaffected.

  When a requester does pick a lodge, the choice is saved with the rest of the
  request so it is available when an officer reviews it (the reciprocal
  "other club member" handling at review time is a later step). The drop-down
  only appears when at least one other lodge has been added to the registry.
