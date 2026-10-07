import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2700 surface 1 — a SOFT-DELETED booking takes no consent answer, from
 * anybody, and the person who tried is told why.
 *
 * WHAT WAS WRONG. `respondToMemberGuestConsent` read neither `Booking.status`
 * nor `Booking.deletedAt`; the booking was loaded only to pick a lodge lock
 * (`select: { id, lodgeId }`). BOTH arms then reached a write. An APPROVE wrote
 * the guest row, reconciled bed allocations, drained the hosting queue and
 * EMAILED THE BOOKING'S OWNER about a record the club had deleted. A DECLINE
 * additionally recorded a BLOCKED response outside the transaction it rolls
 * back. That is what `INV-ADDPAY-032` tracked as a decision rather than a bug.
 *
 * WHAT THE OWNER DECIDED (10 Aug 2026). Refuse, uniformly for every role,
 * placed after the authorisation check — and **not** as a bare 404. The three
 * options the issue body offered (refuse silently / record and suppress /
 * leave) were all rejected in favour of telling the guest plainly that the
 * booking was cancelled or removed, so somebody clicking a link in a
 * weeks-old consent email gets an explanation instead of a dead end.
 *
 * WHY THAT DISCLOSURE IS SAFE, and it is the ordering that makes it safe:
 * the guard sits BELOW the target/delegate check, so to see the sentence at all
 * you must already be the guest being asked or an accepted family delegate
 * answering for them. Everyone else still gets the route's uniform 403 and
 * cannot tell a deleted booking from a live one, from a booking that never
 * existed, or from one they simply are not on. Two cases below pin exactly
 * that, on a deleted booking AND on a live one, because a difference between
 * those two answers is the whole oracle.
 *
 * MUTATION PROOF. Remove either `if (...deletedAt) refuseDeletedBooking()` from
 * `respondToMemberGuestConsent` and "refuses an APPROVE…" / "refuses a
 * DECLINE…" fail by name (the unlocked pre-read), or "re-asserts the refusal
 * under the global lock…" fails (the locked re-read). Move either guard ABOVE
 * `if (!isTarget && !isDelegate) forbidden()` and "gives a caller with no claim
 * the same 403…" fails. Change the wording in one place rather than in
 * `deleted-booking-refusal.ts` and "says exactly what every other surface
 * says" fails.
 */

const mocks = vi.hoisted(() => ({
  canRespondForTarget: vi.fn(),
  // Part of the resolver contract but only consulted when an answer actually
  // lands, so every case here leaves it unused — asserted below.
  resolveNotificationRecipients: vi.fn(),
}));

// The service is reached through its injected `db` and `delegateResolver`
// parameters, so nothing below the guard ever runs and the real client is never
// used. This mock only stops the module-level `import { prisma }` constructing
// one.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  MemberGuestConsentError,
  respondToMemberGuestConsent,
} from "@/lib/member-guest-consent-service";
import { DELETED_BOOKING_MESSAGE } from "@/lib/deleted-booking-refusal";
import type { prisma as PrismaClientType } from "@/lib/prisma";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const BOOKING_ID = "booking-1";
const GUEST_ID = "guest-1";
const TARGET_ID = "member-target";
const DELEGATE_ID = "member-delegate";
const STRANGER_ID = "member-stranger";
const DELETED_AT = new Date("2026-06-01T00:00:00.000Z");

/**
 * `reachedTransaction` is the sentinel for "was NOT refused". The service's own
 * catch rethrows anything that is not a `ConsentRemovalRefusal`, so this
 * escapes cleanly and proves the call got past the guard rather than merely
 * returning some other value.
 */
const REACHED_TRANSACTION = "REACHED_TRANSACTION";

function makeDb(options: {
  deletedAt?: Date | null;
  consentStatus?: string;
  bookingExists?: boolean;
}) {
  const {
    deletedAt = null,
    consentStatus = "PENDING",
    bookingExists = true,
  } = options;

  const bookingFindUnique = vi.fn(async () =>
    bookingExists ? { id: BOOKING_ID, lodgeId: "lodge-1", deletedAt } : null,
  );

  return {
    db: {
      bookingGuest: {
        findUnique: vi.fn(async () => ({
          id: GUEST_ID,
          memberId: TARGET_ID,
          consentStatus,
          consentExpiresAt: null,
          bookingId: BOOKING_ID,
        })),
      },
      booking: { findUnique: bookingFindUnique },
      $transaction: vi.fn(async () => {
        throw new Error(REACHED_TRANSACTION);
      }),
    } as unknown as typeof PrismaClientType,
    bookingFindUnique,
  };
}

function respond(
  db: typeof PrismaClientType,
  actorMemberId: string,
  action: "APPROVE" | "DECLINE",
) {
  return respondToMemberGuestConsent({
    format: CLUB_FORMAT_TEST,
    bookingId: BOOKING_ID,
    guestId: GUEST_ID,
    actorMemberId,
    action,
    db,
    delegateResolver: {
      canRespondForTarget: mocks.canRespondForTarget,
      resolveNotificationRecipients: mocks.resolveNotificationRecipients,
    },
  });
}

async function refusalOf(promise: Promise<unknown>) {
  try {
    await promise;
    throw new Error("expected the call to be refused, but it resolved");
  } catch (err) {
    if (err instanceof MemberGuestConsentError) return err;
    throw err;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  // Nobody is a delegate unless a case says so.
  mocks.canRespondForTarget.mockResolvedValue(false);
});

describe("respondToMemberGuestConsent — soft-deleted booking (#2700)", () => {
  it.each([["APPROVE"], ["DECLINE"]] as const)(
    "refuses a %s on a deleted booking, telling the guest it was cancelled or removed",
    async (action) => {
      const { db } = makeDb({ deletedAt: DELETED_AT });

      const err = await refusalOf(respond(db, TARGET_ID, action));

      expect(err.status).toBe(404);
      expect(err.message).toBe(DELETED_BOOKING_MESSAGE);
      // Nothing recorded: the refusal lands before the transaction is opened at
      // all, so there is no claim, no bed reconcile, no hosting-queue drain and
      // no email to the booking's owner. The recipient resolver is the thing
      // the owner-notification path would consult, so its never having been
      // called is the closest direct evidence a unit test can offer that no
      // email was addressed.
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(mocks.resolveNotificationRecipients).not.toHaveBeenCalled();
    },
  );

  it("refuses an accepted family DELEGATE the same way, with the same sentence", async () => {
    // A delegate has proved authority over the target, so they are entitled to
    // the explanation too. "Uniformly for every role" is the decision.
    mocks.canRespondForTarget.mockResolvedValue(true);
    const { db } = makeDb({ deletedAt: DELETED_AT });

    const err = await refusalOf(respond(db, DELEGATE_ID, "APPROVE"));

    expect(err.status).toBe(404);
    expect(err.message).toBe(DELETED_BOOKING_MESSAGE);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("gives a caller with no claim the same 403 as always, never the cancelled-or-removed message", async () => {
    // THE ORDERING. Checked before the authorisation step, this guard would
    // answer 404 on a deleted booking and 403 on a live one to somebody holding
    // nothing but two guessed ids — an oracle for "is member X on booking Y?".
    const { db } = makeDb({ deletedAt: DELETED_AT });

    const err = await refusalOf(respond(db, STRANGER_ID, "APPROVE"));

    expect(err.status).toBe(403);
    expect(err.message).toBe("Forbidden");
    expect(err.message).not.toBe(DELETED_BOOKING_MESSAGE);
  });

  it("gives that same caller the identical 403 on a booking that is NOT deleted", async () => {
    // The other half of the oracle argument: the unauthorised answer must not
    // move with the booking's deletion state.
    const { db } = makeDb({ deletedAt: null });

    const err = await refusalOf(respond(db, STRANGER_ID, "APPROVE"));

    expect(err.status).toBe(403);
    expect(err.message).toBe("Forbidden");
  });

  it("still answers 403, not the deleted message, for an already-answered request on a deleted booking", async () => {
    // The pre-existing uniform 403 for a non-PENDING row must keep winning, or
    // the new message would leak the consent status of a row the caller may not
    // be entitled to know about.
    const { db } = makeDb({ deletedAt: DELETED_AT, consentStatus: "CONFIRMED" });

    const err = await refusalOf(respond(db, TARGET_ID, "APPROVE"));

    expect(err.status).toBe(403);
    expect(err.message).toBe("Forbidden");
  });

  it.each([["APPROVE"], ["DECLINE"]] as const)(
    "still lets a %s through on an identical booking that is NOT deleted",
    async (action) => {
      // The complement. Without it the suite would be satisfied by a service
      // that refused every consent answer, which is not the fix.
      const { db } = makeDb({ deletedAt: null });

      await expect(respond(db, TARGET_ID, action)).rejects.toThrow(
        REACHED_TRANSACTION,
      );
      expect(db.$transaction).toHaveBeenCalledTimes(1);
    },
  );

  it("re-asserts the refusal under the global lock, not only on the unlocked pre-read", async () => {
    // A deletion committing between the two reads must still be seen. The
    // unlocked read produces the right answer cheaply; the read inside the
    // transaction — after `pg_advisory_xact_lock(1)`, the same key
    // `softDeleteCancelledBooking` takes — is what makes it true.
    const { db, bookingFindUnique } = makeDb({ deletedAt: null });
    // Live on the pre-read, deleted by the time the locked read runs.
    bookingFindUnique
      .mockResolvedValueOnce({
        id: BOOKING_ID,
        lodgeId: "lodge-1",
        deletedAt: null,
      })
      .mockResolvedValue({
        id: BOOKING_ID,
        lodgeId: "lodge-1",
        deletedAt: DELETED_AT,
      });
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      booking: { findUnique: bookingFindUnique },
    };
    (db.$transaction as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    );

    const err = await refusalOf(respond(db, TARGET_ID, "APPROVE"));

    expect(err.status).toBe(404);
    expect(err.message).toBe(DELETED_BOOKING_MESSAGE);
    // The global lock was taken before the authoritative re-read.
    expect(tx.$executeRaw).toHaveBeenCalled();
  });

  it("does not treat a booking with no deletedAt as deleted", async () => {
    const { db } = makeDb({ deletedAt: null });

    await expect(respond(db, TARGET_ID, "APPROVE")).rejects.toThrow(
      REACHED_TRANSACTION,
    );
  });

  it("says exactly what every other deleted-booking surface says", async () => {
    // ONE message, not three variants that drift. This asserts the service
    // returns the shared constant itself rather than a copy of its text.
    const { db } = makeDb({ deletedAt: DELETED_AT });

    const err = await refusalOf(respond(db, TARGET_ID, "APPROVE"));

    expect(err.message).toBe(DELETED_BOOKING_MESSAGE);
    // And what the wording must NOT carry, per the decision: no actor, because
    // the system cannot always assert who deleted it and naming one invites the
    // reader to wonder whether somebody erred; and no member name, because that
    // would leak the booking owner's identity on a deleted booking.
    expect(err.message).not.toMatch(/admin|administrator|deleted by|owner/i);
  });
});
