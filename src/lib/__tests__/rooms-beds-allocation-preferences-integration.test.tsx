// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptyAdminPermissionMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

/*
  #2937 — the REAL allocation preferences panel inside the REAL Rooms & Beds
  manager, on one fake server.

  `rooms-beds-manager.test.tsx` mocks the panel at the seam, which is right for
  that file: it asks what the manager HANDS the panel, and leaving the editor
  real there would add a second endpoint and a second permanently-mounted alert
  region to every query in it. But a seam assertion and a panel assertion can
  both hold while the two never meet — and "hosted by Rooms & Beds" was exactly
  the claim the end-to-end matrix was citing that pair of mocks for.

  So this file mounts them together and nothing between them, small on purpose:
  the lodge selector the manager owns really reaches the editor the panel owns,
  the editor really loads that lodge, and a lodge the manager cannot settle on
  really produces an explanation instead of a write target.
*/

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/components/confirm-dialog", () => ({
  useConfirm: () => ({ confirm: vi.fn(), confirmDialog: null }),
}));

const { lodgeOptions } = vi.hoisted(() => ({
  lodgeOptions: {
    current: {
      lodges: [{ id: "lodge-1", name: "Alpine Lodge" }],
      loading: false,
      failed: false,
      forbidden: false,
    },
  },
}));

vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({ ...lodgeOptions.current, reload: vi.fn() }),
  LodgeSelect: () => null,
  initialLodgeIdFromLocation: () => "lodge-1",
}));

import { RoomsBedsManager } from "@/components/admin/rooms-beds-manager";

const ROOMS_PAYLOAD = {
  rooms: [],
  capacity: {
    capacity: 0,
    source: "unconfigured_lodge" as const,
    bedAllocationEnabled: true,
    activeBedCount: 0,
    fallbackCapacity: 0,
  },
  canImportFromConfig: false,
  configBeds: [],
};

/** The settings route's real reply shape: two editable fields plus provenance. */
function settingsPayload(lodgeId: string) {
  return {
    settings: {
      autoAllocationEnabled: true,
      allocationPriorityOrder: ["BOOKING_COHESION", "STAY_CONTINUITY"],
      authoritativeLodgeId: lodgeId,
      settingsId: lodgeId,
      source: "LODGE",
      fallback: "NONE",
      updatedByMemberId: "admin-1",
      updatedAt: "2026-07-01T00:00:00.000Z",
    },
  };
}

function installServer() {
  const settingsReads: string[] = [];
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.startsWith("/api/admin/bed-allocation/settings")) {
      const lodgeId = new URL(url, "https://example.test").searchParams.get(
        "lodgeId",
      );
      settingsReads.push(String(lodgeId));
      return {
        ok: true,
        status: 200,
        json: async () => settingsPayload(String(lodgeId)),
      };
    }
    if (url.startsWith("/api/admin/bed-allocation/rooms")) {
      return { ok: true, status: 200, json: async () => ROOMS_PAYLOAD };
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
  return { settingsReads };
}

function matrix(overrides: Partial<AdminPermissionMatrix>) {
  return { ...emptyAdminPermissionMatrix(), ...overrides };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  lodgeOptions.current = {
    lodges: [{ id: "lodge-1", name: "Alpine Lodge" }],
    loading: false,
    failed: false,
    forbidden: false,
  };
});

describe("Rooms & Beds hosts the real allocation preferences editor (#2937)", () => {
  it("loads the page's own lodge into the real editor and offers Edit to a bookings editor", async () => {
    const server = installServer();
    render(
      <RoomsBedsManager
        permissionMatrix={matrix({ lodge: "edit", bookings: "edit" })}
      />,
    );

    // The editor itself, not a stand-in: its own checkbox and its own values.
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: "Auto allocation enabled" }),
      ).toBeTruthy(),
    );
    expect(screen.getByText("Keep each booking together")).toBeTruthy();
    // It asked for the lodge the manager settled on, and only that one.
    expect(server.settingsReads).toEqual(["lodge-1"]);

    // Read-only until Edit, which is the manager's `bookings: edit` reaching
    // the panel's `canEdit`.
    expect(
      (
        screen.getByRole("checkbox", {
          name: "Auto allocation enabled",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("checkbox", {
            name: "Auto allocation enabled",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
  });

  it("gives a bookings viewer the real editor with no edit path", async () => {
    installServer();
    render(
      <RoomsBedsManager
        permissionMatrix={matrix({ lodge: "edit", bookings: "view" })}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: "Auto allocation enabled" }),
      ).toBeTruthy(),
    );
    expect(
      screen.getByText(
        /Your admin role can view allocation preferences but cannot change them/,
      ),
    ).toBeTruthy();
  });

  it("explains itself, fetches nothing and offers no write target when the lodge list fails", async () => {
    lodgeOptions.current = {
      lodges: [],
      loading: false,
      failed: true,
      forbidden: false,
    };
    const server = installServer();
    render(
      <RoomsBedsManager
        permissionMatrix={matrix({ lodge: "edit", bookings: "edit" })}
      />,
    );

    // MUTATION PROBE for the mount point: move `<AllocationPreferencesPanel>`
    // inside the manager's `lodgeScopeReady` gate — the tidy the size-allowance
    // fragment predicts a reader will attempt — and the card vanishes entirely,
    // so this line fails. Nothing else in the tree notices.
    await screen.findByText(
      /The lodge list could not be loaded, so preferences cannot be shown or changed/,
    );
    expect(
      screen.queryByRole("checkbox", { name: "Auto allocation enabled" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    // No lodge settled, so the editor was never constructed and asked for
    // nothing — it cannot fall back to "some lodge".
    expect(server.settingsReads).toEqual([]);
  });

  it("still says which state it is in when the club has no active lodge", async () => {
    lodgeOptions.current = {
      lodges: [],
      loading: false,
      failed: false,
      forbidden: false,
    };
    const server = installServer();
    render(
      <RoomsBedsManager
        permissionMatrix={matrix({ lodge: "edit", bookings: "edit" })}
      />,
    );

    await screen.findByText(
      "This club has no active lodge, so there are no preferences to show.",
    );
    expect(server.settingsReads).toEqual([]);
  });
});
