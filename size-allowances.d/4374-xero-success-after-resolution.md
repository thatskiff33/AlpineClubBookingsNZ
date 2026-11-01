# File-size allowances for #4374 - a Xero success on a row resolved in Xero alerts once

The alert itself lives in its own module,
`src/lib/xero-success-after-resolution-alert.ts`, inside its budget. Each file
below gains only the hand-off of that alert to the commit it must follow.

file: src/lib/xero-sync.ts
lines: 1142
reason: the writer is the one place that knows whether its own transaction or
  its caller's commits the row, so the choice between sending the alert after
  its own commit and handing it back as `deferredPostCommit` sits beside that
  transaction; one import, the return type and the two comment lines.

file: src/lib/xero-contacts.ts
lines: 2069
reason: the member-contact update completion owns the transaction the writer
  runs in, so it alone can run the returned alert after that commit; one line.

file: src/lib/xero-contact-create-recovery.ts
lines: 869
reason: the member-contact create completion owns the transaction the writer
  runs in, so it alone can run the returned alert after that commit; one line.
