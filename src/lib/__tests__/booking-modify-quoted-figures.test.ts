import { describe, expect, it } from "vitest";
import { batchModifySchema } from "@/lib/booking-modify-request";
import {
  modifyQuoteSchema,
  OVERRIDE_DATE_ONLY_FIELDS,
  isDateOnlyOverrideViolation,
} from "@/lib/booking-modify-quote-request";
import { assertEditQuotedFigures, EditPriceChangedError } from "@/lib/edit-quoted-figures";

const figures = { newFinalPriceCents: 10000, priceDiffCents: -12000, changeFeeCents: 0, netChargeCents: -12000 };

describe("booking edit approval (#4924)", () => {
  it("derives every preview field without redefining it", () => {
    for (const key of Object.keys(modifyQuoteSchema.shape) as Array<keyof typeof modifyQuoteSchema.shape>) {
      expect(batchModifySchema.shape[key], key).toBe(modifyQuoteSchema.shape[key]);
    }
  });

  it.each(OVERRIDE_DATE_ONLY_FIELDS)("refuses %s on a date-only override", (field) => {
    expect(isDateOnlyOverrideViolation({ [field]: field === "removePromoCode" ? true : ["change"] })).toBe(true);
  });

  it.each([{ applyCreditCents: 0 }, { otherLodgeId: null }])("refuses falsy elections: %j", (data) => {
    expect(isDateOnlyOverrideViolation(data)).toBe(true);
  });

  it("allows dates and empty change lists", () => {
    expect(isDateOnlyOverrideViolation({ checkIn: "2026-08-01", addGuests: [], promoCode: "" })).toBe(false);
  });

  it.each(Object.keys(figures) as Array<keyof typeof figures>)("compares %s independently", (field) => {
    const fresh = { ...figures, [field]: figures[field] + 1 };
    expect(() => assertEditQuotedFigures(figures, fresh)).toThrow(EditPriceChangedError);
    try { assertEditQuotedFigures(figures, fresh); } catch (error) {
      expect(error).toMatchObject({ figures: fresh });
    }
  });

  it("accepts matching figures and the temporary old-client window", () => {
    expect(() => assertEditQuotedFigures(figures, { ...figures })).not.toThrow();
    expect(() => assertEditQuotedFigures(undefined, figures)).not.toThrow();
  });
});
