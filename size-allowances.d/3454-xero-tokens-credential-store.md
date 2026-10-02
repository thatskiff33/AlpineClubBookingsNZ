# File-size allowances for #3454

file: src/app/api/admin/deletion-requests/[id]/route.ts
lines: 1305
reason: the erasure's two-factor clear must be audited inside the erasure
  transaction, after its member row lock, so the call has to sit at that point
  in the transaction body. The read and the audit write already live in
  `two-factor-audit.ts`, and what is left here is the call and its context.

file: src/app/api/admin/integrations/credentials/route.ts
lines: 315
reason: a Xero client id or secret must now be written inside the verify-reset's
  transaction, so the write site chooses between the in-transaction writer and the
  ordinary one. The choice stays at the route because the credential census reads
  the literal admin actor at each write site, and a helper would turn both into
  forwarded actors. The rule for which keys reset the tokens has moved out to the
  token store.

file: src/lib/xero-api-client.ts
lines: 789
reason: the refresh must check that its rotated pair can be stored before it
  spends the refresh token, so that one call has to sit between building the
  client and calling Xero, inside this function's lease-and-mutex block. The
  check itself lives in `xero-token-crypto.ts`; what is added here is the call,
  its import and a one-line comment, plus the two lines that let a refusal
  alert like any other refresh failure without being rewritten as "reconnect".
