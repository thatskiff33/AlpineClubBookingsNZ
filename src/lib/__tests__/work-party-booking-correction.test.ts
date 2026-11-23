import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BookingStatus } from "@prisma/client";
import {
  WORK_PARTY_NOT_ON_BOOKING_MESSAGE,
  WORK_PARTY_OWN_BOOKING_MESSAGE,
  WORK_PARTY_PAID_WITH_NO_MONEY_MESSAGE,
  workPartyBookingEligibility,
  workPartyRemovalEligibility,
  type WorkPartyCorrectionFigures,
  type WorkPartyEligibilityBooking,
  type WorkPartyEligibilityContext,
  type WorkPartyEligibilityEvent,
} from "@/lib/work-party-booking-correction";
import { actorIsMemberOrFamily, workPartyPaidWithNoMoneyTaken } from "@/lib/work-party-booking-facts";
import {
  resolveWorkPartySettlementMethod,
  WORK_PARTY_SETTLEMENT_NOT_OFFERED_MESSAGE,
  workPartyAskOffset,
  workPartySettlementOptions,
} from "@/lib/work-party-settlement-options";
import { PROMO_WORK_PARTY_EXCLUSION_OFFICER_MESSAGE } from "@/lib/promo-code-list-rules";
import { editTotalMoneyBackCents, workPartyAskAbsorbedSentence, workPartyAskPartlyAbsorbedSentence } from "@/lib/edit-money-back";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

/**
 * Fork triyder/AlpineClubBookingsNZ#119: the eligibility rule for "Add booking to work party", one case per
 * refusal, and the census that keeps the officer-only internal-code admission
 * reachable from exactly one place. The money paths are proved on real
 * PostgreSQL in `work-party-booking-correction.realdb.test.ts`. Today is the
 * frozen 2026-07-01.
 */
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const booking: WorkPartyEligibilityBooking = {
  status: BookingStatus.PAID,
  checkIn: d("2026-08-01"),
  checkOut: d("2026-08-04"),
  hasWorkParty: false,
  otherPromoCodes: [],
  quotePriced: false,
  memberOwned: true,
  actorIsOwnerOrFamily: false,
};

const context: WorkPartyEligibilityContext = {
  bookingLodgeId: "lodge-1",
  today: d("2026-07-01"),
  multiPromoCodes: false,
};

const event: WorkPartyEligibilityEvent = {
  name: "Spring Bee",
  active: true,
  startDate: d("2026-08-03"),
  endDate: d("2026-08-05"),
  lodgeId: "lodge-1",
  lodge: { name: "Main Lodge" },
  promoCode: { active: true, archivedAt: null },
};

const refusal = (pattern: RegExp | string) => ({
  ok: false,
  reason: typeof pattern === "string" ? pattern : expect.stringMatching(pattern),
});

describe("workPartyRemovalEligibility (fork triyder/AlpineClubBookingsNZ#130)", () => {
  const onBooking = {
    status: BookingStatus.PAID,
    checkOut: d("2026-08-04"),
    quotePriced: false,
    workPartyEventId: "event-1",
    actorIsOwnerOrFamily: false,
    paidWithNoMoneyTaken: false,
  };

  it("accepts a booking that carries this work party, future or started", () => {
    expect(workPartyRemovalEligibility(onBooking, context, "event-1")).toEqual({ ok: true });
    expect(
      workPartyRemovalEligibility({ ...onBooking, checkOut: d("2026-07-02") }, context, "event-1"),
    ).toEqual({ ok: true });
  });

  it("refuses a booking without that work party", () => {
    expect(workPartyRemovalEligibility(onBooking, context, "event-2")).toEqual(
      refusal(WORK_PARTY_NOT_ON_BOOKING_MESSAGE),
    );
    expect(
      workPartyRemovalEligibility({ ...onBooking, workPartyEventId: null }, context, "event-1"),
    ).toEqual(refusal(WORK_PARTY_NOT_ON_BOOKING_MESSAGE));
  });

  it("refuses a finished stay, a status the edit doors refuse, and a quote-priced booking", () => {
    expect(
      workPartyRemovalEligibility({ ...onBooking, checkOut: d("2026-06-30") }, context, "event-1"),
    ).toMatchObject(refusal(/has finished/));
    expect(
      workPartyRemovalEligibility({ ...onBooking, status: BookingStatus.CANCELLED }, context, "event-1"),
    ).toMatchObject(refusal(/current status/));
    expect(
      workPartyRemovalEligibility({ ...onBooking, quotePriced: true }, context, "event-1"),
    ).toMatchObject(refusal(/priced by its quote/));
  });

  it("owner decision 3: refuses the officer's own or family's booking, before anything else", () => {
    expect(workPartyRemovalEligibility({ ...onBooking, actorIsOwnerOrFamily: true }, context, "event-1")).toEqual(
      refusal(WORK_PARTY_OWN_BOOKING_MESSAGE),
    );
    expect(
      workPartyRemovalEligibility({ ...onBooking, actorIsOwnerOrFamily: true, status: BookingStatus.CANCELLED }, context, "event-1"),
    ).toEqual(refusal(WORK_PARTY_OWN_BOOKING_MESSAGE));
  });

  it("owner decisions 18 and 20 Nov: refuses a booking PAID with no money taken, telling the officer to cancel or ask the treasurer", () => {
    expect(workPartyRemovalEligibility({ ...onBooking, paidWithNoMoneyTaken: true }, context, "event-1")).toEqual(
      refusal(WORK_PARTY_PAID_WITH_NO_MONEY_MESSAGE),
    );
    expect(WORK_PARTY_PAID_WITH_NO_MONEY_MESSAGE).toMatch(/Cancel it, or ask the treasurer/);
  });
});

describe("workPartyBookingEligibility", () => {
  it("accepts a future booking with a night inside an open work party at its lodge", () => {
    expect(workPartyBookingEligibility(booking, context, event)).toEqual({ ok: true });
  });

  it("accepts a club-wide work party at any lodge", () => {
    expect(
      workPartyBookingEligibility(
        booking,
        { ...context, bookingLodgeId: "lodge-2" },
        { ...event, lodgeId: null, lodge: null },
      ),
    ).toEqual({ ok: true });
  });

  it.each([
    BookingStatus.PENDING,
    BookingStatus.PAYMENT_PENDING,
    BookingStatus.CONFIRMED,
    BookingStatus.PAID,
  ])("accepts a %s booking (the edit doors' own rule)", (status) => {
    expect(workPartyBookingEligibility({ ...booking, status }, context, event)).toEqual({ ok: true });
  });

  it.each([
    BookingStatus.AWAITING_REVIEW,
    BookingStatus.CANCELLED,
    BookingStatus.COMPLETED,
    BookingStatus.DRAFT,
    BookingStatus.BUMPED,
    BookingStatus.WAITLISTED,
    BookingStatus.WAITLIST_OFFERED,
  ])("refuses a %s booking, as the edit doors do", (status) => {
    expect(workPartyBookingEligibility({ ...booking, status }, context, event)).toMatchObject(
      refusal(/current status/),
    );
  });

  it("fork triyder/AlpineClubBookingsNZ#127: accepts a stay that has started, nights already slept included", () => {
    expect(
      workPartyBookingEligibility(
        { ...booking, checkIn: d("2026-06-28"), checkOut: d("2026-07-03") },
        context,
        { ...event, startDate: d("2026-06-29"), endDate: d("2026-07-01") },
      ),
    ).toEqual({ ok: true });
  });

  it("fork triyder/AlpineClubBookingsNZ#127: accepts a stay on its check-out day (still in progress)", () => {
    expect(
      workPartyBookingEligibility(
        { ...booking, checkIn: d("2026-06-28"), checkOut: d("2026-07-01") },
        context,
        { ...event, startDate: d("2026-06-28"), endDate: d("2026-06-30") },
      ),
    ).toEqual({ ok: true });
  });

  it("refuses a stay that has finished", () => {
    expect(
      workPartyBookingEligibility(
        { ...booking, checkIn: d("2026-06-20"), checkOut: d("2026-06-30") },
        context,
        { ...event, startDate: d("2026-06-20"), endDate: d("2026-06-25") },
      ),
    ).toMatchObject(refusal(/has finished/));
  });

  it("accepts a stay checking in tomorrow", () => {
    expect(
      workPartyBookingEligibility(
        { ...booking, checkIn: d("2026-07-02") },
        context,
        { ...event, startDate: d("2026-07-02") },
      ),
    ).toEqual({ ok: true });
  });

  it("no longer has an organiser-paid refusal (triyder/AlpineClubBookingsNZ#129 decision 5)", () => {
    // The rule takes no organiser-paid input: such a joiner is eligible on the
    // same terms as any booking, and its money goes back to the organiser.
    expect(Object.keys(booking)).not.toContain("paidByOrganiser");
    expect(workPartyBookingEligibility(booking, context, event)).toEqual({ ok: true });
  });

  it("owner decision 3: refuses the officer's own or family's booking, whatever the money does", () => {
    expect(workPartyBookingEligibility({ ...booking, actorIsOwnerOrFamily: true }, context, event)).toEqual(
      refusal(WORK_PARTY_OWN_BOOKING_MESSAGE),
    );
    // An unpaid booking (nothing would come back) is refused all the same.
    expect(
      workPartyBookingEligibility(
        { ...booking, status: BookingStatus.PAYMENT_PENDING, actorIsOwnerOrFamily: true },
        context,
        event,
      ),
    ).toEqual(refusal(WORK_PARTY_OWN_BOOKING_MESSAGE));
  });

  it("refuses an organisation's booking, which holds no account credit", () => {
    expect(
      workPartyBookingEligibility({ ...booking, memberOwned: false }, context, event),
    ).toMatchObject(refusal(/belongs to an organisation/));
  });

  it("refuses a quote-priced booking", () => {
    expect(
      workPartyBookingEligibility({ ...booking, quotePriced: true }, context, event),
    ).toMatchObject(refusal(/priced by its quote/));
  });

  it("refuses a booking that already has a work party", () => {
    expect(
      workPartyBookingEligibility({ ...booking, hasWorkParty: true }, context, event),
    ).toMatchObject(refusal(/already has a work party/));
  });

  it("refuses another promo code while the club allows one discount: the shared list rule, in an officer's words", () => {
    expect(
      workPartyBookingEligibility({ ...booking, otherPromoCodes: ["SUMMER10"] }, context, event),
    ).toEqual(refusal(PROMO_WORK_PARTY_EXCLUSION_OFFICER_MESSAGE));
    expect(PROMO_WORK_PARTY_EXCLUSION_OFFICER_MESSAGE).not.toMatch(/Please remove/);
  });

  it("accepts another promo code when the club combines codes", () => {
    expect(
      workPartyBookingEligibility(
        { ...booking, otherPromoCodes: ["SUMMER10"] },
        { ...context, multiPromoCodes: true },
        event,
      ),
    ).toEqual({ ok: true });
  });

  it.each([
    ["inactive", { active: false }],
    ["its promo inactive", { promoCode: { active: false, archivedAt: null } }],
    ["its promo archived", { promoCode: { active: true, archivedAt: d("2026-07-01") } }],
  ])("refuses a work party that is %s", (_label, change) => {
    expect(workPartyBookingEligibility(booking, context, { ...event, ...change })).toMatchObject(
      refusal(/not active/),
    );
  });

  it("refuses a stay with no night inside the window (check-out is not a night)", () => {
    expect(
      workPartyBookingEligibility(
        { ...booking, checkIn: d("2026-07-30"), checkOut: d("2026-08-03") },
        context,
        event,
      ),
    ).toMatchObject(refusal(/None of this booking/));
  });

  it("refuses a booking at another lodge, naming the work party's", () => {
    expect(
      workPartyBookingEligibility(booking, { ...context, bookingLodgeId: "lodge-2" }, event),
    ).toMatchObject(refusal(/held at Main Lodge/));
  });
});

describe("actorIsMemberOrFamily (the member-guest family boundary)", () => {
  // Two family groups: the owner is in g1 with a partner; the partner is also
  // in g2 with a cousin. The owner's family is g1's members only.
  const links = [
    { memberId: "owner", familyGroupId: "g1" },
    { memberId: "partner", familyGroupId: "g1" },
    { memberId: "partner", familyGroupId: "g2" },
    { memberId: "cousin", familyGroupId: "g2" },
  ];
  const db = {
    familyGroupMember: {
      findMany: async ({ where }: { where: { memberId?: string; familyGroupId?: { in: string[] } } }) =>
        links.filter((row) =>
          where.memberId !== undefined
            ? row.memberId === where.memberId
            : where.familyGroupId!.in.includes(row.familyGroupId),
        ),
    },
  } as unknown as Parameters<typeof actorIsMemberOrFamily>[0];

  it.each([
    ["the owner", "owner", true],
    ["a co-member of the owner's family group", "partner", true],
    ["a member of another group of that co-member's", "cousin", false],
    ["anyone else", "stranger", false],
  ])("answers %s", async (_label, actor, expected) => {
    expect(await actorIsMemberOrFamily(db, "owner", actor)).toBe(expected);
  });

  it("is false for an organisation's booking, which has no member owner", async () => {
    expect(await actorIsMemberOrFamily(db, null, "owner")).toBe(false);
  });
});

describe("workPartySettlementOptions and the settlement guard (triyder/AlpineClubBookingsNZ#129, upstream owner decision 15 Nov 2026)", () => {
  const paidCard = {
    status: BookingStatus.PAID,
    organiserSettled: false,
    parentBookingId: null,
    payment: { status: "SUCCEEDED", amountCents: 20_000, creditAppliedCents: 0, source: "STRIPE" },
  };
  const paidBank = { ...paidCard, payment: { ...paidCard.payment, source: "INTERNET_BANKING" } };
  // The edit's own answers: whether it asks for a method, and whether its refund goes to the card.
  const ASKS_CARD = { asksForMethod: true, refundsToCard: true };
  const ASKS_BANK = { asksForMethod: true, refundsToCard: false };
  const NO_ASK = { asksForMethod: false, refundsToCard: false };

  // `editAsks` is the ordinary edit's own answer (`requiresSettlementMethod`):
  // the options mirror it, so a refund is offered exactly where the edit offers one.
  it.each([
    ["paid by card", paidCard, ASKS_CARD, ["credit", "card"], false, "card"],
    ["paid by card with some credit", { ...paidCard, payment: { ...paidCard.payment, creditAppliedCents: 5_000 } }, ASKS_CARD, ["credit", "card"], false, "card"],
    // #5212 (`INV-PAY-160`): a card payment Stripe holds no record of is refunded by bank transfer.
    ["paid by card with no Stripe record: a refund by bank transfer", paidCard, ASKS_BANK, ["credit", "card"], false, "bank"],
    ["paid by Internet Banking: a refund by bank transfer, as on an ordinary edit", paidBank, ASKS_BANK, ["credit", "card"], false, "bank"],
    ["paid, but the edit offers no choice (nothing refundable)", paidCard, NO_ASK, ["credit"], false, null],
    ["paid by Internet Banking, but the edit offers no choice", paidBank, NO_ASK, ["credit"], false, null],
    ["paid wholly with account credit", { ...paidCard, payment: { ...paidCard.payment, amountCents: 0, creditAppliedCents: 20_000 } }, NO_ASK, ["credit"], false, null],
    ["unpaid (card intent open)", { ...paidCard, status: BookingStatus.PAYMENT_PENDING, payment: { ...paidCard.payment, status: "PENDING" } }, NO_ASK, ["credit"], false, null],
    ["with no payment row", { ...paidCard, status: BookingStatus.PENDING, payment: null }, NO_ASK, ["credit"], false, null],
    ["an organiser-paid joiner (card)", { ...paidCard, organiserSettled: true, parentBookingId: "parent" }, NO_ASK, ["card"], true, null],
    ["an organiser-paid joiner (Internet Banking)", { ...paidBank, organiserSettled: true, parentBookingId: "parent" }, NO_ASK, ["card"], true, null],
  ] as const)("%s", (_label, shape, edit, methods, organiser, refundTo) => {
    expect(workPartySettlementOptions(shape, edit)).toEqual({ methods, paidByOrganiser: organiser, refundTo });
  });

  it("B-L1: offers no method when an unpaid ask took the whole reduction, and refuses one with the reason", () => {
    const absorbed = workPartySettlementOptions(paidCard, NO_ASK, { unpaidAskOffsetCents: 5_000, wholly: true });
    expect(absorbed).toEqual({ methods: [], paidByOrganiser: false, refundTo: null, unpaidAskOffsetCents: 5_000 });
    expect(resolveWorkPartySettlementMethod(absorbed, undefined, CLUB_FORMAT_TEST)).toBeNull();
    for (const method of ["card", "credit"] as const) {
      expect(() => resolveWorkPartySettlementMethod(absorbed, method, CLUB_FORMAT_TEST)).toThrow(
        expect.objectContaining({ status: 409, message: workPartyAskAbsorbedSentence("$50.00") }),
      );
    }
    expect(workPartyAskAbsorbedSentence("$50.00")).toBe(
      "The discount cancels $50.00 of what is still owed on this booking, so nothing comes back.",
    );
    // An organiser-paid joiner keeps the organiser's one disposition.
    expect(
      workPartySettlementOptions({ ...paidCard, organiserSettled: true, parentBookingId: "parent" }, NO_ASK, { unpaidAskOffsetCents: 5_000, wholly: true }).methods,
    ).toEqual(["card"]);
  });

  it("M4: an ask that took part of the reduction is named beside the choice the rest still has", () => {
    expect(workPartySettlementOptions(paidCard, ASKS_CARD, { unpaidAskOffsetCents: 3_000, wholly: false })).toEqual({
      methods: ["credit", "card"],
      paidByOrganiser: false,
      refundTo: "card",
      unpaidAskOffsetCents: 3_000,
    });
    expect(workPartyAskPartlyAbsorbedSentence("$30.00")).toBe("Of the discount, $30.00 cancels what is still owed on this booking.");
  });

  it("M3: whether an ask took it all is the one rule's answer on the edit's own offset", () => {
    expect(workPartyAskOffset({ priceDiffCents: -5_000, changeFeeCents: 0, unpaidAskOffsetCents: 5_000 })).toEqual({ unpaidAskOffsetCents: 5_000, wholly: true });
    expect(workPartyAskOffset({ priceDiffCents: -5_000, changeFeeCents: 0, unpaidAskOffsetCents: 3_000 })).toEqual({ unpaidAskOffsetCents: 3_000, wholly: false });
    expect(workPartyAskOffset({ priceDiffCents: -5_000, changeFeeCents: 0, unpaidAskOffsetCents: 0 })).toEqual({ unpaidAskOffsetCents: 0, wholly: false });
    // A fee charged on the edit is part of its net, as the edit's own rule reads it.
    expect(workPartyAskOffset({ priceDiffCents: -5_000, changeFeeCents: 1_000, unpaidAskOffsetCents: 4_000 }).wholly).toBe(true);
    expect(workPartyAskOffset({ priceDiffCents: 5_000, changeFeeCents: 0, unpaidAskOffsetCents: 0 }).wholly).toBe(false);
  });

  it("defaults to the first method offered", () => {
    expect(resolveWorkPartySettlementMethod({ methods: ["credit", "card"], paidByOrganiser: false, refundTo: "card" }, undefined, CLUB_FORMAT_TEST)).toBe("credit");
    expect(resolveWorkPartySettlementMethod({ methods: ["card"], paidByOrganiser: true, refundTo: null }, undefined, CLUB_FORMAT_TEST)).toBe("card");
  });

  it("takes the officer's choice when it is offered, by card or by bank", () => {
    for (const refundTo of ["card", "bank"] as const) {
      const options = { methods: ["credit", "card"] as const, paidByOrganiser: false, refundTo };
      expect(resolveWorkPartySettlementMethod(options, "card", CLUB_FORMAT_TEST)).toBe("card");
      expect(resolveWorkPartySettlementMethod(options, "credit", CLUB_FORMAT_TEST)).toBe("credit");
    }
  });

  it("refuses a refund where only credit is offered, with 409", () => {
    expect(() =>
      resolveWorkPartySettlementMethod({ methods: ["credit"], paidByOrganiser: false, refundTo: null }, "card", CLUB_FORMAT_TEST),
    ).toThrow(expect.objectContaining({ status: 409, message: WORK_PARTY_SETTLEMENT_NOT_OFFERED_MESSAGE }));
  });

  it("refuses credit on an organiser-paid joiner, whose money goes back to the organiser", () => {
    expect(() =>
      resolveWorkPartySettlementMethod({ methods: ["card"], paidByOrganiser: true, refundTo: null }, "credit", CLUB_FORMAT_TEST),
    ).toThrow(expect.objectContaining({ status: 409, message: expect.stringMatching(/group organiser/) }));
  });
});

describe("every cent that comes back is counted once (Remove's guard, the absorbed-ask test)", () => {
  const unpaid: WorkPartyCorrectionFigures = {
    previousFinalPriceCents: 20_000,
    newFinalPriceCents: 15_000,
    priceDiffCents: -5_000,
    changeFeeCents: 0,
    accountCreditAmountCents: 0,
    appliedCreditGivenBackCents: 0,
    refundedExcessCreditCents: 0,
    additionalAmountCents: 0,
    billedToOrganiserCents: 0,
    refundAmountCents: 0,
    settlementMethod: "credit",
  };

  it("counts every way money comes back: refund, credit, applied credit given back, and an unpaid booking's freed credit", () => {
    expect(editTotalMoneyBackCents(unpaid)).toBe(0);
    expect(
      editTotalMoneyBackCents({
        ...unpaid,
        refundAmountCents: 1,
        accountCreditAmountCents: 2,
        appliedCreditGivenBackCents: 4,
        refundedExcessCreditCents: 8,
      }),
    ).toBe(15);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === "__tests__" || name === "node_modules" ? [] : sourceFiles(full);
    }
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe("the officer-only internal-code admission (census)", () => {
  const root = path.join(process.cwd(), "src");
  const files = sourceFiles(root);
  const rel = (file: string) => path.relative(process.cwd(), file).replaceAll("\\", "/");

  it("walked the tree", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("only work-party-booking-correction.ts passes `officerWorkPartyCorrection`, in any spelling", () => {
    // Any mention outside the declaring service — shorthand, spread or a
    // wrapper — counts, not just `officerWorkPartyCorrection:`.
    const callers = files
      .filter((file) => /\bofficerWorkPartyCorrection\b/.test(readFileSync(file, "utf8")))
      .map(rel)
      .filter((file) => file !== "src/lib/booking-batch-modification-service.ts")
      .filter((file) => file !== "src/lib/booking-modify-plan.ts")
      .filter((file) => file !== "src/lib/booking-batch-modification-transaction-result.ts") // the result type (#5145)
      .sort();
    // The batch service declares it as `officerWorkPartyCorrection?:` and
    // hands it on to the promo engine in the plan; the correction module is
    // the one file that passes it in.
    expect(callers).toEqual(["src/lib/work-party-booking-correction.ts"]);
  }, CENSUS_TIMEOUT_MS);

  it("only the batch service hands the correction to the promo engine (Add admits, fork triyder/AlpineClubBookingsNZ#130 Remove drops)", () => {
    const service = readFileSync(path.join(root, "lib", "booking-batch-modification-service.ts"), "utf8");
    const plan = readFileSync(path.join(root, "lib", "booking-modify-plan.ts"), "utf8");
    expect(service).toContain("officerWorkPartyCorrection: officerWorkPartyCorrection ?? null,");
    // Defaulted to null, so a caller that passes nothing admits or drops nothing.
    expect(plan).toContain("officerWorkPartyCorrection = null,");
    expect(plan).toContain(
      "const requested = withoutRemovedWorkPartyCode(requestedPromoCodeListFor(input, storedCodes, multiPromoCodes), existing, officerWorkPartyCorrection);",
    );
  });

  it("M1: a work-party correction skips only the pricing pass's bed check", () => {
    const service = readFileSync(path.join(root, "lib", "booking-batch-modification-service.ts"), "utf8");
    const plan = readFileSync(path.join(root, "lib", "booking-modify-plan.ts"), "utf8");
    expect(service).toContain(
      "skipBookingLifecycleRules: dates.skipBookingLifecycleRules || workPartyCorrectionSkipsBedCheck(officerWorkPartyCorrection, booking.status),",
    );
    // Inside calculateModifiedPricing the flag gates the capacity branch and
    // nothing else; a second use would also skip it for a correction.
    const pricing = plan.slice(
      plan.indexOf("export async function calculateModifiedPricing("),
      plan.indexOf("export function resolvePromoBeneficiarySelection("),
    );
    expect(pricing.match(/\bskipBookingLifecycleRules\b/g)).toHaveLength(3);
    expect(pricing).toContain("  if (skipBookingLifecycleRules) {");
  });

  it("is not a request-body field on any route", () => {
    const routes = files.filter((file) => file.endsWith(`${path.sep}route.ts`));
    const offenders = routes
      .filter((file) => /officerWorkParty/.test(readFileSync(file, "utf8")))
      .map(rel);
    expect(offenders).toEqual([]);
  }, CENSUS_TIMEOUT_MS);

  it("still refuses every other internal code in applyPromoCodeChanges", () => {
    const plan = readFileSync(path.join(root, "lib", "booking-modify-plan.ts"), "utf8");
    const rules = readFileSync(path.join(root, "lib", "promo-code-list-rules.ts"), "utf8");
    // The admission is the one helper (in the promo-list leaf, #5149), used at the one refusal.
    expect(rules).toContain(
      "return !promoCode.internal || promoCode.id === admittedInternalPromoCodeId;",
    );
    expect(plan).toContain(
      'import { admittedWorkPartyCodeId, enteredPromoCodeAdmitted, promoCodeListRefusal, withoutRemovedWorkPartyCode, type WorkPartyCodeCorrection } from "@/lib/promo-code-list-rules";',
    );
    expect(plan).toContain(
      "if (!enteredPromoCodeAdmitted(promoCode, admittedWorkPartyCodeId(officerWorkPartyCorrection))) {",
    );
    // A Remove admits nothing.
    expect(rules).toContain('return correction?.direction === "add" ? correction.promoCodeId : null;');
  });
});

describe("workPartyPaidWithNoMoneyTaken (owner decisions of 18 and 20 Nov 2026)", () => {
  // The ledger rows of one payment, filtered as Prisma would by the fact's own `where`.
  type Row = { paymentId: string; amountCents: number; status: string };
  const ledger = (rows: Row[]) => ({
    paymentTransaction: {
      count: async ({ where }: { where: { paymentId: string; amountCents: { gt: number }; status: { in: string[] } } }) =>
        rows.filter(
          (row) => row.paymentId === where.paymentId && row.amountCents > where.amountCents.gt && where.status.in.includes(row.status),
        ).length,
    },
  }) as unknown as Parameters<typeof workPartyPaidWithNoMoneyTaken>[0];
  const paid = (payment: Record<string, unknown>) =>
    ({ status: BookingStatus.PAID, payment: { id: "pay-1", amountCents: 0, creditAppliedCents: 0, ...payment } }) as unknown as Parameters<
      typeof workPartyPaidWithNoMoneyTaken
    >[1];

  it("is true for nothing taken, and for account credit alone", async () => {
    expect(await workPartyPaidWithNoMoneyTaken(ledger([]), paid({}))).toBe(true);
    expect(await workPartyPaidWithNoMoneyTaken(ledger([]), paid({ creditAppliedCents: 10_000 }))).toBe(true);
  });

  it("is false where money is on the payment, as an organiser-paid joiner's share is", async () => {
    expect(await workPartyPaidWithNoMoneyTaken(ledger([]), paid({ amountCents: 5_000, creditAppliedCents: 10_000 }))).toBe(false);
  });

  it.each(["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"])(
    "counts a %s capture as money taken: a refunded capture was still taken (CAPTURED_TRANSACTION_STATUS_LIST)",
    async (status) => {
      const rows = [{ paymentId: "pay-1", amountCents: 20_000, status }];
      expect(await workPartyPaidWithNoMoneyTaken(ledger(rows), paid({ creditAppliedCents: 10_000 }))).toBe(false);
    },
  );

  it("does not count an intent never captured (failed, or still pending)", async () => {
    const rows = [{ paymentId: "pay-1", amountCents: 20_000, status: "FAILED" }, { paymentId: "pay-1", amountCents: 20_000, status: "PENDING" }];
    expect(await workPartyPaidWithNoMoneyTaken(ledger(rows), paid({}))).toBe(true);
  });
});
