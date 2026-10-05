# File-size allowance for #52 — a replaced central-server key forgets the owned-lodge list

One already-over-budget file grows by four lines: one import and a three-line
verify-reset hook (a two-line comment and one guarded call). It sits beside the
Xero, Stripe and Google verify-reset hooks in `applyVerifyReset`, which is the
one place every credential write passes through, and that is the point: the
owned-lodge list the Alpine Central Server issued for the previous API key must
be forgotten the moment a replacement key is stored, in the same request. A
hook lifted into `setServerNzApiKey` would not fire, because this route writes
through `setIntegrationCredential` directly like every other provider, and a
reviewer reading the other three resets expects to find the fourth next to them.

file: src/app/api/admin/integrations/credentials/route.ts
lines: 301
reason: the fourth provider-specific verify-reset, three lines plus its import,
  next to the three it mirrors. Comment compressed to two lines before this
  allowance was written; the import is the one line that cannot be removed.
