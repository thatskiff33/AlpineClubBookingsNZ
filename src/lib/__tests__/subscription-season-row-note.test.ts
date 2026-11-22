import { describe, expect, it } from "vitest";

import type { AgeTierSettingData } from "@/lib/policies/age-tier";
import {
  NOT_CHOSEN_LIABILITY_SETTINGS,
  type SubscriptionLiabilitySettings,
} from "@/lib/policies/subscription";
import {
  hasNotRequiredRowBillingNote,
  isUntouchedNotRequiredRow,
  NOT_REQUIRED_ROW_BILLING_NOTE,
  notRequiredRowBillingNote,
  SEASON_ROW_STATE_SELECT,
  UNTOUCHED_NOT_REQUIRED_ROW,
} from "@/lib/subscription-season-row-note";

// #5190 (owner decision 22 Nov 2026, issue comment 7070827526): the admin
// lists' note on a saved NOT_REQUIRED row whose member billing treats as owing.

const ageTierSettings: AgeTierSettingData[] = [
  { tier: "CHILD", label: "Child", minAge: 0, maxAge: 17, sortOrder: 0, subscriptionRequiredForBooking: false },
  { tier: "ADULT", label: "Adult", minAge: 18, maxAge: null, sortOrder: 1, subscriptionRequiredForBooking: true },
] as AgeTierSettingData[];

const untouched = {
  status: "NOT_REQUIRED" as const,
  xeroInvoiceId: null,
  manuallyMarkedPaidAt: null,
  chargeCoverage: [],
};

function note(opts: {
  subscriptionBehavior: "REQUIRED" | "BASED_ON_AGE_TIER" | "NOT_REQUIRED";
  ageTier: "CHILD" | "ADULT";
  seasonRow?: typeof untouched | null;
  liabilitySettings?: SubscriptionLiabilitySettings;
  active?: boolean;
  archivedAt?: Date | null;
}) {
  return hasNotRequiredRowBillingNote({
    subscriptionBehavior: opts.subscriptionBehavior,
    member: {
      dateOfBirth: null,
      ageTier: opts.ageTier,
      active: opts.active ?? true,
      archivedAt: opts.archivedAt ?? null,
    },
    seasonRow: opts.seasonRow === undefined ? untouched : opts.seasonRow,
    seasonYear: 2026,
    ageTierSettings,
    liabilitySettings: opts.liabilitySettings ?? NOT_CHOSEN_LIABILITY_SETTINGS,
  });
}

describe("isUntouchedNotRequiredRow", () => {
  it("is the UNTOUCHED_NOT_REQUIRED_ROW guard over a row already read", () => {
    expect(UNTOUCHED_NOT_REQUIRED_ROW).toEqual({
      status: "NOT_REQUIRED",
      xeroInvoiceId: null,
      manuallyMarkedPaidAt: null,
      chargeCoverage: { none: { releasedAt: null } },
    });
    expect(SEASON_ROW_STATE_SELECT.chargeCoverage.where).toEqual({ releasedAt: null });
    expect(isUntouchedNotRequiredRow(untouched)).toBe(true);
  });

  it("fails on each guard alone", () => {
    expect(isUntouchedNotRequiredRow({ ...untouched, status: "NOT_INVOICED" })).toBe(false);
    expect(isUntouchedNotRequiredRow({ ...untouched, xeroInvoiceId: "inv-1" })).toBe(false);
    expect(isUntouchedNotRequiredRow({ ...untouched, manuallyMarkedPaidAt: new Date(0) })).toBe(false);
    expect(isUntouchedNotRequiredRow({ ...untouched, chargeCoverage: [{ id: "c" }] })).toBe(false);
    expect(isUntouchedNotRequiredRow(null)).toBe(false);
  });

  it("fails safe on a row read without the claim select", () => {
    expect(
      isUntouchedNotRequiredRow({ ...untouched, chargeCoverage: undefined as never }),
    ).toBe(false);
  });
});

describe("hasNotRequiredRowBillingNote", () => {
  it("edge 1: a REQUIRED-type member on an exempt tier with a saved row gets the note", () => {
    expect(note({ subscriptionBehavior: "REQUIRED", ageTier: "CHILD" })).toBe(true);
  });

  it("edge 2: an age-based member on a liable tier with a saved row gets the note", () => {
    expect(note({ subscriptionBehavior: "BASED_ON_AGE_TIER", ageTier: "ADULT" })).toBe(true);
  });

  it("no note where billing agrees the member owes nothing", () => {
    expect(note({ subscriptionBehavior: "BASED_ON_AGE_TIER", ageTier: "CHILD" })).toBe(false);
    expect(note({ subscriptionBehavior: "NOT_REQUIRED", ageTier: "ADULT" })).toBe(false);
  });

  it("no note without a saved NOT_REQUIRED row", () => {
    expect(note({ subscriptionBehavior: "REQUIRED", ageTier: "CHILD", seasonRow: null })).toBe(false);
    expect(
      note({
        subscriptionBehavior: "REQUIRED",
        ageTier: "ADULT",
        seasonRow: { ...untouched, status: "NOT_INVOICED" } as never,
      }),
    ).toBe(false);
  });

  it("no note outside the billing population (inactive or archived)", () => {
    expect(note({ subscriptionBehavior: "REQUIRED", ageTier: "CHILD", active: false })).toBe(false);
    expect(
      note({ subscriptionBehavior: "REQUIRED", ageTier: "CHILD", archivedAt: new Date("2026-05-01") }),
    ).toBe(false);
  });

  it("a chosen rule under which the member still owes keeps the note (a row the clear-up did not reach)", () => {
    expect(
      note({
        subscriptionBehavior: "BASED_ON_AGE_TIER",
        ageTier: "ADULT",
        liabilitySettings: { requiredTypeAgeRule: "ALWAYS_OWES", liabilityAgeSource: "SEASON_START" },
      }),
    ).toBe(true);
  });

  it("no note once a rule is chosen and the member stops owing", () => {
    expect(
      note({
        subscriptionBehavior: "REQUIRED",
        ageTier: "CHILD",
        liabilitySettings: {
          requiredTypeAgeRule: "AGE_TIER_EXEMPTS",
          liabilityAgeSource: "SEASON_START",
        },
      }),
    ).toBe(false);
  });

  it("returns the note wording", () => {
    expect(NOT_REQUIRED_ROW_BILLING_NOTE).toBe(
      "Marked not required, but billing treats this member as owing",
    );
    expect(
      notRequiredRowBillingNote({
        subscriptionBehavior: "REQUIRED",
        member: { dateOfBirth: null, ageTier: "CHILD", active: true, archivedAt: null },
        seasonRow: untouched,
        seasonYear: 2026,
        ageTierSettings,
        liabilitySettings: NOT_CHOSEN_LIABILITY_SETTINGS,
      }),
    ).toBe(NOT_REQUIRED_ROW_BILLING_NOTE);
  });
});
