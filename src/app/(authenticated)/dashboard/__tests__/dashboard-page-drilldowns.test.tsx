import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  bookingFindFirst: vi.fn(),
  bookingFindMany: vi.fn(),
  calendarEventFindMany: vi.fn(),
  checkCapacity: vi.fn(),
  getAvailablePromoCodesForMember: vi.fn(),
  getMemberCreditBalance: vi.fn(),
  hasAccessRole: vi.fn(),
  isHutLeader: vi.fn(),
  loadEffectiveModuleFlags: vi.fn(),
  lockerFindMany: vi.fn(),
  memberFindUnique: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findFirst: mocks.bookingFindFirst,
      findMany: mocks.bookingFindMany,
    },
    locker: {
      findMany: mocks.lockerFindMany,
    },
    member: {
      findUnique: mocks.memberFindUnique,
    },
    calendarEvent: {
      findMany: mocks.calendarEventFindMany,
    },
  },
}));

vi.mock("@/lib/member-credit", () => ({
  getMemberCreditBalance: mocks.getMemberCreditBalance,
  // #3369: the one home for the account-credit refusal four settlement paths
  // share. Real, not stubbed: the mock must not turn a refusal into a pass.
  requireMemberCreditRecipient: (memberId: string | null) => {
    if (!memberId) throw new Error("no account to credit (#3369)");
    return memberId;
  },
}));

vi.mock("@/lib/promo", () => ({
  getAvailablePromoCodesForMember: mocks.getAvailablePromoCodesForMember,
}));

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mocks.loadEffectiveModuleFlags,
}));

vi.mock("@/lib/access-roles", () => ({
  hasAccessRole: mocks.hasAccessRole,
}));

vi.mock("@/lib/hut-leader", () => ({
  isHutLeader: mocks.isHutLeader,
}));

vi.mock("@/lib/capacity", () => ({
  checkCapacity: mocks.checkCapacity,
}));

import DashboardPage from "../page";

function moduleFlags() {
  return {
    kiosk: false,
    chores: false,
    financeDashboard: false,
    waitlist: false,
    xeroIntegration: false,
    bedAllocation: false,
    internetBankingPayments: false,
    addressAutocomplete: false,
    groupBookings: false,
    lockers: false,
    induction: false,
    workParties: false,
    promoCodes: true,
    hutLeaders: false,
    communications: false,
    skifieldConditions: false,
    twoFactor: false,
    analytics: false,
  };
}

async function renderDashboardPage() {
  return renderToStaticMarkup(await DashboardPage());
}

describe("DashboardPage summary card drill-downs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({
      user: {
        id: "member-1",
        name: "Mere Member",
      },
    });
    mocks.bookingFindFirst.mockResolvedValue(null);
    mocks.bookingFindMany
      .mockResolvedValueOnce([
        {
          id: "upcoming-1",
          memberId: "member-1",
          lodgeId: "lodge-1",
          checkIn: new Date("2026-08-10T00:00:00.000Z"),
          checkOut: new Date("2026-08-12T00:00:00.000Z"),
          status: "CONFIRMED",
          finalPriceCents: 18000,
          _count: { guests: 2 },
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "owed-1",
          status: "CONFIRMED",
          finalPriceCents: 18000,
          payment: null,
        },
      ]);
    mocks.getMemberCreditBalance.mockResolvedValue(2500);
    mocks.getAvailablePromoCodesForMember.mockResolvedValue([
      {
        code: "SAVE10",
        description: "Winter special",
        fixedNightlyMode: null,
        fixedNightlyPriceCents: null,
        freeNightsPerIndividual: null,
        lifetimeFreeNightsCap: null,
        percentOff: 10,
        type: "PERCENTAGE",
        valueCents: null,
      },
    ]);
    mocks.lockerFindMany.mockResolvedValue([]);
    mocks.calendarEventFindMany.mockResolvedValue([]);
    mocks.memberFindUnique.mockResolvedValue({
      requiresInduction: false,
      inductions: [],
    });
    mocks.loadEffectiveModuleFlags.mockResolvedValue(moduleFlags());
    mocks.hasAccessRole.mockReturnValue(false);
    // Peak occupancy 22 across a 30-bed lodge: night one 20/30, night two
    // 22/30 → minAvailable 8, capacity (occupied + available) 30, filled
    // (capacity - minAvailable) 22. Both figures come from this one call.
    mocks.checkCapacity.mockResolvedValue({
      available: true,
      minAvailable: 8,
      nightDetails: [
        {
          date: new Date("2026-08-10T00:00:00.000Z"),
          occupiedBeds: 20,
          availableBeds: 10,
        },
        {
          date: new Date("2026-08-11T00:00:00.000Z"),
          occupiedBeds: 22,
          availableBeds: 8,
        },
      ],
    });
  });

  it("links summary cards to their drill-down targets", async () => {
    const html = await renderDashboardPage();

    expect(html).toContain('href="/bookings"');
    expect(html).toContain('href="/bookings/upcoming-1?returnTo=%2Fdashboard"');
    expect(html).toContain(
      'href="/profile?returnTo=%2Fdashboard#account-credit"',
    );
    expect(html).toContain('href="/bookings/owed-1?returnTo=%2Fdashboard"');
    expect(html).toContain('href="/profile?returnTo=%2Fdashboard#promo-codes"');
    expect(html).toContain("SAVE10");
    expect(html).toContain("10% off per individual");
  });

  it("shows a lodge occupancy meter for the next stay's dates", async () => {
    const html = await renderDashboardPage();

    expect(mocks.checkCapacity).toHaveBeenCalledWith(
      "lodge-1",
      new Date("2026-08-10T00:00:00.000Z"),
      new Date("2026-08-12T00:00:00.000Z"),
      1,
    );
    // filled (peak occupancy) / capacity, both derived from the one call.
    expect(html).toContain("Lodge occupancy for your dates");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("22 / 30");
  });

  it("omits the occupancy meter when the next stay has no lodge", async () => {
    mocks.bookingFindMany.mockReset();
    mocks.bookingFindMany
      .mockResolvedValueOnce([
        {
          id: "upcoming-1",
          memberId: "member-1",
          lodgeId: null,
          checkIn: new Date("2026-08-10T00:00:00.000Z"),
          checkOut: new Date("2026-08-12T00:00:00.000Z"),
          status: "CONFIRMED",
          finalPriceCents: 18000,
          _count: { guests: 2 },
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const html = await renderDashboardPage();

    expect(mocks.checkCapacity).not.toHaveBeenCalled();
    expect(html).not.toContain("Lodge occupancy for your dates");
  });
});

/**
 * #2779 — the draft card is the locked-out member's only route back to a booking
 * the club made for them, so it has to read as the club's booking and lead with
 * paying. "Resume" describes something you started; nobody started this one.
 */
describe("DashboardPage draft bookings saved by the club (#2779)", () => {
  function draftRow(createdById: string | null, finalPriceCents = 24000) {
    return {
      id: "draft-1",
      checkIn: new Date("2026-09-07T00:00:00.000Z"),
      checkOut: new Date("2026-09-09T00:00:00.000Z"),
      finalPriceCents,
      draftExpiresAt: new Date("2026-08-13T00:00:00.000Z"),
      createdById,
      _count: { guests: 1 },
    };
  }

  function seedWithZeroPricedDraft(createdById: string | null) {
    mocks.bookingFindMany.mockReset();
    mocks.bookingFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([draftRow(createdById, 0)])
      .mockResolvedValueOnce([]);
  }

  function seedWithDraft(createdById: string | null) {
    mocks.bookingFindMany.mockReset();
    mocks.bookingFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([draftRow(createdById)])
      .mockResolvedValueOnce([]);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "member-1", name: "Mere Member" } });
    mocks.bookingFindFirst.mockResolvedValue(null);
    mocks.getMemberCreditBalance.mockResolvedValue(0);
    mocks.getAvailablePromoCodesForMember.mockResolvedValue([]);
    mocks.lockerFindMany.mockResolvedValue([]);
    mocks.calendarEventFindMany.mockResolvedValue([]);
    mocks.memberFindUnique.mockResolvedValue({
      requiresInduction: false,
      inductions: [],
    });
    mocks.loadEffectiveModuleFlags.mockResolvedValue(moduleFlags());
    mocks.hasAccessRole.mockReturnValue(false);
  });

  it("labels an admin-created draft and leads with paying it", async () => {
    seedWithDraft("admin-9");

    const html = await renderDashboardPage();

    expect(html).toContain("Saved for you by the club");
    expect(html).toContain("Review &amp; pay");
    expect(html).not.toContain(">Resume<");
    // The acting admin's identity belongs on the booking page's own "Created by"
    // line, not on a dashboard card.
    expect(html).not.toContain("admin-9");
    // The deletion deadline stays visible, because the draft is deleted rather
    // than cancelled when it expires.
    expect(html).toContain("Expires");
  });

  it("leaves a draft the member saved themselves reading as their own", async () => {
    seedWithDraft(null);

    const html = await renderDashboardPage();

    expect(html).toContain("Resume");
    expect(html).not.toContain("Saved for you by the club");
  });

  // A $0 club-saved draft has no pay step at all: the booking page gates its
  // payment card on `finalPriceCents > 0` and offers ConfirmDraftButton instead,
  // which `confirm-draft` refuses for a locked-out non-admin. "Review & pay" on
  // that row sends the one member this journey exists for to a button that 403s
  // them (INV-LOCKOUT-070). The price is already selected for the line above, so
  // there is nothing to trade off.
  it("does not promise a payment step for a $0 draft the club saved", async () => {
    seedWithZeroPricedDraft("admin-9");

    const html = await renderDashboardPage();

    expect(html).toContain("Saved for you by the club");
    expect(html).toContain("there is nothing to pay, so ask the club to confirm it");
    expect(html).not.toContain("Review &amp; pay");
    expect(html).not.toContain("open it to check the details and pay");
    // Still reachable — the member should be able to look at it.
    expect(html).toContain(">Open<");
  });
});
