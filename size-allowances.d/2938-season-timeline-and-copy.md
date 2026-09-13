# File-size allowance for #2938

One file, and the number is bigger than this change is.

It also **carries #2933's declaration for the same file forward**. That entry
recorded 1143 lines and this change makes the file 1182, so 1143 stopped being
its real length — and two live entries for one file is an unusable input rather
than a redundant one, because the gate cannot tell which number is meant. The
entry was removed from `3405-missing-membership-rates.md` (whose other two files
are untouched and still accurate) and its reasoning is restated at the end of
this one. Nothing is withdrawn.

file: src/app/(admin)/admin/fees/_components/hut-fees-section.tsx
lines: 1182
reason: thirty-nine lines against the branch this work started from, and the
  gate reads a bigger figure than that because it measures against `origin/main`
  while this pull request opens into `epic/2725-mad`. Of the 209 lines between
  973 and 1182, 170 are #2933's growth, already declared and already merged into
  the epic; 39 are this change. Splitting was tried FIRST and is most of the
  diff: eleven helpers moved out to `src/lib/season-rate-grid.ts`, taking about
  130 lines with them, and the save handler's inline rate building went with
  them as `rateRowsFromCells`. That move is the point rather than a concession to
  this gate — one of those helpers decides whether a blank rate box saves as "no
  rate" or as a $0.00 nightly rate, and while it lived in a form component the
  only way to exercise it was to render the whole admin console over a fake API.
  What is left is wiring that cannot move: the timeline memo that decodes each
  season's edges and hands the decoded pair to `buildSeasonTimeline`, the
  `startCopyFrom` handler and the paragraph above it explaining why `editingId`
  stays null, and one more action button. The season card was lifted into a local
  `renderSeasonCard` so the timeline can render it in two places — in order, and
  again for a season whose dates the screen could not read — without a second
  copy of eighty lines of grid markup drifting from the first; that costs about
  ten lines and prevents the duplication a reviewer would rightly object to. The
  gap panel itself is NOT here: it is
  `src/components/admin/season-coverage-warning.tsx`, a new file, because the
  Seasons page renders the same warning. The real remaining seam is the one
  #2933's allowance already named — this is one component holding a season
  editor, a rate grid and a season list — and it is a piece of work in its own
  right rather than something to attempt while adding a button to each.

## #2933's reasoning, carried forward

Restated as prose rather than as a second entry — one file, one allowance — so
the record of why the file grew to 1143 survives the move:

> the warning had to be computed where the data already is. This section
> already fetches the seasons, their rate rows, the club's age tiers and the
> membership types that owe rates — everything the gap computation needs — so
> putting the computation anywhere else would mean either a second fetch of all
> four or threading them out through props to a component that renders nothing
> else. About half the growth is exactly that memo and its comment saying why
> only in-scope seasons are judged and why "today" comes from the bound club
> clock rather than the browser's; the rest is the lookup that lets a type's flat
> all-ages rate show against each age tier instead of "Not set", which is a
> correction to the table it sits in and belongs beside it. The panel itself is
> NOT here — it is `missing-hut-rates-notice.tsx`, a new file — and the rule and
> the coverage arithmetic are in `src/lib/membership-type-rate-coverage.ts`, a
> new file too, which is what keeps this one to the wiring. The review round added about fifty
> more, and they are the ones that matter most: the rate record now holds "no
> rate" as `null` rather than as zero, which is what stops this form
> manufacturing a $0.00 nightly rate for every blank box it submits, and roughly
> forty of those lines are the comments at `emptyRates`, the change handler and
> the submit saying what the two states are and what happened when they were the
> same one. Splitting the section
> further is a real piece of work and the right one eventually: it is one
> component holding a season editor, a rate grid and a season list, and the seam
> is between those three, not around the six lines this change adds to each.
