import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fork triyder/AlpineClubBookingsNZ#119: `/api/admin/bookings/[id]/work-party` — the access matrix (view
 * to list, edit to preview or apply), the request shape, and how the service's
 * outcomes reach the officer. The money itself is proved in
 * `work-party-booking-correction.realdb.test.ts`.
 */
const h = vi.hoisted(() => ({
  guard: { ok: true } as { ok: boolean; status?: number },
  requirements: [] as unknown[],
  addBookingToWorkParty: vi.fn(),
  removeBookingFromWorkParty: vi.fn(),
  bookingFindUnique: vi.fn(),
  familyFindMany: vi.fn(async () => [] as Array<{ memberId: string; familyGroupId: string }>),
  findActiveWorkParties: vi.fn(),
  modules: { workParties: true },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: vi.fn(async (requirement: unknown) => {
    h.requirements.push(requirement);
    return h.guard.ok
      ? { ok: true, session: { user: { id: "officer-1" } } }
      : { ok: false, response: new Response("no", { status: h.guard.status ?? 403 }) };
  }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: h.bookingFindUnique },
    familyGroupMember: { findMany: h.familyFindMany },
    // No ledger row took money, unless a case says otherwise (`workPartyPaidWithNoMoneyTaken`).
    paymentTransaction: { count: vi.fn(async () => 0) },
  },
}));
vi.mock("@/lib/lodges", () => ({ getDefaultLodgeId: vi.fn(async () => "lodge-1") }));
vi.mock("@/lib/club-time/server", () => ({
  clubTime: vi.fn(async () => ({ today: () => "2026-07-01" })),
  clubTodayDateOnlyInstant: vi.fn(async () => new Date("2026-07-01T00:00:00.000Z")),
}));
vi.mock("@/lib/module-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/module-settings")),
  loadEffectiveModuleFlags: vi.fn(async () => h.modules),
}));
vi.mock("@/lib/booking-modify-quote-priced", () => ({
  isQuotePricedBooking: vi.fn(async () => false),
}));
vi.mock("@/lib/promo-redemption-slot", () => ({
  multiPromoCodesEnabled: vi.fn(async () => false),
}));
vi.mock("@/lib/work-party", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/work-party")),
  findActiveWorkPartyEventsForRange: h.findActiveWorkParties,
}));
vi.mock("@/lib/club-format-server", () => ({ clubFormatValues: vi.fn(async () => ({})) }));
vi.mock("@/lib/booking-batch-modification-service", () => ({
  prepareBatchModificationForCallerTransaction: vi.fn(async () => ({ pre: true })),
}));
vi.mock("@/lib/work-party-booking-correction", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/work-party-booking-correction")),
  addBookingToWorkParty: h.addBookingToWorkParty,
  removeBookingFromWorkParty: h.removeBookingFromWorkParty,
}));

import { ApiError } from "@/lib/api-error";
import {
  WORK_PARTY_OWN_BOOKING_MESSAGE,
  WORK_PARTY_PAID_WITH_NO_MONEY_MESSAGE,
  WorkPartyCorrectionFiguresChangedError,
} from "@/lib/work-party-booking-correction";
import { GET, POST } from "../route";

const params = Promise.resolve({ id: "booking-1" });
const figures = {
  previousFinalPriceCents: 30_000,
  newFinalPriceCents: 25_000,
  priceDiffCents: -5_000,
  changeFeeCents: 0,
  accountCreditAmountCents: 5_000,
  appliedCreditGivenBackCents: 0,
  refundedExcessCreditCents: 0,
  additionalAmountCents: 0,
  billedToOrganiserCents: 0,
  refundAmountCents: 0,
  settlementMethod: "credit" as const,
};

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/admin/bookings/booking-1/work-party", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
    { params },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.guard = { ok: true };
  h.requirements = [];
  h.modules.workParties = true;
});

describe("the Work Parties module", () => {
  it("404s both methods while the module is off, and changes nothing", async () => {
    h.modules.workParties = false;
    expect((await GET(new Request("http://localhost/x") as never, { params })).status).toBe(404);
    expect((await post({ mode: "preview", workPartyEventId: "wp-1" })).status).toBe(404);
    expect(h.addBookingToWorkParty).not.toHaveBeenCalled();
    expect(h.bookingFindUnique).not.toHaveBeenCalled();
  });
});

describe("access", () => {
  it("lists with bookings view, and previews or applies with bookings edit", async () => {
    h.bookingFindUnique.mockResolvedValue(null);
    await GET(new Request("http://localhost/x") as never, { params });
    h.addBookingToWorkParty.mockResolvedValue({ outcome: "quoted", figures });
    await post({ mode: "preview", workPartyEventId: "wp-1" });
    expect(h.requirements).toEqual([
      { permission: { area: "bookings", level: "view" } },
      { permission: { area: "bookings", level: "edit" } },
    ]);
  });

  it("refuses without the permission and calls nothing", async () => {
    h.guard = { ok: false, status: 403 };
    expect((await post({ mode: "preview", workPartyEventId: "wp-1" })).status).toBe(403);
    expect(h.addBookingToWorkParty).not.toHaveBeenCalled();
  });
});

describe("POST", () => {
  it("previews as a dry run", async () => {
    h.addBookingToWorkParty.mockResolvedValue({ outcome: "quoted", figures });
    const res = await post({ mode: "preview", workPartyEventId: "wp-1" });
    expect(res.status).toBe(200);
    expect(h.addBookingToWorkParty).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        workPartyEventId: "wp-1",
        actorMemberId: "officer-1",
        dryRun: true,
        todayAtClub: "2026-07-01",
        preTransaction: { pre: true },
      }),
    );
  });

  it("applies only with the figures the officer was shown", async () => {
    expect((await post({ mode: "apply", workPartyEventId: "wp-1" })).status).toBe(400);
    h.addBookingToWorkParty.mockResolvedValue({ outcome: "applied", figures, bookingModificationId: "m-1" });
    const res = await post({ mode: "apply", workPartyEventId: "wp-1", expectedFigures: figures, notifyMember: false });
    expect(res.status).toBe(200);
    expect(h.addBookingToWorkParty).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: false, expectedFigures: figures, notifyMember: false }),
    );
  });

  it("returns the new figures when they moved", async () => {
    h.addBookingToWorkParty.mockRejectedValue(
      new WorkPartyCorrectionFiguresChangedError(figures, { methods: ["credit", "card"], paidByOrganiser: false, refundTo: "card" }),
    );
    const res = await post({ mode: "apply", workPartyEventId: "wp-1", expectedFigures: figures });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "FIGURES_CHANGED", figures });
  });

  it("passes a refusal through with its reason", async () => {
    h.addBookingToWorkParty.mockRejectedValue(new ApiError("This booking already has a work party.", 409));
    const res = await post({ mode: "preview", workPartyEventId: "wp-1" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This booking already has a work party.");
  });

  it("hides an unexpected failure behind a nothing-changed message", async () => {
    h.addBookingToWorkParty.mockRejectedValue(new Error("boom"));
    const res = await post({ mode: "preview", workPartyEventId: "wp-1" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/Nothing was changed/);
  });

  it("never accepts the internal code or a member-side field from the body", async () => {
    h.addBookingToWorkParty.mockResolvedValue({ outcome: "quoted", figures });
    await post({ mode: "preview", workPartyEventId: "wp-1", promoCodes: [{ code: "WORKPARTY-X" }] });
    const call = h.addBookingToWorkParty.mock.calls[0][0];
    expect(call).not.toHaveProperty("promoCodes");
  });
});

describe("POST settlement method (triyder/AlpineClubBookingsNZ#129)", () => {
  const settlementOptions = { methods: ["credit", "card"], paidByOrganiser: false };

  it("returns the methods offered with the preview", async () => {
    h.addBookingToWorkParty.mockResolvedValue({ outcome: "quoted", figures, settlementOptions });
    const res = await post({ mode: "preview", workPartyEventId: "wp-1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ settlementOptions });
    // Absent: the service default, so the field is not passed.
    expect(h.addBookingToWorkParty.mock.calls[0][0]).not.toHaveProperty("settlementMethod");
  });

  it("passes the officer's choice through on preview and apply", async () => {
    h.addBookingToWorkParty.mockResolvedValue({ outcome: "quoted", figures, settlementOptions });
    await post({ mode: "preview", workPartyEventId: "wp-1", settlementMethod: "card" });
    expect(h.addBookingToWorkParty).toHaveBeenLastCalledWith(
      expect.objectContaining({ dryRun: true, settlementMethod: "card" }),
    );
    const cardFigures = { ...figures, accountCreditAmountCents: 0, refundAmountCents: 5_000, settlementMethod: "card" };
    h.addBookingToWorkParty.mockResolvedValue({ outcome: "applied", figures: cardFigures, settlementOptions, bookingModificationId: "m-1" });
    const res = await post({ mode: "apply", workPartyEventId: "wp-1", settlementMethod: "card", expectedFigures: cardFigures });
    expect(res.status).toBe(200);
    expect(h.addBookingToWorkParty).toHaveBeenLastCalledWith(
      expect.objectContaining({ dryRun: false, settlementMethod: "card", expectedFigures: cardFigures }),
    );
  });

  it.each(["bank", "CARD", 1, null])("refuses a settlement method of %j with 400, calling nothing", async (value) => {
    expect((await post({ mode: "preview", workPartyEventId: "wp-1", settlementMethod: value })).status).toBe(400);
    expect(h.addBookingToWorkParty).not.toHaveBeenCalled();
  });

  it("passes the service's not-offered refusal through", async () => {
    h.addBookingToWorkParty.mockRejectedValue(
      new ApiError("This booking wasn't paid by card, so the discount can only go back as club credit.", 409),
    );
    const res = await post({ mode: "preview", workPartyEventId: "wp-1", settlementMethod: "card" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/only go back as club credit/);
  });
});

describe("POST action remove (fork triyder/AlpineClubBookingsNZ#130)", () => {
  const removal = {
    ...figures,
    previousFinalPriceCents: 25_000,
    newFinalPriceCents: 30_000,
    priceDiffCents: 5_000,
    changeFeeCents: 0,
    accountCreditAmountCents: 0,
    additionalAmountCents: 5_000,
    billedToOrganiserCents: 0,
    settlementMethod: null,
  };

  it("previews and applies through the removal, never the add", async () => {
    h.removeBookingFromWorkParty.mockResolvedValue({ outcome: "quoted", figures: removal });
    expect((await post({ mode: "preview", action: "remove", workPartyEventId: "wp-1" })).status).toBe(200);
    expect(h.removeBookingFromWorkParty).toHaveBeenLastCalledWith(
      expect.objectContaining({ bookingId: "booking-1", workPartyEventId: "wp-1", dryRun: true }),
    );
    h.removeBookingFromWorkParty.mockResolvedValue({ outcome: "applied", figures: removal, bookingModificationId: "m-2" });
    const res = await post({ mode: "apply", action: "remove", workPartyEventId: "wp-1", expectedFigures: removal });
    expect(res.status).toBe(200);
    expect(h.removeBookingFromWorkParty).toHaveBeenLastCalledWith(
      expect.objectContaining({ dryRun: false, expectedFigures: removal }),
    );
    expect(h.addBookingToWorkParty).not.toHaveBeenCalled();
  });

  it("refuses a settlement method on a removal with 400, calling nothing", async () => {
    const res = await post({ mode: "preview", action: "remove", workPartyEventId: "wp-1", settlementMethod: "card" });
    expect(res.status).toBe(400);
    expect(h.removeBookingFromWorkParty).not.toHaveBeenCalled();
  });

  it("refuses an unknown action with 400", async () => {
    expect((await post({ mode: "preview", action: "undo", workPartyEventId: "wp-1" })).status).toBe(400);
    expect(h.removeBookingFromWorkParty).not.toHaveBeenCalled();
    expect(h.addBookingToWorkParty).not.toHaveBeenCalled();
  });

  it("says a failed removal changed nothing", async () => {
    h.removeBookingFromWorkParty.mockRejectedValue(new Error("boom"));
    const res = await post({ mode: "preview", action: "remove", workPartyEventId: "wp-1" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/could not be removed from the work party. Nothing was changed/);
  });
});

describe("GET", () => {
  const ownBooking = (memberId: string) => ({
    status: "PAID",
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    checkOut: new Date("2026-08-04T00:00:00.000Z"),
    lodgeId: "lodge-1",
    memberId,
    promoRedemptions: [],
  });
  const oneWorkParty = [
    {
      id: "wp-1",
      name: "Here",
      active: true,
      startDate: new Date("2026-08-02T00:00:00.000Z"),
      endDate: new Date("2026-08-03T00:00:00.000Z"),
      discountPercent: 50,
      lodgeId: "lodge-1",
      lodge: { name: "Main" },
      promoCode: { active: true, archivedAt: null },
    },
  ];

  it("owner decision 3: greys out the signed-in officer's own booking with the reason, and its Remove", async () => {
    h.bookingFindUnique.mockResolvedValue(ownBooking("officer-1"));
    h.findActiveWorkParties.mockResolvedValue(oneWorkParty);
    const body = await (await GET(new Request("http://localhost/x") as never, { params })).json();
    expect(body.workParties[0]).toMatchObject({ eligible: false, reason: WORK_PARTY_OWN_BOOKING_MESSAGE });

    h.bookingFindUnique.mockResolvedValue({
      ...ownBooking("officer-1"),
      promoRedemptions: [
        { id: "r-1", applicationOrder: 0, promoCode: { workPartyEvent: { id: "wp-1", name: "Here" } } },
      ],
    });
    const removal = await (await GET(new Request("http://localhost/x") as never, { params })).json();
    expect(removal.removal).toEqual({ eligible: false, reason: WORK_PARTY_OWN_BOOKING_MESSAGE });
  });

  it("owner decision 3: greys out a family member's booking, read for the signed-in officer", async () => {
    h.bookingFindUnique.mockResolvedValue(ownBooking("member-1"));
    h.familyFindMany.mockImplementation(async (args?: unknown) => {
      const where = (args as { where: { memberId?: string; familyGroupId?: { in: string[] } } }).where;
      const links = [
        { memberId: "member-1", familyGroupId: "fam-1" },
        { memberId: "officer-1", familyGroupId: "fam-1" },
      ];
      return links.filter((row) =>
        where.memberId !== undefined ? row.memberId === where.memberId : where.familyGroupId!.in.includes(row.familyGroupId),
      );
    });
    h.findActiveWorkParties.mockResolvedValue(oneWorkParty);
    const body = await (await GET(new Request("http://localhost/x") as never, { params })).json();
    expect(body.workParties[0]).toMatchObject({ eligible: false, reason: WORK_PARTY_OWN_BOOKING_MESSAGE });
    h.familyFindMany.mockReset();
    h.familyFindMany.mockResolvedValue([]);
  });

  it("lists overlapping open work parties with the eligibility answer", async () => {
    h.bookingFindUnique.mockResolvedValue({
      status: "PAID",
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      checkOut: new Date("2026-08-04T00:00:00.000Z"),
      lodgeId: "lodge-1",
      memberId: "member-1",
      promoRedemptions: [],
    });
    h.findActiveWorkParties.mockResolvedValue([
      {
        id: "wp-1",
        name: "Here",
        active: true,
        startDate: new Date("2026-08-02T00:00:00.000Z"),
        endDate: new Date("2026-08-03T00:00:00.000Z"),
        discountPercent: 50,
        lodgeId: "lodge-1",
        lodge: { name: "Main" },
        promoCode: { active: true, archivedAt: null },
      },
      {
        id: "wp-2",
        name: "Elsewhere",
        active: true,
        startDate: new Date("2026-08-02T00:00:00.000Z"),
        endDate: new Date("2026-08-03T00:00:00.000Z"),
        discountPercent: 50,
        lodgeId: "lodge-9",
        lodge: { name: "Other Hut" },
        promoCode: { active: true, archivedAt: null },
      },
    ]);
    const res = await GET(new Request("http://localhost/x") as never, { params });
    const body = await res.json();
    expect(body.currentWorkParty).toBeNull();
    expect(body.workParties.map((w: { id: string; eligible: boolean }) => [w.id, w.eligible])).toEqual([
      ["wp-1", true],
      ["wp-2", false],
    ]);
    expect(body.workParties[1].reason).toMatch(/Other Hut/);
    expect(JSON.stringify(body)).not.toMatch(/WORKPARTY-/);
  });

  it("fork triyder/AlpineClubBookingsNZ#130: says whether the work party on the booking can be removed", async () => {
    h.bookingFindUnique.mockResolvedValue({
      ...ownBooking("member-1"),
      promoRedemptions: [
        { id: "r-1", applicationOrder: 0, promoCode: { workPartyEvent: { id: "wp-1", name: "Here" } } },
      ],
    });
    h.findActiveWorkParties.mockResolvedValue(oneWorkParty);
    const body = await (await GET(new Request("http://localhost/x") as never, { params })).json();
    expect(body.currentWorkParty).toEqual({ id: "wp-1", name: "Here" });
    expect(body.removal).toEqual({ eligible: true, reason: null });

    h.bookingFindUnique.mockResolvedValue({ ...ownBooking("member-1"), status: "CANCELLED", promoRedemptions: [
      { id: "r-1", applicationOrder: 0, promoCode: { workPartyEvent: { id: "wp-1", name: "Here" } } },
    ] });
    const refused = await (await GET(new Request("http://localhost/x") as never, { params })).json();
    expect(refused.removal).toMatchObject({ eligible: false, reason: expect.stringMatching(/current status/) });
  });

  it("#5149 owner decision 20 Nov: the list refuses Remove on a booking paid by account credit alone", async () => {
    const onWorkParty = [{ id: "r-1", applicationOrder: 0, promoCode: { workPartyEvent: { id: "wp-1", name: "Here" } } }];
    const creditOnly = { id: "p-1", status: "SUCCEEDED", amountCents: 0, creditAppliedCents: 10_000, source: "STRIPE" };
    h.bookingFindUnique.mockResolvedValue({ ...ownBooking("member-1"), promoRedemptions: onWorkParty, payment: creditOnly });
    h.findActiveWorkParties.mockResolvedValue(oneWorkParty);
    const body = await (await GET(new Request("http://localhost/x") as never, { params })).json();
    expect(body.removal).toEqual({ eligible: false, reason: WORK_PARTY_PAID_WITH_NO_MONEY_MESSAGE });

    // Money on the payment (an organiser-paid joiner's share, or a card capture): allowed.
    h.bookingFindUnique.mockResolvedValue({
      ...ownBooking("member-1"),
      promoRedemptions: onWorkParty,
      payment: { ...creditOnly, amountCents: 5_000 },
    });
    const allowed = await (await GET(new Request("http://localhost/x") as never, { params })).json();
    expect(allowed.removal).toEqual({ eligible: true, reason: null });
  });

  it("404s an unknown booking", async () => {
    h.bookingFindUnique.mockResolvedValue(null);
    expect((await GET(new Request("http://localhost/x") as never, { params })).status).toBe(404);
  });
});
