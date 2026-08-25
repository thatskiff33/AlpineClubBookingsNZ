# File-size allowance for #3077 (CT-4 group F5, #2870)

The other file this change grew past its ceiling, `src/lib/calendar-service.ts`,
is **not** listed here. It was inside its budget on the base ref, so an
allowance is refused for it by name and rightly — its pure half was extracted to
`src/lib/calendar-occurrences.ts` instead, and it is back under 700 LOC.

file: src/components/calendar/event-dialog.tsx
lines: 1034
reason: forty-four net lines on a 991-line dialog that was already 291 over
  budget on the base ref and is not restructured here. Counted rather than
  asserted: 69 lines added and 25 removed, and of the 69, **34 are comment** and
  one is blank. Of the 35 lines of code, 8 are imports, and the rest are existing
  call expressions that each gained a `club.zone` argument and no longer fit 80
  columns — plus one `parseInstant` guard, one `useClubTime()` call and one
  changed effect dependency. The dialog also LOSES an 8-line host-local
  `todayDateValue()` helper and gains no branch it did not have, except the two
  guards named below.
  The comments are why this is an allowance rather than a split. Each sits at the
  line it governs and records a measured defect whose wrong version looked
  deliberate and agrees with the right one in New Zealand: that the date and time
  boxes were composed with `new Date("...T19:00")`, which JavaScript resolves in
  the HOST's zone, so an officer editing from overseas SAVED 7pm their own time
  onto a club event; that the "Repeat" labels were derived from a browser-local
  midnight, so an overseas admin could be offered "Weekly on Monday" for a date
  they had selected as a Tuesday; that the series summary is only honest when its
  anchor instant parses; why the form must reload when an operator changes the
  club's timezone; and why the END of a timed event goes through its own resolver,
  because both ends of a time inside a spring-forward gap otherwise collapse onto
  one instant and the event is stored zero-length. Lifting any of those into a
  helper a reader of this form would never open is how each fix gets reverted.
  Splitting the dialog is a genuine job — it carries a create/edit form, a
  read-only detail view, a join-meeting flow, a scope chooser and three
  confirmation prompts in one component — but it is an unrelated one, and doing it
  inside a timezone migration would bury this change's diff and separate every one
  of those comments from the lines they exist to protect.
