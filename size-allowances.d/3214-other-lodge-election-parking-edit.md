# File-size allowances for #3214

Both files grow by one guard and the comment that explains where it may sit.
Neither guard can move to a smaller module, because both are decisions about a
value that exists only at one point inside a long function: the pricing verdict
for THIS request, which is the only thing that knows the edit is about to park.
The rule itself — what the refusal says and why the owner chose refusal over
disclosure — is already in one place,
`src/lib/booking-other-lodge-rate.ts`, and both call sites read that constant
rather than restating it.

file: src/app/api/bookings/[id]/modify-quote/route.ts
lines: 2297
reason: the refusal has to sit inside `parkedQuoteResponse`, the one composer
  both parked exits return, so the preview cannot offer a quote the save
  declines. Lifting it out would need the resolved election, the plan result and
  the response shape passed to a helper that answers nothing else.

file: src/lib/booking-batch-modification-service.ts
lines: 1901
reason: the guard must fire after `calculateModifiedPricing` returns and before
  the first write, and the comment records exactly that — which lines above it
  are reads and locks, and why no earlier or later placement is correct. That is
  the load-bearing part of the change and it is unreadable anywhere but here.
