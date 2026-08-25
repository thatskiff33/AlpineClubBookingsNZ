# File-size allowance for the season-name adoption (#3103)

One line, in one file: the `import { seasonSelectLabel } from "@/lib/season-label";`
that lets the member data export stop writing the season's name out by hand.

The other three surfaces this change touches pay for their own import and need
no allowance. `membership-types/page.tsx` and the admin member card both DELETE
a local `formatSeasonLabel` and end shorter than they began;
`profile/page.tsx` ends at exactly its length on the base ref, because the
single-use `const seasonLabel` was inlined at its one call site to pay for the
import. That is the same trade #2870's allowance describes: in-file comment
prose was cut back to a pointer rather than declared, because the reasoning has
a canonical home in `src/lib/season-label.ts` and duplicating it into four call
sites is how a rule comes to be stated four slightly different ways. The two new
test files carry the per-surface reasoning, where it is read at the moment it
matters.

A route handler cannot inline an import, so this last line has nowhere to go.

file: src/app/api/member/data-export/route.ts
lines: 339
reason: one import line. The alternative is the defect being fixed - a local
  copy of `${seasonYear}/${seasonYear + 1}`, which asserts that a season spans
  two calendar years and is wrong for a club whose financial year ends in
  December. Splitting a 338-line GDPR export handler is a real seam and a real
  refactor, but it is unrelated to naming a season and would put a
  disclosure-shaped route on the same diff as a one-string change; the export's
  every field is one flat serialisation and the seam runs across all of them,
  not near this line.
