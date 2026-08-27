import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  joiningFeeFindFirst: vi.fn(),
  itemMappingFindFirst: vi.fn(),
  accountMappingFindUnique: vi.fn(),
  membershipAnnualFeeFindFirst: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    joiningFee: { findFirst: mocks.joiningFeeFindFirst },
    xeroItemCodeMapping: { findFirst: mocks.itemMappingFindFirst },
    xeroAccountMapping: { findUnique: mocks.accountMappingFindUnique },
    membershipAnnualFee: { findFirst: mocks.membershipAnnualFeeFindFirst },
  },
}));

import {
  FeeScheduleValidationError,
  getEffectiveJoiningFee,
  getEffectiveMembershipAnnualFee,
  scheduleOverlapWhere,
  validateFeeScheduleInput,
} from "@/lib/authoritative-fees";

/**
 * The club's day, supplied explicitly (#3123). `asOf` used to default to the
 * environment's day inside `authoritative-fees.ts`, which for a club configured
 * behind its container selected a fee schedule row a day before it took effect.
 */
const CLUB_TODAY = new Date("2026-07-01T00:00:00.000Z");

describe("authoritative fee schedules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.joiningFeeFindFirst.mockResolvedValue(null);
    mocks.itemMappingFindFirst.mockResolvedValue(null);
    mocks.accountMappingFindUnique.mockResolvedValue(null);
    mocks.membershipAnnualFeeFindFirst.mockResolvedValue(null);
  });

  it("accepts inclusive single-day boundaries and preserves integer cents", () => {
    const result = validateFeeScheduleInput({
      amountCents: 12345,
      effectiveFrom: "2026-07-13",
      effectiveTo: "2026-07-13",
    });
    expect(result.amountCents).toBe(12345);
    expect(result.effectiveFrom.toISOString()).toContain("2026-07-13");
    expect(result.effectiveTo?.toISOString()).toContain("2026-07-13");
  });

  it.each([
    [{ amountCents: 12.5, effectiveFrom: "2026-07-13" }, "integer"],
    [{ amountCents: -1, effectiveFrom: "2026-07-13" }, "non-negative"],
    [{ amountCents: 0, effectiveFrom: "2026-02-30" }, "valid YYYY-MM-DD"],
    [{ amountCents: 0, effectiveFrom: "2026-07-14", effectiveTo: "2026-07-13" }, "cannot be before"],
    [{ amountCents: 1, effectiveFrom: "2026-07-13", billingBasis: "NO_INVOICE" as const }, "zero-cent"],
  ])("rejects invalid money and date input", (input, message) => {
    expect(() => validateFeeScheduleInput(input)).toThrow(message);
  });

  it("builds an inclusive overlap predicate and excludes the edited row", () => {
    const from = new Date("2026-07-01T00:00:00.000Z");
    const to = new Date("2026-07-31T00:00:00.000Z");
    expect(scheduleOverlapWhere({ effectiveFrom: from, effectiveTo: to, excludeId: "fee-1" })).toEqual({
      id: { not: "fee-1" },
      effectiveFrom: { lte: to },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }],
    });
  });

  it("resolves the age-tier joining fee row first (no legacy fallback)", async () => {
    mocks.joiningFeeFindFirst.mockResolvedValueOnce({ amountCents: 8800, effectiveFrom: new Date("2026-01-01") });
    await expect(
      getEffectiveJoiningFee({ membershipTypeId: "type-full", ageTier: "ADULT" }, new Date("2026-07-13T00:00:00.000Z")),
    ).resolves.toEqual({ amountCents: 8800, effectiveFrom: "2026-01-01", source: "SCHEDULE" });
    // Age-tier hit means the flat fallback query never runs, and no deprecated
    // mapping/account table is consulted.
    expect(mocks.joiningFeeFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.itemMappingFindFirst).not.toHaveBeenCalled();
    expect(mocks.accountMappingFindUnique).not.toHaveBeenCalled();
  });

  it("resolves the flat NULL-tier membership fee on inclusive effective boundaries", async () => {
    const asOf = new Date("2026-07-13T00:00:00.000Z");
    mocks.membershipAnnualFeeFindFirst.mockResolvedValue({ id: "mf-1", amountCents: 10000 });
    await expect(getEffectiveMembershipAnnualFee({ membershipTypeId: "full", ageTier: null }, asOf))
      .resolves.toMatchObject({ id: "mf-1" });
    // A null tier reads the flat NULL-tier row directly (byte-identical to the
    // pre-#2067 single-query behaviour for every all-flat config).
    expect(mocks.membershipAnnualFeeFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.membershipAnnualFeeFindFirst).toHaveBeenCalledWith({
      where: {
        membershipTypeId: "full",
        ageTier: null,
        effectiveFrom: { lte: asOf },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: asOf } }],
      },
      orderBy: { effectiveFrom: "desc" },
      // Components are the invoice lines (#1932, E6), resolved in stable order.
      include: { components: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] } },
    });
  });

  it("prefers the exact age-tier annual fee row over the flat row (#2067)", async () => {
    const asOf = new Date("2026-07-13T00:00:00.000Z");
    mocks.membershipAnnualFeeFindFirst.mockResolvedValueOnce({ id: "mf-adult", amountCents: 15000 });
    await expect(getEffectiveMembershipAnnualFee({ membershipTypeId: "full", ageTier: "ADULT" }, asOf))
      .resolves.toMatchObject({ id: "mf-adult" });
    // Exact-tier hit means the flat fallback query never runs.
    expect(mocks.membershipAnnualFeeFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.membershipAnnualFeeFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ membershipTypeId: "full", ageTier: "ADULT" }),
    }));
  });

  it("falls back to the flat annual fee row when the tier has none (#2067)", async () => {
    const asOf = new Date("2026-07-13T00:00:00.000Z");
    mocks.membershipAnnualFeeFindFirst
      .mockResolvedValueOnce(null) // no YOUTH row
      .mockResolvedValueOnce({ id: "mf-flat", amountCents: 12000 }); // flat fallback
    await expect(getEffectiveMembershipAnnualFee({ membershipTypeId: "full", ageTier: "YOUTH" }, asOf))
      .resolves.toMatchObject({ id: "mf-flat" });
    expect(mocks.membershipAnnualFeeFindFirst).toHaveBeenCalledTimes(2);
    expect(mocks.membershipAnnualFeeFindFirst).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ membershipTypeId: "full", ageTier: null }),
    }));
  });

  it("resolves NOT_APPLICABLE annual fee directly to the flat row, skipping any tier lookup (#2067)", async () => {
    const asOf = new Date("2026-07-13T00:00:00.000Z");
    mocks.membershipAnnualFeeFindFirst.mockResolvedValueOnce({ id: "mf-flat", amountCents: 9000 });
    await expect(getEffectiveMembershipAnnualFee({ membershipTypeId: "school", ageTier: "NOT_APPLICABLE" }, asOf))
      .resolves.toMatchObject({ id: "mf-flat" });
    // Only the flat lookup runs (no NOT_APPLICABLE tier rows are ever offered).
    expect(mocks.membershipAnnualFeeFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.membershipAnnualFeeFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ membershipTypeId: "school", ageTier: null }),
    }));
  });

  it("returns null when neither a tier row nor a flat annual fee row exists (#2067)", async () => {
    mocks.membershipAnnualFeeFindFirst.mockResolvedValue(null);
    await expect(
      // #3123 - `asOf` is required now; the club day is stated rather than
      // defaulted from the environment.
      getEffectiveMembershipAnnualFee({ membershipTypeId: "full", ageTier: "ADULT" }, CLUB_TODAY),
    ).resolves.toBeNull();
    expect(mocks.membershipAnnualFeeFindFirst).toHaveBeenCalledTimes(2);
  });

  it("falls back to the flat NULL-tier row (Family type), then to NONE", async () => {
    // No age-tier row, but a flat NULL-tier row exists (the Family flat fee).
    mocks.joiningFeeFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ amountCents: 20000, effectiveFrom: new Date("2026-02-01") });
    await expect(
      getEffectiveJoiningFee({ membershipTypeId: "type-family", ageTier: "ADULT" }, CLUB_TODAY),
    ).resolves.toEqual({ amountCents: 20000, effectiveFrom: "2026-02-01", source: "SCHEDULE" });

    // Nothing configured -> NONE (no legacy fallback).
    mocks.joiningFeeFindFirst.mockResolvedValue(null);
    await expect(
      getEffectiveJoiningFee({ membershipTypeId: "type-school", ageTier: "ADULT" }, CLUB_TODAY),
    ).resolves.toEqual({ amountCents: null, effectiveFrom: null, source: "NONE" });
  });

  it("exposes the validation error status for API conflict handling", () => {
    expect(new FeeScheduleValidationError("overlap", 409).status).toBe(409);
  });
});
