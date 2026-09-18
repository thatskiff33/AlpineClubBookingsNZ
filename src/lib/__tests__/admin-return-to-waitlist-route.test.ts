// The admin repair for a stranded zero-dollar waitlist confirm (#2649).
//
// This route is a booking-status writer on a capacity-holding status, so the
// things worth pinning are not the happy path but the refusals: which shapes it
// declines, and the proof that a claim lost to a concurrent writer leaves NO
// trace — no allocation reconcile, no audit row, no member email, and no
// waitlist sweep.

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    booking: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    auditLog: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  };

  return {
    tx,
    transaction: vi.fn(),
    requireAdmin: vi.fn(),
    acquireLodgeCapacityLock: vi.fn().mockResolvedValue(undefined),
    reconcile: vi.fn(),
    sendWaitlistPlaceRestoredEmail: vi.fn(),
    sendWaitlistOfferExpiredEmail: vi.fn(),
    processWaitlistForDates: vi.fn(),
    loggerError: vi.fn(),
  };
});

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: mocks.requireAdmin,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));

vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: mocks.acquireLodgeCapacityLock,
}));

vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithLodgeLockHeld: mocks.reconcile,
}));

vi.mock("@/lib/email", () => ({
  sendWaitlistPlaceRestoredEmail: mocks.sendWaitlistPlaceRestoredEmail,
  sendWaitlistOfferExpiredEmail: mocks.sendWaitlistOfferExpiredEmail,
}));

vi.mock("@/lib/waitlist", () => ({
  processWaitlistForDates: mocks.processWaitlistForDates,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: mocks.loggerError, warn: vi.fn(), info: vi.fn() },
}));

import { POST } from "@/app/api/admin/bookings/[id]/return-to-waitlist/route";
import { WAITLIST_CONFIRM_OFFER_RELEASE_FAILED_AUDIT_ACTION } from "@/lib/waitlist-confirm-recovery-contract";
import {
  RETURN_TO_WAITLIST_AUDIT_ACTION,
  RETURN_TO_WAITLIST_CLAIM_LOST_MESSAGE,
  RETURN_TO_WAITLIST_CONTENDED_MESSAGE,
  RETURN_TO_WAITLIST_NO_STRAND_EVIDENCE_MESSAGE,
  RETURN_TO_WAITLIST_PAYMENT_PRESENT_MESSAGE,
  RETURN_TO_WAITLIST_PRICED_MESSAGE,
  RETURN_TO_WAITLIST_STATUS_MESSAGE,
} from "@/lib/waitlist-return-contract";

const CHECK_IN = new Date("2026-07-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-07-03T00:00:00.000Z");
const STRAND_REPORTED_AT = new Date("2026-06-20T00:00:00.000Z");

function returnRequest() {
  return new NextRequest(
    "http://localhost/api/admin/bookings/booking-1/return-to-waitlist",
    {
      method: "POST",
      headers: {
        "x-request-id": "request-1",
        "x-forwarded-for": "203.0.113.5",
        "user-agent": "vitest",
      },
    },
  );
}

function routeParams() {
  return { params: Promise.resolve({ id: "booking-1" }) };
}

/** The immutable identity read taken before the lodge lock. */
function keyRow() {
  return {
    lodgeId: "lodge-1",
    memberId: "member-1",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
  };
}

/** The mutable re-read taken under both locks. */
function strandedRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "PAYMENT_PENDING",
    finalPriceCents: 0,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    adminCapacityHoldAt: null,
    adminCapacityHoldByMemberId: null,
    wholeLodgeHold: false,
    wholeLodgeHoldAt: null,
    wholeLodgeHoldByMemberId: null,
    member: { email: "member@example.com", firstName: "Alex" },
    payment: null,
    ...overrides,
  };
}

/**
 * The #2648 strand report the provenance guard requires. `findFirst` asks for
 * the NEWEST of the strand action and the repair action, so the fixture has to
 * carry `action` — a repair row coming back means the last thing that happened
 * to this booking was a repair, not a strand.
 */
function strandReport(overrides: Record<string, unknown> = {}) {
  return {
    id: "audit-strand-1",
    action: WAITLIST_CONFIRM_OFFER_RELEASE_FAILED_AUDIT_ACTION,
    createdAt: STRAND_REPORTED_AT,
    ...overrides,
  };
}

/**
 * The route reads immutable identity first and everything mutable second. Route
 * the two `findUnique` calls by the shape they ask for rather than by call
 * order, so a reordering inside the route shows up as a wrong answer instead of
 * silently passing.
 */
function bookingReads(mutable: Record<string, unknown> | null) {
  mocks.tx.booking.findUnique.mockImplementation(
    async (args: { select?: Record<string, unknown> }) =>
      args.select && "lodgeId" in args.select && !("status" in args.select)
        ? keyRow()
        : mutable,
  );
}

describe("POST /api/admin/bookings/[id]/return-to-waitlist (#2649)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mocks.transaction.mockImplementation(
      async (fn: (tx: unknown) => unknown) => fn(mocks.tx),
    );
    bookingReads(strandedRow());
    mocks.tx.booking.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.booking.count.mockResolvedValue(2);
    mocks.tx.auditLog.findFirst.mockResolvedValue(strandReport());
    mocks.tx.auditLog.create.mockResolvedValue({});
    mocks.reconcile.mockResolvedValue(undefined);
    mocks.sendWaitlistPlaceRestoredEmail.mockResolvedValue(undefined);
    mocks.sendWaitlistOfferExpiredEmail.mockResolvedValue(undefined);
    mocks.processWaitlistForDates.mockResolvedValue({ offeredBookingId: null });
  });

  it("puts the member back in the queue and clears the consumed offer", async () => {
    const response = await POST(returnRequest(), routeParams());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      status: "WAITLISTED",
      waitlistPosition: 3,
    });

    // The claim re-asserts BOTH scalar facts that made this booking eligible, so
    // a concurrent re-price or status move matches no row, and it clears both
    // hold fragments alongside the status the way every other release does.
    expect(mocks.tx.booking.updateMany).toHaveBeenCalledWith({
      where: {
        id: "booking-1",
        status: "PAYMENT_PENDING",
        finalPriceCents: 0,
      },
      data: {
        status: "WAITLISTED",
        waitlistPosition: null,
        waitlistOfferedAt: null,
        waitlistOfferExpiresAt: null,
        waitlistOfferedLodgeId: null,
        waitlistOfferedPriceCents: null,
        adminCapacityHoldAt: null,
        adminCapacityHoldByMemberId: null,
        wholeLodgeHold: false,
        wholeLodgeHoldAt: null,
        wholeLodgeHoldByMemberId: null,
      },
    });

    expect(mocks.reconcile).toHaveBeenCalledWith({
      bookingId: "booking-1",
      db: mocks.tx,
      previousRange: { checkIn: CHECK_IN, checkOut: CHECK_OUT },
    });
  });

  it("takes the global lock before the lodge lock, and re-reads mutable state after both", async () => {
    await POST(returnRequest(), routeParams());

    const globalLock = mocks.tx.$executeRaw.mock.invocationCallOrder[0];
    const lodgeLock = mocks.acquireLodgeCapacityLock.mock.invocationCallOrder[0];
    const mutableRead = mocks.tx.booking.findUnique.mock.invocationCallOrder[1];
    const claim = mocks.tx.booking.updateMany.mock.invocationCallOrder[0];

    expect(globalLock).toBeLessThan(lodgeLock);
    expect(lodgeLock).toBeLessThan(mutableRead);
    expect(mutableRead).toBeLessThan(claim);
    expect(mocks.acquireLodgeCapacityLock).toHaveBeenCalledWith(
      mocks.tx,
      "lodge-1",
    );
  });

  it("records the audit row that closes the strand's trail", async () => {
    await POST(returnRequest(), routeParams());

    // Newest-first over BOTH actions: the strand report and the repair. See the
    // provenance tests below for why the repair action has to be in the query.
    expect(mocks.tx.auditLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          targetId: "booking-1",
          action: {
            in: [
              WAITLIST_CONFIRM_OFFER_RELEASE_FAILED_AUDIT_ACTION,
              RETURN_TO_WAITLIST_AUDIT_ACTION,
            ],
          },
        },
        orderBy: { createdAt: "desc" },
      }),
    );
    expect(mocks.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: RETURN_TO_WAITLIST_AUDIT_ACTION,
        memberId: "admin-1",
        actorMemberId: "admin-1",
        subjectMemberId: "member-1",
        targetId: "booking-1",
        entityType: "Booking",
        entityId: "booking-1",
        category: "booking",
        // Pinned because the retention class rides on it: `important` is what
        // puts this row in the same seven-year band as the strand report it
        // resolves, and half a trail is worse than none.
        severity: "important",
        outcome: "success",
        requestId: "request-1",
        ipAddress: "203.0.113.5",
        userAgent: "vitest",
        metadata: expect.objectContaining({
          previousStatus: "PAYMENT_PENDING",
          nextStatus: "WAITLISTED",
          finalPriceCents: 0,
          waitlistPosition: 3,
          resolvesAuditLogId: "audit-strand-1",
          resolvesAuditLogAt: STRAND_REPORTED_AT.toISOString(),
          releasedAdminCapacityHold: null,
          releasedWholeLodgeHold: null,
        }),
      }),
    });
  });

  it("refuses a free PAYMENT_PENDING booking that was never on a waitlist", async () => {
    // #2649 review BLOCKER. `PAYMENT_PENDING` + $0 + no payment row is NOT the
    // stranded shape: SIX other producers reach it — the 20260511113000 backfill
    // migration, a date change that reprices to zero with no credit applied, an
    // admin date shift or a guest ADD releasing a free PENDING non-member hold,
    // an admin review approval, and the group settlement reaper reverting a
    // never-billed ORGANISER_PAYS child. On any of those, this button
    // would un-confirm a booking that was never on a waitlist, prune its
    // allocations and email its member.
    mocks.tx.auditLog.findFirst.mockResolvedValue(null);

    const response = await POST(returnRequest(), routeParams());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: RETURN_TO_WAITLIST_NO_STRAND_EVIDENCE_MESSAGE,
    });
    expect(mocks.tx.booking.updateMany).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
    expect(mocks.sendWaitlistPlaceRestoredEmail).not.toHaveBeenCalled();
    expect(mocks.processWaitlistForDates).not.toHaveBeenCalled();
  });

  it("refuses a booking whose strand was ALREADY repaired", async () => {
    // A strand report is permanent, so a booking repaired once carries one for
    // seven years. Without the resolution test, the same booking — repaired,
    // re-confirmed successfully, then repriced to zero by one of the producers
    // above — would look eligible again on the strength of a closed incident.
    // The query is newest-first over both actions, so a repair coming back IS
    // the refusal.
    mocks.tx.auditLog.findFirst.mockResolvedValue({
      id: "audit-repair-1",
      action: RETURN_TO_WAITLIST_AUDIT_ACTION,
      createdAt: new Date("2026-06-21T00:00:00.000Z"),
    });

    const response = await POST(returnRequest(), routeParams());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: RETURN_TO_WAITLIST_NO_STRAND_EVIDENCE_MESSAGE,
    });
    expect(mocks.tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it("releases an admin capacity hold and an exclusive whole-lodge hold, and names both", async () => {
    // #2649 review S3. An admin may set a capacity hold on ANY PAYMENT_PENDING
    // booking from this same card, so "hold the beds, then repair" is a
    // plausible order. Left on the row the flag is inert at WAITLISTED and then
    // silently RE-ARMS when the booking is re-offered and confirmed back.
    const heldAt = new Date("2026-06-25T02:00:00.000Z");
    bookingReads(
      strandedRow({
        adminCapacityHoldAt: heldAt,
        adminCapacityHoldByMemberId: "officer-9",
        wholeLodgeHold: true,
        wholeLodgeHoldAt: heldAt,
        wholeLodgeHoldByMemberId: "officer-9",
      }),
    );

    const response = await POST(returnRequest(), routeParams());

    expect(response.status).toBe(200);
    expect(mocks.tx.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          adminCapacityHoldAt: null,
          adminCapacityHoldByMemberId: null,
          wholeLodgeHold: false,
          wholeLodgeHoldAt: null,
          wholeLodgeHoldByMemberId: null,
        }),
      }),
    );
    expect(mocks.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: expect.objectContaining({
          releasedAdminCapacityHold: {
            heldAt: heldAt.toISOString(),
            heldByMemberId: "officer-9",
          },
          releasedWholeLodgeHold: {
            heldAt: heldAt.toISOString(),
            heldByMemberId: "officer-9",
          },
        }),
      }),
    });
  });

  it("tells the member their place is RESTORED, not that their offer expired", async () => {
    // #2649 review S4. The member confirmed inside the window and the club's
    // code failed; #2648 has already told them their confirmation was stuck.
    // The offer-expiry mailer's subject, heading and first line all say the
    // offer expired, which is false here and contradicts that message.
    await POST(returnRequest(), routeParams());

    expect(mocks.sendWaitlistOfferExpiredEmail).not.toHaveBeenCalled();
    expect(mocks.sendWaitlistPlaceRestoredEmail).toHaveBeenCalledWith(
      { bookingId: "booking-1", recipientMemberId: "member-1" },
      "member@example.com",
      "Alex",
      CHECK_IN,
      CHECK_OUT,
      3,
      "lodge-1",
    );
    expect(mocks.processWaitlistForDates).toHaveBeenCalledWith({
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      lodgeId: "lodge-1",
    });
  });

  it("re-offers at the lodge whose beds it actually freed, and cannot read any other", async () => {
    // A PAYMENT_PENDING booking's bed allocations sit at `Booking.lodgeId`: that
    // is the lock this route takes, the rows the reconcile prunes, and therefore
    // the queue the freed beds belong to. `expireStaleOffers` reads
    // `waitlistOfferedLodgeId` because ITS entry is still WAITLIST_OFFERED and
    // holds a bed at the offered lodge — copying that rule here would sweep a
    // lodge this repair freed nothing at and leave the freed beds unoffered.
    // Structural, not conditional: the mutable re-read no longer SELECTS the
    // offered lodge at all, so there is nothing to key off by mistake.
    await POST(returnRequest(), routeParams());

    const mutableSelect = mocks.tx.booking.findUnique.mock.calls[1][0].select;
    expect(mutableSelect).not.toHaveProperty("waitlistOfferedLodgeId");
    expect(mutableSelect).not.toHaveProperty("waitlistOfferedPriceCents");

    expect(mocks.processWaitlistForDates).toHaveBeenCalledWith({
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      lodgeId: "lodge-1",
    });
    // The member's own lodge still brands their email.
    expect(mocks.sendWaitlistPlaceRestoredEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      CHECK_IN,
      CHECK_OUT,
      3,
      "lodge-1",
    );
  });

  it("opens its transaction on the admin lock budget, not Prisma's defaults", async () => {
    // #2649 review S5. This route exists BECAUSE an exhausted lock wait broke
    // the confirm's compensating release, and the advisory wait counts against
    // the timeout — on 2s/5s the repair button would 503 during exactly the
    // contention that creates strands. `assignBedRange`, the longest-lived
    // holder of lock(1) in the tree, runs inside a 30s transaction.
    await POST(returnRequest(), routeParams());

    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 10_000,
      timeout: 30_000,
    });
  });

  it("a claim lost to a concurrent writer runs NO side effect", async () => {
    // The booking passed every guard when it was re-read, then another writer
    // moved it between the re-read and the claim. This is the case the status
    // guard exists for, and it must leave nothing behind.
    mocks.tx.booking.updateMany.mockResolvedValue({ count: 0 });

    const response = await POST(returnRequest(), routeParams());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({ error: RETURN_TO_WAITLIST_CLAIM_LOST_MESSAGE });
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
    expect(mocks.sendWaitlistPlaceRestoredEmail).not.toHaveBeenCalled();
    expect(mocks.processWaitlistForDates).not.toHaveBeenCalled();
  });

  it("refuses a booking a concurrent confirm already moved out of PAYMENT_PENDING", async () => {
    bookingReads(strandedRow({ status: "PAID" }));

    const response = await POST(returnRequest(), routeParams());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({ error: RETURN_TO_WAITLIST_STATUS_MESSAGE });
    expect(mocks.tx.booking.updateMany).not.toHaveBeenCalled();
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
    expect(mocks.sendWaitlistPlaceRestoredEmail).not.toHaveBeenCalled();
  });

  it("refuses a booking a concurrent cancel already took", async () => {
    bookingReads(strandedRow({ status: "CANCELLED" }));

    const response = await POST(returnRequest(), routeParams());

    expect(response.status).toBe(409);
    expect(mocks.tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a priced booking: it has a payment path and is not stranded", async () => {
    bookingReads(strandedRow({ finalPriceCents: 12000 }));

    const response = await POST(returnRequest(), routeParams());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({ error: RETURN_TO_WAITLIST_PRICED_MESSAGE });
    expect(mocks.tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a booking that already has a payment record", async () => {
    bookingReads(strandedRow({ payment: { id: "payment-1" } }));

    const response = await POST(returnRequest(), routeParams());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: RETURN_TO_WAITLIST_PAYMENT_PRESENT_MESSAGE,
    });
    expect(mocks.tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it("404s an unknown booking before taking the lodge lock", async () => {
    mocks.tx.booking.findUnique.mockResolvedValue(null);

    const response = await POST(returnRequest(), routeParams());
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ error: "Booking not found" });
    expect(mocks.acquireLodgeCapacityLock).not.toHaveBeenCalled();
  });

  it("is offered on the booking page only behind the SAME provenance test", async () => {
    // Source contract, because the page gate has no render test of its own and
    // the failure it prevents is a false statement to an operator: the banner
    // says the waitlist offer that created this booking was used up. The route
    // refusing is the safety net; the gate is what stops the club asserting a
    // diagnosis about an ordinary booking. A gate that drifted back to the
    // three cheap conditions would still be "safe" and still be wrong, so it is
    // pinned here rather than left to review.
    const { readFileSync } = await import("node:fs");
    // #2958: the admin-gated reads the tools card is fed live in this module.
    const page = readFileSync(
      "src/app/(authenticated)/bookings/[id]/_lib/booking-detail-admin-tools.ts",
      "utf8",
    );

    expect(page).toContain("findUnresolvedWaitlistStrandReport");
    // The awaited provenance read is what `showReturnToWaitlist` is derived
    // from — not merely something the file mentions.
    expect(page).toMatch(
      /showReturnToWaitlist\s*=\s*[\s\S]{0,200}?await findUnresolvedWaitlistStrandReport\(/,
    );
  });

  it("answers 403 without touching the database when the admin cannot edit bookings", async () => {
    const { NextResponse } = await import("next/server");
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });

    const response = await POST(returnRequest(), routeParams());

    expect(response.status).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("maps an exhausted lock wait to a retryable 503, not an opaque 500", async () => {
    // This route exists BECAUSE lock contention broke the confirm's own
    // compensating release (#2623 T4). Its own contention must therefore read
    // as "something else holds this booking, try again", not as "the repair is
    // broken" — nothing was committed either way.
    const contended = Object.assign(new Error("transaction timeout"), {
      code: "P2028",
    });
    mocks.transaction.mockRejectedValue(contended);

    const response = await POST(returnRequest(), routeParams());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ error: RETURN_TO_WAITLIST_CONTENDED_MESSAGE });
    expect(mocks.sendWaitlistPlaceRestoredEmail).not.toHaveBeenCalled();
    expect(mocks.processWaitlistForDates).not.toHaveBeenCalled();
  });

  it("maps an unexpected failure to a 500 without claiming the repair happened", async () => {
    mocks.transaction.mockRejectedValue(new Error("lock wait timeout"));

    const response = await POST(returnRequest(), routeParams());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "Failed to return the booking to the waitlist",
    });
    expect(mocks.sendWaitlistPlaceRestoredEmail).not.toHaveBeenCalled();
    expect(mocks.processWaitlistForDates).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalled();
  });
});
