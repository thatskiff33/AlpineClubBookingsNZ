# File-size allowance for #4673 (a late failure keeps an officer's Retry)

file: src/lib/xero-operation-outbox.ts
lines: 3472
reason: the outbox's failure catch now reads whether its failure write landed
  and, when `INV-INT-029` refused it (the row is no longer this run's, such as
  one an officer's Retry queued again), counts the row skipped and exposes no
  subscription-charge error. That decision belongs in the one catch that holds
  the failed count and the charge exposure; moving eight lines of it to a
  helper would split one ordering (fail first, then expose) across two files.
  Measured again after merging main with #4684 (#4656). That PR's
  `RefundNoteNotRecordedError` branch in the same catch, and its own
  allowance, now sit in the base, so this file's length is both changes
  together.
