- **Emails the hold-deadline job owes are no longer lost if the app is
  interrupted (#5433).** The scheduled job that acts on unpaid bookings at
  their hold deadline changes the booking first and emails afterwards. If the
  app stopped in between, the email was never sent and no later run noticed.
  Each of these emails is now recorded as owed together with the change, and a
  later run (every 30 minutes) sends any that did not go. This covers the
  confirmation of a booking with nothing to pay, the notices to the member and
  to officers when an unpaid request booking or a non-member guest portion is
  cancelled, the payment link for a non-member guest portion, and the request
  to save a new card when a saved card can no longer be charged. No member is
  sent the same email twice by this.

  What members notice: an email that was missed arrives late, usually within
  an hour. A late confirmation is built from the booking as it is when it goes.
  A payment link that was never emailed is replaced by a new one before it is
  sent, at most three times. Late sending stops after seven days, or earlier at
  the booking's own date: the end of the check-in day for a confirmation, a
  payment link and a new-card request, and the end of the check-out day for a
  cancellation notice.

  What officers notice, by owner decision: a new alert, "Booking email not
  sent", on the "Booking review required" preference. It is sent once when one
  of these emails could not be sent in time, or did not reach the member: the
  send failed, the address bounced or is on the suppression list, or the owner
  has no address that can be emailed. A booking confirmed with nothing to pay
  whose owner cannot be emailed raises "Booking confirmation not sent", as a
  card payment already does. The alert about a saved card that can no longer
  be charged now says the member's email is sent separately, in place of
  saying it has been sent.

  During the upgrade, a server still running the previous version sends these
  emails the old way and records nothing as owed. The regular reminders to
  officers about an unpaid request or guest portion are unchanged: the next
  reminder goes out on its usual day.
