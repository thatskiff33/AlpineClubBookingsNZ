import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRequestPromoFields,
  validatePromoCodeList,
} from "@/components/promo-code-list-client";
import { promoActionPayload } from "@/components/edit-booking/hooks/use-promo-selection";
import type { PromoResult } from "@/components/promo-code-input";

/**
 * The request fields an ordered code list becomes (#3492). One code keeps the
 * legacy single-code body byte-for-byte; several travel as `promoCodes` in the
 * booker's order — never both, which the create route refuses (#3827).
 */
function applied(code: string, extra: Partial<PromoResult> = {}): PromoResult {
  return {
    code,
    description: null,
    type: "FREE_NIGHTS",
    discountCents: 0,
    promoAdjustmentCents: 0,
    totalPriceCents: 0,
    finalPriceCents: 0,
    ...extra,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("createRequestPromoFields", () => {
  it("sends one code exactly as a single-code booking always has", () => {
    expect(createRequestPromoFields([applied("ONE", { selectedGuestIndexes: [1] })])).toEqual({
      promoCode: "ONE",
      promoGuestIndexes: [1],
    });
  });

  it("sends several codes as promoCodes, in order, with only the booker's own guest choices", () => {
    expect(
      createRequestPromoFields([
        applied("B", { selectedGuestIndexes: [2] }),
        applied("A", { promoGuestIndexes: [0], selectedGuestIndexes: [0] }),
      ]),
    ).toEqual({ promoCodes: [{ code: "B" }, { code: "A", promoGuestIndexes: [0] }] });
  });

  it("sends nothing for a working-bee discount, which is not a typed code", () => {
    expect(
      createRequestPromoFields([applied("", { code: null, workPartyEvent: { id: "e", name: "Bee", discountPercent: 50 } })]),
    ).toEqual({});
  });
});

describe("promoActionPayload", () => {
  it("binds an existing guest by id and an added guest by its request position, per code", () => {
    expect(
      promoActionPayload(
        { type: "list", codes: [{ code: "KEEP" }, { code: "PICK", guestIndexes: [0, 2] }] },
        [{ id: "bg-1" }, { id: "bg-2" }],
      ),
    ).toEqual({
      promoCodes: [{ code: "KEEP" }, { code: "PICK", promoGuestIds: ["bg-1"], promoAddedGuestIndexes: [0] }],
    });
  });

  it("keeps the legacy single-code fields for the single-code editor", () => {
    expect(promoActionPayload({ type: "remove" }, [])).toEqual({ removePromoCode: true });
    expect(promoActionPayload({ type: "new", code: "X" }, [])).toEqual({ promoCode: "X" });
    expect(promoActionPayload({ type: "keep" }, [])).toEqual({});
  });
});

describe("validatePromoCodeList", () => {
  function stubPreview(body: unknown) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("asks the several-code preview and maps each code's own amount, in the booker's order", async () => {
    const fetchMock = stubPreview({
      valid: true,
      codes: [
        { code: "A", valid: true, promoAdjustmentCents: -1000, discountCents: 1000, type: "FREE_NIGHTS" },
        { code: "B", valid: true, promoAdjustmentCents: -500, discountCents: 500, type: "PERCENTAGE" },
      ],
      totalPriceCents: 9000,
      finalPriceCents: 7500,
    });
    const outcome = await validatePromoCodeList({
      entries: [{ code: "B" }, { code: "A" }],
      appliesTo: new Map([["A", "Sam"]]),
      checkIn: "2026-08-01",
      checkOut: "2026-08-03",
      guests: [{ ageTier: "ADULT", isMember: true, memberId: "m1" }],
      lodgeId: "lodge-1",
    });
    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.codes).toEqual([{ code: "B" }, { code: "A" }]);
    expect(outcome).toMatchObject({
      ok: true,
      applied: [
        { code: "B", promoAdjustmentCents: -500 },
        { code: "A", promoAdjustmentCents: -1000, appliesTo: "Sam" },
      ],
    });
  });

  it("refuses the whole list and names the code that failed", async () => {
    stubPreview({
      valid: false,
      codes: [
        { code: "A", valid: true, promoAdjustmentCents: -1000 },
        { code: "B", valid: false, error: "Already covered by an earlier code" },
      ],
    });
    await expect(
      validatePromoCodeList({
        entries: [{ code: "A" }, { code: "B" }],
        checkIn: "2026-08-01",
        checkOut: "2026-08-03",
        guests: [],
      }),
    ).resolves.toEqual({ ok: false, error: "B: Already covered by an earlier code" });
  });
});
