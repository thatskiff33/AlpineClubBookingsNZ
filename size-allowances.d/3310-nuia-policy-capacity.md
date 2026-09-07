# File-size allowances for #3310 (#2799, Type Safety stage E2)

Three already-oversized modules gain a handful of lines each because
`noUncheckedIndexedAccess` made an indexed lookup's missing case explicit and
the code now handles it. Splitting any of them is a real refactor with its own
issue and its own review, and doing it inside a type-safety stage would bury a
behaviour-preserving decomposition inside a compiler change — the opposite of
how this repository splits files (`docs/MAINTENANCE.md` → "Refactor history and
split guidance"). Stages E3 and E4 rewrite these same files again; splitting
them here would also make those diffs unreadable.

file: src/lib/capacity.ts
lines: 1044
reason: the partner-shared coverage loop stopped correlating two parallel
  arrays by index and now builds one array of `{ sharer, covered }` pairs, so
  the missing case is unrepresentable rather than guarded. That is the better
  structure and it costs six lines; splitting capacity.ts is #2958-shaped work
  on the busiest module in the codebase and does not belong in this stage.

file: src/lib/policies/adult-member-hosting.ts
lines: 994
reason: `parts.at(-1)` can be undefined when no hosting scope is enabled, and
  the entry now says so and returns the wording the rule already used for that
  case. Three lines, inside the policy the rule belongs to.

file: src/lib/policies/pricing.ts
lines: 923
reason: the free-nights allocation iterates a bounded slice instead of indexing
  by a counter, which is two lines and removes the assumption rather than
  asserting it. The money rule and its bound stay in one place.
