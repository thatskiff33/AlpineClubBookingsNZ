# File-size allowances for #4937

file: src/lib/capacity.ts
lines: 1195
reason: the range occupancy reader has to sit beside the private occupancy
  index and per-night guest walk it reuses; moving it out would mean exporting
  those internals, which the night-occupancy census keeps in this one module.

file: src/app/api/admin/reports/route.ts
lines: 377
reason: three lines to refuse an over-long range before any booking is read;
  the rule and message already live in date-range-presets.ts.

file: src/app/(admin)/admin/finance/reports/page.tsx
lines: 772
reason: one line clearing the previous range's figures when a query is
  refused, beside the fetch-sequence guard it belongs to.
