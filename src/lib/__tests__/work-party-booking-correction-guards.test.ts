import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * triyder/AlpineClubBookingsNZ#129: the service's own guards around the canonical edit, with the edit
 * itself (`modifyBookingBatch`) doubled so each guard can be handed a shape the
 * real pipeline would not produce:
 *
 *  - the refund backstop: a refund the offered options did not mean (one under
 *    `credit`) is refused, never paid;
 *  - the options are the edit's own (upstream owner decision, 15 Nov 2026): a
 *    refund is offered exactly where the edit asked for a method
 *    (`requiresSettlementMethod`), on a card- or bank-paid booking alike, and
 *    one requested where the edit offers none is refused (409);
 *  - owner decision 3 (18 Nov 2026, maintainers' comment
 *    https://github.com/thatskiff33/AlpineClubBookingsNZ/pull/5149#issuecomment-6951626920):
 *    the officer's own or family's booking — its owner, or for an
 *    organiser-paid joiner the organiser who paid, and their family groups —
 *    is refused on Add and Remove, whatever the money does, before the edit
 *    runs; a disputed card payment is refused where the edit would hold money;
 *  - the settlement method is a checked figure on its own: a save whose figures
 *    differ ONLY in the method is refused, and the edit's own quoted-figures
 *    check (`INV-MOD-062`) runs on the save;
 *  - an unpaid ask that took the whole reduction offers no method (B-L1), and
 *    a Remove on a booking PAID with no money taken (nothing, or credit alone) is refused.
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
  takenTransactions: 0,
  /** When set, the doubled edit refuses a save quoted with other figures, as `assertEditQuotedFigures` does. */
  editFreshFigures: null as Record<string, number> | null,
}));

const tx = {
  $executeRaw: vi.fn(async () => 0),
  booking: {
    findUnique: vi.fn(async ({ select }: { select: Record<string, unknown> }) => {
      const keys = Object.keys(select);
      if (keys.length === 1 && keys[0] === "lodgeId") return { lodgeId: "lodge-1" };
      // The organiser's booking, read for an organiser-paid joiner (owner decision 3).
      if (keys.length === 1 && keys[0] === "memberId") return h.parent;
      return h.booking;
    }),
  },
  paymentTransaction: { count: vi.fn(async () => h.takenTransactions) },
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
vi.mock("@/lib/booking-batch-modification-service", async () => {
  const { EditPriceChangedError } = await import("@/lib/edit-quoted-figures");
  return {
    modifyBookingBatch: vi.fn(async (args: { input: Record<string, unknown> }) => {
      h.modifyCalls.push(args);
      const quoted = args.input.quotedFigures as Record<string, number> | undefined;
      const fresh = h.editFreshFigures;
      if (quoted && fresh && Object.keys(fresh).some((key) => quoted[key] !== fresh[key])) {
        throw new EditPriceChangedError(fresh as never);
      }
      return h.modified;
    }),
  };
});

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { requireCalendarDate } from "@/lib/club-time";
import {
  addBookingToWorkParty,
  removeBookingFromWorkParty,
  WORK_PARTY_DISPUTED_PAYMENT_MESSAGE,
  WORK_PARTY_NOT_ON_BOOKING_MESSAGE,
  WORK_PARTY_OWN_BOOKING_MESSAGE,
  WORK_PARTY_REMOVAL_MONEY_BACK_MESSAGE,
  WORK_PARTY_PAID_WITH_NO_MONEY_MESSAGE,
  WorkPartyCorrectionFiguresChangedError,
  type WorkPartyCorrectionFigures,
} from "@/lib/work-party-booking-correction";
import { WORK_PARTY_SETTLEMENT_NOT_OFFERED_MESSAGE } from "@/lib/work-party-settlement-options";

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
 * `reductionRefundsToCard` is its answer to where a refund goes (`INV-PAY-160`).
 */
function edit(
  money: Partial<Record<"refundAmountCents" | "accountCreditAmountCents" | "appliedCreditGivenBackCents" | "refundedExcessCreditCents", number>>,
  requiresSettlementMethod = true,
  reductionRefundsToCard = true,
) {
  h.modified = {
    requiresSettlementMethod,
    reductionRefundsToCard,
    booking: { finalPriceCents: 15_000 },
    priceDiffCents: -5_000,
    changeFeeCents: 0,
    unpaidAskOffsetCents: 0,
    refundHeldForDispute: false,
    refundAmountCents: 0,
    accountCreditAmountCents: 0,
    appliedCreditGivenBackCents: 0,
    refundedExcessCreditCents: 0,
    additionalAmountCents: 0,
    billedToOrganiserCents: 0,
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
  h.takenTransactions = 0;
  h.editFreshFigures = null;
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
    edit({ refundAmountCents: 5_000 }, true, false);
    const result = await addBookingToWorkParty({ ...common, settlementMethod: "card", dryRun: true });
    expect(result.settlementOptions).toEqual({ methods: ["credit", "card"], paidByOrganiser: false, refundTo: "bank" });
    expect(result.figures).toMatchObject({ refundAmountCents: 5_000, settlementMethod: "card" });
    expect(h.modifyCalls[0]).toMatchObject({ input: expect.objectContaining({ settlementMethod: "card" }) });
  });

  it("#5212 (INV-PAY-160): names the refund by the edit's own answer, so a card payment the edit refunds by bank transfer says so", async () => {
    edit({ refundAmountCents: 5_000 }, true, false);
    const result = await addBookingToWorkParty({ ...common, settlementMethod: "card", dryRun: true });
    expect(result.settlementOptions).toEqual({ methods: ["credit", "card"], paidByOrganiser: false, refundTo: "bank" });
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

describe("own or family booking: never, whatever the money does (owner decision 3, 18 Nov)", () => {
  /** What an officer would have been shown on the default paid booking. */
  const shown: WorkPartyCorrectionFigures = {
    previousFinalPriceCents: 20_000,
    newFinalPriceCents: 15_000,
    priceDiffCents: -5_000,
    changeFeeCents: 0,
    accountCreditAmountCents: 5_000,
    appliedCreditGivenBackCents: 0,
    refundedExcessCreditCents: 0,
    additionalAmountCents: 0,
    billedToOrganiserCents: 0,
    refundAmountCents: 0,
    settlementMethod: "credit",
  };
  const OWN = { status: 409, message: WORK_PARTY_OWN_BOOKING_MESSAGE };

  it("refuses the officer's own UNPAID booking, where nothing would come back, before the edit runs", async () => {
    seedBooking({ memberId: "officer-1", status: "PAYMENT_PENDING", payment: null });
    edit({}, false);
    expect(await refusal(addBookingToWorkParty({ ...common, dryRun: true }))).toEqual(OWN);
    expect(h.modifyCalls).toEqual([]);
  });

  it.each(["credit", "card"] as const)("refuses the officer's own paid booking by %s, on preview and apply", async (method) => {
    seedBooking({ memberId: "officer-1" });
    expect(await refusal(addBookingToWorkParty({ ...common, settlementMethod: method, dryRun: true }))).toEqual(OWN);
    expect(
      await refusal(addBookingToWorkParty({ ...common, settlementMethod: method, dryRun: false, expectedFigures: shown })),
    ).toEqual(OWN);
    expect(h.modifyCalls).toEqual([]);
  });

  it("refuses a family member's booking", async () => {
    h.family = [
      { memberId: "member-1", familyGroupId: "fam-1" },
      { memberId: "officer-1", familyGroupId: "fam-1" },
    ];
    expect(await refusal(addBookingToWorkParty({ ...common, dryRun: true }))).toEqual(OWN);
    expect(h.modifyCalls).toEqual([]);
  });

  it("allows anyone else's booking, money back and all: an officer only a guest on it is not its owner", async () => {
    const result = await addBookingToWorkParty({ ...common, dryRun: true });
    expect(result.figures.accountCreditAmountCents).toBe(5_000);
  });

  describe("an organiser-paid joiner: the owner and the organiser who paid", () => {
    beforeEach(() => {
      seedBooking({ organiserSettled: true, parentBookingId: "organiser-booking" });
      h.parent = { memberId: "organiser-1" };
      edit({ refundAmountCents: 5_000 }, false);
    });

    it("refuses when the acting officer is the group organiser", async () => {
      h.parent = { memberId: "officer-1" };
      expect(await refusal(addBookingToWorkParty({ ...common, dryRun: true }))).toEqual(OWN);
    });

    it("refuses when the organiser is in the officer's family", async () => {
      h.family = [
        { memberId: "organiser-1", familyGroupId: "fam-2" },
        { memberId: "officer-1", familyGroupId: "fam-2" },
      ];
      expect(await refusal(addBookingToWorkParty({ ...common, dryRun: true }))).toEqual(OWN);
    });

    it("refuses the officer as the joiner, though the money goes to the organiser", async () => {
      seedBooking({ memberId: "officer-1", organiserSettled: true, parentBookingId: "organiser-booking" });
      expect(await refusal(addBookingToWorkParty({ ...common, dryRun: true }))).toEqual(OWN);
      expect(h.modifyCalls).toEqual([]);
    });

    it("A1: refuses an UNPAID joiner whose organiser (who will pay) is the officer, before any settlement", async () => {
      seedBooking({ status: "PAYMENT_PENDING", payment: null, organiserSettled: true, parentBookingId: "organiser-booking" });
      h.parent = { memberId: "officer-1" };
      edit({}, false);
      expect(await refusal(addBookingToWorkParty({ ...common, dryRun: true }))).toEqual(OWN);
      expect(h.modifyCalls).toEqual([]);
    });

    it("allows it when neither is the officer or their family", async () => {
      const result = await addBookingToWorkParty({ ...common, dryRun: true });
      expect(result.settlementOptions).toEqual({ methods: ["card"], paidByOrganiser: true, refundTo: null });
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
});

describe("a disputed card payment (#5151, INV-PAY-154): refused only where the edit holds money", () => {
  it("is refused with the plain reason when the edit holds what would come back", async () => {
    edit({ refundAmountCents: 5_000 }, false);
    h.modified!.refundHeldForDispute = true;
    expect(await refusal(addBookingToWorkParty({ ...common, dryRun: true }))).toEqual({
      status: 409,
      message: WORK_PARTY_DISPUTED_PAYMENT_MESSAGE,
    });
  });

  it("goes ahead when nothing would come back, so nothing is held (an unpaid ask took it)", async () => {
    edit({}, false);
    h.modified!.refundHeldForDispute = true;
    h.modified!.unpaidAskOffsetCents = 5_000;
    expect((await addBookingToWorkParty({ ...common, dryRun: true })).outcome).toBe("quoted");
  });
});

describe("an unpaid ask that took the whole reduction (B-L1)", () => {
  beforeEach(() => {
    edit({}, false);
    h.modified!.unpaidAskOffsetCents = 5_000;
  });

  it("offers no method and settles by none: nothing comes back", async () => {
    const result = await addBookingToWorkParty({ ...common, dryRun: true });
    expect(result.settlementOptions).toEqual({
      methods: [],
      paidByOrganiser: false,
      refundTo: null,
      unpaidAskOffsetCents: 5_000,
    });
    expect(result.figures).toMatchObject({ settlementMethod: null, accountCreditAmountCents: 0, refundAmountCents: 0 });
  });

  it("refuses a refund with that reason, not 'only as club credit'", async () => {
    expect(await refusal(addBookingToWorkParty({ ...common, settlementMethod: "card", dryRun: true }))).toEqual({
      status: 409,
      message: "The discount cancels $50.00 of what is still owed on this booking, so nothing comes back.",
    });
  });

  it("M4: names the part an ask took when the rest still comes back", async () => {
    edit({ accountCreditAmountCents: 2_000 }, true);
    h.modified!.unpaidAskOffsetCents = 3_000;
    expect((await addBookingToWorkParty({ ...common, dryRun: true })).settlementOptions).toEqual({
      methods: ["credit", "card"],
      paidByOrganiser: false,
      refundTo: "card",
      unpaidAskOffsetCents: 3_000,
    });
  });
});

describe("the edit's own quoted-figures check (INV-MOD-062) runs on the save", () => {
  const saved: WorkPartyCorrectionFigures = {
    previousFinalPriceCents: 20_000,
    newFinalPriceCents: 15_000,
    priceDiffCents: -5_000,
    changeFeeCents: 0,
    accountCreditAmountCents: 5_000,
    appliedCreditGivenBackCents: 0,
    refundedExcessCreditCents: 0,
    additionalAmountCents: 0,
    billedToOrganiserCents: 0,
    refundAmountCents: 0,
    settlementMethod: "credit",
  };

  it("hands the edit the preview's figures on apply, and none on a dry run", async () => {
    await addBookingToWorkParty({ ...common, dryRun: true });
    expect(h.modifyCalls[0]!.input).not.toHaveProperty("quotedFigures");
    await addBookingToWorkParty({ ...common, dryRun: false, expectedFigures: saved });
    expect(h.modifyCalls[1]!.input).toMatchObject({
      quotedFigures: { newFinalPriceCents: 15_000, priceDiffCents: -5_000, changeFeeCents: 0, netChargeCents: -5_000 },
    });
  });

  it("M2: builds the edit's figures from the fee shown, and refuses a save shown another fee", async () => {
    await addBookingToWorkParty({ ...common, dryRun: false, expectedFigures: { ...saved, changeFeeCents: 0 } });
    expect(h.modifyCalls.at(-1)!.input).toMatchObject({ quotedFigures: { changeFeeCents: 0, netChargeCents: -5_000 } });
    await expect(
      addBookingToWorkParty({ ...common, dryRun: false, expectedFigures: { ...saved, changeFeeCents: 100 } }),
    ).rejects.toBeInstanceOf(WorkPartyCorrectionFiguresChangedError);
    // The edit was handed the fee shown, net of it, and the save refused on the fee alone.
    expect(h.modifyCalls.at(-1)!.input).toMatchObject({ quotedFigures: { changeFeeCents: 100, netChargeCents: -4_900 } });
  });

  it("answers the edit's refusal as a figures change, with the figures and choices a fresh dry run gives", async () => {
    // The edit's own figures differ from the ones shown (a fee where none was quoted).
    h.editFreshFigures = { newFinalPriceCents: 15_000, priceDiffCents: -5_000, changeFeeCents: 100, netChargeCents: -4_900 };
    h.modified!.changeFeeCents = 100;
    const refused = await addBookingToWorkParty({ ...common, dryRun: false, expectedFigures: saved }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(WorkPartyCorrectionFiguresChangedError);
    // M2: the fee is a figure of its own, so the fresh figures show it.
    expect((refused as WorkPartyCorrectionFiguresChangedError).actual).toEqual({ ...saved, changeFeeCents: 100 });
    // M1: and what may be chosen for them travels with them.
    expect((refused as WorkPartyCorrectionFiguresChangedError).settlementOptions).toEqual({
      methods: ["credit", "card"],
      paidByOrganiser: false,
      refundTo: "card",
    });
    // The save, then the dry run that re-read the figures.
    expect(h.modifyCalls).toHaveLength(2);
    expect(h.modifyCalls[1]!.input).not.toHaveProperty("quotedFigures");
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
      changeFeeCents: 0,
      accountCreditAmountCents: 5_000,
      appliedCreditGivenBackCents: 0,
      refundedExcessCreditCents: 0,
      additionalAmountCents: 0,
      billedToOrganiserCents: 0,
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

describe("Remove from work party (fork triyder/AlpineClubBookingsNZ#130): the service's own guards", () => {
  const ON_WORK_PARTY = [
    { id: "r-1", applicationOrder: 0, promoCode: { code: "WP-1", workPartyEvent: { id: "wp-1" } } },
  ];
  /** The edit's answer to a removal: the price back up by 5,000c, nothing back. */
  function raised(money: Record<string, number> = {}) {
    h.modified = {
      booking: { finalPriceCents: 20_000 },
      priceDiffCents: 5_000,
      changeFeeCents: 0,
      unpaidAskOffsetCents: 0,
      refundHeldForDispute: false,
      refundAmountCents: 0,
      accountCreditAmountCents: 0,
      appliedCreditGivenBackCents: 0,
      refundedExcessCreditCents: 0,
      additionalAmountCents: 5_000,
      billedToOrganiserCents: 0,
      promoChangeNotApplied: null,
      bookingModificationId: "mod-2",
      ...money,
    };
  }

  beforeEach(() => {
    seedBooking({ finalPriceCents: 15_000, promoRedemptions: ON_WORK_PARTY });
    raised();
    tx.promoRedemption.findFirst.mockResolvedValue(null as never);
  });

  afterEach(() => {
    tx.promoRedemption.findFirst.mockResolvedValue({ id: "redemption-1" } as never);
  });

  it("asks the edit for the booking's codes without the work party's, with no settlement method", async () => {
    const result = await removeBookingFromWorkParty({ ...common, dryRun: true });
    expect(result.figures).toMatchObject({ priceDiffCents: 5_000, additionalAmountCents: 5_000, settlementMethod: null });
    expect(h.modifyCalls[0]).toMatchObject({
      input: { promoCodes: [], notifyMember: false },
      officerWorkPartyCorrection: { workPartyEventId: "wp-1", promoCodeId: "promo-1", direction: "remove" },
    });
    expect(h.modifyCalls[0]!.input).not.toHaveProperty("settlementMethod");
  });

  it("refuses a booking without that work party before the edit runs", async () => {
    seedBooking({ promoRedemptions: [] });
    expect(await refusal(removeBookingFromWorkParty({ ...common, dryRun: true }))).toEqual({
      status: 409,
      message: WORK_PARTY_NOT_ON_BOOKING_MESSAGE,
    });
    expect(h.modifyCalls).toEqual([]);
  });

  it.each([
    ["credit", { accountCreditAmountCents: 1 }],
    ["a refund", { refundAmountCents: 1 }],
    ["applied credit given back", { appliedCreditGivenBackCents: 1 }],
    ["freed applied credit", { refundedExcessCreditCents: 1 }],
  ])("refuses a removal that would hand back %s", async (_label, money) => {
    raised(money);
    expect(await refusal(removeBookingFromWorkParty({ ...common, dryRun: true }))).toEqual({
      status: 409,
      message: WORK_PARTY_REMOVAL_MONEY_BACK_MESSAGE,
    });
  });

  it("refuses a removal that lowered the price, or left the work party on", async () => {
    raised({ priceDiffCents: -1 });
    expect(await refusal(removeBookingFromWorkParty({ ...common, dryRun: true }))).toMatchObject({
      status: 409,
      message: expect.stringContaining("would lower"),
    });
    raised();
    tx.promoRedemption.findFirst.mockResolvedValue({ id: "redemption-1" } as never);
    expect(await refusal(removeBookingFromWorkParty({ ...common, dryRun: true }))).toMatchObject({
      status: 409,
      message: expect.stringContaining("could not be removed"),
    });
  });

  it("Security L1: an increase invoiced to the group organiser is a figure, and a preview without it does not save", async () => {
    raised({ additionalAmountCents: 0, billedToOrganiserCents: 5_000 });
    const quoted = await removeBookingFromWorkParty({ ...common, dryRun: true });
    expect(quoted.figures).toMatchObject({ billedToOrganiserCents: 5_000, additionalAmountCents: 0 });
    const stale = { ...quoted.figures, billedToOrganiserCents: 0 };
    await expect(
      removeBookingFromWorkParty({ ...common, dryRun: false, expectedFigures: stale }),
    ).rejects.toBeInstanceOf(WorkPartyCorrectionFiguresChangedError);
  });

  it("owner decision 3: refuses the officer's own booking, a family member's, and one the officer organised and paid for", async () => {
    const OWN = { status: 409, message: WORK_PARTY_OWN_BOOKING_MESSAGE };
    seedBooking({ memberId: "officer-1", finalPriceCents: 15_000, promoRedemptions: ON_WORK_PARTY });
    expect(await refusal(removeBookingFromWorkParty({ ...common, dryRun: true }))).toEqual(OWN);

    seedBooking({ finalPriceCents: 15_000, promoRedemptions: ON_WORK_PARTY });
    h.family = [
      { memberId: "member-1", familyGroupId: "fam-1" },
      { memberId: "officer-1", familyGroupId: "fam-1" },
    ];
    expect(await refusal(removeBookingFromWorkParty({ ...common, dryRun: true }))).toEqual(OWN);

    h.family = [];
    seedBooking({ finalPriceCents: 15_000, promoRedemptions: ON_WORK_PARTY, organiserSettled: true, parentBookingId: "organiser-booking" });
    h.parent = { memberId: "officer-1" };
    expect(await refusal(removeBookingFromWorkParty({ ...common, dryRun: true }))).toEqual(OWN);
    expect(h.modifyCalls).toEqual([]);
  });

  it("owner decisions 18 and 20 Nov: refuses a booking PAID with no money taken, nothing or credit alone, before the edit runs", async () => {
    const NOTHING_TAKEN = { id: "payment-1", status: "SUCCEEDED", amountCents: 0, creditAppliedCents: 0, source: "STRIPE", stripePaymentIntentId: null };
    const refused = { status: 409, message: WORK_PARTY_PAID_WITH_NO_MONEY_MESSAGE };
    seedBooking({ finalPriceCents: 0, promoRedemptions: ON_WORK_PARTY, payment: NOTHING_TAKEN });
    expect(await refusal(removeBookingFromWorkParty({ ...common, dryRun: true }))).toEqual(refused);
    // 20 Nov: account credit alone is no money taken either.
    seedBooking({ finalPriceCents: 10_000, promoRedemptions: ON_WORK_PARTY, payment: { ...NOTHING_TAKEN, creditAppliedCents: 10_000 } });
    expect(await refusal(removeBookingFromWorkParty({ ...common, dryRun: true }))).toEqual(refused);
    expect(h.modifyCalls).toEqual([]);
    // Money was taken: a captured ledger row, or money on the payment (an organiser-paid
    // joiner's mirror records its share, credit or not): allowed.
    h.takenTransactions = 1;
    expect((await removeBookingFromWorkParty({ ...common, dryRun: true })).outcome).toBe("quoted");
    h.takenTransactions = 0;
    seedBooking({ finalPriceCents: 15_000, promoRedemptions: ON_WORK_PARTY, payment: { ...NOTHING_TAKEN, amountCents: 5_000, creditAppliedCents: 10_000 } });
    expect((await removeBookingFromWorkParty({ ...common, dryRun: true })).outcome).toBe("quoted");
  });
});
