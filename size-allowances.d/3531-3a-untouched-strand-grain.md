# File-size allowance for #3531 stage 3a — the cleared-locks fact has one home

file: src/lib/booking-modify-plan.ts
lines: 3045
reason: `editedGuestPricingLocks` — the locks an edited guest prices with and
  whether the edit cleared them — replaces two hand-agreed spellings of the
  same rule in the modify save (this file) and the modify preview
  (`modify-quote/route.ts`), which a review lens on this PR named as the
  copy that could drift. It sits beside `lockedNightPricesForGuest`, the
  reader it wraps, because the pair is one decision; moving both to a new
  module is a real seam worth taking, but it is the kind of split this
  file's 3000 lines need as a whole (its own issue), not a line saved here.
  The preview file shrank by the comment it no longer restates.
