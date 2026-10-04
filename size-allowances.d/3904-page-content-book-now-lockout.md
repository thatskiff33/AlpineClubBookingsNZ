# File-size allowances for #3852 — page delete edge cases and Book Now lock-out

Two already-over-budget files grow. Neither is a good split candidate inside
this change: each addition is a step in, or a sentence about, one transaction
or one dialog that already lives in that file, and moving it out would leave
the reader of the DELETE handler or the delete dialog unable to see the whole
sequence in one place.

file: src/app/api/admin/page-content/route.ts
lines: 898
reason: The DELETE transaction gains three steps the issue asks for — the audit
  copy built from the row the delete returned, a P2025 mapped to 404 for the
  loser of two simultaneous deletes, and a post-delete repair of a `PAGE` + null
  Book Now pair — plus a measurement of whether the audit sanitiser kept that
  copy whole, sized from the stored text. The new lines are those steps, the
  error type and the completeness check they need, and the comments saying why
  each one is correct under no lock. They belong beside the transaction they
  are part of; splitting the handler would put the ordering that makes the
  delete safe across two files.

file: src/components/admin/page-content-panel.tsx
lines: 2608
reason: The delete dialog and the post-delete message gain the sentences the
  issue asks for — a check that could not run, relative links not detected, the
  repaired Book Now setting, an incomplete audit copy, and cache wording that
  matches the code. They are lines in two existing arrays of sentences; there
  is nothing to extract that would not be a second home for the same dialog.
