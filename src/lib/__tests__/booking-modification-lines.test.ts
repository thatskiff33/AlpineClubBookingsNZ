/**
 * The lines behind a booking edit's price delta (#3530 stage 2a). Each rule in
 * the module's docblock is pinned here, and the last case prints the rendered
 * sentences so the owner can read the wording before a Xero document (2b)
 * carries it.
 */
import { describe, expect, it, vi } from "vitest";
import {
  computeModificationPriceLines,
  diffBookingPricing,
  loadModificationLinesAuditFields,
  modificationLinesAuditFields,
  parseModificationLines,
  renderModificationLineDescription,
  renderModificationLineWithAmount,
  sumModificationLines,
  type ModificationLine,
  type ModificationPricingSide,
} from "@/lib/booking-modification-lines";

function day(d: string): Date {
  return new Date(`${d}T00:00:00.000Z`);
}

function nights(
  from: string,
  prices: number[],
  priceSource: "SOLD" | "OFFICER_PRICED" | "EVEN_SPLIT" | "UNKNOWN" | undefined = "SOLD",
) {
  const start = day(from);
  return prices.map((priceCents, i) => ({
    stayDate: new Date(start.getTime() + i * 86_400_000),
    priceCents,
    ...(priceSource ? { priceSource } : {}),
  }));
}

function guest(
  guestKey: string,
  overrides: Partial<ModificationPricingSide["guests"][number]> = {},
): ModificationPricingSide["guests"][number] {
  return {
    guestKey,
    ageTier: "ADULT",
    isMember: false,
    rateMembershipTypeId: "rate-non-member",
    name: `Guest ${guestKey}`,
    nights: nights("2026-08-14", [8000, 8000]),
    ...overrides,
  };
}

function side(
  guests: ModificationPricingSide["guests"],
  promoAdjustmentCents = 0,
  promoCode: string | null = null,
): ModificationPricingSide {
  return { guests, promoAdjustmentCents, promoCode };
}

/** The after side is freshly priced: no provenance on its nights. */
function afterNights(from: string, prices: number[]) {
  return nights(from, prices, undefined);
}

function linesOf(result: ReturnType<typeof diffBookingPricing>): ModificationLine[] {
  expect(result.kind).toBe("lines");
  return result.kind === "lines" ? result.lines : [];
}

describe("diffBookingPricing", () => {
  it("adds one guest for one night as one line", () => {
    const before = side([guest("a")]);
    const after = side([
      { ...guest("a"), nights: afterNights("2026-08-14", [8000, 8000]) },
      { ...guest("b"), nights: afterNights("2026-08-14", [8000]) },
    ]);

    const lines = linesOf(diffBookingPricing(before, after, 8000));

    expect(lines).toEqual([
      expect.objectContaining({
        kind: "GUEST_NIGHTS",
        sign: 1,
        ageTier: "ADULT",
        isMember: false,
        unitCents: 8000,
        nightCount: 1,
        guestCount: 1,
        quantity: 1,
        startDate: "2026-08-14",
        endExclusive: "2026-08-15",
        guestNames: ["Guest b"],
        amountCents: 8000,
      }),
    ]);
  });

  it("removes a guest as a negative line, and folds two identical removals into one", () => {
    const before = side([
      guest("a"),
      guest("b", { name: "Guest b" }),
      guest("c", { isMember: true, rateMembershipTypeId: "rate-member", nights: nights("2026-08-14", [5000, 5000]) }),
    ]);
    const after = side([
      { ...guest("c"), isMember: true, rateMembershipTypeId: "rate-member", nights: afterNights("2026-08-14", [5000, 5000]) },
    ]);

    const lines = linesOf(diffBookingPricing(before, after, -32000));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      sign: -1,
      guestCount: 2,
      nightCount: 2,
      quantity: 4,
      unitCents: 8000,
      amountCents: -32000,
      guestNames: ["Guest a", "Guest b"],
    });
    expect(renderModificationLineDescription(lines[0]!)).toBe(
      "2 x Non-member Adult removed - 2 nights - 14 Aug 2026 - 16 Aug 2026",
    );
  });

  it("a date move: kept nights cancel, the vacated night is removed and the new night added", () => {
    // 14-16 Aug -> 15-17 Aug: the 15th is kept, the 14th removed, the 16th added.
    const before = side([guest("a", { nights: nights("2026-08-14", [8000, 8000]) })]);
    const after = side([{ ...guest("a"), nights: afterNights("2026-08-15", [8000, 8000]) }]);

    const lines = linesOf(diffBookingPricing(before, after, 0));

    expect(lines.map((line) => renderModificationLineDescription(line))).toEqual([
      "1 x Non-member Adult removed - 1 night - 14 Aug 2026 - 15 Aug 2026",
      "1 x Non-member Adult added - 1 night - 16 Aug 2026 - 17 Aug 2026",
    ]);
    expect(sumModificationLines(lines)).toBe(0);
  });

  it("a reprice in place is two lines, never netted", () => {
    const before = side([guest("a", { nights: nights("2026-08-14", [8000]) })]);
    const after = side([{ ...guest("a"), nights: afterNights("2026-08-14", [9500]) }]);

    const lines = linesOf(diffBookingPricing(before, after, 1500));

    expect(lines.map((line) => line.amountCents)).toEqual([-8000, 9500]);
    expect(lines.map((line) => renderModificationLineDescription(line))).toEqual([
      "1 x Non-member Adult removed - 1 night - 14 Aug 2026 - 15 Aug 2026",
      "1 x Non-member Adult added - 1 night - 14 Aug 2026 - 15 Aug 2026",
    ]);
  });

  it("a category change on a kept guest re-sells every night under the new shape", () => {
    const before = side([guest("a", { isMember: false, rateMembershipTypeId: "rate-non-member", nights: nights("2026-08-14", [8000]) })]);
    const after = side([{ ...guest("a"), isMember: true, rateMembershipTypeId: "rate-member", nights: afterNights("2026-08-14", [5000]) }]);

    const lines = linesOf(diffBookingPricing(before, after, -3000));

    expect(lines.map((line) => renderModificationLineDescription(line))).toEqual([
      "1 x Non-member Adult removed - 1 night - 14 Aug 2026 - 15 Aug 2026",
      "1 x Member Adult added - 1 night - 14 Aug 2026 - 15 Aug 2026",
    ]);
  });

  it("a partial-night removal names only the nights that went", () => {
    const before = side([guest("a", { nights: nights("2026-08-14", [8000, 8000, 8000]) })]);
    const after = side([{ ...guest("a"), nights: afterNights("2026-08-14", [8000, 8000]) }]);

    const lines = linesOf(diffBookingPricing(before, after, -8000));

    expect(lines.map((line) => renderModificationLineDescription(line))).toEqual([
      "1 x Non-member Adult removed - 1 night - 16 Aug 2026 - 17 Aug 2026",
    ]);
  });

  it("cuts a guest's nights into same-price runs, like the original invoice", () => {
    const before = side([]);
    const after = side([{ ...guest("a"), nights: afterNights("2026-08-14", [8000, 8000, 9500]) }]);

    const lines = linesOf(diffBookingPricing(before, after, 25500));

    expect(lines.map((line) => renderModificationLineDescription(line))).toEqual([
      "1 x Non-member Adult added - 2 nights - 14 Aug 2026 - 16 Aug 2026",
      "1 x Non-member Adult added - 1 night - 16 Aug 2026 - 17 Aug 2026",
    ]);
  });

  it("a promotion that moves is one signed PROMO_DELTA line", () => {
    const before = side([guest("a")], -1000, "SUMMER25");
    const after = side(
      [{ ...guest("a"), nights: afterNights("2026-08-14", [8000, 8000]) }, { ...guest("b"), nights: afterNights("2026-08-14", [8000, 8000]) }],
      -2000,
      "SUMMER25",
    );

    // +16000 of nights, -1000 more promotion.
    const lines = linesOf(diffBookingPricing(before, after, 15000));

    expect(lines.at(-1)).toEqual({
      v: 1,
      kind: "PROMO_DELTA",
      sign: -1,
      promoCode: "SUMMER25",
      amountCents: -1000,
    });
    expect(renderModificationLineDescription(lines.at(-1)!)).toBe(
      "Promotion SUMMER25 increased by $10.00",
    );
  });

  it("a promotion that is removed reads as reduced by what it was worth", () => {
    const before = side([guest("a")], -1000, "SUMMER25");
    const after = side([{ ...guest("a"), nights: afterNights("2026-08-14", [8000, 8000]) }], 0, null);

    const lines = linesOf(diffBookingPricing(before, after, 1000));

    expect(renderModificationLineDescription(lines[0]!)).toBe(
      "Promotion SUMMER25 reduced by $10.00",
    );
  });

  it("INV-MOD-028: any unpriced night on either side yields no lines", () => {
    const beforeNull = side([guest("a", { nights: [{ stayDate: day("2026-08-14"), priceCents: null, priceSource: "UNKNOWN" }] })]);
    expect(diffBookingPricing(beforeNull, side([]), -0)).toEqual({ kind: "none", reason: "UNPRICED_NIGHT" });

    const afterNull = side([{ ...guest("a"), nights: [{ stayDate: day("2026-08-14"), priceCents: null }] }]);
    expect(diffBookingPricing(side([]), afterNull, 0)).toEqual({ kind: "none", reason: "UNPRICED_NIGHT" });
  });

  it("a before-night whose stored price is not exact provenance yields no lines", () => {
    // An EVEN_SPLIT row sums to the strand's total but was never THIS night's
    // price; diffing it against an exactly-priced after set would print a
    // reprice that never happened.
    const before = side([guest("a", { nights: nights("2026-08-14", [8000, 8000], "EVEN_SPLIT") })]);
    const after = side([{ ...guest("a"), nights: afterNights("2026-08-14", [7000, 9000]) }]);

    expect(diffBookingPricing(before, after, 0)).toEqual({
      kind: "none",
      reason: "INEXACT_STORED_NIGHT_PRICE",
    });
  });

  it("an inexact before-night that CANCELS needs no provenance; one that leaves a line does (#3531 3a)", () => {
    // Guest a is untouched with EVEN_SPLIT rows (kept at the same price and
    // category, so no line names them); guest b is removed with SOLD rows.
    const before = side([
      guest("a", { nights: nights("2026-08-14", [8000, 8000], "EVEN_SPLIT") }),
      guest("b"),
    ]);
    const after = side([{ ...guest("a"), nights: afterNights("2026-08-14", [8000, 8000]) }]);
    const lines = linesOf(diffBookingPricing(before, after, -16000));
    expect(lines.map((line) => renderModificationLineDescription(line))).toEqual([
      "1 x Non-member Adult removed - 2 nights - 14 Aug 2026 - 16 Aug 2026",
    ]);
    // The same untouched guest, but this time its nights are the ones going:
    // the line would name an even-split figure as a sold price, so no lines.
    expect(
      diffBookingPricing(
        side([guest("a", { nights: nights("2026-08-14", [8000, 8000], "EVEN_SPLIT") })]),
        side([]),
        -16000,
      ),
    ).toEqual({ kind: "none", reason: "INEXACT_STORED_NIGHT_PRICE" });
  });

  it("POSTCONDITION: lines that do not sum to the caller's delta are not returned", () => {
    const before = side([guest("a", { nights: nights("2026-08-14", [8000]) })]);
    const after = side([{ ...guest("a"), nights: afterNights("2026-08-14", [8000]) }, { ...guest("b"), nights: afterNights("2026-08-14", [8000]) }]);

    // The caller believes the delta is $79.99; the nights say $80.00.
    expect(diffBookingPricing(before, after, 7999)).toEqual({
      kind: "none",
      reason: "SUM_MISMATCH",
      linesSumCents: 8000,
    });
  });

  it("MUTATION: the fold never merges an add with a remove of the same shape", () => {
    // A batch edit that swaps one non-member adult for another on the same
    // nights at the same price: two guests, two lines, net zero, both kept.
    const before = side([guest("a", { nights: nights("2026-08-14", [8000]) })]);
    const after = side([{ ...guest("b"), nights: afterNights("2026-08-14", [8000]) }]);

    const lines = linesOf(diffBookingPricing(before, after, 0));

    expect(lines.map((line) => line.sign)).toEqual([-1, 1]);
  });

  it("an edit that moves no money stores an empty list, which the parser reads as no itemisation", () => {
    const before = side([guest("a")]);
    const after = side([{ ...guest("a"), nights: afterNights("2026-08-14", [8000, 8000]) }]);

    const result = diffBookingPricing(before, after, 0);

    expect(result).toEqual({ kind: "lines", lines: [] });
    expect(parseModificationLines([])).toBeNull();
  });
});

describe("parseModificationLines", () => {
  const good: ModificationLine = {
    v: 1,
    kind: "GUEST_NIGHTS",
    sign: -1,
    ageTier: "YOUTH",
    isMember: true,
    rateMembershipTypeId: "rate-member",
    unitCents: 4500,
    nightCount: 2,
    guestCount: 1,
    quantity: 2,
    startDate: "2026-08-14",
    endExclusive: "2026-08-16",
    guestNames: ["Sam Guest"],
    amountCents: -9000,
  };

  it("round-trips what the builder writes", () => {
    expect(parseModificationLines([good])).toEqual([good]);
  });

  it("reads a legacy NULL, an empty array, a foreign version and a half-readable array all as null", () => {
    expect(parseModificationLines(null)).toBeNull();
    expect(parseModificationLines(undefined)).toBeNull();
    expect(parseModificationLines([])).toBeNull();
    expect(parseModificationLines([{ ...good, v: 2 }])).toBeNull();
    expect(parseModificationLines([good, { kind: "GUEST_NIGHTS" }])).toBeNull();
  });

  it("refuses a line whose money does not equal sign x unit x quantity", () => {
    expect(parseModificationLines([{ ...good, amountCents: -8999 }])).toBeNull();
  });
});

describe("the sentences (for the owner's eye)", () => {
  it("prints every shape once", () => {
    const before = side(
      [
        guest("a", { nights: nights("2026-08-14", [8000, 8000]) }),
        guest("b", { nights: nights("2026-08-14", [8000, 8000]) }),
        guest("c", { ageTier: "YOUTH", isMember: true, rateMembershipTypeId: "rate-member", nights: nights("2026-08-14", [4500, 4500]) }),
      ],
      -1000,
      "SUMMER25",
    );
    const after = side(
      [
        { ...guest("c"), ageTier: "YOUTH", isMember: true, rateMembershipTypeId: "rate-member", nights: afterNights("2026-08-15", [4500, 4500]) },
        { ...guest("d"), nights: afterNights("2026-08-15", [8000]) },
      ],
      0,
      null,
    );
    const lines = linesOf(
      diffBookingPricing(before, after, -32000 + -4500 + 4500 + 8000 + 1000),
    );
    const rendered = lines.map((line) => renderModificationLineWithAmount(line));
    console.info(["", "Rendered modification lines:", ...rendered.map((l) => `  ${l}`)].join("\n"));
    // Removals first, then additions; within each, by start date, members
    // before non-members; the promotion last.
    expect(rendered).toEqual([
      "1 x Member Youth removed - 1 night - 14 Aug 2026 - 15 Aug 2026 (-$45.00)",
      "2 x Non-member Adult removed - 2 nights - 14 Aug 2026 - 16 Aug 2026 (-$320.00)",
      "1 x Non-member Adult added - 1 night - 15 Aug 2026 - 16 Aug 2026 (+$80.00)",
      "1 x Member Youth added - 1 night - 16 Aug 2026 - 17 Aug 2026 (+$45.00)",
      "Promotion SUMMER25 reduced by $10.00 (+$10.00)",
    ]);
  });
});

describe("the member word follows the rate snapshot (#2543), as on the invoice line", () => {
  const lockedOutMember: ModificationLine = {
    v: 1,
    kind: "GUEST_NIGHTS",
    sign: 1,
    ageTier: "ADULT",
    isMember: true,
    rateMembershipTypeId: "type-non-member",
    unitCents: 8000,
    nightCount: 1,
    guestCount: 1,
    quantity: 1,
    startDate: "2026-08-14",
    endExclusive: "2026-08-15",
    guestNames: ["Guest a"],
    amountCents: 8000,
  };

  it("says Non-member for a member priced at the non-member rate when the club's type is known", () => {
    expect(
      renderModificationLineDescription(lockedOutMember, { nonMemberTypeId: "type-non-member" }),
    ).toBe("1 x Non-member Adult added - 1 night - 14 Aug 2026 - 15 Aug 2026");
  });

  it("falls back to isMember with no resolver, exactly as a legacy invoice line does", () => {
    expect(renderModificationLineDescription(lockedOutMember)).toBe(
      "1 x Member Adult added - 1 night - 14 Aug 2026 - 15 Aug 2026",
    );
    expect(renderModificationLineDescription(lockedOutMember, { nonMemberTypeId: null })).toBe(
      "1 x Member Adult added - 1 night - 14 Aug 2026 - 15 Aug 2026",
    );
  });

  it("puts the same words and signed money on the audit row", () => {
    expect(modificationLinesAuditFields([lockedOutMember], { nonMemberTypeId: "type-non-member" })).toEqual({
      priceLines: [lockedOutMember],
      priceLinesText: ["1 x Non-member Adult added - 1 night - 14 Aug 2026 - 15 Aug 2026 (+$80.00)"],
    });
    expect(modificationLinesAuditFields(null, null)).toEqual({});
    expect(modificationLinesAuditFields([], null)).toEqual({});
  });

  it("loads the club's NON_MEMBER type only when there are lines, and narrates without it when the read fails", async () => {
    const findFirst = vi.fn(async () => ({ id: "type-non-member" }));
    const db = { membershipType: { findFirst } } as unknown as Parameters<
      typeof loadModificationLinesAuditFields
    >[0];
    const log = { warn: vi.fn() };

    expect(await loadModificationLinesAuditFields(db, null, log)).toEqual({});
    expect(findFirst).not.toHaveBeenCalled();

    const fields = await loadModificationLinesAuditFields(db, [lockedOutMember], log);
    expect(findFirst).toHaveBeenCalledWith({ where: { key: "NON_MEMBER" }, select: { id: true } });
    expect(fields).toMatchObject({
      priceLinesText: ["1 x Non-member Adult added - 1 night - 14 Aug 2026 - 15 Aug 2026 (+$80.00)"],
    });
    expect(log.warn).not.toHaveBeenCalled();

    findFirst.mockRejectedValueOnce(new Error("connection reset"));
    const fallback = await loadModificationLinesAuditFields(db, [lockedOutMember], log);
    expect(fallback).toMatchObject({
      priceLinesText: ["1 x Member Adult added - 1 night - 14 Aug 2026 - 15 Aug 2026 (+$80.00)"],
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

describe("computeModificationPriceLines never fails the edit", () => {
  const context = { bookingId: "booking-1", site: "test" };

  it("stores NULL and logs when the diff says none", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    await expect(
      computeModificationPriceLines(
        context,
        () => ({ kind: "none", reason: "SUM_MISMATCH", linesSumCents: 100 }),
        log,
      ),
    ).resolves.toBeNull();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "booking-1", site: "test", reason: "SUM_MISMATCH", linesSumCents: 100 }),
      expect.any(String),
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it("stores NULL and logs when the builder throws - synchronously or from its await", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    await expect(
      computeModificationPriceLines(
        context,
        () => {
          throw new Error("undefined is not iterable");
        },
        log,
      ),
    ).resolves.toBeNull();
    await expect(
      computeModificationPriceLines(context, async () => Promise.reject(new Error("re-read failed")), log),
    ).resolves.toBeNull();
    expect(log.error).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenLastCalledWith(
      expect.objectContaining({ bookingId: "booking-1", site: "test", err: expect.any(Error) }),
      expect.any(String),
    );
  });

  it("returns the lines when the diff has them", async () => {
    const before = side([guest("a")]);
    const after = side([
      { ...guest("a"), nights: afterNights("2026-08-14", [8000, 8000]) },
      { ...guest("b"), nights: afterNights("2026-08-14", [8000]) },
    ]);
    const log = { info: vi.fn(), error: vi.fn() };
    const lines = await computeModificationPriceLines(
      context,
      async () => diffBookingPricing(before, after, 8000),
      log,
    );
    expect(lines).toHaveLength(1);
    expect(sumModificationLines(lines ?? [])).toBe(8000);
    expect(log.info).not.toHaveBeenCalled();
  });
});
