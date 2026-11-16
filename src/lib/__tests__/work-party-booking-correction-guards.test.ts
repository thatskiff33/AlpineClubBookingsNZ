import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fork #129: the service's own guards around the canonical edit, with the edit
 * itself (`modifyBookingBatch`) doubled so each guard can be handed a shape the
 * real pipeline would not produce:
 *
 *  - the refund backstop: a refund the offered options did not mean (one under
 *    `credit`) is refused, never paid;
 *  - the options are the edit's own (upstream owner decision, 15 Nov 2026): a
 *    refund is offered exactly where the edit asked for a method
 *    (`requiresSettlementMethod`), on a card- or bank-paid booking alike, and
 *    one requested where the edit offers none is refused (409);
 *  - #129 decision 6 (16 Nov): the officer's own or family's booking is refused
 *    exactly when money would come back to them, on the preview and the save;
 *    for an organiser-paid joiner the recipient is the group organiser;
 *  - the settlement method is a checked figure on its own: a save whose figures
 *    differ ONLY in the method is refused.
 *
 * The real money paths are proved on PostgreSQL in
 * `work-party-booking-correction.realdb.test.ts`.
 */
const h = vi.hoisted(() => ({
  booking: null as Record<string, unknown> | null,
  parent: null as Record<string, unknown> | null,
  family: [] as Array<{ memberId: string; familyGroupId: string }>,
  modified: null as Record<string, unknown> | null,
  modifyCalls: [] as Array<Record<string, unknown>>,
}));

const tx = {
  $executeRaw: vi.fn(async () => 0),
  booking: {
    findUnique: vi.fn(async ({ select }: { select: Record<string, unknown> }) =>
      "lodgeId" in select && Object.keys(select).length === 1 ? { lodgeId: "lodge-1" } : h.booking,
    ),
    findUniqueOrThrow: vi.fn(async () => h.parent),
  },
  workPartyEvent: {
    findUnique: vi.fn(async () => ({
      name: "Spring Bee",
      active: true,
      startDate: new Date("2026-08-02T00:00:00.000Z"),
      endDate: new Date("2026-08-03T00:00:00.000Z"),
      lodgeId: "lodge-1",
      lodge: { name: "Main" },
      promoCode: { id: "promo-1", code: "WP-1", active: true, archivedAt: null },
    })),
  },
  promoRedemption: { findFirst: vi.fn(async () => ({ id: "redemption-1" })) },
  familyGroupMember: {
    findMany: vi.fn(async ({ where }: { where: { memberId?: string; familyGroupId?: { in: string[] } } }) =>
      h.family.filter((row) =>
        where.memberId !== undefined
          ? row.memberId === where.memberId
          : where.familyGroupId!.in.includes(row.familyGroupId),
      ),
    ),
  },
};

vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) },
}));
vi.mock("@/lib/capacity", () => ({ acquireLodgeCapacityLock: vi.fn(async () => undefined) }));
vi.mock("@/lib/lodges", () => ({ getDefaultLodgeId: vi.fn(async () => "lodge-1") }));
vi.mock("@/lib/booking-row-lock", () => ({ lockBookingRowForOwnerRead: vi.fn(async () => undefined) }));
vi.mock("@/lib/booking-exception-approval", () => ({ reauthorizeBookingOfficerFromDb: vi.fn(async () => true) }));
vi.mock("@/lib/booking-modify-quote-priced", () => ({ isQuotePricedBooking: vi.fn(async () => false) }));
vi.mock("@/lib/promo-redemption-slot", () => ({ multiPromoCodesEnabled: vi.fn(async () => false) }));
vi.mock("@/lib/booking-batch-modification-service", () => ({
  modifyBookingBatch: vi.fn(async (args: Record<string, unknown>) => {
    h.modifyCalls.push(args);
    return h.modified;
  }),
}));

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { requireCalendarDate } from "@/lib/club-time";
import {
  addBookingToWorkParty,
  WORK_PARTY_OWN_MONEY_BACK_MESSAGE,
  WORK_PARTY_SETTLEMENT_NOT_OFFERED_MESSAGE,
  WorkPartyCorrectionFiguresChangedError,
  type WorkPartyCorrectionFigures,
} from "@/lib/work-party-booking-correction";

const PAID_BY_CARD = { status: "SUCCEEDED", amountCents: 20_000, creditAppliedCents: 0, source: "STRIPE" };

function seedBooking(change: Record<string, unknown> = {}) {
  h.booking = {
    status: "PAID",
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    checkOut: new Date("2026-08-04T00:00:00.000Z"),
    lodgeId: "lodge-1",
    memberId: "member-1",
    finalPriceCents: 20_000,
    organiserSettled: false,
    parentBookingId: null,
    payment: PAID_BY_CARD,
    promoRedemptions: [],
    ...change,
  };
}

/**
 * What the canonical edit reports back: a 5,000c reduction, settled as given.
 * `requiresSettlementMethod` is the edit's own answer to "is there a choice":
 * true for a paid booking with cash to return, false otherwise.
 */
function edit(
  money: Partial<Record<"refundAmountCents" | "accountCreditAmountCents" | "appliedCreditGivenBackCents" | "refundedExcessCreditCents", number>>,
  requiresSettlementMethod = true,
) {
  h.modified = {
    requiresSettlementMethod,
    booking: { finalPriceCents: 15_000 },
    priceDiffCents: -5_000,
    refundAmountCents: 0,
    accountCreditAmountCents: 0,
    appliedCreditGivenBackCents: 0,
    refundedExcessCreditCents: 0,
    additionalAmountCents: 0,
    promoChangeNotApplied: null,
    bookingModificationId: "mod-1",
    ...money,
  };
}

const common = {
  bookingId: "booking-1",
  workPartyEventId: "wp-1",
  actorMemberId: "officer-1",
  notifyMember: false,
  ipAddress: "127.0.0.1",
  todayAtClub: requireCalendarDate("2026-07-01"),
  format: CLUB_FORMAT_TEST,
  preTransaction: {} as never,
};

async function refusal(run: Promise<unknown>) {
  return run.then(
    () => null,
    (error: { status?: number; message: string }) => ({ status: error.status, message: error.message }),
  );
}

beforeEach(() => {
  h.family = [];
  h.parent = null;
  h.modifyCalls = [];
  seedBooking();
  edit({ accountCreditAmountCents: 5_000 });
});

describe("the refund backstop", () => {
  it("refuses a refund the officer did not choose (a refund under credit), and saves nothing", async () => {
    edit({ refundAmountCents: 5_000 });
    expect(await refusal(addBookingToWorkParty({ ...common, settlementMethod: "credit", dryRun: true }))).toEqual({
      status: 409,
      message: expect.stringContaining("would be refunded, not credited"),
    });
    expect(h.modifyCalls[0]).toMatchObject({ input: expect.objectContaining({ settlementMethod: "credit" }) });
  });

  it("allows the refund the officer chose on a card-paid booking", async () => {
    edit({ refundAmountCents: 5_000 });
    const result = await addBookingToWorkParty({ ...common, settlementMethod: "card", dryRun: true });
    expect(result.figures).toMatchObject({ refundAmountCents: 5_000, settlementMethod: "card" });
    expect(result.settlementOptions).toEqual({ methods: ["credit", "card"], paidByOrganiser: false, refundTo: "card" });
  });
});

describe("the options are the ordinary edit's (upstream owner decision, 15 Nov 2026)", () => {
  const PAID_BY_BANK = { ...PAID_BY_CARD, source: "INTERNET_BANKING" };

  it("offers a refund by bank transfer on a booking paid by Internet Banking, and runs the edit with it", async () => {
    seedBooking({ payment: PAID_BY_BANK });
    edit({ refundAmountCents: 5_000 });
    const result = await addBookingToWorkParty({ ...common, settlementMethod: "card", dryRun: true });
    expect(result.settlementOptions).toEqual({ methods: ["credit", "card"], paidByOrganiser: false, refundTo: "bank" });
    expect(result.figures).toMatchObject({ refundAmountCents: 5_000, settlementMethod: "card" });
    expect(h.modifyCalls[0]).toMatchObject({ input: expect.objectContaining({ settlementMethod: "card" }) });
  });

  it("defaults a bank-paid booking to club credit", async () => {
    seedBooking({ payment: PAID_BY_BANK });
    const result = await addBookingToWorkParty({ ...common, dryRun: true });
    expect(result.figures).toMatchObject({ accountCreditAmountCents: 5_000, settlementMethod: "credit" });
    expect(h.modifyCalls[0]).toMatchObject({ input: expect.objectContaining({ settlementMethod: "credit" }) });
  });

  it.each([
    ["card", PAID_BY_CARD],
    ["Internet Banking", { ...PAID_BY_CARD, source: "INTERNET_BANKING" }],
  ])("refuses a refund where the edit offers no choice (paid by %s, nothing refundable), with 409", async (_label, payment) => {
    seedBooking({ payment });
    edit({ appliedCreditGivenBackCents: 5_000 }, false);
    expect(await refusal(addBookingToWorkParty({ ...common, settlementMethod: "card", dryRun: true }))).toEqual({
      status: 409,
      message: WORK_PARTY_SETTLEMENT_NOT_OFFERED_MESSAGE,
    });
  });

  it("offers credit only on an unpaid booking", async () => {
    seedBooking({ status: "PAYMENT_PENDING", payment: null });
    edit({}, false);
    const result = await addBookingToWorkParty({ ...common, dryRun: true });
    expect(result.settlementOptions).toEqual({ methods: ["credit"], paidByOrganiser: false, refundTo: null });
  });

  it("runs an organiser-paid joiner's edit with the organiser's disposition, and refuses credit", async () => {
    seedBooking({ organiserSettled: true, parentBookingId: "organiser-booking" });
    h.parent = { memberId: "organiser-1" };
    edit({ refundAmountCents: 5_000 }, false);
    expect(await refusal(addBookingToWorkParty({ ...common, settlementMethod: "credit", dryRun: true }))).toEqual({
      status: 409,
      message: expect.stringMatching(/group organiser/),
    });
    expect(h.modifyCalls[0]).toMatchObject({ input: expect.objectContaining({ settlementMethod: "card" }) });
  });
});

describe("own or family booking (#129 decision 6, 16 Nov)", () => {
  it("allows the officer's own booking when nothing comes back", async () => {
    seedBooking({ memberId: "officer-1", status: "PAYMENT_PENDING", payment: null });
    edit({}, false);
    const result = await addBookingToWorkParty({ ...common, dryRun: true });
    expect(result.outcome).toBe("quoted");
  });

  it.each([
    ["credit", { accountCreditAmountCents: 5_000 }, "credit"],
    ["a card refund", { refundAmountCents: 5_000 }, "card"],
    ["applied credit given back", { appliedCreditGivenBackCents: 5_000 }, "credit"],
  ] as const)("refuses the officer's own booking when %s would come back, on preview and apply", async (_label, money, method) => {
    seedBooking({ memberId: "officer-1" });
    edit(money);
    expect(await refusal(addBookingToWorkParty({ ...common, settlementMethod: method, dryRun: true }))).toEqual({
      status: 409,
      message: WORK_PARTY_OWN_MONEY_BACK_MESSAGE,
    });
    const shown: WorkPartyCorrectionFigures = {
      previousFinalPriceCents: 20_000,
      newFinalPriceCents: 15_000,
      priceDiffCents: -5_000,
      accountCreditAmountCents: 0,
      appliedCreditGivenBackCents: 0,
      refundedExcessCreditCents: 0,
      additionalAmountCents: 0,
      refundAmountCents: 0,
      ...money,
      settlementMethod: method,
    };
    expect(
      await refusal(addBookingToWorkParty({ ...common, settlementMethod: method, dryRun: false, expectedFigures: shown })),
    ).toEqual({ status: 409, message: WORK_PARTY_OWN_MONEY_BACK_MESSAGE });
  });

  it("refuses the officer's own UNPAID booking whose applied credit the lower price frees (F1)", async () => {
    seedBooking({
      memberId: "officer-1",
      status: "PAYMENT_PENDING",
      payment: { status: "PENDING", amountCents: 2_000, creditAppliedCents: 18_000, source: "STRIPE" },
    });
    edit({ refundedExcessCreditCents: 3_000 }, false);
    expect(await refusal(addBookingToWorkParty({ ...common, dryRun: true }))).toEqual({
      status: 409,
      message: WORK_PARTY_OWN_MONEY_BACK_MESSAGE,
    });
  });

  it("shows another member's freed applied credit as a figure, so a save is checked against it", async () => {
    seedBooking({ status: "PAYMENT_PENDING", payment: { status: "PENDING", amountCents: 2_000, creditAppliedCents: 18_000, source: "STRIPE" } });
    edit({ refundedExcessCreditCents: 3_000 }, false);
    const quoted = await addBookingToWorkParty({ ...common, dryRun: true });
    expect(quoted.figures.refundedExcessCreditCents).toBe(3_000);
    const refused = await addBookingToWorkParty({
      ...common,
      dryRun: false,
      expectedFigures: { ...quoted.figures, refundedExcessCreditCents: 0 },
    }).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(WorkPartyCorrectionFiguresChangedError);
  });

  it("refuses a family member's booking when money comes back", async () => {
    h.family = [
      { memberId: "member-1", familyGroupId: "fam-1" },
      { memberId: "officer-1", familyGroupId: "fam-1" },
    ];
    expect(await refusal(addBookingToWorkParty({ ...common, dryRun: true }))).toEqual({
      status: 409,
      message: WORK_PARTY_OWN_MONEY_BACK_MESSAGE,
    });
  });

  it("allows anyone else's booking when money comes back", async () => {
    const result = await addBookingToWorkParty({ ...common, dryRun: true });
    expect(result.figures.accountCreditAmountCents).toBe(5_000);
  });

  describe("an organiser-paid joiner: the recipient is the group organiser", () => {
    beforeEach(() => {
      seedBooking({ organiserSettled: true, parentBookingId: "organiser-booking" });
      edit({ refundAmountCents: 5_000 }, false);
    });

    it("refuses when the acting officer is the group organiser", async () => {
      h.parent = { memberId: "officer-1" };
      expect(await refusal(addBookingToWorkParty({ ...common, dryRun: true }))).toEqual({
        status: 409,
        message: WORK_PARTY_OWN_MONEY_BACK_MESSAGE,
      });
    });

    it("refuses when the organiser is in the officer's family", async () => {
      h.parent = { memberId: "organiser-1" };
      h.family = [
        { memberId: "organiser-1", familyGroupId: "fam-2" },
        { memberId: "officer-1", familyGroupId: "fam-2" },
      ];
      expect(await refusal(addBookingToWorkParty({ ...common, dryRun: true }))).toMatchObject({ status: 409 });
    });

    it("allows the officer as the joiner, because the money goes to the organiser", async () => {
      seedBooking({ memberId: "officer-1", organiserSettled: true, parentBookingId: "organiser-booking" });
      h.parent = { memberId: "organiser-1" };
      const result = await addBookingToWorkParty({ ...common, dryRun: true });
      expect(result.settlementOptions).toEqual({ methods: ["card"], paidByOrganiser: true, refundTo: null });
    });
  });
});

describe("the settlement method is a checked figure", () => {
  it("refuses a save whose figures differ ONLY in the method", async () => {
    // The edit credits the same money under either label, so nothing but the
    // method differs between what was shown and what would be saved.
    const saved: WorkPartyCorrectionFigures = {
      previousFinalPriceCents: 20_000,
      newFinalPriceCents: 15_000,
      priceDiffCents: -5_000,
      accountCreditAmountCents: 5_000,
      appliedCreditGivenBackCents: 0,
      refundedExcessCreditCents: 0,
      additionalAmountCents: 0,
      refundAmountCents: 0,
      settlementMethod: "credit",
    };
    const quoted = await addBookingToWorkParty({ ...common, dryRun: true });
    expect(quoted.figures).toEqual(saved);
    const refused = await addBookingToWorkParty({
      ...common,
      settlementMethod: "credit",
      dryRun: false,
      expectedFigures: { ...saved, settlementMethod: "card" },
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(WorkPartyCorrectionFiguresChangedError);
    expect((refused as WorkPartyCorrectionFiguresChangedError).actual).toEqual(saved);
  });
});
