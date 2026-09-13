// @vitest-environment jsdom

/**
 * #2724 — the lodge configuration screen explains the effective limit.
 *
 * An admin may deliberately configure a capacity above the beds installed so
 * far, intending to install the rest later. That save is ACCEPTED; what the
 * screen owes the admin is the consequence in figures — the configured
 * capacity, the active bed count, and the effective capacity that governs
 * until more beds are activated.
 *
 * These cases are about the officer-facing configuration screen only. Nothing
 * here is surfaced to a member, so the #2930 rule that a member can never tell
 * a held lodge from an ordinarily full one is not engaged.
 */

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";

const EDIT_MATRIX: AdminPermissionMatrix = {
  overview: "view",
  bookings: "view",
  membership: "view",
  finance: "view",
  lodge: "edit",
  content: "view",
  support: "view",
};

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "u1", adminPermissionMatrix: EDIT_MATRIX } },
    status: "authenticated",
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useParams: () => ({ id: "lodge-1" }),
  useSearchParams: () => new URLSearchParams(),
}));

// Imported after the mocks are registered.
import LodgeConfigurationHubPage from "@/app/(admin)/admin/lodges/[id]/page";

const LODGE = {
  id: "lodge-1",
  name: "Lodge 1",
  slug: "lodge-1",
  active: true,
  doorCode: null,
  travelNote: null,
};

let lodgeSettingsPuts: Array<Record<string, unknown>> = [];

/**
 * Stub the page's reads with a given bed inventory and saved capacity. A PUT
 * to lodge-settings is recorded and answered 200, which is what "the save is
 * accepted" means on this screen — the server-side validation of the value
 * itself is `capacity.test.ts`'s subject, not this file's.
 */
function stubPage(options: {
  activeBedCount: number;
  savedCapacity: number | null;
  resolvedCapacity: number;
  source: string;
}) {
  lodgeSettingsPuts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });

      if (url.startsWith("/api/admin/lodges")) return json({ lodges: [LODGE] });
      if (url.startsWith("/api/admin/modules")) {
        return json({ settings: { bedAllocation: true } });
      }
      if (url.startsWith("/api/admin/bed-allocation/rooms")) {
        return json({
          rooms: [],
          capacity: {
            capacity: options.resolvedCapacity,
            source: options.source,
            activeBedCount: options.activeBedCount,
            partnerSharedHeadroom: 0,
          },
        });
      }
      if (url.startsWith("/api/admin/lodge-settings")) {
        if (init?.method === "PUT") {
          lodgeSettingsPuts.push(
            JSON.parse(String(init.body)) as Record<string, unknown>,
          );
          return json({ capacity: null });
        }
        return json({ capacity: options.savedCapacity });
      }
      if (url.startsWith("/api/admin/lockers")) return json({ lockers: [] });
      if (url.startsWith("/api/admin/seasons")) return json([]);
      if (url.startsWith("/api/admin/chores")) return json([]);
      throw new Error(`Unstubbed fetch in test: ${url}`);
    }),
  );
}

/** Every guidance note beside the capacity field, whitespace-normalised. */
function capacityNotices(): string[] {
  return screen
    .queryAllByRole("status")
    .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter((text) => /active bed/i.test(text));
}

async function openScreenWith(options: {
  activeBedCount: number;
  savedCapacity: number | null;
  resolvedCapacity: number;
  source: string;
}) {
  stubPage(options);
  render(<LodgeConfigurationHubPage />);
  return (await screen.findByLabelText(
    /Capacity for this lodge/i,
  )) as HTMLInputElement;
}

async function typeCapacity(field: HTMLInputElement, value: string) {
  fireEvent.change(field, { target: { value } });
  await waitFor(() => expect(field.value).toBe(value));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("capacity above the active beds is accepted and explained (#2724)", () => {
  beforeEach(() => {
    lodgeSettingsPuts = [];
  });

  it("names the configured capacity, the active beds and the effective capacity", async () => {
    const field = await openScreenWith({
      activeBedCount: 24,
      savedCapacity: null,
      resolvedCapacity: 24,
      source: "configured_beds",
    });
    await typeCapacity(field, "30");

    const notice = capacityNotices().find((text) => /is above/i.test(text));
    expect(notice).toBeDefined();
    // All three figures, and the direction of the remedy. 24 is the effective
    // capacity here, not merely the bed count: with 30 configured the beds are
    // what bind, which is the whole point of the explanation.
    expect(notice).toContain("This is above the 24 active beds");
    expect(notice).toContain("saving 30 is allowed");
    expect(notice).toContain("only 24 places can be booked right now");
    expect(notice).toContain("Activating 6 more beds");
    expect(notice).toContain("up to 30");
  });

  it("leaves the save enabled — this is guidance, not a validation error", async () => {
    const field = await openScreenWith({
      activeBedCount: 24,
      savedCapacity: null,
      resolvedCapacity: 24,
      source: "configured_beds",
    });
    await typeCapacity(field, "30");

    const save = screen
      .getAllByRole("button", { name: /^Save$/ })
      .find((button) => field.parentElement?.contains(button));
    expect(save).toBeDefined();
    expect(save).toBeEnabled();

    fireEvent.click(save as HTMLElement);
    await waitFor(() => expect(lodgeSettingsPuts).toHaveLength(1));
    expect(lodgeSettingsPuts[0]).toMatchObject({ capacity: 30 });
    expect(await screen.findByText("Capacity saved")).toBeInTheDocument();
  });

  it("singularises one bed and one place", async () => {
    const field = await openScreenWith({
      activeBedCount: 1,
      savedCapacity: null,
      resolvedCapacity: 1,
      source: "configured_beds",
    });
    await typeCapacity(field, "2");

    const notice = capacityNotices().find((text) => /is above/i.test(text));
    expect(notice).toContain("This is above the 1 active bed configured");
    expect(notice).toContain("only 1 place can be booked");
    expect(notice).toContain("Activating 1 more bed raises");
  });
});

describe("the existing below-beds capping warning is preserved (#1653)", () => {
  it("still explains the cap and the stranded beds", async () => {
    const field = await openScreenWith({
      activeBedCount: 24,
      savedCapacity: null,
      resolvedCapacity: 24,
      source: "configured_beds",
    });
    await typeCapacity(field, "20");

    const notice = capacityNotices().find((text) => /is below/i.test(text));
    expect(notice).toBeDefined();
    expect(notice).toContain("This is below the 24 active beds");
    expect(notice).toContain("cap the lodge at 20");
    expect(notice).toContain("the extra 4 beds");
    // The two explanations are mutually exclusive by construction.
    expect(capacityNotices().some((text) => /is above/i.test(text))).toBe(false);
  });
});

describe("the screen explains nothing it cannot stand behind", () => {
  it("says neither thing when the capacity equals the bed count", async () => {
    const field = await openScreenWith({
      activeBedCount: 24,
      savedCapacity: null,
      resolvedCapacity: 24,
      source: "configured_beds",
    });
    await typeCapacity(field, "24");

    expect(capacityNotices()).toEqual([]);
  });

  it("says nothing for a value the save would refuse", async () => {
    // Before #2724 the check accepted any finite number, so "0" was explained
    // as capping the lodge at zero — a prediction of something that cannot
    // happen, since `saveCapacityOverride` refuses anything below 1.
    const field = await openScreenWith({
      activeBedCount: 24,
      savedCapacity: null,
      resolvedCapacity: 24,
      source: "configured_beds",
    });

    // The field is `type="number"`, so a browser never delivers letters here —
    // these are the refusable values it CAN deliver.
    for (const refused of ["0", "-5", "2.5"]) {
      await typeCapacity(field, refused);
      expect(capacityNotices()).toEqual([]);
    }
  });

  it("says nothing while the field is blank", async () => {
    const field = await openScreenWith({
      activeBedCount: 24,
      savedCapacity: 30,
      resolvedCapacity: 24,
      source: "configured_beds",
    });
    await waitFor(() => expect(field.value).toBe("30"));
    expect(capacityNotices().some((text) => /is above/i.test(text))).toBe(true);

    await typeCapacity(field, "");
    expect(capacityNotices()).toEqual([]);
  });

  it("says nothing when the lodge has no active beds at all", async () => {
    // With no bed inventory the configured capacity IS the effective figure,
    // so there is no gap to explain. (A lodge with neither beds nor a capacity
    // deliberately resolves to 0; that rough edge is #3407, untouched here.)
    const field = await openScreenWith({
      activeBedCount: 0,
      savedCapacity: null,
      resolvedCapacity: 0,
      source: "unconfigured_lodge",
    });
    await typeCapacity(field, "30");

    expect(capacityNotices()).toEqual([]);
  });
});
