# File-size allowances for #2801 (Type Safety stage 4, `src/app` tranche)

Twenty already-oversized routes, pages and page components gain a handful of
lines each because `noUncheckedIndexedAccess` made an indexed lookup's missing
case explicit and the code now says what it does about it. Most of the growth is
the sentence, not the code: nearly every site already answered its own missing
case a line or two away — a `length === 0` early return, a `length === 1`
branch, a bounds check — and the change is to say that once, in a form the
compiler can follow, with a comment recording which condition it is so a
reviewer can check that no second answer was invented.

Splitting any of these is a real refactor with its own issue and its own review,
and doing it inside a type-safety stage would bury a behaviour-preserving
decomposition in a compiler change — the opposite of how this repository splits
files (`docs/MAINTENANCE.md` -> "Refactor history and split guidance"). Stage 5
(#2802) touches `scripts` and `prisma` plus the activation itself, so this is
the one time these files grow for this programme.

The recurring shapes, each costing a line or two of code and a sentence:

- an "exactly one" length test becomes a first-with-no-rest destructure, so the
  branch holds the row rather than a count that licenses a later read;
- a counting loop becomes `entries()`, where the index was only ever wanted for
  a row number or a `sortOrder`;
- a `YYYY-MM` or `yyyy-MM-dd` string already validated by a regex is read at
  fixed `slice` offsets instead of being split and destructured;
- a price breakdown indexed by a guest's position is read once, through one
  named refusal, in the terms #3031 and #3167 already set for a per-night
  amount — a money path has no default that is not invented money.

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1463
reason: the largest entry, and the only structural one. The created
  `BookingGuest`, the normalized input it came from and the breakdown row that
  priced it are now carried together through one pass, so the promo-allocation
  rows are built beside the create instead of three arrays being re-indexed
  against each other afterwards — and `bookingGuestId` comes out a real id
  rather than a nullable one. A short breakdown is refused by name at ONE place,
  following the shape #2800 gave `waitlist.ts` and
  `booking-date-modification-service.ts`. The docblock on that refusal is most
  of the addition: it has to say what a mispaired row would sell a stay for, and
  why the refusal lives above both readers rather than in each. Splitting this
  route is #2958-shaped work on the file the whole add-guest story runs through.

file: src/app/(admin)/admin/site-style/site-style-wizard.tsx
lines: 1051
reason: three fixed-size theme substrate reads go through the shared `must`
  guard, each naming the scale or ramp step it assumes — the same three values
  `theme/app-tokens.ts` already reads that way (`INV-SSOT`), and a substrate
  short of one would otherwise put the string "undefined" in a swatch. The
  wizard's step strip reads its active step by name instead of by index, and
  Back reads the previous step once so the `Math.max` clamp that existed only to
  avoid a negative index goes with it.

file: src/app/(admin)/admin/work-parties/page.tsx
lines: 616
reason: the expanded event's bookings table moves into its own local component
  so the loaded detail is looked up ONCE — the row used to test
  `details[event.id]` and then read `.attendingBookings` off a second lookup of
  the same key. That is a small split rather than an avoided one; the component
  boundary is what makes "have I loaded this event yet" one question with one
  answer, and its docblock is the rest of the addition.

file: src/app/api/promo-codes/validate/route.ts
lines: 391
reason: fourteen lines. The promo guests are walked over the guests the pricing
  pass was GIVEN, each paired with the row that priced it, and a missing row is
  refused rather than read past. The reasoning is the quote-versus-save
  disagreement INV-MOD-028 exists to prevent, which is the part that needs
  saying beside a #3031 refusal on a preview path.

file: src/app/api/bookings/[id]/modify-quote/route.ts
lines: 2333
reason: twelve lines. The added guests' resolved stay ranges are read once and
  refused when absent. The positional join was already documented as sound by
  construction directly above; the refusal is what happens when the type cannot
  carry that proof, and it says why quoting a guest on nobody's nights is worse
  than failing.

file: src/app/api/admin/hut-leaders/eligible-members/route.ts
lines: 337
reason: ten lines. The per-member stay list is declared as a non-empty tuple —
  true at both insertion sites, which is what lets the span reduce use its first
  element as a seed with no assertion and no refusal for a state that cannot
  occur — and the first uncovered run is walked with a first-and-rest
  destructure instead of counting to `length`.

file: src/app/(admin)/admin/display/setup/display-wizard-steps.tsx
lines: 1459
reason: ten lines. Two "exactly one" branches — the only board to seed, and the
  only live screen to name in a headline — become first-with-no-rest reads, so
  each acts on the row its own condition tested for.

file: src/app/(admin)/admin/membership-types/page.tsx
lines: 1868
reason: ten lines, and one of the three real defects this tranche found. The
  reorder bounded `targetIndex` and never bounded `index`: a negative one makes
  `splice` remove from the END, and one past the end removes nothing and then
  inserts `undefined` into the order about to be persisted. Both refuse now, and
  the comment records which `splice` behaviour each is guarding against.

file: src/app/(admin)/admin/fees/_components/hut-fees-section.tsx
lines: 973
reason: eight lines. The membership type id half of a rate key goes through the
  shared `must` guard, whose message names the key: `String.prototype.split`
  always yields a first element, so this is unreachable, and the sentence saying
  so is what stops the next reader replacing it with an invented id in a saved
  rate row.

file: src/app/(admin)/admin/hut-leaders/page.tsx
lines: 1186
reason: seven lines. A `YYYY-MM` month key is read at fixed offsets, and the
  short leader label's last name part IS the "there are no parts" check.

file: src/app/(admin)/admin/bed-allocation/page.tsx
lines: 1967
reason: six lines. The guest group's last stay night is read once and falls back
  to the board window, mirroring what the line above already does for the other
  end — instead of handing `undefined` to `requireCalendarDate` and getting an
  opaque throw out of opening a dialog.

file: src/app/(lodge)/lodge/roster/[date]/setup/page.tsx
lines: 920
reason: six lines. The first eligible guest is both the "nobody is eligible"
  check and the fallback when everyone eligible is already assigned, and the
  chore grouping reads its bucket once rather than testing presence and then
  looking it up again. The reduce's seed cast goes with it.

file: src/app/(admin)/admin/committee/page.tsx
lines: 801
reason: five lines. The four boolean assignment fields are declared `as const`,
  so the key reaches a computed property name and the form lookup as a literal;
  two casts go with it, and the comment says which two.

file: src/app/(lodge)/lodge/kiosk/page.tsx
lines: 1405
reason: five lines. The chore grouping reads its bucket once instead of testing
  presence and looking it up again, and drops the reduce's seed cast.

file: src/app/api/issue-reports/route.ts
lines: 260
reason: five lines. Both of the screenshot data-URL pattern's mandatory captures
  are read out of the destructure, so "the pattern matched" and "both parts are
  here" are one condition answered by the one 400 that already existed.

file: src/app/api/admin/lodge/route.ts
lines: 491
reason: three lines. The auto-created kiosk account maps a missing row onto this
  route's own declared `null`, which the block immediately below already owns —
  the comment exists so `?? null` here does not read as a fallback invented for
  the compiler.

file: src/app/api/admin/members/import/route.ts
lines: 772
reason: three lines. The import loop iterates `entries()`, which retires all
  twenty-three of this file's diagnostics at once: the index was only ever the
  row number in the admin's error report.

file: src/app/(admin)/admin/display/builder/display-builder.tsx
lines: 1308
reason: three lines. The side-rail main cell is zone 0 by that skeleton's own
  rule, and a model with no zones has no main cell to draw — which is what the
  rail-only render now says instead of passing `undefined` into a cell.

file: src/app/(admin)/admin/members/_components/member-import-dialog.tsx
lines: 871
reason: three lines. The previous wizard step is read once, and its presence IS
  the "there is a step before this one" test the index comparison expressed.

file: src/app/api/admin/bookings/search/route.ts
lines: 260
reason: two lines. The booking-reference pattern's mandatory capture is read out
  of the destructure, so its presence is the same condition as the match.
