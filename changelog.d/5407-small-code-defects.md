- **Small fixes found while simplifying the code (#5407).** The email a member
  gets when the confirm-pending job cancels their unpaid guests' provisional
  place now shows their own booking's short reference (eight characters, as on
  their invoice) instead of its full internal id. The same goes for the
  booking-request approved email and the guest payment-link email: a club whose
  own wording for either uses the booking reference token now sees the short
  reference there too, as in other emails.

  The app stops writing `ServerNzSettings.otherLodgesOwnedNames` (it stopped
  reading it in v0.14.0), the lodge-name list older central-server versions
  sent. No migration runs and nothing changes on screen; a later release
  (#5415) drops the column, so deploy this release before that one (see
  `docs/UPGRADING.md`).

  The email-change confirmation and resent email-verification emails now state
  the expiry their stored link actually has, rather than working it out again a
  moment later.

  The blue-green deploy's cron-registration check now recognises the Xero
  membership refresh line the app logs, so a deploy with the daily Xero
  membership refresh turned on no longer fails that check.

  The promo-code redemptions list, and its CSV export's "Booking reference"
  column, now show the same booking reference as the rest of the site (the
  first eight characters of the booking's id, rather than the last eight). The
  export's "Booking ID" column is unchanged.
