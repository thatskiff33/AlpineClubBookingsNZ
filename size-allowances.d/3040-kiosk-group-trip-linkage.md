# File-size allowances for #3040

One entry, and two notes about what is NOT here.

Everything #3040 adds that could live somewhere else does:
`src/lib/kiosk-group-trip.ts` holds the tier split and its reads,
`src/lib/kiosk-adult-cover.ts` holds the rule for reading a canonical hosting
snapshot as cover evidence, and
`src/app/(lodge)/lodge/kiosk/_components/kiosk-group-trip-card.tsx` holds all
three pieces of markup. The cover reader was part of the first module until the
review round grew it past its budget; the two answer different questions — which
tier is told what, versus what the stored evaluation supports saying — so the
seam was already there and splitting was the better answer than an allowance
(which a NEW file may not have in any case). The guest-list route was kept inside
its 250-line route-handler budget for the same reason: the modules took the
logic.

`src/lib/adult-member-hosting-review.ts` also grows in this change, by the
batched split-pair reader that removes the kiosk's N+1. Its declaration is in
`size-allowances.d/3038-group-trip-cover-evaluator.md` and not here: every child
of epic #2943 diffs against `main` until the epic merges, so those allowances are
all live together and the gate refuses two numbers for one file. That fragment's
entry carries the reasoning and the current length.

file: src/app/(lodge)/lodge/kiosk/page.tsx
lines: 1191
reason: twenty-nine lines, and the smallest wiring available. Six render three
  presentational components; ten declare the three optional payload fields with
  the note saying WHY they are optional rather than nullable (the server omits
  the key for a viewer without the capability, so absent means "not disclosed to
  this viewer"); the rest are the two imports and the four-line comment warning
  the next editor that the tier split is server-side and must not become "send
  it and hide it in JSX". Three lines are a `div` wrapper so the trip chip sits
  beside the booked-by line. Splitting this page is real work and a real review —
  it is one screen holding a week strip, a day list, PIN sign-in, chore roster
  and per-account preview, and it was already 1162 lines before this change —
  and doing it inside a cross-account privacy lane would put the split's risk on
  top of the disclosure boundary's. The comment about JSX-hiding in particular
  has to sit at the interface it warns about; that is the mistake the issue
  rejected by name.
