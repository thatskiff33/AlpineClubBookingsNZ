# File-size allowances for #3076

file: src/lib/policies/pricing.ts
lines: 871
reason: the forty lines are the docblock on `normalizeBookingDate`, and they are
  the thing that stops this defect being rewritten. It records what the function
  used to do — read every stored lodge day through the container's timezone, so
  a club behind Greenwich froze, capacity-checked and EXECUTED a party starting a
  night early — and it states the contract that replaces it: every input is a
  calendar day, never an instant, and a caller holding a real instant derives its
  club day at its own boundary rather than widening this helper to guess. That
  sentence is the whole reason the function is safe to leave as one function, and
  the issue's own notes had recorded the opposite, so a reader who does not find
  it here will reasonably re-add the projection. It also records that #1146's
  zone-keyed formatter memo is retired because the decode builds no
  `Intl.DateTimeFormat` at all, which is the next thing someone would wonder.
  Splitting a docblock away from the four-line function it governs puts the rule
  and its exception in different files, which is the failure mode the allowance
  policy names; splitting `pricing.ts` itself is a real refactor of the pricing
  engine and must not be smuggled in beside a one-function correctness fix.
