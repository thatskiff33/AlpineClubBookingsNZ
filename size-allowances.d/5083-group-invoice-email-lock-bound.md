# File-size allowances for #5083 (#4919)

Two already-over-budget files grow by a few lines. The group invoice email
fence itself was moved into its own module,
`src/lib/xero-group-settlement-invoice-email.ts`, so
`xero-group-settlement-invoices.ts` stays inside its budget.

file: src/lib/xero-api-client.ts
lines: 793
reason: the optional `usageTasks` field on the metered call options, and the
  two-line branch in `persistMeteredXeroApiUsage` that defers the usage write
  until the email fence has released lock(1). The deferral has to sit in the
  one function that writes the usage row; a second writer elsewhere would be
  a second copy of the metering rule.

file: src/lib/xero-operation-outbox.ts
lines: 3473
reason: one import of `scanSpacesGroupInvoiceEmailsDeferred`, which joins the
  existing list of scan-spacing filters in the outbox claim query. That list
  is the single place the outbox decides which waiting rows to look at, so
  the filter cannot live anywhere else.
