- **The pricing, age-tier, hosting and shared-bed rules now handle an empty list
  explicitly instead of assuming it has a first entry (#2799).** This is
  internal type-safety work with no change to any fee, capacity or permission
  decision: every place the code looked up "the first tier", "the last clause"
  or "the sharer at this position" was rewritten so that the missing case is
  either impossible by construction or answered the same way the surrounding
  rule already did.

  Behind the scenes, a new build safeguard makes sure this kind of assumption
  cannot creep back in while the rest of the codebase is tidied up the same way.
