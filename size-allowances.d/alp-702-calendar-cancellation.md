# File-size allowances for #5249

The cancelled and bumped emails carry a calendar cancellation and a sentence,
and a date-changing modified email a sentence. The rules live in the new
`src/lib/booking-calendar-removal.ts`; each file below gains only the lines that
hand its result on. The retry job replays a stored body, so it rebuilds the file
at the one place it hands the message to the mail provider; splitting
`retryFailedEmails` here would collide with the parallel retry-job work in
#5298, which the plan keeps this change clear of.

function: src/lib/cron-email-retry.ts#retryFailedEmails
lines: 578
reason: replays a cancelled or bumped email with its calendar cancellation
  file, rebuilt by booking-calendar-removal; the delivery copy also matches
  the standard calendar sentence to whether that retry has an attachment.

file: src/lib/email/booking.ts
lines: 1889
reason: the cancelled, bumped and modified senders each ask
  booking-calendar-removal for the calendar note and file and pass them to the
  template, the token and sendEmail; the rule itself lives in that module.

file: src/lib/email-message-token-contract.ts
lines: 732
reason: declares {{calendarRemovalNote}} and {{calendarUpdateNote}} optional
  for the three templates, the one table that turns the empty-token guard on.
