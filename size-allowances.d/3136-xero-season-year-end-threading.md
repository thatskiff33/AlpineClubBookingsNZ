# File-size allowances for #3136

Five already-over-budget files grow here. The growth is one shape in all five:
making the club's financial year-end an **explicit, required** input instead of
something each site read from a process cache that background workers never
seed (#3116). That is the "prefer unrepresentable over policed" remedy #3123
used for the club timezone, and it costs lines at every call site by design —
threading a value is longer than reading a global, which is the whole trade.

The explanation of *why* the default is wrong lives in exactly one place,
`src/lib/season-label.ts`, and the sites below point at it rather than repeating
it. An earlier draft of this branch explained it at each site and was 23 lines
longer; condensing it to one canonical copy is both better writing and smaller,
so what remains is the code, not the commentary.

None of these five appears in [#3128](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3128)'s
split list, and nothing here creates a new seam worth cutting on: the additions
are parameters and guards inside existing decision paths, not new
responsibilities that could move out whole.

file: src/lib/membership-subscription-billing.ts
lines: 1517
reason: the largest share, and the only one that is not purely threading. It
  adds the in-transaction refusal guard, which has to sit beside the identical
  refusal this file already makes for the club timezone — the two rules are the
  same rule and separating them is how the second one gets forgotten. The rest
  is the required parameter on `buildComponentLineDescription`, the frozen
  year-end on the preview type, and the correction of a comment that
  misattributed byte-identity to a literal when persistence is what provides it.

file: src/lib/xero-membership-sync.ts
lines: 1732
reason: the year-end becomes a required field on `SubscriptionInvoiceMatchOptions`
  and is threaded through the season-window builder, the Xero where-clause
  builder and the invoice classifier, so one sweep cannot classify two invoices
  against two different windows. A seam exists here in principle — the matching
  helpers could leave this file — but that is a behaviour-preserving refactor of
  a module that decides who reads as unfinancial, and doing it inside a change
  that alters which season an invoice belongs to would make both unreviewable.

file: src/lib/xero-record-activity.ts
lines: 756
reason: nine lines: one resolver with a short docblock, and the year-end passed
  to the two scope builders that name a season. The file is 56 over its ceiling
  in total, so almost all of its debt predates this change.

file: src/app/api/admin/subscription-billing/route.ts
lines: 333
reason: five lines. The route resolves the year-end before opening the reconcile
  transaction, precisely so the transaction cannot resolve it under the season's
  advisory lock — a provider call inside a transaction. Moving five lines of
  resolution out of a route handler to satisfy a budget would hide the ordering
  that is the point of them being there.

file: src/lib/membership-cancellation-xero.ts
lines: 1399
reason: three lines. A hand-written season formatter is deleted and replaced by
  the shared derivation plus a resolved year-end; the file is net shorter in
  code and longer only by the comment recording why a credit-note retry spanning
  a deployment is harmless.
