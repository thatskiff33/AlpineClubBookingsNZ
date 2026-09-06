- **The pricing, age-tier, hosting and shared-bed rules now handle an empty list
  explicitly instead of assuming it has a first entry (#2799).** This is
  internal type-safety work with no change to any fee, capacity or permission
  decision: every place the code looked up "the first tier", "the last clause"
  or "the sharer at this position" was rewritten so that the missing case is
  either impossible by construction or answered the same way the surrounding
  rule already did.

  Behind the scenes, the repository now records every place the stricter
  TypeScript `noUncheckedIndexedAccess` check would complain — 1,089 at the
  start of this stage — and the build fails if that list ever grows. Later
  stages of the same programme (#2694) pay the list down area by area until the
  check can be switched on for good.
