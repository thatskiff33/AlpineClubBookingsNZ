// @vitest-environment jsdom

// #1320 follow-up to #1262/#1275: the configurable hut-leader label must reach
// the lower-priority prose surfaces that still hard-coded "hut leader" after the
// first pass. Prove a custom label ("Warden") threads through both accessor
// paths: the client hook (useClubIdentity) and the server-only constant
// (CLUB_HUT_LEADER_LABEL).

import { render, screen } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClubIdentityProvider } from "@/components/club-identity-provider";

// #1940: the Lodge Capacity card reads the session permission matrix for
// view-only gating; provide an edit-level admin session so the prose renders.
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "edit",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: "edit",
          content: "edit",
          support: "edit",
        },
      },
    },
  }),
}));
import type { ClubIdentity } from "@/config/club-identity-types";

// Server surface reads the static constant. Override it, and stub the client
// panel so the test renders only the prose under test.
vi.mock("@/config/club-identity", async (importActual) => {
  const actual = await importActual<typeof import("@/config/club-identity")>();
  return { ...actual, CLUB_HUT_LEADER_LABEL: "Warden" };
});

vi.mock("@/components/admin/lodge-instructions-panel", () => ({
  LodgeInstructionsPanel: () => <div data-testid="lodge-instructions-panel" />,
}));

import LodgeInstructionsAdminPage from "@/app/(admin)/admin/lodge-instructions/page";
import MemberLodgeInstructionsPage from "@/app/(authenticated)/lodge-instructions/page";
import { LodgeCapacityCard } from "@/components/admin/lodge-capacity-card";

const wardenIdentity: ClubIdentity = {
  bookingsName: "Example Bookings",
  contactEmail: "contact@example.org",
  emailFromName: "Example Club",
  hutLeaderLabel: "Warden",
  lodgeCapacity: 20,
  lodgeName: "Example Lodge",
  lodgeTravelNote: "Allow travel time.",
  name: "Example Club",
  publicHost: "example.org",
  publicUrl: "https://example.org",
  shortName: "Example",
  socialLinks: {},
  supportEmail: "support@example.org",
};

describe("custom hut-leader label reaches lower-priority prose (#1320)", () => {
  describe("server surface: admin Lodge Instructions page", () => {
    it("uses the custom label in the protected-content description", () => {
      render(<LodgeInstructionsAdminPage />);

      expect(screen.getByText(/instructions wardens rely on/i)).toBeTruthy();
      expect(
        screen.getByText(/only visible to admins and assigned wardens/i),
      ).toBeTruthy();
      expect(document.body.textContent?.toLowerCase()).not.toContain(
        "hut leader",
      );
    });
  });

  describe("client surface: member Lodge Instructions page", () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      // 403 means "not assigned"; this is the deterministic prose path.
      global.fetch = vi
        .fn()
        .mockResolvedValue({ status: 403 }) as unknown as typeof fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
      vi.clearAllMocks();
    });

    it("uses the custom label in the not-assigned notice", async () => {
      render(
        <ClubIdentityProvider value={wardenIdentity}>
          <MemberLodgeInstructionsPage />
        </ClubIdentityProvider>,
      );

      expect(
        await screen.findByText(/not currently assigned as a warden/i),
      ).toBeTruthy();
      expect(
        screen.getByText(/current or upcoming warden assignment/i),
      ).toBeTruthy();
      expect(document.body.textContent?.toLowerCase()).not.toContain(
        "hut leader",
      );
    });
  });

  describe("client surface: Lodge Capacity card", () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      global.fetch = vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/admin/lodges") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              lodges: [{ id: "lodge-1", name: "Example Lodge" }],
            }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            capacity: 20,
            hutLeaderLookaheadDays: 14,
            clubConfigCapacity: 24,
          }),
        } as Response;
      });
    });

    afterEach(() => {
      global.fetch = originalFetch;
      vi.clearAllMocks();
    });

    it("uses the custom label in the lookahead description and field label", async () => {
      render(
        <ClubIdentityProvider value={wardenIdentity}>
          <LodgeCapacityCard />
        </ClubIdentityProvider>,
      );

      expect(
        screen.getByText(/how far ahead warden coverage is checked/i),
      ).toBeTruthy();
      expect(await screen.findByText(/warden lookahead \(days\)/i)).toBeTruthy();
      expect(document.body.textContent?.toLowerCase()).not.toContain(
        "hut-leader",
      );
    });
  });
});
