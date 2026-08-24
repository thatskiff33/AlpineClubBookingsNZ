# File-size allowance for #3077 (CT-4 group F5, #2870)

The other file this change grew past its ceiling, `src/lib/calendar-service.ts`,
is **not** listed here. It was inside its budget on the base ref, so an
allowance is refused for it by name and rightly — its pure half was extracted to
`src/lib/calendar-occurrences.ts` instead, and it is back under 700 LOC.

file: src/components/calendar/event-dialog.tsx
lines: 1024
reason: thirty-three net lines on a 991-line dialog that was already 291 over
  budget on the base ref and is not restructured here. Counted: twenty-three are
  COMMENT, six are imports, one is a `parseInstant` guard, and the remaining
  eleven are Prettier re-wrapping eleven existing call expressions that each
  gained one `club.zone` argument — the dialog also LOSES an eight-line
  host-local `todayDateValue()` helper, so there is no new logic in it at all.
  The comments are the point and they cannot be lifted out. Each sits at the line
  it governs and records a measured defect: that the date and time boxes were
  composed with `new Date("...T19:00")`, which JavaScript resolves in the HOST's
  zone, so an officer editing from overseas SAVED 7pm their own time onto a club
  event; that the "Repeat" labels were derived from a browser-local midnight and
  could offer "Weekly on Monday" for a Tuesday; and why the form must reload when
  an operator changes the club's timezone. Every one of those wrong versions
  looked deliberate and agrees with the right one in New Zealand, which is why
  the explanation has to be at the call site rather than in a helper a reader of
  this form would never open. Splitting the dialog is a genuine job — it carries
  a create/edit form, a read-only detail view, a join-meeting flow, a scope
  chooser and three confirmation prompts in one component — but it is an
  unrelated one, and doing it inside a timezone migration would bury this
  change's diff and separate all four comments from the lines they exist to
  protect.
