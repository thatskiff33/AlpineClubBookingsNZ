// @vitest-environment jsdom

/**
 * #4581 — the lodge hub offers the Lockers card only to an admin who can open
 * `/admin/lockers`. That page is a membership-area page (its API is
 * `requireAdmin({ area: "membership" })`), so a lodge-only admin saw a card the
 * layout then refused, and the hub fetched a summary the API would 403.
 *
 * C11 (#4808) moved Lockers, Rooms & Beds and Chores under `/admin/lodge-ops`:
 * with the hub switch on, the cards link there, and the Lockers card is still
 * offered only to an admin the layout admits at that path.
 */

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyAdminPermissionMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

let permissionMatrix: AdminPermissionMatrix = emptyAdminPermissionMatrix();

const hubs = vi.hoisted(() => ({ live: false }));

vi.mock("@/lib/admin-hubs/release", () => ({
  get ADMIN_HUBS_LIVE() {
    return hubs.live;
  },
}));
const fetchedUrls: string[] = [];

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "u1", adminPermissionMatrix: permissionMatrix } },
    status: "authenticated",
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useParams: () => ({ id: "lodge-1" }),
  useSearchParams: () => new URLSearchParams(),
}));

import LodgeConfigurationHubPage from "@/app/(admin)/admin/lodge-ops/lodges/[id]/page";

const LODGE = {
  id: "lodge-1",
  name: "Lodge 1",
  slug: "lodge-1",
  active: true,
  doorCode: null,
  travelNote: null,
};

beforeEach(() => {
  fetchedUrls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      fetchedUrls.push(url);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.startsWith("/api/admin/lodges")) return json({ lodges: [LODGE] });
      if (url.startsWith("/api/admin/modules")) return json({ settings: {} });
      if (url.startsWith("/api/admin/bed-allocation/rooms")) {
        return json({ rooms: [] });
      }
      if (url.startsWith("/api/admin/lodge-settings")) return json({ capacity: null });
      if (url.startsWith("/api/admin/lockers")) return json({ lockers: [] });
      if (url.startsWith("/api/admin/seasons")) return json([]);
      if (url.startsWith("/api/admin/chores")) return json([]);
      throw new Error(`Unstubbed fetch in test: ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  hubs.live = false;
});

/** Every card's Configure link, as rendered. */
function configureHrefs(): string[] {
  return screen
    .getAllByRole("link", { name: "Configure" })
    .map((link) => link.getAttribute("href") ?? "");
}

describe("lodge hub cards at the hub paths (C11 #4808)", () => {
  it.each([
    [false, "/admin"],
    [true, "/admin/lodge-ops"],
  ] as const)("links Rooms & Beds, Lockers and Chores with the lodge (live=%s)", async (live, base) => {
    hubs.live = live;
    permissionMatrix = { ...emptyAdminPermissionMatrix(), lodge: "edit", membership: "view" };
    render(<LodgeConfigurationHubPage />);
    await waitFor(() => expect(screen.getByText("Lockers")).toBeInTheDocument());
    expect(configureHrefs()).toEqual(
      expect.arrayContaining([
        `${base}/rooms-beds?lodgeId=lodge-1`,
        `${base}/lockers?lodgeId=lodge-1`,
        `${base}/chores?lodgeId=lodge-1`,
      ]),
    );
  });

  it("still hides the Lockers card from a lodge-only admin with the switch on", async () => {
    hubs.live = true;
    permissionMatrix = { ...emptyAdminPermissionMatrix(), lodge: "edit" };
    render(<LodgeConfigurationHubPage />);
    await screen.findByText("Chores");
    expect(screen.queryByText("Lockers")).not.toBeInTheDocument();
    expect(configureHrefs()).not.toContain("/admin/lodge-ops/lockers?lodgeId=lodge-1");
    expect(configureHrefs()).toContain("/admin/lodge-ops/chores?lodgeId=lodge-1");
    expect(fetchedUrls.some((u) => u.startsWith("/api/admin/lockers"))).toBe(false);
  });
});

describe("lodge hub Lockers card (#4581)", () => {
  it("hides the card and skips the lockers fetch for a lodge-only admin", async () => {
    permissionMatrix = { ...emptyAdminPermissionMatrix(), lodge: "edit" };
    render(<LodgeConfigurationHubPage />);
    await screen.findByText("Chores");
    expect(screen.queryByText("Lockers")).not.toBeInTheDocument();
    expect(fetchedUrls.some((u) => u.startsWith("/api/admin/lockers"))).toBe(false);
  });

  it("shows the card for an admin with membership access", async () => {
    permissionMatrix = {
      ...emptyAdminPermissionMatrix(),
      lodge: "edit",
      membership: "view",
    };
    render(<LodgeConfigurationHubPage />);
    await waitFor(() => expect(screen.getByText("Lockers")).toBeInTheDocument());
    expect(fetchedUrls.some((u) => u.startsWith("/api/admin/lockers"))).toBe(true);
  });
});

/**
 * #4643 — the Seasons & Rates card links to the fee console (`/admin/fees`,
 * bookings OR finance); its season count comes from `/api/admin/seasons`
 * (bookings). The card follows the console, the count follows the API.
 */
describe("lodge hub Seasons & Rates card (#4643)", () => {
  it("hides the card and skips the seasons fetch for a lodge-only admin", async () => {
    permissionMatrix = { ...emptyAdminPermissionMatrix(), lodge: "edit" };
    render(<LodgeConfigurationHubPage />);
    await screen.findByText("Chores");
    expect(screen.queryByText("Seasons & Rates")).not.toBeInTheDocument();
    expect(fetchedUrls.some((u) => u.startsWith("/api/admin/seasons"))).toBe(false);
  });

  it("shows the card without a count, and claims nothing, for a finance admin without bookings", async () => {
    permissionMatrix = {
      ...emptyAdminPermissionMatrix(),
      lodge: "edit",
      finance: "view",
    };
    render(<LodgeConfigurationHubPage />);
    await waitFor(() => expect(screen.getByText("Seasons & Rates")).toBeInTheDocument());
    await screen.findByText("Chores");
    expect(fetchedUrls.some((u) => u.startsWith("/api/admin/seasons"))).toBe(false);
    expect(screen.queryByText(/No seasons yet/)).not.toBeInTheDocument();
  });

  it("shows the card and its count for a bookings admin", async () => {
    permissionMatrix = {
      ...emptyAdminPermissionMatrix(),
      lodge: "edit",
      bookings: "view",
    };
    render(<LodgeConfigurationHubPage />);
    await waitFor(() => expect(screen.getByText("Seasons & Rates")).toBeInTheDocument());
    expect(fetchedUrls.some((u) => u.startsWith("/api/admin/seasons"))).toBe(true);
    // The stub returns no seasons, so once read the card says so.
    await waitFor(() => expect(screen.getByText(/No seasons yet/)).toBeInTheDocument());
  });
});
