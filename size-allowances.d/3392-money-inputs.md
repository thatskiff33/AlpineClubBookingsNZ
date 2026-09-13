# File-size allowances for #3392

file: src/app/(admin)/admin/payments/page.tsx
lines: 1323
reason: one line, and it is an import. The three gross-amount boxes on this
  screen spelled `INV-MONEY-003`'s money-box contract by hand as a bare
  `inputMode="decimal"`, which is the fifth spelling of the same thing and the
  one the shared constant's own docblock cited as where the pattern came from;
  they spread `MONEY_INPUT_PROPS` now, which trades three hand-written
  attributes for three spreads and adds the import. Splitting a 1,300-line
  route page is a real piece of work and the right one eventually, but doing it
  inside a change whose whole point is that one spelling of a money box exists
  would bury that in a move diff — and the alternative, leaving this screen on
  the hand-written spelling because the file is long, is how the other four got
  missed in the first place.
