/**
 * #3827: while the `multiPromoCodes` rollout switch is off (#3826), a create
 * that carries a second code — or a code beside a working bee — is refused in
 * words the member reads, before `redeemPromoCode`'s backstop could refuse it
 * less helpfully; once it is on, the working bee comes first (D-3813-3).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ multiPromoCodes: false }));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/module-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/module-settings")),
  loadEffectiveModuleFlags: vi.fn(async () => ({
    promoCodes: true,
    workParties: true,
    multiPromoCodes: flags.multiPromoCodes,
  })),
}));
vi.mock("@/lib/work-party", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/work-party")),
  resolveWorkPartyEventPromoForBooking: vi.fn(async () => ({ ok: true, promoCodeStr: "WB-INTERNAL" })),
}));

import {
  DUPLICATE_PROMO_CODE_MESSAGE,
  ONE_PROMO_CODE_PER_BOOKING_MESSAGE,
  orderedPromoCodeRequests,
  resolveEffectivePromoSources,
} from "../booking-create-promo";

const STAY = {
  checkIn: new Date("2026-08-01T00:00:00.000Z"),
  checkOut: new Date("2026-08-03T00:00:00.000Z"),
};

describe("create's promo sources and the multiPromoCodes switch", () => {
  beforeEach(() => {
    flags.multiPromoCodes = false;
  });

  it("refuses a second code while the switch is off", async () => {
    await expect(
      resolveEffectivePromoSources({} as never, {
        ...STAY,
        promoCodes: [{ code: "ANN" }, { code: "BOB" }],
      }),
    ).rejects.toThrow(ONE_PROMO_CODE_PER_BOOKING_MESSAGE);
  });

  it("keeps the working bee exclusive while the switch is off", async () => {
    await expect(
      resolveEffectivePromoSources({} as never, {
        ...STAY,
        promoCodes: [{ code: "ANN" }],
        workPartyEventId: "wp-1",
      }),
    ).rejects.toThrow(/cannot be combined with a working bee/);
  });

  it("refuses the same code twice whatever the switch says", async () => {
    flags.multiPromoCodes = true;
    await expect(
      resolveEffectivePromoSources({} as never, {
        ...STAY,
        promoCodes: [{ code: "ann" }, { code: " ANN " }],
      }),
    ).rejects.toThrow(DUPLICATE_PROMO_CODE_MESSAGE);
  });

  it("with the switch on, puts the working bee first, then the booker's codes in order", async () => {
    flags.multiPromoCodes = true;
    const sources = await resolveEffectivePromoSources({} as never, {
      ...STAY,
      promoCodes: [{ code: "BOB" }, { code: "ANN", promoGuestIndexes: [1] }],
      workPartyEventId: "wp-1",
    });
    expect(sources).toEqual([
      { promoCodeStr: "WB-INTERNAL", allowInternal: true },
      { promoCodeStr: "BOB", allowInternal: false },
      { promoCodeStr: "ANN", allowInternal: false, promoGuestIndexes: [1] },
    ]);
  });
});

describe("the create request's code list (D-3813-2)", () => {
  it("sorts by each entry's order (its list position where none is given), ties by list position", () => {
    expect(
      orderedPromoCodeRequests({
        promoCodes: [
          { code: "C", order: 2 },
          { code: "A", order: 0, promoGuestIndexes: [1] },
          { code: "B" },
        ],
      }),
    // B has no order, so it sorts as its position, 2 — level with C, which
    // comes first in the list.
    ).toEqual([{ code: "A", promoGuestIndexes: [1] }, { code: "C" }, { code: "B" }]);
  });

  it("reads the legacy single code with its guest choice", () => {
    expect(orderedPromoCodeRequests({ promoCodeStr: "ann", promoGuestIndexes: [0] })).toEqual([
      { code: "ann", promoGuestIndexes: [0] },
    ]);
    expect(orderedPromoCodeRequests({})).toEqual([]);
  });
});
