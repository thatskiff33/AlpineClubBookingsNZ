- **A school booking no longer trips the hosting rule's safety fence, so
  recording a teacher's membership payment or standing works again (#3480).**
  Since schools became bookings owned by the school itself rather than by an
  invented member, the adult-member hosting rule had two different ideas of
  which bookings it should re-check when a member's standing changes. One half
  correctly left the school's booking out; the other half still put it in. When
  a club member was a guest on a school's booking at a lodge running the rule,
  the disagreement looked like a concurrent edit, and recording that member's
  manual subscription payment, deactivating them, or syncing their standing
  from Xero failed with "this booking or member changed, reload before trying
  again" — every time, with nothing to reload. Approving a school booking
  request at such a lodge failed the same way, as did a school's Xero invoice
  being marked paid. There is now one answer to "is this booking part of the
  hosting rule's re-check?", asked by both halves, and a school's booking is
  simply not one: its hosting review is still recorded for an officer to see,
  but nothing about a member's account is queued for it.

- **Copying a school booking now says so (#3480).** An officer pressing Copy on
  a booking owned by a school was told "The booking member is inactive". The
  refusal now says that the booking belongs to a school rather than to a member
  and cannot be copied, and points to approving a new school booking request
  instead.

- **Admin lists no longer link a school to a member page that does not exist
  (#3480).** On the bookings, payments and waitlist lists and the Xero health
  panel, a school-owned booking's name was a link to `/admin/members/undefined`.
  The school's name is now plain text there, as it already was on the booking
  change-requests panel.

- **Rolling the school cutover back no longer invents a promo discount
  (#3480).** The reverse script gives each school booking back to the member
  who owned it, and writing that member back onto the booking's promo
  redemption made the database's own bookkeeping trigger add a discount
  allocation that had never existed — for a promo assigned to named guests
  rather than to the booker, one carrying the whole discount a second time.
  Nothing a club could see while the cutover stood, and no amount a member was
  charged, but the rollback is the path taken when a cutover goes wrong and it
  has to leave the books as it found them.

- **The school cutover's "not everyone has been classified yet" refusal now
  tells the operator how to carry on (#3480).** It said to record the missing
  decisions and run the migration again. Running it again failed a second time
  with a different error, because the refused attempt is recorded as a failed
  migration and has to be cleared first. The refusal, the cutover guide and the
  upgrade runbook now all give the exact command, and the runbook also covers
  backing out of the maintenance window if the decision needs somebody who is
  not there.
