# File-size allowances for #3167

file: src/lib/booking-request-quotes.ts
lines: 1759
reason: the growth is the refusal that replaces `guestPriceCents[index] ?? 0`
  on the capacity hold, plus the note recording that the #3167 census graded
  this site a tautology rather than a live hazard. Splitting is not available
  to this change: the guest rows are built inline here precisely because the
  hold is the one write point that does NOT go through
  `buildApprovalGuestCreates`, and moving them out would merge the two write
  points — a real refactor of the approval pipeline, and the opposite of what a
  money-refusal change should carry. The reason has to sit at the call site
  because it is the site-specific half; the rule itself is stated once in
  `required-price-cents.ts` and is not repeated here.

# Corrected numbers, not new allowances
#
# Two entries this epic already carries no longer matched their files after this
# change, and the ratchet fails a number that has drifted from the tree:
#
#   size-allowances.d/3032-modified-email-review-flag.md
#     src/app/api/bookings/[id]/guests/route.ts  1264 -> 1277  (this change)
#   size-allowances.d/3031-exact-sold-price.md
#     src/lib/booking-modify-plan.ts             2490 -> 2481  (this change SHRANK it,
#                                                               by moving the #3031
#                                                               refusal to its own module)
#
# Both were edited in place rather than re-declared here, because the gate matches
# an allowance to a path and two allowances naming one path is an error. Neither
# reason text was touched.
