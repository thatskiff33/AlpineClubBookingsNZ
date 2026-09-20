# File-size allowance for #3530 stage 2b — builders render the stored lines

file: src/lib/xero-credit-notes.ts
lines: 1090
reason: the unapplied (account-credit) note for a booking change gains one
  select-then-render call and the record it spreads into two payloads. The
  selection, the rendering and the coding live in their own modules
  (`booking-modification-document-lines.ts`, `xero-modification-line-items.ts`,
  `xero-hut-fee-line-codes.ts`); what stays here is the call, because only this
  builder knows it is the modification variant of a note that is also raised
  for cancellations, which are never itemised. Splitting the unapplied-note
  builder out of this file is real work that belongs to its own issue, not to
  a lane whose contract is to change no document that has no stored lines.
