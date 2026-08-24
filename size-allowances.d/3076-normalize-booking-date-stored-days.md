# File-size allowances for #3076

file: src/lib/policies/pricing.ts
lines: 922
reason: sixty-odd of these lines are the docblock on `normalizeBookingDate` plus
  the guard that enforces what it says, and together they are the thing that
  stops this defect being rewritten. The docblock records what the function used
  to do — read every stored lodge day through the container's timezone, so a club
  behind Greenwich froze, capacity-checked and EXECUTED a party starting a night
  early — and it states the contract that replaces it: every input is a calendar
  day, never an instant, and a caller holding a real instant derives its club day
  at its own boundary rather than widening this helper to guess. That sentence is
  the whole reason the function is safe to leave as one function, and the issue's
  own notes had recorded the opposite, so a reader who does not find it here will
  reasonably re-add the projection. It also names which invariant blesses the
  decode (`INV-DATE-019`'s first exact boundary, with `INV-DATE-026`) and which
  one does not, because an earlier draft cited `INV-DATE-010` for the inverse of
  what that rule says, and a reader who follows an id and finds a mismatch is
  exactly the reader who re-adds the projection. It records that #1146's
  zone-keyed formatter memo is retired because the decode builds no
  `Intl.DateTimeFormat` at all, which is the next thing someone would wonder.
  And the eight lines of guard are what make the contract enforced rather than
  merely asserted: `calendarDateOfDateOnlyInstant` truncates a real instant to
  its UTC day in silence, so without a refusal a future caller passing
  `booking.createdAt` would get the `INV-DATE-019` defect with no signal at all.
  Splitting a docblock away from the function it governs puts the rule and its
  exception in different files, which is the failure mode the allowance policy
  names; splitting `pricing.ts` itself is a real refactor of the pricing engine
  and must not be smuggled in beside a one-function correctness fix.
