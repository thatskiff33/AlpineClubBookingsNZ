# File-size allowances for #3107

Three already-oversized modules gain a few lines each. Every line is an import
the decode needs plus the note saying which frame the values beside it are in —
the rule that generalises has been moved into `INV-DATE-013` rather than
restated here, and each note was trimmed to the site-specific fact after that.

file: src/lib/booking-edit-guest-ranges.ts
lines: 1369
reason: this file's own night-key derivation has to move in the same commit as
  the one in `booking-guest-stay-ranges.ts`, because the two key the same night
  sets against each other and one decoding while the other projected is the
  straddle #3107 exists to close. The derivation cannot move to the sibling
  module: that one is private behind function bodies
  `booking-guest-stay-ranges-contract.test.ts` freezes byte-for-byte, so
  exporting it would mean editing the frozen contract in a capacity-path change.
  Splitting a 1,369-line in-progress-edit pricing planner is a real job with its
  own review, and it would not shrink this hunk.

file: src/lib/capacity.ts
lines: 1048
reason: one import, and four lines recording that the occupancy index keys and
  the night key they are compared against are now built the same way. That
  mismatch was a live off-by-one behind Greenwich, so the reason belongs beside
  the two lines that fixed it rather than in a commit message nobody reads from
  here.
