# File-size allowances for #3412

file: src/lib/school-booking-request.ts
lines: 2633
reason: the shared resolver is the school module's own rule — the strict read,
  the preserved teachers, the regenerated children and the capacity bound — and
  it is net ADDITIONS of about thirty lines plus its docblock, since approval's
  inline copy of the same logic was deleted in the same change. Lifting it into
  a new module would separate it from `generateSchoolGuests` and
  `parseSchoolTeachers`, the two functions it composes and its only
  dependencies, which is the split this file most needs not to make.

file: src/lib/booking-request-quotes.ts
lines: 1936
reason: what grew is one new refusal helper and the comments explaining the
  claim's three fences, on a money path where the reasoning is the point — the
  two refusals sit in the quote service because they are about the quote's
  surroundings (a live hold, a posted member link), not about the party, which
  is exactly why they are not in the shared resolver. The seam this file wants
  is quote-create versus quote-respond, which is a refactor of its own and
  would collide with the four writers epic #2725 is already changing here.

file: src/components/admin/booking-requests/public-booking-requests-panel.tsx
lines: 2380
reason: the added lines are one shared payload helper — which DELETED the
  duplicate the approve handler carried — three small predicates it feeds, and
  the two inline sentences that say why a button is off. The predicates read the
  same local edit state the count boxes write, so extracting them means lifting
  that state out of the card, and the card is the unit an officer works in.
  Splitting this panel by request kind is the seam it really wants and is a
  change of its own.
