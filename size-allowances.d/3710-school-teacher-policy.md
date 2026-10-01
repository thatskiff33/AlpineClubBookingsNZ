# File-size allowances for #3416

file: src/components/admin/booking-policies/public-booking-requests-section.tsx
lines: 940
reason: the new policy card shares the existing per-card staged edit state,
  fresh settings read, permission banner and save/cancel controls; extracting
  only this card would duplicate those contracts.

file: src/lib/config-transfer/categories/club-settings.ts
lines: 1175
reason: the portable teacher policy is one field in the existing booking
  settings export/import list and must share its validation and default map.
