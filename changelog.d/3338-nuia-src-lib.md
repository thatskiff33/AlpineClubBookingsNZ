- **Bed allocation, booking edits, membership merge and the Xero repair jobs now
  say what happens when a lookup finds nothing, instead of assuming it always
  will (#2800).** This is internal type-safety work and no fee, capacity,
  membership or Xero decision changes. Where the code used to check a list's
  length and then read an entry out of it further down, it now reads the entry
  where the check is and works from that value, so the two cannot drift apart.
  Where a price came out of a pricing breakdown by the guest's position, the
  code refuses outright if that guest has no priced row, under the same rule the
  club already applies to a missing night price: an amount nobody calculated is
  never replaced by a guess. Where a stay's first and last night are needed, both
  are read where the date range is built, and a stay with no nights keeps the
  answer it had before.

  Nothing was silenced to make the compiler happy: no forced non-null reads, no
  type casts, no suppression comments. The recorded list of remaining places the
  stricter `noUncheckedIndexedAccess` check would complain drops from 1,076 to
  673 with this stage of programme #2694, and the build still fails if it ever
  grows.

Behind the scenes, the shared library layer no longer assumes that looking
something up will always find it. Where an amount, a night or a record might
genuinely be missing, the code now says so and handles it; where it cannot be
missing, the structure proves that instead of trusting it. Two real faults were
found and fixed on the way, one of which could have written a booking night with
no price recorded against it.

Members and administrators see no change.
