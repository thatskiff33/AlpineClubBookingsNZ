# File-size allowances for #3485

file: src/components/admin/booking-requests/public-booking-requests-panel.tsx
lines: 2686
reason: the teacher attention warning, disabled actions, and derived-total display
  belong beside the three existing blob warnings in this card; extracting just
  this state would split one decision across components. A broader card split
  is outside this bounded read-path repair.

file: src/lib/booking-request.ts
lines: 2980
reason: the two-line net growth is the school-only serialization flag beside
  the existing guest, link, and quote flags. The shared teacher schema was
  extracted instead of duplicated; moving the whole serializer is unrelated.
