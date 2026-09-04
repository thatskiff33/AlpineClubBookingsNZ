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
lines: 2321
reason: the refusal has to sit inside `parkedQuoteResponse`, the one composer
  both parked exits return, so the preview cannot offer a quote the save
  declines. Lifting it out would need the resolved election, the plan result and
  the response shape passed to a helper that answers nothing else. Review round
  added the record of why that refusal sits ahead of the capacity payload rather
  than after it — the one ordering question the two surfaces answer differently,
  and the file is where the next reader meets it.

file: src/lib/booking-batch-modification-service.ts
lines: 2432
reason: the guard must fire after `calculateModifiedPricing` returns and before
  the first write, and the comment records exactly that — which lines above it
  are reads and locks, and why no earlier or later placement is correct. That is
  the load-bearing part of the change and it is unreadable anywhere but here.

The two below are #3214's second half: the route an officer takes to record what
a booking's nights sold for, which is what makes this issue's refusal message
true rather than merely written.

file: src/app/(authenticated)/bookings/[id]/page.tsx
lines: 2737
reason: the offers have to be read where `financialReviewPending` already is.
  The page holds that flag for the member's own banner, and the same flag is what
  withholds this section while a review is open - so reading the offers anywhere
  else would mean a second answer to "is a review open on this booking", which
  can disagree with the banner on the same page load. The file already states
  that reasoning for `financialReviewWarnings` three blocks above and this
  follows it. Splitting the whole 2700-line server component is a real piece of
  work and is not this issue's; adding twenty-one lines to it under the rule the
  file already applies is.

file: src/lib/admin-permissions.ts
lines: 897
reason: `SPECIAL_ROUTE_AREA_PATTERNS` is the one place a bookings-shaped path is
  resolved to the finance area, and the new route is the second member of that
  list rather than a new kind of thing - mark-paid, directly above it, is the
  precedent and carries the same nine-line shape. Moving the list to a module of
  its own would separate it from `getAdminRouteRequirement`, the only function
  that reads it, and from the prefix table it overrides; the census that pins
  every route's area (`admin-route-area-matrix.test.ts`) reads the resolver, so
  the two have to stay answerable together.
