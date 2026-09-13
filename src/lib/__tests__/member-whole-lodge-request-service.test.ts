import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingRequestQuoteStatus,
  BookingRequestStatus,
  BookingRequestType,
} from "@prisma/client";

/*
  #2263 — the member whole-lodge request service.

  The privacy argument for this feature is STRUCTURAL, and this file is where
  that structure is pinned. The acknowledgement a member receives is uniform not
  because a delay was tuned but because the handler and the service between them
  never look at the calendar: no booking query, no capacity query, no season
  query, no pricing. A test that only checked the response body would pass
  equally well against an implementation that branched on availability and then
  discarded the answer — and that implementation would leak through timing. So
  the assertions below are about which queries are ISSUED.
*/

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingRequest: {
      create: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      update: vi.fn(),
    },
    bookingRequestQuote: { updateMany: vi.fn() },
    bookingRequestSettings: { findUnique: vi.fn(), upsert: vi.fn() },
    member: { findUnique: vi.fn(), create: vi.fn(), findMany: vi.fn() },
    booking: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    bookingGuest: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn(), update: vi.fn() },
    payment: { create: vi.fn() },
    paymentLink: { create: vi.fn() },
    // The three query surfaces that MUST stay untouched on the submit path.
    season: { findMany: vi.fn() },
    lodge: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    seasonalMembershipAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    membershipType: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

vi.mock("@/lib/email", () => ({
  sendAdminBookingRequestPendingEmail: vi.fn().mockResolvedValue(undefined),
  sendBookingRequestVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendBookingRequestApprovedEmail: vi.fn().mockResolvedValue(undefined),
  sendBookingRequestDeclinedEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminOwnerSubstitutionAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/booking-cancel", () => ({ cancelBooking: vi.fn() }));
vi.mock("bcryptjs", () => ({ hash: vi.fn().mockResolvedValue("hashed") }));
vi.mock("@/lib/cancellation", () => ({
  getNonMemberHoldDays: vi.fn().mockResolvedValue(2),
}));
vi.mock("@/lib/lodge-settings", () => ({
  loadSchoolGroupSoftCap: vi.fn().mockResolvedValue(25),
}));
// #2576 §9 widened this module's import graph: the path under test now reaches the
// hosting coverage drain, which pulls in the incident and email modules. Exports this
// partial mock never had to provide became reachable, so it spreads `importOriginal`
// over the real module and overrides only what it actually stubs — which is the shape
// that cannot break again the next time an edge is added.
vi.mock("@/lib/lodge-capacity", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/lodge-capacity")),
  getLodgeCapacity: vi.fn(async () => 30),
  getDefaultLodgeCapacity: vi.fn(async () => 30),
}));
// Every capacity entry point is mocked and then asserted NOT to have been
// called: the point is that the submit path does not reach them at all.
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sendAdminBookingRequestPendingEmail } from "@/lib/email";
import {
  acquireLodgeCapacityLock,
  checkCapacityForGuestRanges,
} from "@/lib/capacity";
import {
  buildMemberWholeLodgePlaceholderGuests,
  createMemberWholeLodgeRequest,
  isMemberWholeLodgeRequest,
  MEMBER_WHOLE_LODGE_OPEN_REQUEST_CAP,
  priceBookingRequest,
  withdrawMemberWholeLodgeRequest,
} from "@/lib/booking-request";
import { MEMBER_WHOLE_LODGE_OPEN_STATUSES } from "@/lib/member-whole-lodge-requests";

const MEMBER = {
  id: "member-1",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  phoneNumber: "021 000 000",
};

const INPUT = {
  memberId: MEMBER.id,
  checkIn: new Date("2026-08-01T00:00:00.000Z"),
  checkOut: new Date("2026-08-05T00:00:00.000Z"),
  headcount: 12,
  groupDescription: "Club alpine skills course",
  notes: "Arriving late on the Friday",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.member.findUnique).mockResolvedValue(MEMBER as never);
  vi.mocked(prisma.bookingRequest.count).mockResolvedValue(0 as never);
  vi.mocked(prisma.bookingRequest.create).mockResolvedValue({
    id: "req-1",
  } as never);
});

describe("createMemberWholeLodgeRequest (#2263)", () => {
  it("writes a VERIFIED, exclusivity-requesting, member-attributed row and holds no capacity", async () => {
    await createMemberWholeLodgeRequest(INPUT);

    const data = vi.mocked(prisma.bookingRequest.create).mock.calls[0][0]
      .data as Record<string, unknown>;

    // Enters the officer queue directly: an authenticated requester has nothing
    // to email-verify, so no verification token is minted at all.
    expect(data.status).toBe(BookingRequestStatus.VERIFIED);
    expect(data.verifiedAt).toBeInstanceOf(Date);
    expect(data).not.toHaveProperty("verificationTokenHash");
    expect(data).not.toHaveProperty("verificationTokenExpiresAt");

    expect(data.type).toBe(BookingRequestType.GENERAL);
    expect(data.exclusivityRequested).toBe(true);
    expect(data.requestedByMemberId).toBe(MEMBER.id);

    // The member is shown no price at request time, so none is computed.
    expect(data).not.toHaveProperty("indicativePriceCents");

    // Contact details are snapshot from the account, never taken from a body.
    expect(data.contactEmail).toBe(MEMBER.email);
    expect(data.contactFirstName).toBe(MEMBER.firstName);

    // A hostile member cannot deny the lodge by asking: no Booking row, no
    // hold, and the capacity engine is never touched.
    expect(prisma.booking.create).not.toHaveBeenCalled();
    expect(acquireLodgeCapacityLock).not.toHaveBeenCalled();
    expect(checkCapacityForGuestRanges).not.toHaveBeenCalled();
  });

  it("issues NO availability, occupancy, season or pricing query — the timing defence is structural", async () => {
    await createMemberWholeLodgeRequest(INPUT);

    // If any of these ever fires, the handler has acquired a branch whose
    // duration varies with what is already booked, and the uniform-response
    // guarantee becomes a claim about copy rather than about behaviour.
    expect(prisma.booking.findUnique).not.toHaveBeenCalled();
    expect(prisma.booking.create).not.toHaveBeenCalled();
    expect(prisma.season.findMany).not.toHaveBeenCalled();
    expect(prisma.bookingGuest.findMany).not.toHaveBeenCalled();
    expect(checkCapacityForGuestRanges).not.toHaveBeenCalled();
  });

  it("stores placeholder guests sized to the headcount so every guests.length reader keeps working", async () => {
    await createMemberWholeLodgeRequest(INPUT);

    const data = vi.mocked(prisma.bookingRequest.create).mock.calls[0][0]
      .data as { guests: Array<{ firstName: string; lastName: string; ageTier: string }> };

    expect(data.guests).toHaveLength(INPUT.headcount);
    expect(data.guests[0]).toEqual({
      firstName: "Guest",
      lastName: "1",
      ageTier: "ADULT",
    });
    // No guest names are collected (D5), so no real name can appear here.
    expect(
      data.guests.every((guest) => guest.firstName === "Guest"),
    ).toBe(true);
  });

  it("refuses a headcount above the lodge's configured capacity", async () => {
    await expect(
      createMemberWholeLodgeRequest({ ...INPUT, headcount: 31 }),
    ).rejects.toMatchObject({ status: 422 });
    expect(prisma.bookingRequest.create).not.toHaveBeenCalled();
  });

  it("refuses once the member already has the maximum open requests", async () => {
    vi.mocked(prisma.bookingRequest.count).mockResolvedValue(
      MEMBER_WHOLE_LODGE_OPEN_REQUEST_CAP as never,
    );

    await expect(createMemberWholeLodgeRequest(INPUT)).rejects.toMatchObject({
      status: 409,
    });
    expect(prisma.bookingRequest.create).not.toHaveBeenCalled();

    // The cap counts THIS member's non-terminal exclusivity rows — account
    // state, never availability.
    const where = vi.mocked(prisma.bookingRequest.count).mock.calls[0][0]
      ?.where as Record<string, unknown>;
    expect(where.requestedByMemberId).toBe(MEMBER.id);
    expect(where.exclusivityRequested).toBe(true);
    // And the counted statuses are the SAME list the withdraw claim accepts, so
    // the cap can never count a row the member has no way to clear.
    expect(where.status).toEqual({
      in: [...MEMBER_WHOLE_LODGE_OPEN_STATUSES],
    });

    // The refusal is audited with outcome "failure" — cheap detection of a
    // member (or a broken client) hammering the door. It carries the cap and the
    // count, both account state, and nothing about the calendar.
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_request.member_whole_lodge_refused",
        outcome: "failure",
        metadata: expect.objectContaining({
          reason: "open_request_cap",
          cap: MEMBER_WHOLE_LODGE_OPEN_REQUEST_CAP,
        }),
      }),
    );
    const refusalAudit = vi
      .mocked(logAudit)
      .mock.calls.find(
        (call) =>
          (call[0] as { action?: string }).action ===
          "booking_request.member_whole_lodge_refused",
      )![0];
    const serialised = JSON.stringify(refusalAudit).toLowerCase();
    expect(serialised).not.toContain("checkin");
    expect(serialised).not.toContain("available");
  });

  it("audits the submission and alerts admins", async () => {
    await createMemberWholeLodgeRequest(INPUT);

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_request.member_whole_lodge_submitted",
        metadata: expect.objectContaining({ headcount: 12 }),
      }),
    );
    expect(sendAdminBookingRequestPendingEmail).toHaveBeenCalled();
  });
});

describe("withdrawMemberWholeLodgeRequest (#2263)", () => {
  function armTransaction(claimedCount: number) {
    const tx = {
      bookingRequest: {
        updateMany: vi.fn().mockResolvedValue({ count: claimedCount }),
      },
      bookingRequestQuote: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    vi.mocked(prisma.$transaction).mockImplementation(
      (async (fn: (client: unknown) => unknown) => fn(tx)) as never,
    );
    return tx;
  }

  it("claims by owner AND status AND heldBookingId in one guarded update", async () => {
    const tx = armTransaction(1);

    await withdrawMemberWholeLodgeRequest({
      requestId: "req-1",
      memberId: MEMBER.id,
    });

    const where = tx.bookingRequest.updateMany.mock.calls[0][0].where as Record<
      string,
      unknown
    >;
    // Ownership is part of the claim, not a separate read: no window between
    // "is this mine?" and "cancel it", and another member's id behaves exactly
    // like an id that does not exist.
    expect(where.requestedByMemberId).toBe(MEMBER.id);
    expect(where.exclusivityRequested).toBe(true);
    // Load-bearing: member withdraw has NO hold-release machinery, so a row
    // holding beds must not be flippable to CANCELLED here — it would strand an
    // AWAITING_REVIEW hold forever with nothing left to release it.
    expect(where.heldBookingId).toBeNull();

    const data = tx.bookingRequest.updateMany.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(data.status).toBe(BookingRequestStatus.CANCELLED);
    expect(data.version).toEqual({ increment: 1 });
  });

  it("retires any stray SENT quote in the same transaction, after claiming the request", async () => {
    const tx = armTransaction(1);

    await withdrawMemberWholeLodgeRequest({
      requestId: "req-1",
      memberId: MEMBER.id,
    });

    // #1423 lock-ordering invariant: the BookingRequest row is locked BEFORE
    // any quote row, matching decline's claim-first order. A mismatched order
    // deadlocks against a concurrent decline.
    expect(
      tx.bookingRequest.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(tx.bookingRequestQuote.updateMany.mock.invocationCallOrder[0]);

    const quoteArgs = tx.bookingRequestQuote.updateMany.mock.calls[0][0];
    expect(quoteArgs.where.status).toBe(BookingRequestQuoteStatus.SENT);
    // SUPERSEDED = an admin/the system retired it; CANCELLED is the
    // requester-cancel semantic the decline path is careful to distinguish.
    expect(quoteArgs.data.status).toBe(BookingRequestQuoteStatus.SUPERSEDED);
  });

  it("409s the loser of a withdraw-vs-decision race, touches no quote, and audits the refusal", async () => {
    const tx = armTransaction(0);

    await expect(
      withdrawMemberWholeLodgeRequest({ requestId: "req-1", memberId: MEMBER.id }),
    ).rejects.toMatchObject({ status: 409 });

    expect(tx.bookingRequestQuote.updateMany).not.toHaveBeenCalled();
    // No SUCCESS audit — the withdrawal did not happen.
    expect(logAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_request.member_whole_lodge_withdrawn",
      }),
    );
    // But the refusal IS audited. An audit trail recording only successes cannot
    // show a member repeatedly aiming at ids they do not own, which is the
    // cheapest signal that something is wrong.
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_request.member_whole_lodge_withdraw_refused",
        outcome: "failure",
        entityId: "req-1",
      }),
    );
  });

  // M2: the status half of the guarded claim, pinned. Reverting the clause must
  // fail, and it must fail for the RIGHT reason — the exact set, not "some
  // statuses".
  it("claims ONLY the member-visible open statuses, so a decided row can never be clawed back", async () => {
    const tx = armTransaction(1);

    await withdrawMemberWholeLodgeRequest({
      requestId: "req-1",
      memberId: MEMBER.id,
    });

    const where = tx.bookingRequest.updateMany.mock.calls[0][0].where as {
      status: { in: BookingRequestStatus[] };
    };
    // Derived from the ONE list the member DTO's withdraw affordance also reads,
    // so the button and the API can never disagree (finding M3).
    expect(where.status).toEqual({
      in: [...MEMBER_WHOLE_LODGE_OPEN_STATUSES],
    });
    // Spelled out as well as compared, so deleting the constant and inlining a
    // wrong list still fails: every terminal or post-decision status is absent.
    for (const status of [
      BookingRequestStatus.NEW,
      BookingRequestStatus.ACCEPTED,
      BookingRequestStatus.APPROVED,
      BookingRequestStatus.CONVERTED,
      BookingRequestStatus.DECLINED,
      BookingRequestStatus.CANCELLED,
    ]) {
      expect(where.status.in).not.toContain(status);
    }
  });

  it("tolerates a member left over the cap by a merge, and lets them clear it (L6)", async () => {
    /*
      MEMBER_MERGE_RELATION_SPECS classifies BookingRequest.requestedByMemberId
      as `move`, so merging two members re-points the loser's whole-lodge
      requests onto the master — who can end up holding THREE open requests
      against a cap of two. That is accepted because the cap is a CREATION-TIME
      GUARD, not an invariant: nothing reads it to decide whether an existing row
      is valid. The two halves of that claim are asserted together here, because
      each is worthless alone — if the over-cap state were unclearable the merge
      would strand the master, and if creation still succeeded the cap would mean
      nothing.
    */
    const overCap = MEMBER_WHOLE_LODGE_OPEN_REQUEST_CAP + 1;
    vi.mocked(prisma.bookingRequest.count).mockResolvedValue(overCap as never);

    // Half 1: no NEW request may be created while over the cap.
    await expect(createMemberWholeLodgeRequest(INPUT)).rejects.toMatchObject({
      status: 409,
    });
    expect(prisma.bookingRequest.create).not.toHaveBeenCalled();

    // Half 2: the rows they already hold are untouched and still withdrawable,
    // so the master can bring themselves back under the cap unaided. Withdraw
    // does not consult the cap at all — its guard is owner + status + hold.
    const tx = armTransaction(1);
    await withdrawMemberWholeLodgeRequest({
      requestId: "req-merged-in",
      memberId: MEMBER.id,
    });
    const where = tx.bookingRequest.updateMany.mock.calls[0][0].where as Record<
      string,
      unknown
    >;
    expect(where.requestedByMemberId).toBe(MEMBER.id);
    expect(where).not.toHaveProperty("cap");
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_request.member_whole_lodge_withdrawn",
      }),
    );
  });

  it("does not match an already-CONVERTED row: the claim's status set is what refuses it", async () => {
    // Simulate the database's answer for a CONVERTED row — the WHERE matches
    // nothing, so updateMany reports zero. A member cannot cancel a stay an
    // officer already approved and booked out from under the club.
    const tx = armTransaction(0);

    await expect(
      withdrawMemberWholeLodgeRequest({ requestId: "req-1", memberId: MEMBER.id }),
    ).rejects.toMatchObject({ status: 409 });

    // And critically: no unguarded fallback write ran afterwards.
    expect(tx.bookingRequestQuote.updateMany).not.toHaveBeenCalled();
  });
});

describe("member-origin guards on the shared pipeline (#2263)", () => {
  it("identifies a member whole-lodge row by BOTH columns", () => {
    expect(
      isMemberWholeLodgeRequest({
        requestedByMemberId: "m1",
        exclusivityRequested: true,
      }),
    ).toBe(true);
    // A member could in principle be attributed on a non-exclusivity row, and a
    // school row is exclusivity-requesting with no member — neither is the
    // member whole-lodge door.
    expect(
      isMemberWholeLodgeRequest({
        requestedByMemberId: "m1",
        exclusivityRequested: false,
      }),
    ).toBe(false);
    expect(
      isMemberWholeLodgeRequest({
        requestedByMemberId: null,
        exclusivityRequested: true,
      }),
    ).toBe(false);
  });

  it("refuses the officer-price op on a member whole-lodge request", async () => {
    vi.mocked(prisma.bookingRequest.findUnique).mockResolvedValue({
      id: "req-1",
      requestedByMemberId: MEMBER.id,
      exclusivityRequested: true,
      status: BookingRequestStatus.VERIFIED,
      priceCents: null,
      indicativePriceCents: null,
    } as never);

    await expect(
      priceBookingRequest({
        requestId: "req-1",
        adminMemberId: "admin-1",
        priceCents: 50_000,
      }),
    ).rejects.toMatchObject({ status: 409 });

    // Refused before any write: pricing one of these rows would strand it in
    // PRICED with a number the approval path does not read.
    expect(prisma.bookingRequest.updateMany).not.toHaveBeenCalled();
  });
});

describe("placeholder guest builder (#2263)", () => {
  it("numbers guests from 1 and tiers them ADULT", () => {
    expect(buildMemberWholeLodgePlaceholderGuests(3)).toEqual([
      { firstName: "Guest", lastName: "1", ageTier: "ADULT" },
      { firstName: "Guest", lastName: "2", ageTier: "ADULT" },
      { firstName: "Guest", lastName: "3", ageTier: "ADULT" },
    ]);
  });

  it("returns an empty list for a zero headcount rather than throwing", () => {
    expect(buildMemberWholeLodgePlaceholderGuests(0)).toEqual([]);
  });
});
