# File-size allowances for #3413

file: src/app/(admin)/admin/bed-allocation/page.tsx
lines: 1980
reason: the board's anonymous-school-adult hold notice sits with the existing
  date window and allocation controls so officers see the occupied nights in
  the same view; extracting the notice would duplicate board payload handling.

file: src/lib/capacity.ts
lines: 1154
reason: the pending-adult count is one additional term in the canonical
  occupancy calculation, beside the named guest-night terms it must share.
