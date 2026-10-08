# File-size allowance for #3818 (presence-aware hut-leader coverage)

file: src/app/(admin)/admin/dashboard/page.tsx
lines: 976
reason: the hut-leader read stays in the page's one batched `Promise.all`
  but now waits on the shared permission-matrix promise, so it can skip the
  "Handovers this week" read (and the names it needs) for an actor who cannot
  see that card without serialising the batch; the page then labels the
  uncovered nights in the club's date format and mounts the new card. The card
  itself (`hut-leader-handovers-card.tsx`), the combined read
  (`getHutLeaderDashboardCoverage`) and the uncovered-night label
  (`uncoveredNightLabel`) live outside the page to keep the growth to these
  wiring lines; moving the read out of the batch would add a second round trip
  to every dashboard load, which #2091 removed on purpose.
