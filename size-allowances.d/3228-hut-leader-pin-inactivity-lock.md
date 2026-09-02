# File-size allowances for #3228

Three files grow here and one shrinks against what the first cut of this change
had. The shrink is the point: the interaction listeners and the renewal moved
OUT of the kiosk page into `src/components/lodge-pin-session.tsx`, because a hut
leader's authority spans two pages and the kiosk is only one of them.

file: src/app/(lodge)/lodge/kiosk/page.tsx
lines: 1371
reason: the Lock control, the persistent lock-failure banner and the
  renewal-trouble notice all belong on the screen whose privilege they govern,
  and they are a few lines of JSX each. The renewal itself is NOT here any more
  — it is mounted from `(lodge)/layout.tsx` so it also covers the roster wizard
  — which is why this is 42 lines shorter than the first cut of the same
  feature. A real split of this file is worth doing (it is nearly three times
  its budget) but it is a refactor of the arrivals list, the chore panel and the
  week strip, not something to attempt inside a security fix.

file: src/app/(lodge)/lodge/roster/[date]/setup/page.tsx
lines: 914
reason: the wizard now answers a lapsed PIN session by offering the PIN inline
  and re-running the interrupted step, instead of printing the server's bare
  "Forbidden" over a full lodge's chore allocation that exists nowhere but this
  component's state. The panel itself is a separate component
  (`src/components/lodge-pin-relock-panel.tsx`); what is here is the three
  places that can hit a 403, the retry that picks the step back up, and the
  comments saying which is which. Splitting the wizard is the same
  arrivals/chores/steps refactor as the kiosk above.

`src/app/api/lodge/roster/[date]/route.ts` deliberately has **no** entry. It was
243 lines on the base ref — inside its 250-line route-handler budget — and an
allowance cannot carry a file over a budget it was inside, which is the gate
telling you to make it fit instead. It does: the `GET` gains a `no-store` wrapper
and hands its inner handler the date directly, the `PUT` is not wrapped (see
`src/lib/lodge-cache-headers.ts` -> "Writes"), and the file lands at 249.
