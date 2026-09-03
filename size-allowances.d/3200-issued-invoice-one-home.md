# File-size allowances for #3200

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1401
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
