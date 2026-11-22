# File-size allowances for #5403

file: src/lib/email-message-token-contract.ts
lines: 730
reason: declares `lodgeName` empty-able for the booking-bumped alert and the
  capacity warning. EMPTYABLE_OVERRIDE_TOKENS is the one hand-maintained table
  guard 6 holds to its rules, and guard 4 only checks a token declared there, so
  a second table elsewhere would split what the guards read and let the two
  drift. Splitting the file's guards apart is a refactor of its own.

file: src/lib/cron-confirm-pending.ts
lines: 2009
reason: one import line, `bookingBumpReason` from `@/lib/booking-bump-reason`,
  the same path the email registry imports it from. The alert itself lives in
  its own module; re-exporting the reason through that module to save this
  line was rejected in review as a second import path for one helper.
