# File-size allowance for #4338 — a lost Xero operation start whose winner already finished

file: src/lib/xero-sync.ts
lines: 1134
reason: the lost-start rule (return the winner's active row; insert again only
  when the newest row FAILED, unresolved or closed by the converge; never read on a caller's transaction,
  which the unique violation has aborted) resolves the one `create` in
  `startXeroSyncOperation` and has to sit in that function's catch, beside the
  #1354 lookup it extends. Moving it out would split one insert's error
  handling across two files, and the bound on re-inserts is kept as a named
  constant rather than an inline 3.
