## Database Rules (applies to prisma/**)

- All prices stored as integer cents (e.g. $45.50 = 4550) - never use floats for money
- Use Prisma transactions for any multi-table writes
- Always add indexes on foreign keys and commonly queried fields
- Season year logic: if current month >= April, seasonYear = currentYear; else seasonYear = currentYear - 1
- Lodge capacity is 29 beds (6 rooms x 4 beds + 1 room x 5 beds)
- Booking is capacity-based, not room-based
- Use cuid() for all primary keys
- All timestamps in Pacific/Auckland timezone
- Dates for bookings are date-only (no time component) - checkIn/checkOut are calendar dates
