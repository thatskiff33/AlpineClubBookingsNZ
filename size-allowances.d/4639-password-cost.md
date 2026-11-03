# File-size allowances for #4639

file: src/app/api/admin/lodge/route.ts
lines: 492
reason: One import routes the existing password writer to the shared bcrypt cost. Splitting the surrounding service would expand this auth fix into an unrelated refactor.

file: src/app/api/admin/members/import/route.ts
lines: 816
reason: One import routes the existing password writer to the shared bcrypt cost. Splitting the surrounding service would expand this auth fix into an unrelated refactor.

file: src/app/api/admin/xero/import-member-contact/route.ts
lines: 394
reason: One import routes the existing password writer to the shared bcrypt cost. Splitting the surrounding service would expand this auth fix into an unrelated refactor.

file: src/lib/admin-family-group-requests-service.ts
lines: 1711
reason: One import routes the existing password writer to the shared bcrypt cost. Splitting the surrounding service would expand this auth fix into an unrelated refactor.

file: src/lib/admin-members-service.ts
lines: 1783
reason: One import routes the existing password writer to the shared bcrypt cost. Splitting the surrounding service would expand this auth fix into an unrelated refactor.

file: src/lib/booking-request-quotes.ts
lines: 2233
reason: One import routes the existing password writer to the shared bcrypt cost. Splitting the surrounding service would expand this auth fix into an unrelated refactor.

file: src/lib/booking-request.ts
lines: 3091
reason: One import routes the existing password writer to the shared bcrypt cost. Splitting the surrounding service would expand this auth fix into an unrelated refactor.

file: src/lib/group-booking.ts
lines: 1967
reason: One import routes the existing password writer to the shared bcrypt cost. Splitting the surrounding service would expand this auth fix into an unrelated refactor.

file: src/lib/nomination.ts
lines: 2649
reason: One import routes the existing password writer to the shared bcrypt cost. Splitting the surrounding service would expand this auth fix into an unrelated refactor.

file: src/lib/school-booking-request.ts
lines: 3230
reason: One import routes the existing password writer to the shared bcrypt cost. Splitting the surrounding service would expand this auth fix into an unrelated refactor.

file: src/lib/xero-member-import.ts
lines: 1301
reason: One import routes the existing password writer to the shared bcrypt cost. Splitting the surrounding service would expand this auth fix into an unrelated refactor.
