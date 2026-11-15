- **Emailing a group's bank-transfer invoice can no longer hold up bookings
  while Xero is slow, or go out after the group was cancelled (#4919).** The
  combined invoice email is sent while other booking changes briefly wait, so
  that a cancellation cannot slip in between the last check and the send. A
  slow or rate-limited Xero could stretch that wait well past its intended few
  seconds.

  The email is now asked for once, with a three-second limit and no retries
  while bookings wait. If Xero does not answer in time, the invoice stays
  raised and the email is asked for again about a minute later, after the same
  checks, so a group cancelled in the meantime is never sent it. Nothing needs
  doing: a group invoice whose email is still owed stays queued in the Xero
  sync list rather than failing.
