- **Small fixes found while simplifying the code (#5407).** When an officer
  declines a booking request that holds beds, the cancellation's audit entry
  now always records the officer's address as every other cancellation does
  ("unknown" when none can be read), never an empty value.

  The email a member gets when the confirm-pending job cancels their unpaid
  guests' provisional place now shows their own booking's short reference
  (eight characters, as on their invoice) instead of its full internal id.

  The app stops reading or writing `ServerNzSettings.otherLodgesOwnedNames`,
  the lodge-name list older central-server versions sent. No migration runs
  and nothing changes on screen; a later release drops the column, so deploy
  this release before that one (see `docs/UPGRADING.md`).

  The email-change confirmation email now states the expiry the stored link
  actually has, rather than working it out again a moment later.
