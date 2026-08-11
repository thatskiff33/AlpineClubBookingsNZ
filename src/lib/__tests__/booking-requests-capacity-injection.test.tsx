// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// R1 (#1982) regression pin. The regression lens feared the public single-lodge
// booking forms enforce a hardcoded guest cap of 20 (FALLBACK_LODGE_CAPACITY):
// getPublicBookingRequestLodges returns [] for a single-lodge club, so
// `effectiveCapacity = selectedLodge?.capacity ?? club.lodgeCapacity` falls back
// to `club.lodgeCapacity`, which is baked to 20 in club-identity.ts. The claim is
// REFUTED because the (public) route-group layout OVERRIDES `lodgeCapacity` with
// the DB-resolved getDefaultLodgeCapacity() before providing the club identity,
// so at runtime the form's cap reflects the real DB value. These tests pin both
// halves so the flow can never silently regress to the static 20.

// A distinctive non-20 value standing in for the DB-resolved default lodge
// capacity the (public) layout injects into the club identity provider.
const DB_CAPACITY = 47;

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({
    lodgeName: "Test Alpine Lodge",
    otherLodgeId: null,
    otherLodgeName: null,
    suggestedGuestNightRates: {},
    lodgeCapacity: DB_CAPACITY,
  }),
}));

import BookingRequestPage from "@/app/(public)/booking-requests/page";

function mockFetch(lodges: Array<{ id: string; name: string; capacity: number }>) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/booking-requests/settings")) {
      return {
        ok: true,
        json: async () => ({ showPricingToNonMembers: false, lodges }),
      } as Response;
    }
    // /api/age-tier-settings and anything else → empty settings (defaults).
    return { ok: true, json: async () => ({ settings: [] }) } as Response;
  }) as unknown as typeof fetch;
}

describe("public booking-request form — guest cap comes from the injected DB capacity, not the static 20 (#1982 R1)", () => {
  beforeEach(() => {
    // Single-lodge club: the settings endpoint returns no lodges, so the form
    // shows no lodge selector and effectiveCapacity falls to club.lodgeCapacity.
    mockFetch([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("caps guests at the DB-resolved club.lodgeCapacity (47), never the FALLBACK 20", async () => {
    const { container } = render(<BookingRequestPage />);

    await waitFor(() => {
      expect(container.textContent).toContain(`/${DB_CAPACITY} max`);
    });
    // The static FALLBACK_LODGE_CAPACITY must never surface as the cap here.
    expect(container.textContent).not.toContain("/20 max");
    // The cap is rendered in the guest counter against the injected value.
    expect(container.textContent).toMatch(/Guests \(\d+\/47 max\)/);
  });
});

describe("(public) layout injects the DB-resolved default lodge capacity into the club identity (#1982 R1)", () => {
  it("overrides the static lodgeCapacity with getCachedDefaultLodgeCapacity() before providing club identity", () => {
    const layout = readFileSync(
      join(process.cwd(), "src/app/(public)/layout.tsx"),
      "utf8",
    );
    // The layout resolves the DB capacity and spreads it over the (config-
    // derived, static-20) club identity, so downstream useClubIdentity() sees
    // the DB value. If this injection is removed the public forms would silently
    // regress to FALLBACK_LODGE_CAPACITY.
    expect(layout).toContain("getCachedDefaultLodgeCapacity()");
    expect(layout).toMatch(
      /liveClubIdentity\s*=\s*\{\s*\.\.\.clubIdentity,\s*lodgeCapacity\s*\}/,
    );
    expect(layout).toMatch(/AppProviders[\s\S]*clubIdentity=\{liveClubIdentity\}/);
  });
});
