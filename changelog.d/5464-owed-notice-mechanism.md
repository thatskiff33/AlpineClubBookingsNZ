- **Emails a booking change owes now have one shared way to be sent later
  if the first attempt never started (#5433).** When a scheduled job changes a
  booking and the process stops before the email about it goes out, a later
  run notices and sends it. A few notices already had a recovery of their own;
  the notices for a pending booking released for lack of room had one built for
  them alone. They now use one shared mechanism, recorded in a new database
  table that the usual migration step creates, which later changes reuse.

  Members and officers see no change in this release: the same notices go out
  with the same wording, a member still never receives one twice, and a
  recovered notice can now arrive sooner, because the email retry job (every
  30 minutes) also looks for them: a send that failed before its email record
  was written is retried about every hour to hour and a half, where it was
  every three hours (a provider failure is still replayed by the failed-email
  retry, as before). Later changes for #5433 move the other
  confirmation, cancellation and waitlist emails onto the same mechanism.
