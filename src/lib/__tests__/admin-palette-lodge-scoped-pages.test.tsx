// @vitest-environment jsdom

/**
 * The lodge-scoped pages open from the command palette (S2 #4797).
 *
 * #130 took Chores, Lockers and Seasons (and Rooms & Beds was never there) off
 * the sidebar because they are lodge-scoped (ADR-005): the lodge hub links each
 * one as `…?lodgeId=<lodge>`. The palette links them at their bare `adminHref`,
 * with no lodge, so this proves that link is not a dead end: each page reads
 * `?lodgeId=` as optional (`initialLodgeIdFromLocation`) and the REAL
 * `LodgeSelect` settles a missing one on the club's first lodge (or its sole
 * lodge, ADR-002), then loads that lodge's records. Only the lodge list is
 * stubbed; the selector and the URL read are the shipped ones.
 */

import "@testing-library/jest-dom/vitest";
import type { ReactElement } from "react";
import { act, cleanup, render, screen } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import { adminHref } from "@/lib/admin-hubs";
import { requireCalendarDate } from "@/lib/club-time";

type LodgeOptionState = {
  lodges: ReadonlyArray<{ id: string; name: string }>;
  loading: boolean;
  failed: boolean;
  forbidden: boolean;
  reload: () => void;
};

let lodgeOptions: LodgeOptionState;

vi.mock("@/components/lodge-select", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/components/lodge-select");
  // `LodgeSelect` and `initialLodgeIdFromLocation` stay real.
  return { ...actual, useLodgeOptions: () => lodgeOptions };
});

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/test",
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock("@/components/confirm-dialog", () => ({
  useConfirm: () => ({ confirm: vi.fn(async () => false), confirmDialog: null }),
}));

import SeasonsPage from "@/app/(admin)/admin/rules/seasons/page";
import ChoresPage from "@/app/(admin)/admin/chores/page";
import LockersPage from "@/app/(admin)/admin/lockers/page";
import { RoomsBedsManager } from "@/components/admin/rooms-beds-manager";
import { getAdminFeatureSearchIndex } from "@/components/admin-sidebar";

const MATRIX: AdminPermissionMatrix = {
  overview: "view",
  bookings: "edit",
  membership: "edit",
  finance: "edit",
  lodge: "edit",
  content: "view",
  support: "view",
};

const allOn: FeatureFlags = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;

const TWO_LODGES = [
  { id: "lodge-1", name: "Lodge One" },
  { id: "lodge-2", name: "Lodge Two" },
];

/** The lodge-scoped pages the palette now offers; none takes a path parameter. */
type LodgeScopedPageId = "seasons" | "chores" | "lockers" | "rooms-beds";

const PAGES: Array<{
  id: LodgeScopedPageId;
  render: () => ReactElement;
  /** The lodge-scoped read the page makes once its lodge has settled. */
  read: string;
  action: RegExp;
}> = [
  { id: "seasons", render: () => <SeasonsPage />, read: "/api/admin/seasons?", action: /^edit window of /i },
  { id: "chores", render: () => <ChoresPage />, read: "/api/admin/chores?", action: /add chore|create chore/i },
  { id: "lockers", render: () => <LockersPage />, read: "/api/admin/lockers?", action: /^create locker$/i },
  {
    // The page is a server wrapper that passes the viewer's matrix to this.
    id: "rooms-beds",
    render: () => <RoomsBedsManager permissionMatrix={MATRIX} />,
    read: "/api/admin/bed-allocation/rooms?",
    action: /add room|bulk create|import rooms/i,
  },
];

function respond(url: string): unknown {
  if (url.includes("/api/admin/seasons")) {
    return [
      {
        id: "season-1",
        name: "Winter",
        type: "WINTER",
        startDate: "2026-08-01",
        endDate: "2026-09-01",
        active: true,
        flatWholeLodgeNightCents: null,
        membershipTypeRates: [],
      },
    ];
  }
  if (url.includes("/api/admin/chores")) return [];
  if (url.includes("/api/admin/lockers")) return { lockers: [], members: [] };
  if (url.includes("/api/admin/bed-allocation/rooms")) {
    return {
      rooms: [],
      capacity: {
        capacity: 30,
        source: "capacity_override",
        bedAllocationEnabled: true,
        activeBedCount: 0,
        fallbackCapacity: 30,
      },
      canImportFromConfig: false,
      configBeds: [],
    };
  }
  return {};
}

function scopedReads(prefix: string): string[] {
  return vi
    .mocked(fetch)
    .mock.calls.map(([input]) => String(input))
    .filter((url) => url.startsWith(prefix));
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const body = respond(String(input));
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("the palette links each lodge-scoped page bare", () => {
  it.each(PAGES)("$id is offered at its adminHref, with no lodge in it", ({ id }) => {
    const href = adminHref(id);
    expect(href).not.toMatch(/[?#]/);
    const index = getAdminFeatureSearchIndex(requireCalendarDate("2026-07-01"), allOn, MATRIX, true);
    expect(index.map((entry) => entry.href)).toContain(href);
  });
});

describe("a lodge-scoped page opened from the palette settles its own lodge", () => {
  it.each(PAGES)(
    "$id loads the first lodge's records when two lodges exist",
    async ({ id, render: renderPage, read, action }) => {
      lodgeOptions = { lodges: TWO_LODGES, loading: false, failed: false, forbidden: false, reload: vi.fn() };
      window.history.replaceState({}, "", adminHref(id));
      render(renderPage());

      expect(await screen.findByRole("button", { name: action })).toBeInTheDocument();
      const reads = scopedReads(read);
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every((url) => url.includes("lodgeId=lodge-1"))).toBe(true);
      expect(screen.queryByText(/your role cannot choose a lodge/i)).not.toBeInTheDocument();
    },
  );

  it.each(PAGES)("$id loads the sole lodge's records in a one-lodge club", async ({ id, render: renderPage, read, action }) => {
    lodgeOptions = {
      lodges: [{ id: "lodge-only", name: "The Lodge" }],
      loading: false,
      failed: false,
      forbidden: false,
      reload: vi.fn(),
    };
    window.history.replaceState({}, "", adminHref(id));
    render(renderPage());

    expect(await screen.findByRole("button", { name: action })).toBeInTheDocument();
    const reads = scopedReads(read);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((url) => url.includes("lodgeId=lodge-only"))).toBe(true);
  });

  it.each(PAGES)("$id still honours the lodge hub's ?lodgeId= link", async ({ id, render: renderPage, read }) => {
    lodgeOptions = { lodges: TWO_LODGES, loading: false, failed: false, forbidden: false, reload: vi.fn() };
    window.history.replaceState({}, "", `${adminHref(id)}?lodgeId=lodge-2`);
    render(renderPage());
    await act(async () => {});

    await vi.waitFor(() => expect(scopedReads(read).length).toBeGreaterThan(0));
    expect(scopedReads(read).every((url) => url.includes("lodgeId=lodge-2"))).toBe(true);
  });
});
