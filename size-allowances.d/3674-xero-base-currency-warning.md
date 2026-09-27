# File-size allowances for #3633 (PR #3674 — the Xero base-currency warning)

Three files that were already over budget grow here, and each one grows by a
field or a branch placed beside the siblings it extends. The new logic that
could live elsewhere already does. The comparison is in
`src/lib/xero-base-currency.ts`, the finance-gated reader in
`src/lib/xero-base-currency-server.ts`, and the sentence in
`src/lib/club-format-copy.ts`. All three are new and inside their budgets.

file: src/lib/xero-organisation.ts
lines: 1002
reason: `baseCurrency` is one more field on the `XeroConnectedOrganisation`
  summary, read from the same `getOrganisations` response in the same two
  mapping sites (live and mock) as `shortCode` (#2261). The issue requires it
  to cost no extra Xero call, so it has to be filled where the summary is
  built. A second module would need a second read, or a hook into the cache's
  internals.

file: src/lib/setup-readiness.ts
lines: 2233
reason: the warning is a branch of the existing Operational Xero step. It
  changes that step's status and message, and the ordering against the
  legacy-variable message is deliberate. Moving it to another file would split
  one step's status ladder across two files; the step builders are all in this
  one. Most of the growth is the doc comments on the two new inputs, which say
  where each comes from and why the raw stored currency is not the one
  compared.

file: src/lib/admin-permissions.ts
lines: 1006
reason: `XERO_ORGANISATION_READ_PERMISSION` names who may read the Xero
  organisation summary, and sits beside `hasFinanceViewerAccess` and the rest
  of the admin permission vocabulary. Placing it in a Xero module would put a
  permission definition outside the one module that defines them. The growth
  is the constant and its explanation of why the route keeps the literal (for
  the #2975 census) while the other surfaces import this.
