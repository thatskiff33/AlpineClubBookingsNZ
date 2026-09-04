# File-size allowances for #3258

file: src/lib/adult-member-hosting-review.ts
lines: 4483
reason: ten lines in `enqueueSameOwnerDependentItems`, so a stranded booking
  that still OVERLAPS the moved dates gets a re-evaluation row of its own. The
  skip it qualifies exists to avoid duplicate work, and it is now the difference
  between an officer being told a member chose this and not, since a row's
  explanation stops at the booking it is about (`INV-HOST-053`). The rule has to
  sit at the one place that decides whether a dependent gets a row; there is no
  seam to lift it to that would not put the decision and its reason in different
  files. The file is 4483 lines against a 700-line budget and wants splitting,
  but that is a refactor of the hosting engine and not something to attempt
  inside a release-ordering fix.
