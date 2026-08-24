// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE 404 PAGE'S EMBEDDED PUBLIC FORMS GET THE CLUB'S PERSISTED ZONE (CT-4 group
 * E, #2870; epic #2988; INV-CONFIG-002).
 *
 * ## The defect these two wrappers exist to close, and how it was found
 *
 * `BookingRequestForm` and `SchoolBookingForm` derive the club's TODAY for their
 * earliest selectable night, so since CT-4 they read it from `ClubTimeProvider`
 * — and `useClubTime()` THROWS when there is none, deliberately. On every normal
 * render there is one: `website/website-chrome.tsx` mounts it for both public
 * route groups.
 *
 * The root `src/app/not-found.tsx` is outside both. It renders
 * `EmbeddedPageContentParts` over whatever an admin published at that path, so a
 * `{{booking-requests}}` or `{{school-bookings}}` token on the 404 page would
 * have rendered the form with no provider above it — a thrown error on the one
 * page whose job is to fail gracefully. `club-time-provider-mount-census.test.tsx`
 * reddened the moment the forms were migrated, which is the walk earning its
 * keep; these wrappers are the fix, and `skifield-whakapapa-embed.tsx` is the
 * same shape for the same reason.
 *
 * ## What this file adds that the mount census cannot
 *
 * The census proves a provider is THERE. It cannot prove the provider carries
 * the right value, because it reads source rather than running anything. These
 * cases run the wrapper and assert the zone it delivered, end to end, by reading
 * the date input's bound off the rendered form.
 *
 * ## The zones, and why each is the one it is
 *
 * - PERSISTED `America/Denver`. Behind UTC, which is the direction the date-only
 *   defects live in, and on the frozen instant (2026-07-01T00:00:00.000Z) it is
 *   still 30 June there.
 * - ENVIRONMENT `Pacific/Auckland`, mocked. It is what `APP_TIME_ZONE` resolves
 *   to wherever `TZ` is unset — CI included — and it is 1 July on that instant.
 *   The two therefore DISAGREE, which is what makes the assertion mean anything:
 *   a wrapper that resolved the environment instead would offer 1 July.
 * - HOST `Asia/Tokyo`, a third place again, so a read of the machine's own clock
 *   cannot pass by accident either.
 *
 * The premise is asserted as those two ANSWERS rather than as zone identifiers,
 * which would go vacuous on a machine whose own zone happened to match.
 *
 * ## The prisma mock's `clubTimeSettings` delegate is load-bearing
 *
 * `getClubTimeZone` degrades silently to the environment in three places — a
 * missing delegate, a throwing query, and an absent row — so a prisma mock
 * without it would let this file pass for exactly the reason it exists to rule
 * out. The last case drives that home by asserting the row was really read.
 */

// Inlined literals: `vi.mock` factories hoist above every const in this file.
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
}));

vi.mock("server-only", () => ({}));

const { mockClubTimeSettingsFindUnique } = vi.hoisted(() => ({
  mockClubTimeSettingsFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubTimeSettings: { findUnique: mockClubTimeSettingsFindUnique },
  },
}));

import { BookingRequestFormEmbed } from "@/app/(website-dynamic)/booking-requests/booking-request-form-embed";
import { SchoolBookingFormEmbed } from "@/app/(website-dynamic)/school-bookings/school-booking-form-embed";
import { bindClubTime, fixedClubClock, requireClubTimeZone } from "@/lib/club-time";
import { captureHostTimeZone } from "@/lib/__tests__/helpers/timezone";
import type { ClubIdentity } from "@/config/club-identity-types";

const PERSISTED_ZONE = "America/Denver";
const ENVIRONMENT_ZONE = "Pacific/Auckland";

/** The frozen test clock (`vitest.clock-setup.ts`). */
const frozenClock = fixedClubClock(new Date("2026-07-01T00:00:00.000Z"));

const CLUB = {
  lodgeName: "Silverpeak Lodge",
  lodgeCapacity: 20,
  hutLeaderLabel: "Hut Leader",
} as unknown as ClubIdentity;

const hostTimeZone = captureHostTimeZone();

beforeEach(() => {
  mockClubTimeSettingsFindUnique.mockReset();
  mockClubTimeSettingsFindUnique.mockResolvedValue({
    id: 1,
    timeZone: PERSISTED_ZONE,
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedByMemberId: null,
  });
  // The public settings endpoint both forms call on mount.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ showPricingToNonMembers: false, lodges: [] }),
    })),
  );
  // The viewer's own machine, somewhere neither zone would produce.
  process.env.TZ = "Asia/Tokyo";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  hostTimeZone.restore();
});

async function earliestNightFrom(element: React.ReactElement) {
  render(element);
  const checkIn = (await screen.findByLabelText(
    /check-?in/i,
  )) as HTMLInputElement;
  await waitFor(() => expect(checkIn.getAttribute("min")).toBeTruthy());
  return checkIn.getAttribute("min");
}

describe("public form embeds carry the club's persisted zone (CT-4, #2870)", () => {
  it("the two zones really do disagree about today", () => {
    // PREMISE AS AN ANSWER. If a runtime, a DST rule or an edit to the frozen
    // instant ever made these agree, this fails here rather than leaving both
    // cases below quietly asserting nothing.
    expect(
      bindClubTime(requireClubTimeZone(PERSISTED_ZONE)).today(frozenClock),
    ).toBe("2026-06-30");
    expect(
      bindClubTime(requireClubTimeZone(ENVIRONMENT_ZONE)).today(frozenClock),
    ).toBe("2026-07-01");
  });

  it("the booking-request embed offers the PERSISTED club's night", async () => {
    expect(await earliestNightFrom(await BookingRequestFormEmbed({ club: CLUB }))).toBe(
      "2026-06-30",
    );
  });

  it("the school-booking embed offers the PERSISTED club's night", async () => {
    expect(await earliestNightFrom(await SchoolBookingFormEmbed({ club: CLUB }))).toBe(
      "2026-06-30",
    );
  });

  it("follows the persisted row when it changes, and really reads it", async () => {
    /*
      The other half of the pair, and the reason the two above are about the
      DATABASE rather than about a hard-coded 30 June: change only the stored
      row and the offered night follows it. A wrapper that resolved the
      environment, or the host, answers both halves identically.

      The call count is asserted too, because the resolver is fail-soft: a
      prisma mock that never got asked would degrade to the environment, and
      `2026-07-01` is exactly what the environment says — so without this the
      failure and the fallback look the same.
    */
    mockClubTimeSettingsFindUnique.mockResolvedValue({
      id: 1,
      timeZone: ENVIRONMENT_ZONE,
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedByMemberId: null,
    });

    expect(await earliestNightFrom(await BookingRequestFormEmbed({ club: CLUB }))).toBe(
      "2026-07-01",
    );
    expect(mockClubTimeSettingsFindUnique).toHaveBeenCalled();
  });
});
