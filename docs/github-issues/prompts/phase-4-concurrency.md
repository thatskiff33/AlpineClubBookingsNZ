# Phase 4: Concurrency & Race Condition Fixes

You are fixing 4 race conditions in a Next.js + Prisma booking system. These require careful transaction handling. Make each change exactly as described, then run tests and build.

**PREREQUISITE:** Phase 1 must be completed first (the `@unique` on `Member.email` is needed for Change 3).

## Setup

```
git checkout -b fix/phase-4-concurrency
```

## Change 1 of 4: Fix roster auto-suggest race condition (CRITICAL)

Read `src/app/api/admin/roster/[date]/route.ts` lines 85-140. You will see a pattern like:

```typescript
  let existing = await prisma.choreAssignment.findMany({
    where: { date },
    include: { choreTemplate: true, bookingGuest: true },
  })

  if (regenerate) {
    await prisma.choreAssignment.deleteMany({
      where: { date, status: "SUGGESTED" },
    })
    existing = existing.filter((a) => a.status !== "SUGGESTED")
  }

  const hasSuggested = existing.some((a) => a.status === "SUGGESTED")
  const hasConfirmed = existing.some((a) => a.status === "CONFIRMED" || a.status === "COMPLETED")

  if (!hasSuggested && !hasConfirmed) {
    // Auto-suggest
    const choreTemplates = await prisma.choreTemplate.findMany(...)
    // ... allocateChores() ...
    await prisma.choreAssignment.createMany(...)
  }
```

The problem: the check + create is NOT in a transaction, so two concurrent requests can both create assignments.

Wrap the entire section (from `let existing` through the end of the `if (!hasSuggested && !hasConfirmed)` block) in a Prisma interactive transaction:

```typescript
  const { existing: assignments, created } = await prisma.$transaction(async (tx) => {
    let existing = await tx.choreAssignment.findMany({
      where: { date },
      include: { choreTemplate: true, bookingGuest: true },
    })

    if (regenerate) {
      await tx.choreAssignment.deleteMany({
        where: { date, status: "SUGGESTED" },
      })
      existing = existing.filter((a) => a.status !== "SUGGESTED")
    }

    const hasSuggested = existing.some((a) => a.status === "SUGGESTED")
    const hasConfirmed = existing.some((a) => a.status === "CONFIRMED" || a.status === "COMPLETED")

    let created = false;
    if (!hasSuggested && !hasConfirmed) {
      // ... keep the existing allocation logic but use tx instead of prisma ...
      const choreTemplates = await tx.choreTemplate.findMany(...)
      // ... allocateChores() ...
      await tx.choreAssignment.createMany(...)
      created = true;
    }

    // Re-fetch after potential creation
    const final = await tx.choreAssignment.findMany({
      where: { date },
      include: { choreTemplate: true, bookingGuest: true },
    })

    return { existing: final, created };
  });
```

Read the full function carefully to ensure you move ALL the relevant code inside the transaction, replacing `prisma.` calls with `tx.` calls. Don't break the function's return value or any variables used after this block.

## Change 2 of 4: Fix Xero findOrCreateContact race condition

Read `src/lib/xero.ts` lines 359-421 (the `findOrCreateXeroContact` function). The problem: two concurrent calls for the same member can both create a Xero contact.

Add an advisory lock at the start of the function, right after the member lookup. Import or use the existing prisma client to run:

```typescript
export async function findOrCreateXeroContact(memberId: string): Promise<string> {
  // Advisory lock to prevent duplicate Xero contact creation for same member
  await prisma.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${memberId}))`;

  const member = await prisma.member.findUnique({
    where: { id: memberId },
  });
```

Wait — `pg_advisory_xact_lock` only works inside a transaction. We need to wrap the entire function in a transaction instead. Change the function to:

```typescript
export async function findOrCreateXeroContact(memberId: string): Promise<string> {
  return prisma.$transaction(async (tx) => {
    // Advisory lock prevents concurrent duplicate creation for same member
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${memberId}))`;

    const member = await tx.member.findUnique({
      where: { id: memberId },
    });
    if (!member) throw new Error(`Member not found: ${memberId}`);

    // If member already has a Xero contact linked, verify it exists
    if (member.xeroContactId) {
      try {
        const { xero, tenantId } = await getAuthenticatedXeroClient();
        await xero.accountingApi.getContact(tenantId, member.xeroContactId);
        return member.xeroContactId;
      } catch {
        // Contact not found in Xero, will create a new one
      }
    }

    const { xero, tenantId } = await getAuthenticatedXeroClient();

    // Search by email first
    try {
      const contactsResponse = await xero.accountingApi.getContacts(
        tenantId,
        undefined,
        `EmailAddress="${member.email}"`
      );
      const contacts = contactsResponse.body.contacts;
      if (contacts && contacts.length > 0) {
        const contactId = contacts[0].contactID!;
        await tx.member.update({
          where: { id: memberId },
          data: { xeroContactId: contactId },
        });
        return contactId;
      }
    } catch {
      // Search failed, will create new contact
    }

    // Create new contact
    const contact: Contact = {
      name: `${member.firstName} ${member.lastName}`,
      firstName: member.firstName,
      lastName: member.lastName,
      emailAddress: member.email,
      phones: member.phone
        ? [{ phoneType: Phone.PhoneTypeEnum.MOBILE, phoneNumber: member.phone }]
        : [],
    };

    const response = await xero.accountingApi.createContacts(tenantId, { contacts: [contact] });
    const createdContact = response.body.contacts?.[0];
    if (!createdContact?.contactID) {
      throw new Error("Failed to create Xero contact");
    }

    await tx.member.update({
      where: { id: memberId },
      data: { xeroContactId: createdContact.contactID },
    });

    return createdContact.contactID;
  });
}
```

Note: Replace ALL `prisma.member` calls inside with `tx.member`. The Xero API calls (`xero.accountingApi.*`) stay as-is since they're external.

## Change 3 of 4: Fix email change confirmation race condition

Read `src/app/api/auth/confirm-email-change/route.ts`. Find the section that checks if the new email is already taken and then updates the member. Wrap both operations in a single transaction:

```typescript
    // Atomic: check uniqueness + update email in one transaction
    try {
      await prisma.$transaction(async (tx) => {
        const existingMember = await tx.member.findFirst({
          where: { email: token.newEmail, parentMemberId: null },
        });
        if (existingMember) {
          throw new Error("EMAIL_TAKEN");
        }
        await tx.member.update({
          where: { id: token.memberId },
          data: { email: token.newEmail },
        });
      });
    } catch (err) {
      if (err instanceof Error && err.message === "EMAIL_TAKEN") {
        return NextResponse.json(
          { error: "This email address is already in use" },
          { status: 409 }
        );
      }
      // Handle Prisma unique constraint violation (P2002) as backup
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "P2002") {
        return NextResponse.json(
          { error: "This email address is already in use" },
          { status: 409 }
        );
      }
      throw err;
    }
```

Read the full route handler to understand the current flow, then restructure it to use this transactional approach. Keep the token deletion and Xero update logic outside the transaction (they can be fire-and-forget).

## Change 4 of 4: Fix guest chore token duplicates

Read `src/app/api/admin/roster/[date]/route.ts` lines 363-383 (the email sending section). Find where `createGuestChoreToken` is called:

```typescript
              const token = await createGuestChoreToken(guestId, date)
```

Add a cleanup step before creating the new token:

```typescript
              // Delete old tokens for this guest+date to prevent duplicates
              await prisma.guestChoreToken.deleteMany({
                where: { bookingGuestId: guestId, date },
              });
              const token = await createGuestChoreToken(guestId, date)
```

You'll need to import prisma at the top of the file if it's not already imported:

```typescript
import { prisma } from "@/lib/prisma";
```

## Verify

```bash
npm test
npm run build
```

All tests must pass. Pay particular attention to:
- Xero-related tests (the transaction wrapper changes the function signature slightly)
- Roster tests
- Email change tests

## Commit

```bash
git add -A
git commit -m "Fix race conditions: roster transactions, Xero contact lock, email change, tokens

- C3: Wrap roster auto-suggest in Prisma transaction
- H3: Add advisory lock to Xero findOrCreateContact
- H7: Make email change confirmation atomic with P2002 handling
- M12: Delete old guest chore tokens before creating new ones"
```
