# File-size allowances for #4950 (booking wizard keeps work in the tab)

The seams that existed were taken first: what is kept and how it is checked
lives in `src/lib/booking-wizard-work.ts`, when it is saved and restored in
`use-wizard-work-persistence.ts`, and the page's notice in
`_components/restored-work-notice.tsx`. What is left has to sit where the
wizard's state is.

file: src/app/(authenticated)/book/_hooks/use-booking-wizard.ts
lines: 2567
reason: restoring work writes nineteen pieces of the wizard's own state and then
  re-runs the wizard's own date check and quote, so the member's restored inputs
  are checked exactly as a click would check them. Those setters and functions
  are private to this hook; moving the restore out would mean handing a second
  module every setter, which is a wider surface than the code it moves. About a
  third of the growth is the date check learning to report whether it moved on,
  which the restore needs and a click ignores.

file: src/app/(authenticated)/book/page.tsx
lines: 712
reason: the notice itself is its own component; the page gains only the import,
  the two values it reads from the hook and the one line that places it above
  the steps, which is page layout and belongs in the page.
