# File-size allowance for #3818 (presence-aware hut-leader coverage)

file: src/app/(admin)/admin/dashboard/page.tsx
lines: 920
reason: the "Handovers this week" read joins the page's one batched
  `Promise.all` and its result is handed to a new card component, so the page
  gains the call, its destructured name, two return fields and the card's
  mount. The card itself (`hut-leader-handovers-card.tsx`) and the uncovered-
  night label (`uncoveredNightLabel`) were moved out to keep the growth to
  these wiring lines; moving the read out of the batch would add a second
  round trip to every dashboard load, which #2091 removed on purpose.
