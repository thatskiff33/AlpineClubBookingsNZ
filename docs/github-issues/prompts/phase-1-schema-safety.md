# Phase 1: Database Schema Safety

You are fixing 5 database schema issues in a Next.js + Prisma booking system. Make each change exactly as described, then run tests and build.

## Setup

```
git checkout -b fix/phase-1-schema-safety
```

## Change 1 of 5: Add @unique to Member.email

Read `prisma/schema.prisma` lines 95-100. You will see:

```prisma
model Member {
  id            String   @id @default(cuid())
  email         String
```

Change line 97 to:

```prisma
  email         String   @unique
```

This prevents duplicate member accounts via race conditions.

## Change 2 of 5: Add .max(100) to guest name fields in booking creation

Read `src/app/api/bookings/route.ts` lines 26-43. Find the `createBookingSchema`. Inside the guests array object, change:

```typescript
firstName: z.string().min(1),
lastName: z.string().min(1),
```

to:

```typescript
firstName: z.string().min(1).max(100),
lastName: z.string().min(1).max(100),
```

Now read `src/app/api/bookings/[id]/guests/route.ts` lines 19-31. Find `addGuestsSchema`. Make the same change:

```typescript
firstName: z.string().min(1),
lastName: z.string().min(1),
```

to:

```typescript
firstName: z.string().min(1).max(100),
lastName: z.string().min(1).max(100),
```

## Change 3 of 5: Add onDelete to Booking.member

Read `prisma/schema.prisma` line 281. You will see:

```prisma
  member           Member               @relation(fields: [memberId], references: [id])
```

Change to:

```prisma
  member           Member               @relation(fields: [memberId], references: [id], onDelete: Cascade)
```

## Change 4 of 5: Add onDelete to PromoRedemption.member

Read `prisma/schema.prisma` line 389. You will see:

```prisma
  member    Member    @relation(fields: [memberId], references: [id])
```

Change to:

```prisma
  member    Member    @relation(fields: [memberId], references: [id], onDelete: Cascade)
```

## Change 5 of 5: Add database-level length constraint to Booking.notes

Read `prisma/schema.prisma` line 276. You will see:

```prisma
  notes              String?
```

Change to:

```prisma
  notes              String?       @db.VarChar(500)
```

## Verify

Run these commands in order. ALL must succeed:

```bash
npx prisma generate
npm test
npm run build
```

All 948 tests must pass. If any test fails, read the error message and fix the issue before committing.

## Commit

```bash
git add prisma/schema.prisma src/app/api/bookings/route.ts src/app/api/bookings/[id]/guests/route.ts
git commit -m "Schema safety: unique email, name length limits, onDelete cascades, notes varchar

- C1: Add @unique to Member.email to prevent duplicate accounts
- C5: Add .max(100) to guest firstName/lastName in booking + guest schemas
- H4: Add onDelete: Cascade to Booking.member relation
- H5: Add onDelete: Cascade to PromoRedemption.member relation
- L10: Add @db.VarChar(500) to Booking.notes field"
```
