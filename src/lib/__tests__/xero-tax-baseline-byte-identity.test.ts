/**
 * BYTE-IDENTITY UNDER THE BASELINE TREATMENT (#4632). A club that never saves a
 * tax setting is registered at 1500 bp under `OUTPUT2`, and every line a Xero
 * document carries must serialise exactly as it did before the club tax
 * schedule existed: same keys, same order, same values.
 *
 * `xero-tax-baseline-goldens.json` was captured by running these same cases
 * against the code before #4632 (main at 4c27950e8), where each builder wrote
 * the literal `taxType: "OUTPUT2"` and each document `LineAmountTypes.Inclusive`.
 * The builders ignore a trailing argument they do not declare, so the identical
 * calls ran there; the goldens are that run's output, never regenerated from
 * the code under test. A difference here is a change to what an existing club
 * sends Xero, not a fixture to refresh.
 *
 * The senders around these builders are held by their own suites, which assert
 * the document's line-amount basis and tax type and pass the baseline anchor
 * (`support/xero-tax-anchors-baseline.ts`).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { diffBookingPricing, type ModificationPricingSide } from "@/lib/booking-modification-lines";
import { mintLineItems } from "@/lib/xero-applied-credit-mint-accounts";
import { buildInvoiceLineItems } from "@/lib/xero-booking-invoices";
import { buildEntranceFeeLineItem } from "@/lib/xero-entrance-fee-invoices";
import type { HutFeeItemCodeResolver } from "@/lib/xero-mappings";
import { buildModificationDocumentLineItems, changeFeeLineItem } from "@/lib/xero-modification-line-items";
import { planPromoAdjustmentLines, promoAdjustmentLineItems } from "@/lib/xero-promo-adjustment-lines";
import { BASELINE_XERO_TAX_RENDERING } from "@/lib/xero-tax-rendering";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const GOLDENS = JSON.parse(
  readFileSync(path.join(process.cwd(), "src/lib/__tests__/xero-tax-baseline-goldens.json"), "utf8"),
) as Record<string, string>;

const baseline = BASELINE_XERO_TAX_RENDERING;
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
const FULL = "type-full";
const NON_MEMBER = "type-non-member";
const resolver: HutFeeItemCodeResolver = {
  byKey: new Map([
    [`${FULL}_WINTER_ADULT`, "HUT-MEMBER-ADULT"],
    [`${NON_MEMBER}_WINTER_ADULT`, "HUT-NONMEMBER-ADULT"],
  ]),
  fullTypeId: FULL,
  nonMemberTypeId: NON_MEMBER,
  legacyItemCode: null,
  size: 2,
};
const income = { code: "200", itemCode: "HUT", codeExplicitlyConfigured: false };
const refund = { code: "201", itemCode: null, codeExplicitlyConfigured: true };

function pricingSide(prices: number[]): ModificationPricingSide {
  return {
    guests: [
      {
        guestKey: "g1",
        ageTier: "ADULT",
        isMember: false,
        rateMembershipTypeId: NON_MEMBER,
        name: "Guest One",
        nights: prices.map((priceCents, i) => ({
          stayDate: new Date(day("2026-08-14").getTime() + i * 86_400_000),
          priceCents,
          priceSource: "SOLD" as const,
        })),
      },
    ],
    promoAdjustmentCents: 0,
  };
}

function modificationLines(before: number[], after: number[]) {
  const beforeSide = pricingSide(before);
  const afterSide = pricingSide(after);
  const delta = after.reduce((a, b) => a + b, 0) - before.reduce((a, b) => a + b, 0);
  const result = diffBookingPricing(beforeSide, afterSide, delta);
  if (result.kind !== "lines") throw new Error(`expected lines, got ${result.kind}`);
  return result.lines;
}

const modificationContext = {
  incomeMapping: income,
  refundMapping: refund,
  itemCodeResolver: resolver,
  seasonType: "WINTER",
  promo: { xeroItemCode: "PROMO", xeroAccountCode: null },
  firstGuest: { ageTier: "ADULT", isMember: false, rateMembershipTypeId: NON_MEMBER },
  taxRendering: baseline,
};

const promoCoding = {
  firstGuest: { ageTier: "ADULT", isMember: true, rateMembershipTypeId: FULL },
  itemCodeResolver: resolver,
  seasonType: "WINTER",
  hutFeeMapping: income,
};

/** Each case renders one document kind's lines exactly as its sender does. */
const CASES: Record<string, () => unknown> = {
  "document line-amount basis": () => baseline.lineAmountTypes,
  "booking invoice, per-night runs and a whole-range guest": () =>
    buildInvoiceLineItems(
      [
        {
          firstName: "Ana",
          lastName: "Member",
          ageTier: "ADULT",
          isMember: true,
          rateMembershipTypeId: FULL,
          priceCents: 16_000,
          nights: [
            { stayDate: day("2026-08-14"), priceCents: 8_000 },
            { stayDate: day("2026-08-15"), priceCents: 8_000 },
          ],
        },
        { firstName: "Ben", lastName: "Guest", ageTier: "ADULT", isMember: false, priceCents: 24_000, nights: null },
      ],
      day("2026-08-14"),
      day("2026-08-16"),
      2,
      "200",
      "HUT",
      false,
      resolver,
      "WINTER",
      baseline,
    ),
  "booking invoice, explicit account and no item code": () =>
    buildInvoiceLineItems(
      [{ firstName: "Cara", lastName: "Solo", ageTier: "YOUTH", isMember: false, priceCents: 9_999 }],
      day("2026-09-01"),
      day("2026-09-04"),
      3,
      "205",
      null,
      true,
      undefined,
      null,
      baseline,
    ),
  "change-fee line": () => changeFeeLineItem(2_500, income, baseline),
  "change-fee line, explicit account": () =>
    changeFeeLineItem(1_234, { code: "210", itemCode: null, codeExplicitlyConfigured: true }, baseline),
  "entrance-fee invoice line": () => buildEntranceFeeLineItem("Adult", 15_000, "200", "JOIN", false, null, baseline),
  "entrance-fee invoice line, narrated": () =>
    buildEntranceFeeLineItem("Family", 30_000, "220", null, true, " Joining fee 2026 ", baseline),
  "applied-credit remainder note": () =>
    mintLineItems(
      [
        { amountCents: 4_000, accountCode: "201" },
        { amountCents: 1_500, itemCode: "GOODWILL" },
        { amountCents: 500, accountCode: "201" },
      ],
      "Credit applied to booking",
      baseline,
    ),
  "booking-edit supplementary invoice with a change fee": () =>
    buildModificationDocumentLineItems(
      {
        lines: modificationLines([8_000, 8_000], [8_000, 8_000, 9_000]),
        changeFeeCents: 2_500,
        document: "SUPPLEMENTARY_INVOICE",
        context: modificationContext,
      },
      CLUB_FORMAT_TEST,
    ),
  "booking-edit credit note": () =>
    buildModificationDocumentLineItems(
      {
        lines: modificationLines([8_000, 8_000, 9_000], [8_000]),
        changeFeeCents: 0,
        document: "MODIFICATION_CREDIT_NOTE",
        context: modificationContext,
      },
      CLUB_FORMAT_TEST,
    ),
  "promotion line, one code": () =>
    promoAdjustmentLineItems(
      planPromoAdjustmentLines({
        aggregateCents: -2_000,
        redemptions: [{ id: "r1", promoCode: { code: "SNOW", xeroItemCode: "PROMO-SNOW", xeroAccountCode: null } }],
        adjustmentRows: [],
      } as Parameters<typeof planPromoAdjustmentLines>[0]),
      promoCoding,
      baseline,
    ),
  "promotion line, no code": () =>
    promoAdjustmentLineItems({ kind: "ONE_CODE", promo: null, amountCents: -750 }, promoCoding, baseline),
};

describe("every Xero line under the baseline treatment is byte-identical to before #4632", () => {
  it("has a golden for every case and a case for every golden", () => {
    expect(Object.keys(GOLDENS).sort()).toEqual(Object.keys(CASES).sort());
  });

  it.each(Object.keys(CASES))("%s", (name) => {
    expect(JSON.stringify(CASES[name]!())).toBe(GOLDENS[name]);
  });
});
