# File-size allowances for #2933

Three files, and the two small ones are the same three lines twice.

file: src/app/(admin)/admin/fees/_components/hut-fees-section.tsx
lines: 1143
reason: the warning had to be computed where the data already is. This section
  already fetches the seasons, their rate rows, the club's age tiers and the
  membership types that owe rates — everything the gap computation needs — so
  putting the computation anywhere else would mean either a second fetch of all
  four or threading them out through props to a component that renders nothing
  else. About half the growth is exactly that memo and its comment saying why
  only in-scope seasons are judged and why "today" comes from the bound club
  clock rather than the browser's; the rest is the lookup that lets a type's flat
  all-ages rate show against each age tier instead of "Not set", which is a
  correction to the table it sits in and belongs beside it. The panel itself is
  NOT here — it is `missing-hut-rates-notice.tsx`, a new file — and the rule and
  the coverage arithmetic are in `src/lib/membership-type-rate-coverage.ts`, a
  new file too, which is what keeps this one to the wiring. The review round added about fifty
  more, and they are the ones that matter most: the rate record now holds "no
  rate" as `null` rather than as zero, which is what stops this form
  manufacturing a $0.00 nightly rate for every blank box it submits, and roughly
  forty of those lines are the comments at `emptyRates`, the change handler and
  the submit saying what the two states are and what happened when they were the
  same one. Splitting the section
  further is a real piece of work and the right one eventually: it is one
  component holding a season editor, a rate grid and a season list, and the seam
  is between those three, not around the six lines this change adds to each.

file: src/lib/config-transfer/categories/lodge-config.ts
lines: 1011
reason: three lines, and they make the file say less rather than more. The
  inline `const rateBearing = … || …` became a call to the one shared predicate;
  the import is one line and the call spans two more than the expression did
  because the object literal it passes wraps. Nothing here is worth splitting a
  category validator over.

file: src/lib/config-transfer/categories/xero-config.ts
lines: 818
reason: the same three lines as its sibling above, for the same reason: the
  HUT_FEE item-code row validator now asks the shared predicate instead of
  spelling the rate-bearing rule itself.
