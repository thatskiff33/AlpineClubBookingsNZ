# File-size allowances for #3228

file: src/app/(lodge)/lodge/kiosk/page.tsx
lines: 1413
reason: the idle window has to be enforced where the interaction happens, and
  on this page that is the same component that already owns the club-day tick
  and the two-minute data refresh. The whole point of the change is that those
  three timers must NOT be confused with each other, so putting the interaction
  timer in a separate module would move the one piece of code whose value is
  sitting next to the traffic it deliberately ignores — and the comment
  explaining why is longer than the code. A real split of this file is worth
  doing (it is nearly three times its budget) but it is a refactor of the
  arrivals list, the chore panel and the week strip, not something to attempt
  inside a security fix.
