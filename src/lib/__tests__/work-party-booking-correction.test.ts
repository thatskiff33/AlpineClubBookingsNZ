import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BookingStatus } from "@prisma/client";
import {
  workPartyBookingEligibility,
  type WorkPartyEligibilityBooking,
  type WorkPartyEligibilityContext,
  type WorkPartyEligibilityEvent,
} from "@/lib/work-party-booking-correction";
import { PROMO_WORK_PARTY_EXCLUSION_MESSAGE } from "@/lib/promo-code-list-rules";

/**
 * Fork #119: the eligibility rule for "Add booking to work party", one case per
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
  hasOtherPromoCode: false,
  paidByOrganiser: false,
  quotePriced: false,
  memberOwned: true,
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

  it("refuses a stay that has started (checking in today, owner decision 3)", () => {
    expect(
      workPartyBookingEligibility({ ...booking, checkIn: d("2026-07-01") }, context, event),
    ).toMatchObject(refusal(/already started/));
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

  it("refuses an organiser-paid joiner's booking (owner decision 4)", () => {
    expect(
      workPartyBookingEligibility({ ...booking, paidByOrganiser: true }, context, event),
    ).toMatchObject(refusal(/paid by its group organiser/));
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

  it("refuses another promo code while the club allows one discount, with the booking-create wording", () => {
    expect(
      workPartyBookingEligibility({ ...booking, hasOtherPromoCode: true }, context, event),
    ).toEqual(refusal(PROMO_WORK_PARTY_EXCLUSION_MESSAGE));
  });

  it("accepts another promo code when the club combines codes", () => {
    expect(
      workPartyBookingEligibility(
        { ...booking, hasOtherPromoCode: true },
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
      .sort();
    // The batch service declares it as `officerWorkPartyCorrection?:`; the
    // correction module is the one file that passes it.
    expect(callers).toEqual(["src/lib/work-party-booking-correction.ts"]);
  });

  it("only the batch service hands the admission to the promo engine", () => {
    const callers = files
      .filter((file) => /\bofficerWorkPartyPromoCodeId\b/.test(readFileSync(file, "utf8")))
      .map(rel)
      .sort();
    expect(callers).toEqual([
      "src/lib/booking-batch-modification-service.ts",
      "src/lib/booking-modify-plan.ts",
    ]);
  });

  it("is not a request-body field on any route", () => {
    const routes = files.filter((file) => file.endsWith(`${path.sep}route.ts`));
    const offenders = routes
      .filter((file) => /officerWorkParty/.test(readFileSync(file, "utf8")))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("still refuses every other internal code in applyPromoCodeChanges", () => {
    const plan = readFileSync(path.join(root, "lib", "booking-modify-plan.ts"), "utf8");
    expect(plan).toContain(
      "(promoCode.internal && promoCode.id !== officerWorkPartyPromoCodeId)",
    );
    // Defaulted to null, so a caller that passes nothing admits nothing.
    expect(plan).toContain("officerWorkPartyPromoCodeId = null,");
  });
});
