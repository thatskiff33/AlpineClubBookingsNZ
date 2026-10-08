# File-size allowances for #3976

Each file below gains exactly one line: the import of `pluralHutLeaderLabel`,
the one shared helper the owner's decision on #3976 routes every hut-leader
plural through. The call replaces the old `${label}s` on the same line, so the
import is the whole growth. Splitting a file to absorb one import line would
move unrelated code for no benefit.

file: src/app/(admin)/admin/lodge/page.tsx
lines: 563
reason: one import line for the shared hut-leader plural helper (#3976).

file: src/components/admin-sidebar.tsx
lines: 1205
reason: one import line for the shared hut-leader plural helper (#3976).

file: src/components/admin/booking-requests/public-booking-requests-panel.tsx
lines: 2707
reason: one import line for the shared hut-leader plural helper (#3976).
