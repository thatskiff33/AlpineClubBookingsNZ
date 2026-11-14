/**
 * THE HAND-MIRRORED VOCABULARIES CANNOT DRIFT (#2816, review finding 13 Aug 2026).
 *
 * Two admin list pages publish the filter state they APPLIED, and a page can only
 * know whether a value was applied by holding the vocabulary its own query uses.
 * Both vocabularies live server-side behind Prisma imports, so both are mirrored as
 * literals in client-safe modules — the same technique
 * `page-context/registry.ts` uses for `BookingStatus` and `PaymentStatus`, and the
 * same technique needs the same guard: a literal nobody checks is a literal that
 * rots, and the consequence here is a filter reported as applied when it narrowed
 * nothing.
 */

import { AgeTier, PaymentStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  MEMBER_AGE_TIER_FILTER_LABELS,
  MEMBER_AGE_TIER_FILTER_VALUES,
  isAppliedMemberAgeTier,
} from "@/app/(admin)/admin/membership/members/_age-tier-filter-values";
import {
  APPLIED_PAYMENT_STATUS_VALUES,
  APPLIED_PAYMENTS_SEARCH_MAX_CHARS,
  isAppliedPaymentStatus,
  isAppliedPaymentsDate,
  isAppliedPaymentsSearch,
} from "@/app/(admin)/admin/finance/payments/_applied-query-vocabulary";
import { adminPaymentsQuerySchema } from "@/lib/admin-payments-service";
import { AGE_TIER_VALUES } from "@/lib/age-tier-schema";
import { DIAGNOSTICS_PAGE_CONTEXT_BOUNDS } from "@/lib/diagnostics/page-context/types";

describe("the members list's age-tier vocabulary", () => {
  it("is exactly the shared validator's, which is exactly the Prisma enum", () => {
    expect([...MEMBER_AGE_TIER_FILTER_VALUES].sort()).toEqual(
      [...AGE_TIER_VALUES].sort(),
    );
    expect([...MEMBER_AGE_TIER_FILTER_VALUES].sort()).toEqual(
      Object.values(AgeTier).sort(),
    );
  });

  it("labels every value, so a new tier cannot ship unlabelled", () => {
    for (const tier of MEMBER_AGE_TIER_FILTER_VALUES) {
      expect(MEMBER_AGE_TIER_FILTER_LABELS[tier]).toBeTruthy();
    }
  });

  it("rejects a tier `buildMembersWhere` would silently ignore", () => {
    // The members service applies `ageTier` only when it is in `AGE_TIER_VALUES`,
    // and otherwise ignores it with no 400 at all — so this is the whole
    // difference between "narrowed" and "published a narrowing that never
    // happened".
    expect(isAppliedMemberAgeTier("ADULT")).toBe(true);
    expect(isAppliedMemberAgeTier("adult")).toBe(false);
    expect(isAppliedMemberAgeTier("GROWN_UPS")).toBe(false);
    expect(isAppliedMemberAgeTier("x".repeat(120))).toBe(false);
  });
});

describe("the payments list's applied-query vocabulary", () => {
  it("is exactly the Prisma `PaymentStatus` enum", () => {
    expect([...APPLIED_PAYMENT_STATUS_VALUES].sort()).toEqual(
      Object.values(PaymentStatus).sort(),
    );
  });

  it("accepts exactly what the strict server schema accepts", () => {
    // The schema's parse is TOTAL: one refused value 400s the whole query and
    // `fetchData` keeps the previous rows on screen.
    for (const status of APPLIED_PAYMENT_STATUS_VALUES) {
      expect(adminPaymentsQuerySchema.safeParse({ status }).success).toBe(true);
      expect(isAppliedPaymentStatus(status)).toBe(true);
    }
    for (const rejected of ["succeeded", "SUCCESS", "", "all-of-them"]) {
      expect(adminPaymentsQuerySchema.safeParse({ status: rejected }).success).toBe(
        false,
      );
      expect(isAppliedPaymentStatus(rejected)).toBe(false);
    }
  });

  it("mirrors the schema's LENGTH bound on `search`, which the first cut omitted", () => {
    // `search: z.string().trim().max(100)`. It is applied on every keystroke — no
    // debounce, no submit — so the 101st character 400s the whole query and the
    // rows on screen belong to the last request that succeeded. Publishing that
    // value as applied reported a narrowing the API refused (review, 14 Aug 2026).
    const exact = "n".repeat(APPLIED_PAYMENTS_SEARCH_MAX_CHARS);
    expect(adminPaymentsQuerySchema.safeParse({ search: exact }).success).toBe(
      true,
    );
    expect(isAppliedPaymentsSearch(exact)).toBe(true);

    const tooLong = `${exact}n`;
    expect(adminPaymentsQuerySchema.safeParse({ search: tooLong }).success).toBe(
      false,
    );
    expect(isAppliedPaymentsSearch(tooLong)).toBe(false);

    // The schema TRIMS before it measures, so the mirror has to as well: this is
    // 100 characters of search inside 120 characters of string.
    const padded = `          ${exact}          `;
    expect(adminPaymentsQuerySchema.safeParse({ search: padded }).success).toBe(
      true,
    );
    expect(isAppliedPaymentsSearch(padded)).toBe(true);

    // And an empty or whitespace-only search narrowed nothing at all.
    for (const blank of ["", "   "]) {
      expect(isAppliedPaymentsSearch(blank)).toBe(false);
    }
  });

  it("stays inside the bound the ask route will actually carry", () => {
    // Belt and braces on the two bounds meeting: the API's 100 is the tighter of
    // the two, so a search the API accepts is always one the route carries. If a
    // future edit loosened the API past `filterValueMaxChars`, the page would
    // publish values the route silently drops.
    expect(APPLIED_PAYMENTS_SEARCH_MAX_CHARS).toBeLessThanOrEqual(
      DIAGNOSTICS_PAGE_CONTEXT_BOUNDS.filterValueMaxChars,
    );
  });

  it("agrees with the schema about which date strings are applied", () => {
    for (const date of ["2026-08-01", "2026-13-45"]) {
      // Both accept a well-shaped string without a calendar check — mirroring
      // the schema means mirroring that too, not improving on it.
      expect(
        adminPaymentsQuerySchema.safeParse({ lastUpdatedFrom: date }).success,
      ).toBe(true);
      expect(isAppliedPaymentsDate(date)).toBe(true);
    }
    for (const date of ["13-45-2026", "2026-8-1", "", "2026-08-01T00:00:00Z"]) {
      expect(
        adminPaymentsQuerySchema.safeParse({ lastUpdatedFrom: date }).success,
      ).toBe(false);
      expect(isAppliedPaymentsDate(date)).toBe(false);
    }
  });
});
