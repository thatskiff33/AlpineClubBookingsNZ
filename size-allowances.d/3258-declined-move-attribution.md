# File-size allowances for #3258

file: src/lib/adult-member-hosting-review.ts
lines: 4498
reason: twenty-five lines across the two places that decide which
  re-evaluation row a dependent gets and what story it carries — the stranded
  booking that still OVERLAPS the moved dates needs a row of its own, a booking
  uncovered for its own reason must not be handed the member's decision, and the
  changed booking's own row must not claim the member was asked about the booking
  they were editing (`INV-HOST-053`). All three are properties of the one
  function that enqueues those rows; there is no seam to lift them to that would
  not separate a decision from its reason. The file is 4498 lines against a
  700-line budget and wants splitting, but that is a refactor of the hosting
  engine, not something to attempt inside a release-ordering fix. The cause
  vocabulary this change did outgrow was split out, into
  `src/lib/adult-member-hosting-incident-causes.ts`.
