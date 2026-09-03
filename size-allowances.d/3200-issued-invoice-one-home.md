# File-size allowances for #3200

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1404
reason: the change itself is a net reduction — five inline lines restating
  `hasIssuedPrimaryXeroInvoice` become one call to it. The growth is the note
  saying why this door reads the shared rule instead of restating it, and why
  the SUCCEEDED-only payment test beside it was deliberately not converted with
  it. That note has to sit at the call site: the copy it replaces was written
  from the eligibility list a few hundred lines above in this same file, so a
  reader who lands here without it repeats exactly the mistake. The reasoning
  that is general rather than local already lives once in
  `docs/invariants/single-source-of-truth.md` and is linked, not repeated. This
  route is long for reasons no part of this change creates or could fix; a split
  of it is real work and belongs to an issue that can review the seam.

  Three lines of that total are a review addition, re-measured rather than
  incremented: the eligibility gate's comment now says that #3245 proposes
  routing the same status list through `canModifyBookingStatusForRole`, and that
  the COMPLETED exclusion has to survive that convergence. Without it the
  comment describes a list that will not live here afterwards, and the test
  pinned to it reads as a widening nobody performed.
