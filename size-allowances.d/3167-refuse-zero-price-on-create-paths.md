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

# One number corrected in a neighbouring allowance, not a new allowance
#
# The ratchet fails an allowance whose recorded length has drifted from the tree,
# so a change that moves an already-allowanced file has to refresh that file's
# number where it is declared. This change moves one:
#
#   size-allowances.d/3031-exact-sold-price.md
#     src/lib/waitlist.ts                        1380 -> 1385
#
# The five lines are the offer-time reprice being routed through
# `requiredNightPriceCents` instead of restating the same predicate inline — the
# SSOT convergence this change owes, since `required-price-cents.ts` claims to be
# the rule's home. It was refreshed in the allowance that already owns that path
# rather than re-declared here, because two allowances naming one path is an
# error the gate refuses by name. Its reason text was not touched.
#
# Two other files this change touches need no allowance at all, and it is worth
# saying which and why, because an earlier draft of this fragment claimed
# otherwise:
#
#   src/lib/booking-request-shared.ts  613 -> 631, still inside its 700-line
#     domain-module budget, so the ratchet has nothing to allow.
#   src/lib/required-price-cents.ts    a NEW file at 160 lines, inside the same
#     budget. An allowance may never cover a new file in any case.
#
# `src/lib/booking-modify-plan.ts` is NOT in this change's diff. An earlier
# revision of this fragment recorded it at 2490 -> 2481; neither number was ever
# real. The edit-path routing that would have shrunk it was reverted in
# `2887e4032` and belongs to #3170, which has since taken that file to 2703 —
# the length `size-allowances.d/3031-exact-sold-price.md` already declares, in a
# file this branch does not modify.
