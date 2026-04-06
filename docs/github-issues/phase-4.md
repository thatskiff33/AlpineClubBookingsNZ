## Phase 4: Concurrency & Race Conditions

**Priority:** Critical/High — must complete before go-live
**Depends on:** Phase 1 (C1 unique constraint on email enables H7)
**Reference:** [docs/CODEBASE_REVIEW_2026-04-07.md](../CODEBASE_REVIEW_2026-04-07.md)

### Issues Addressed

| ID | Severity | Description |
|----|----------|-------------|
| C3 | Critical | Roster auto-suggest race condition — duplicate assignments from concurrent requests |
| H3 | High | Xero `findOrCreateContact` race condition — duplicate contacts |
| H7 | High | Email change confirmation — race condition on email uniqueness |
| M12 | Medium | Guest chore token generation creates duplicates on repeated email sends |

### Checklist

- [ ] **C3** — Fix `src/app/api/admin/roster/[date]/route.ts:94-106`:
  - Wrap the assignment existence check + createMany in `prisma.$transaction()`:
    ```typescript
    await prisma.$transaction(async (tx) => {
      const existing = await tx.choreAssignment.findMany({ where: { date } });
      if (!existing.some(a => a.status === 'SUGGESTED' || a.status === 'CONFIRMED')) {
        const allocations = allocateChores(...);
        await tx.choreAssignment.createMany({ data: allocations });
      }
    });
    ```
- [ ] **H3** — Fix `src/lib/xero.ts` `findOrCreateContact()` (~line 359-421):
  - Add an advisory lock keyed on the member ID before the find-or-create:
    ```typescript
    await prisma.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${memberId}))`;
    ```
  - Or use a simpler approach: try to find first, if not found try to create, catch duplicate and re-find
- [ ] **H7** — Fix `src/app/api/auth/confirm-email-change/route.ts:34-57`:
  - With C1 (unique constraint on email) in place, wrap the email uniqueness check + update in a single transaction
  - The DB constraint will prevent duplicate emails even under race conditions
  - Handle the unique constraint violation error with a user-friendly message
- [ ] **M12** — Fix `src/app/api/admin/roster/[date]/route.ts:363-383` (email action):
  - Before creating a new GuestChoreToken, delete existing valid tokens for the same bookingGuestId + date:
    ```typescript
    await prisma.guestChoreToken.deleteMany({
      where: { bookingGuestId: guest.id, date: rosterDate }
    });
    ```
- [ ] Run full test suite: `npm test`
- [ ] Run build: `npm run build`

### Agent Prompt

```
Fix 4 concurrency and race condition issues from the codebase review (docs/CODEBASE_REVIEW_2026-04-07.md, Phase 4).

IMPORTANT: Phase 1 must be completed first (the @unique on Member.email is required for H7).

1. src/app/api/admin/roster/[date]/route.ts:94-106 — The auto-suggest logic checks for
   existing assignments then creates them, but NOT in a transaction. Wrap the check +
   createMany in a prisma.$transaction() to prevent duplicate roster entries from
   concurrent requests.

2. src/lib/xero.ts, findOrCreateContact function (~line 359-421) — Two concurrent calls
   for the same member can create duplicate Xero contacts. Add an advisory lock using
   pg_advisory_xact_lock with a hash of the memberId before the find-or-create logic.

3. src/app/api/auth/confirm-email-change/route.ts:34-57 — The email uniqueness check and
   update are not atomic. Wrap in a single prisma.$transaction(). The @unique constraint
   on Member.email (from Phase 1) provides the DB-level guarantee. Handle Prisma P2002
   (unique violation) with a user-friendly "email already taken" error.

4. src/app/api/admin/roster/[date]/route.ts:363-383 — Before generating a new
   GuestChoreToken, delete existing tokens for the same bookingGuestId + date to prevent
   duplicates from repeated email sends.

After all changes: npm test && npm run build. Commit on branch: fix/phase-4-concurrency
```
