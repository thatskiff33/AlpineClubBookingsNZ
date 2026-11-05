# File-size allowances for #4220 (lane a)

file: src/app/(admin)/admin/xero/_components/health-diagnostics-panel.tsx
lines: 736
reason: one import and one tile in the Health Snapshot grid, beside the seven
  tiles already inline there. The tile itself is its own component
  (`credit-used-in-xero-card.tsx`); only its place in the grid can live here,
  because the grid is the list of what the snapshot shows.
