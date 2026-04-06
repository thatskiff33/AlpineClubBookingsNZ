## Phase 1: Database Schema Safety

**Priority:** Critical — must complete before production
**Blocks:** Phase 4 (C1 unique constraint enables H7 email change fix)
**Reference:** [docs/CODEBASE_REVIEW_2026-04-07.md](../CODEBASE_REVIEW_2026-04-07.md)

### Issues Addressed

| ID | Severity | Description |
|----|----------|-------------|
| C1 | Critical | No `@unique` on `Member.email` — race condition can create duplicate accounts |
| C5 | Critical | No `.max(100)` on guest name fields in booking/guest Zod schemas — DoS vector |
| H4 | High | `Booking.member` relation missing explicit `onDelete` clause |
| H5 | High | `PromoRedemption.member` relation missing explicit `onDelete` clause |
| L10 | Low | `Booking.notes` lacks `@db.VarChar(500)` database-level constraint |

### Checklist

- [ ] Add `@unique` to `Member.email` field in `prisma/schema.prisma`
  - Verify no duplicate emails exist first: `SELECT email, COUNT(*) FROM "Member" WHERE "parentMemberId" IS NULL GROUP BY email HAVING COUNT(*) > 1`
  - If duplicates exist, deduplicate before adding constraint
- [ ] Add `.max(100)` to `firstName` and `lastName` in:
  - `src/app/api/bookings/route.ts` (createBookingSchema guests)
  - `src/app/api/bookings/[id]/guests/route.ts` (addGuestsSchema)
- [ ] Add `onDelete: Cascade` to `Booking.member` relation at `schema.prisma:281`
- [ ] Add `onDelete: Cascade` to `PromoRedemption.member` relation at `schema.prisma:385`
- [ ] Add `@db.VarChar(500)` to `Booking.notes` at `schema.prisma:276`
- [ ] Generate Prisma migration: `npx prisma migrate dev --name schema-safety`
- [ ] Run full test suite: `npm test` (948 tests must pass)
- [ ] Run build: `npm run build`

### Agent Prompt

```
Fix 5 database schema safety issues from the codebase review (docs/CODEBASE_REVIEW_2026-04-07.md, Phase 1).

1. prisma/schema.prisma:97 — Add @unique to Member.email field. This is the most critical fix.

2. src/app/api/bookings/route.ts — Find the createBookingSchema guests array. Add .max(100) to firstName and lastName fields.
   src/app/api/bookings/[id]/guests/route.ts — Find the addGuestsSchema. Add .max(100) to firstName and lastName fields.

3. prisma/schema.prisma:281 — Change the Booking.member relation to:
   member Member @relation(fields: [memberId], references: [id], onDelete: Cascade)

4. prisma/schema.prisma:385 — Change the PromoRedemption.member relation to:
   member Member @relation(fields: [memberId], references: [id], onDelete: Cascade)

5. prisma/schema.prisma:276 — Change Booking.notes to:
   notes String? @db.VarChar(500)

After making changes:
- Run: npx prisma generate
- Run: npm test (all 948 tests must pass)
- Run: npm run build (must succeed)
- Commit on branch: fix/phase-1-schema-safety
```
