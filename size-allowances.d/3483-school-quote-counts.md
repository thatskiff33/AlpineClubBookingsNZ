# File-size allowances for #3412

file: src/lib/school-booking-request.ts
lines: 2677
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
lines: 2517
reason: the added lines are one shared payload helper — which DELETED the
  duplicate the approve handler carried — the small predicates it feeds, and the
  inline sentences that say why a button is off, which after review cover the
  member-link refusal and the two buttons that reserve beds as well as the hold.
  Two more predicates were added rather than inlined precisely so the panel and
  the service draw their lines through the same shared comparison helpers. The
  predicates read the same local edit state the count boxes write, so extracting
  them means lifting that state out of the card, and the card is the unit an
  officer works in. Splitting this panel by request kind is the seam it really
  wants and is a change of its own.
