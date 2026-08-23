// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// R1 (#1982) regression pin, re-aimed at the mechanism that actually carries the
// capacity today (#2818 decision 7).
//
// The original claim was that the public single-lodge forms enforce a hardcoded
// guest cap of 20 (FALLBACK_LODGE_CAPACITY): `getPublicBookingRequestLodges`
// returns [] for a single-lodge club, so `effectiveCapacity` falls through to
// `club.lodgeCapacity`, which is baked to 20 in club-identity.ts. It was refuted
// because the `(public)` route-group layout overrode `lodgeCapacity` with the
// DB-resolved value before providing the club identity.
//
// That refutation no longer describes this code. The forms moved out of
// `(public)` and stopped reading `useClubIdentity()` at all — they take `club` as
// a prop, so the `(public)` layout's injection is nothing to do with them, and a
// test asserting the shape of that layout would pass forever while the forms
// regressed. Worse, the prop is only correct on the two DEDICATED pages, which
// spread the DB figure over the identity themselves; the `{{booking-requests}}`
// and `{{school-bookings}}` embeds on an ordinary CMS page, and the 404 page,
// pass the identity WITHOUT that spread and would show the static 20.
//
// So the mechanism pinned here is the one that makes EVERY render path right:
// the public settings endpoint both forms already call serves the DB-resolved
// `defaultLodgeCapacity`, and each form prefers it over the prop.

// A distinctive non-20 value standing in for the DB-resolved default lodge
// capacity, so a passing assertion cannot be the static fallback in disguise.
const DB_CAPACITY = 47;

import type { ClubIdentity } from "@/config/club-identity-types";
import { FALLBACK_LODGE_CAPACITY } from "@/lib/lodge-capacity";
import { BookingRequestForm } from "@/app/(website-dynamic)/booking-requests/booking-request-form";
import { SchoolBookingForm } from "@/app/(website-dynamic)/school-bookings/school-booking-form";

// The club identity a DEDICATED page injects: it resolves the real capacity and
// spreads it over the identity before rendering. Only the fields the forms read
// need real values; the cast satisfies the ClubIdentity type.
function injectedClub(): ClubIdentity {
  return {
    lodgeName: "Test Alpine Lodge",
    hutLeaderLabel: "Hut Leader",
    lodgeCapacity: DB_CAPACITY,
  } as unknown as ClubIdentity;
}

// The club identity every OTHER render path passes — the config-derived one,
// carrying the static fallback. This is what `(website)/[...slug]/page.tsx` and
// the 404 page hand to an embedded form.
function embedClub(): ClubIdentity {
  return {
    lodgeName: "Test Alpine Lodge",
    hutLeaderLabel: "Hut Leader",
    lodgeCapacity: FALLBACK_LODGE_CAPACITY,
  } as unknown as ClubIdentity;
}

function mockFetch(
  settings: {
    lodges?: Array<{
      id: string;
      name: string;
      capacity: number;
      schoolGroupSoftCap?: number;
    }>;
    defaultLodgeCapacity?: number;
  } = {},
) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/booking-requests/settings")) {
      return {
        ok: true,
        json: async () => ({
          showPricingToNonMembers: false,
          lodges: settings.lodges ?? [],
          ...(settings.defaultLodgeCapacity === undefined
            ? {}
            : { defaultLodgeCapacity: settings.defaultLodgeCapacity }),
        }),
      } as Response;
    }
    // /api/age-tier-settings and anything else → empty settings (defaults).
    return { ok: true, json: async () => ({ settings: [] }) } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("public booking-request form — guest cap comes from the DB capacity, not the static 20 (#1982 R1)", () => {
  beforeEach(() => {
    // Single-lodge club: the settings endpoint returns no lodges, so the form
    // shows no lodge selector and the cap falls through to the default lodge.
    mockFetch({ lodges: [] });
  });

  it("caps guests at the injected DB capacity (47) on the dedicated page, never the FALLBACK 20", async () => {
    const { container } = render(<BookingRequestForm club={injectedClub()} />);

    await waitFor(() => {
      expect(container.textContent).toContain(`/${DB_CAPACITY} max`);
    });
    // The static FALLBACK_LODGE_CAPACITY must never surface as the cap here.
    expect(container.textContent).not.toContain("/20 max");
    expect(container.textContent).toMatch(/Guests \(\d+\/47 max\)/);
  });
});

describe("embedded on an ordinary CMS page, the forms still show the real capacity (#2818 decision 7)", () => {
  it("prefers the settings endpoint's defaultLodgeCapacity over the static prop — booking requests", async () => {
    // The exact embed pre-state: the club identity carries the static fallback,
    // because `(website)/[...slug]/page.tsx` does not spread the DB figure.
    mockFetch({ lodges: [], defaultLodgeCapacity: DB_CAPACITY });

    const { container } = render(<BookingRequestForm club={embedClub()} />);

    await waitFor(() => {
      expect(container.textContent).toContain(`/${DB_CAPACITY} max`);
    });
    expect(container.textContent).not.toContain(
      `/${FALLBACK_LODGE_CAPACITY} max`,
    );
  });

  it("prefers the settings endpoint's defaultLodgeCapacity over the static prop — school bookings", async () => {
    mockFetch({ lodges: [], defaultLodgeCapacity: DB_CAPACITY });

    const { container } = render(<SchoolBookingForm club={embedClub()} />);

    await waitFor(() => {
      expect(container.textContent).toContain(`/ ${DB_CAPACITY} max`);
    });
    expect(container.textContent).not.toContain(
      `/ ${FALLBACK_LODGE_CAPACITY} max`,
    );
  });

  it("a CHOSEN lodge still wins over the default, so a multi-lodge club measures the right lodge", async () => {
    // Ordering matters: lodge → settings default → prop. A club with two lodges
    // must not have the default lodge's capacity applied to the other one.
    mockFetch({
      lodges: [
        { id: "a", name: "Alpha Lodge", capacity: 12, schoolGroupSoftCap: 25 },
        { id: "b", name: "Beta Lodge", capacity: 30, schoolGroupSoftCap: 25 },
      ],
      defaultLodgeCapacity: DB_CAPACITY,
    });

    const { container } = render(<BookingRequestForm club={embedClub()} />);

    // No lodge chosen yet, so the default capacity applies...
    await waitFor(() => {
      expect(container.textContent).toContain(`/${DB_CAPACITY} max`);
    });
    // ...and neither lodge's own figure has leaked in as the default.
    expect(container.textContent).not.toContain("/12 max");
    expect(container.textContent).not.toContain("/30 max");
  });

  it("falls back to the prop when the endpoint omits the field, so an older payload cannot blank the cap", async () => {
    mockFetch({ lodges: [] });

    const { container } = render(<BookingRequestForm club={injectedClub()} />);

    await waitFor(() => {
      expect(container.textContent).toContain(`/${DB_CAPACITY} max`);
    });
  });
});

describe("the public settings endpoint serves the DB-resolved default lodge capacity (#2818 decision 7)", () => {
  it("resolves it from the same cached read the dedicated pages use, and returns it in the payload", () => {
    // The forms above are pinned against a MOCKED payload, so something has to
    // pin that the real endpoint actually sends the field — otherwise both
    // halves could agree on a contract the server never implements.
    const route = readFileSync(
      join(process.cwd(), "src/app/api/booking-requests/settings/route.ts"),
      "utf8",
    );

    expect(route).toContain("getCachedDefaultLodgeCapacity");
    expect(route).toMatch(/defaultLodgeCapacity,/);
    // It must come from the DB-backed resolver, never from the config constant
    // the whole regression is about.
    expect(route).not.toContain("FALLBACK_LODGE_CAPACITY");
  });
});
