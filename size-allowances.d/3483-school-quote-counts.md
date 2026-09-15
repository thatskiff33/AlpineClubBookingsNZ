# File-size allowances for #3412

file: src/lib/school-booking-request.ts
lines: 2684
reason: the shared resolver is the school module's own rule — the strict read,
  the preserved teachers, the regenerated children, the capacity bound, and
  (after review) the refusal of a member link on a row the regeneration
  renumbers, which had to move here because APPROVE applies its link map
  positionally too and a copy in the quote service covered only one of the two
  doors. Approval's inline copy of the same logic was deleted in the same
  change, and so was one of the three copies of the capacity rule, which is now
  one exported helper the public route and the create service both call. Lifting
  any of it into a new module would separate it from `generateSchoolGuests` and
  `parseSchoolTeachers`, the two functions it composes and its only
  dependencies, which is the split this file most needs not to make.

file: src/lib/booking-request-quotes.ts
lines: 2049
reason: what grew is one refusal helper, the send path's two new guards, and the
  comments explaining them, on a money path where the reasoning is the point.
  The send now refuses unsaved group numbers before it reserves beds or emails
  the school, and claims its quote row on status rather than overwriting it —
  both are interleavings with a worked example in the comment, because the
  reason a plain `update` was wrong here is not visible from the line. The hold
  refusal stays in this file rather than the shared resolver because it is about
  the quote's surroundings, not the party. The seam this file wants is
  quote-create versus quote-respond, which is a refactor of its own and would
  collide with the four writers epic #2725 is already changing here.

file: src/components/admin/booking-requests/public-booking-requests-panel.tsx
lines: 2620
reason: the added lines are one shared payload helper — which DELETED the
  duplicate the approve handler carried — the small predicates it feeds, and the
  inline sentences that say why a button is off, which after review cover the
  member-link refusal and the two buttons that reserve beds as well as the hold.
  Two more predicates were added rather than inlined precisely so the panel and
  the service draw their lines through the same shared comparison helpers. The
  predicates read the same local edit state the count boxes write, so extracting
  them means lifting that state out of the card, and the card is the unit an
  officer works in. Splitting this panel by request kind is the seam it really
  wants and is a change of its own. The closing review round added the rest: the
  misplaced-link derivation now takes the link list as an argument, because save
  quote posts the links on screen and approve reads the ones saved on the
  request, and drawing one line for both left approve enabled in the state the
  refusal exists to block. Two thin doors over one derivation, a count of the
  unsaved link edits, and the two sentences that say which button is off and
  why — said beside the buttons, because a disabled button cannot say it.

file: src/lib/booking-request.ts
lines: 2944
reason: twenty-three lines, all of them the docblock over `parseAdminTeachers`,
  which now reads stored teacher names through `nameField()` — the helper the
  school reader already used. The one-line change is invisible without the
  comment: it matters only because the admin panel composes the party it is
  about to quote from these names and compares it to the stored guest list, so a
  raw read made the two lists differ at the teacher prefix on any hand-repaired
  row and shut both Save quote and Send quote on a request nothing was wrong
  with. The comment records that measurement and the one behaviour change
  (a name the helper rejects now yields the empty list this parser already
  returns for an unreadable shape). The serialiser belongs with the request
  schemas it is built from; the seam this file wants is public-request versus
  admin-serialisation, which is a refactor of its own.
