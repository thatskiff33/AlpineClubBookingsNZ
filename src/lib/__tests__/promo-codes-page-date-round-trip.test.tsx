// @vitest-environment jsdom

/**
 * The promo-code window edges survive a trip through the edit form, in a club
 * WEST of UTC (#2872, CT-3; INV-DATE-010, INV-DATE-026).
 *
 * WHY THE ZONE IS THE WHOLE TEST. `PromoCode.validFrom`, `validUntil`,
 * `bookingStartFrom` and `bookingStartUntil` are `@db.Date`: each holds a
 * calendar day, encoded as UTC midnight, and reaches this screen as the string
 * that encoding serialises to (`"2026-09-30T00:00:00.000Z"`). The screen used to
 * seed its `<input type="date">` boxes by PROJECTING that value into the club's
 * zone. For New Zealand, which sits ahead of UTC, the projection lands on the
 * same day and the bug is invisible — which is exactly why it survived review.
 * For a club behind UTC it reads back the PREVIOUS day.
 *
 * AND THIS FORM WRITES BACK. The four boxes are submitted verbatim, so an admin
 * who opened the dialog to fix a typo in the description saved the window a day
 * short, and every subsequent edit walked it back another day. These columns
 * gate a discount against `Booking.checkIn`, so the day decides what a member is
 * charged.
 *
 * So the config module is mocked to `America/Denver` (UTC-6, and UTC-7 in
 * winter) for this file only. Against the fixed code the assertions below hold
 * because nothing consults a zone at all; against the projection they fail by
 * exactly one day, which is the discrimination this file exists to provide. The
 * sibling file `promo-codes-page.test.tsx` covers the rest of this screen in the
 * default zone and is deliberately left alone.
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  emptyAdminPermissionMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

// A club west of Greenwich. Everything the real module exports is restated, so
// an import this screen picks up later cannot resolve to `undefined`.
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "America/Denver",
  APP_LOCALE: "en-NZ",
}));

vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({
    lodges: [{ id: "lodge-1", name: "Lodge One" }],
    loading: false,
    failed: false,
    forbidden: false,
    reload: vi.fn(),
  }),
}));

import { PromoCodesPageClient } from "@/app/(admin)/admin/promo-codes/promo-codes-page-client";

/** The four days as a club actually stores them, and as the API serialises them. */
const STORED = {
  validFrom: "2026-04-01",
  validUntil: "2026-09-30",
  bookingStartFrom: "2026-06-01",
  bookingStartUntil: "2026-08-31",
};

/** One promo code carrying all four window edges, in the `@db.Date` wire shape. */
const promo = {
  id: "promo-1",
  code: "WESTOFUTC",
  description: "A code with a full window",
  type: "PERCENTAGE" as const,
  valueCents: null,
  percentOff: 10,
  freeNightsPerIndividual: null,
  lifetimeFreeNightsCap: null,
  fixedNightlyPriceCents: null,
  fixedNightlyMode: null,
  maxNightlyValueCents: null,
  maxGuestsPerBooking: null,
  maxRedemptionsTotal: null,
  maxUniqueMembersTotal: null,
  maxUsesPerMember: null,
  currentRedemptions: 0,
  validFrom: `${STORED.validFrom}T00:00:00.000Z`,
  validUntil: `${STORED.validUntil}T00:00:00.000Z`,
  bookingStartFrom: `${STORED.bookingStartFrom}T00:00:00.000Z`,
  bookingStartUntil: `${STORED.bookingStartUntil}T00:00:00.000Z`,
  membersOnly: false,
  memberGuestsOnly: false,
  assignedMembersOnlyOwnNights: true,
  xeroItemCode: null,
  xeroAccountCode: null,
  active: true,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  redemptions: [],
  totalRedemptionCount: 0,
  benefitFreeRedemptionCount: 0,
  assignments: [],
  lodgeIds: [],
};

function matrix(
  overrides: Partial<AdminPermissionMatrix>,
): AdminPermissionMatrix {
  return { ...emptyAdminPermissionMatrix(), ...overrides };
}

function stubFetch() {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("archived=true")) {
      return { ok: true, status: 200, json: async () => [] };
    }
    if (url.includes("/api/admin/promo-codes")) {
      return { ok: true, status: 200, json: async () => [promo] };
    }
    return { ok: true, status: 200, json: async () => [] };
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
}

function dateInputValue(id: string): string {
  const element = document.getElementById(id);
  expect(element, `no <input type="date"> with id ${id}`).not.toBeNull();
  return (element as HTMLInputElement).value;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("promo window edges in a club west of UTC (#2872, INV-DATE-026)", () => {
  it("seeds every date box with the day that is STORED, not the club-zone reading of it", async () => {
    stubFetch();
    render(
      <PromoCodesPageClient permissionMatrix={matrix({ bookings: "edit" })} />,
    );

    const editButton = await screen.findByRole("button", { name: "Edit" });
    fireEvent.click(editButton);

    await waitFor(() => {
      expect(dateInputValue("validFrom")).not.toBe("");
    });

    // Each of the four, named individually so a failure says WHICH edge moved.
    expect(
      dateInputValue("validFrom"),
      "INV-DATE-026: `validFrom` is `@db.Date`. Reading it through the club " +
        "zone puts a club behind UTC a day early, and this form writes the box " +
        "back, so the stored window walks backwards one edit at a time.",
    ).toBe(STORED.validFrom);
    expect(dateInputValue("validUntil")).toBe(STORED.validUntil);
    expect(dateInputValue("bookingStartFrom")).toBe(STORED.bookingStartFrom);
    expect(dateInputValue("bookingStartUntil")).toBe(STORED.bookingStartUntil);
  });

  it("shows the stored day in the read-only summary too", async () => {
    stubFetch();
    render(
      <PromoCodesPageClient permissionMatrix={matrix({ bookings: "edit" })} />,
    );

    // "1 Apr 2026 - 30 Sept 2026" — the house medium shape (en-NZ abbreviates
    // September to "Sept"), over the DAY rather than over a projection of it. A
    // club-zone reading west of UTC would render 31 Mar and 29 Sept here.
    const summary = await screen.findByText(/Apr 2026/);
    expect(summary.textContent).toContain("1 Apr 2026");
    expect(summary.textContent).toContain("30 Sept 2026");
  });
});
