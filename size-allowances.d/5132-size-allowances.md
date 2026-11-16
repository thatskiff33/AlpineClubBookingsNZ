# Size allowances for #5132

file: src/app/(admin)/admin/booking-desk/bookings/page.tsx
lines: 833
reason: the Bookings list Review chip link built through the shared
  booking-requests link builder; those lines sit inside this file, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.
