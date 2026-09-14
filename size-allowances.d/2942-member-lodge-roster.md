# File-size allowances for #2942 (member lodge roster)

Two already-over-budget files gain a few lines each. Neither has a split
available that would leave the code easier to follow than it is now.

file: src/app/(admin)/admin/lodges/[id]/page.tsx
lines: 627
reason: the lodge configuration hub gains one card linking to the new Member
  roster sub-page. Every other area on this hub is a row in the `areas` array
  and costs no lines, and this one cannot be: the array is filtered by module
  flag, and the roster card must appear while its module is OFF so an
  administrator can choose the disclosure level before switching the roster on.
  Adding an "ignore the flag" escape to the shared array would put a
  one-off exception into the loop every other card reads, which is worse than
  the card standing on its own beside the Lobby display card it mirrors.
  Splitting the hub is a real refactor of a 600-line page and is not this
  change.

file: src/lib/config-transfer/categories/club-settings.ts
lines: 1159
reason: the module-flag classification for `memberLodgeRoster` — whether the
  flag travels in a config bundle, and why the per-lodge name detail
  deliberately does not travel with it — has to sit inside the should-travel
  list beside the flag it classifies. That list IS the decision record for
  every module flag; lifting one entry's reasoning out to another file is how
  the next reader stops finding it.
