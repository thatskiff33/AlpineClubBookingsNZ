# File-size allowance for #4948 (lodge name on booking screens)

file: src/app/(authenticated)/dashboard/page.tsx
lines: 1002
reason: the Next Stay, draft and Recent Bookings rows each gain one
  `BookingListLodgeName` line, their three selects gain the booking's lodge,
  and the existing `Promise.all` gains the active-lodge count (INV-CAP-039).
  The decision itself lives in `bookingListLodgeLabel` and the markup in its
  own component; what stays here is the per-row call, which only reads right
  beside the dates it sits under. Extracting the three row shapes is a
  dashboard refactor out of this issue's scope.
