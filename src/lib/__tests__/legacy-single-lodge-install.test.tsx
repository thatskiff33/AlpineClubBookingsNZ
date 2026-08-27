// @vitest-environment jsdom

// #160 — Backward-compat (#123 / ADR-005): a genuine legacy-install simulation.
//
// Epic #123 promised existing single-lodge installs keep working transparently
// once multi-lodge became always-on core (ADR-005). The only prior guard was
// the near-tautological route-gating test in feature-routes.test.ts, which
// never exercised real legacy state. This suite seeds an actual pre-removal
// single-lodge install and drives the surfaces that must stay unchanged:
//
//   1. A persisted ClubModuleSettings row still physically carrying the retired
//      `multiLodge` flag (the pre-#128 state). The live schema keeps the column
//      vestigial (see ADR-005 "Schema safety" and #139), and every read goes
//      through CLUB_MODULE_SETTINGS_COLUMN_SELECT, which deliberately does NOT
//      name it — so this row's stale column must never surface or throw.
//   2. A single-row Lodge table (the club's default lodge) with a lodge-scoped
//      child row (LodgeSettings) keyed to it.
//
// It then asserts: the admin sidebar renders the single Lodges entry; the lodge
// list renders single-lodge presentation (Add lodge available, no lodge
// picker); LodgeSelect hides the picker and auto-resolves the sole lodge; the
// module-settings load path tolerates the stale row; and a booking-path
// capacity read resolves identically to the documented single-lodge behaviour
// (docs/CAPACITY_MODEL.md scenario table). Every ClubModuleSettings read is
// asserted to use the explicit column select, composing with the #153 static
// guard (club-module-settings-select-guard.test.ts) which stays green.
//
// TEST-ONLY: no production code is changed by this issue.

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #1940: the lodge hub pages read the session permission matrix for view-only
// gating; provide an edit-level admin session so the legacy render succeeds.
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

import {
  CLUB_MODULE_SETTINGS_COLUMN_SELECT,
  DEFAULT_MODULE_SETTINGS,
  MODULE_KEYS,
  getEffectiveModuleFlags,
} from "@/config/modules";

// ---------------------------------------------------------------------------
// Legacy single-lodge install fixtures
// ---------------------------------------------------------------------------

const DEFAULT_LODGE_ID = "default-lodge";

// The single-row Lodge table — every legacy install has exactly one lodge.
const LEGACY_LODGES = [
  {
    id: DEFAULT_LODGE_ID,
    name: "Club Lodge",
    slug: "club-lodge",
    active: true,
    doorCode: null,
    travelNote: null,
  },
];

// The persisted ClubModuleSettings singleton as a PRE-REMOVAL install still
// holds it: every live module column at its default, PLUS the retired
// `multiLodge` flag still physically set (the state before #128 stopped
// reading/writing it). `multiLodge` is intentionally not a MODULE_KEY, so the
// normalise/load path must ignore it without error, and the column select must
// never name it.
const LEGACY_CLUB_MODULE_SETTINGS_ROW = {
  ...DEFAULT_MODULE_SETTINGS,
  multiLodge: true,
  updatedAt: new Date("2024-01-01T00:00:00.000Z"),
  updatedByMemberId: null,
} as unknown as Record<string, unknown>;

// A lodge-scoped child row keyed to the default lodge. No capacity override is
// set (the legacy default), so capacity resolves to the club-config fallback.
const LEGACY_LODGE_SETTINGS_ROW = {
  capacity: null as number | null,
  lodgeId: DEFAULT_LODGE_ID,
  schoolGroupSoftCap: null,
};

// ---------------------------------------------------------------------------
// Mocked prisma singleton + navigation
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  clubModuleSettingsFindUnique: vi.fn(),
  lodgeFindFirst: vi.fn(),
  lodgeSettingsFindUnique: vi.fn(),
  lodgeBedCount: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubModuleSettings: { findUnique: mocks.clubModuleSettingsFindUnique },
    lodge: { findFirst: mocks.lodgeFindFirst },
    lodgeSettings: { findUnique: mocks.lodgeSettingsFindUnique },
    lodgeBed: { count: mocks.lodgeBedCount },
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/lodges",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

// Imports that read the mocked prisma / navigation come after the mocks.
import {
  loadClubModuleSettings,
  loadEffectiveModuleFlags,
  normalizeClubModuleSettings,
} from "@/lib/module-settings";
import { loadAdminModuleSettings } from "@/lib/admin-modules";
import {
  CLUB_CONFIG_LODGE_CAPACITY,
  getLodgeCapacity,
  getLodgeCapacityStatus,
} from "@/lib/lodge-capacity";
import { getVisibleAdminNavSections } from "@/components/admin-sidebar";
import { requireCalendarDate } from "@/lib/club-time";

/**
 * #3123 — the club's day, first and REQUIRED on the nav exports. Nothing in this
 * file asserts on the one dated href, so a single fixed day serves every call.
 */
const CLUB_DAY = requireCalendarDate("2026-07-01");

import { LodgeSelect } from "@/components/lodge-select";
import AdminLodgesPage from "@/app/(admin)/admin/lodges/page";

const EXPECTED_SELECT = {
  where: { id: "default" },
  select: CLUB_MODULE_SETTINGS_COLUMN_SELECT,
};

// Feature flags a legacy install derives from its saved settings row — the only
// input to sidebar/route gating. Built through the real normalise + effective
// helpers so a regression in either fails these tests.
const LEGACY_FEATURE_FLAGS = getEffectiveModuleFlags(
  normalizeClubModuleSettings(LEGACY_CLUB_MODULE_SETTINGS_ROW),
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.clubModuleSettingsFindUnique.mockResolvedValue(
    LEGACY_CLUB_MODULE_SETTINGS_ROW,
  );
  mocks.lodgeFindFirst.mockResolvedValue({ id: DEFAULT_LODGE_ID });
  mocks.lodgeSettingsFindUnique.mockResolvedValue(LEGACY_LODGE_SETTINGS_ROW);
  mocks.lodgeBedCount.mockResolvedValue(0);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1. Module-settings load path tolerates the stale multiLodge column
// ---------------------------------------------------------------------------

describe("legacy install: module-settings load path tolerates the stale row", () => {
  it("the column select never names the retired multiLodge column (#153 invariant)", () => {
    expect("multiLodge" in CLUB_MODULE_SETTINGS_COLUMN_SELECT).toBe(false);
  });

  it("loadClubModuleSettings ignores multiLodge and reads via the explicit select", async () => {
    const payload = await loadClubModuleSettings();

    // multiLodge is not a module key, so it never leaks into normalised settings.
    expect(Object.keys(payload.settings)).toEqual([...MODULE_KEYS]);
    expect("multiLodge" in payload.settings).toBe(false);
    // Legacy install: every optional/capability module keeps its documented
    // default; nothing is toggled by the presence of the stale flag.
    expect(payload.settings.bedAllocation).toBe(false);
    expect(mocks.clubModuleSettingsFindUnique).toHaveBeenCalledWith(
      EXPECTED_SELECT,
    );
  });

  it("loadEffectiveModuleFlags resolves without error from the stale row", async () => {
    const flags = await loadEffectiveModuleFlags();
    expect(flags).toEqual(LEGACY_FEATURE_FLAGS);
    expect(mocks.clubModuleSettingsFindUnique).toHaveBeenCalledWith(
      EXPECTED_SELECT,
    );
  });

  it("the client-injected admin load seam also tolerates the row and uses the select", async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValue(LEGACY_CLUB_MODULE_SETTINGS_ROW);
    const settings = await loadAdminModuleSettings({
      clubModuleSettings: { findUnique },
    });

    expect(settings.bedAllocation).toBe(false);
    expect("multiLodge" in settings).toBe(false);
    expect(findUnique).toHaveBeenCalledWith(EXPECTED_SELECT);
  });
});

// ---------------------------------------------------------------------------
// 2. Admin sidebar renders the single Lodges entry
// ---------------------------------------------------------------------------

describe("legacy install: admin sidebar shows the single Lodges entry", () => {
  it("renders exactly one Lodges entry, with the scattered lodge editors retired into the hub", () => {
    const sections = getVisibleAdminNavSections(
      CLUB_DAY,
      LEGACY_FEATURE_FLAGS,
      undefined,
      true,
    );
    const labels = sections.flatMap((section) =>
      section.items.map((item) => item.label),
    );

    // ADR-005: multi-lodge is always-on core, so the Lodges entry is present
    // and unique regardless of the (now retired) multiLodge flag.
    expect(labels.filter((label) => label === "Lodges")).toEqual(["Lodges"]);
    // The lodge-scoped editors are reached as Configure cards under the hub,
    // not as standalone sidebar entries (#130).
    expect(labels).not.toContain("Chores");
    expect(labels).not.toContain("Lockers");
    expect(labels).not.toContain("Hut Fees & Seasons");
  });
});

// ---------------------------------------------------------------------------
// 3. Lodge list + LodgeSelect render single-lodge presentation
// ---------------------------------------------------------------------------

describe("legacy install: lodge hub renders single-lodge presentation", () => {
  it("lists the sole lodge with Add lodge available and no lodge picker", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ lodges: LEGACY_LODGES }),
      })),
    );

    render(<AdminLodgesPage />);

    // Add Lodge is always available (ADR-005: "start with one, Add Lodge").
    expect(
      screen.getByRole("button", { name: /Add lodge/i }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("Club Lodge")).toBeInTheDocument(),
    );
    // The single-lodge list carries no lodge selector.
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("LodgeSelect hides the picker and auto-resolves the sole lodge", () => {
    const onChange = vi.fn();
    const { container } = render(
      <LodgeSelect
        lodges={[{ id: DEFAULT_LODGE_ID, name: "Club Lodge" }]}
        value={null}
        onChange={onChange}
      />,
    );

    expect(container).toBeEmptyDOMElement();
    // #2701: the selector now reports WHO asked for the change. The sole-lodge
    // rule is the component's own normalisation, never the admin's choice.
    expect(onChange).toHaveBeenCalledWith(DEFAULT_LODGE_ID, "auto");
  });
});

// ---------------------------------------------------------------------------
// 4. Booking-path capacity read matches documented single-lodge behaviour
// ---------------------------------------------------------------------------

describe("legacy install: booking-path capacity read is unchanged", () => {
  it("resolves the self-healed default lodge to the club-config total, unchanged (Off / healed capacity / default lodge, #1982)", async () => {
    // #1982 collapsed the dual source: the club.json runtime fallback is gone
    // and the default lodge's capacity is backfilled into LodgeSettings by the
    // boot self-heal. The resolved capacity BEFORE fallback-removal (club-config
    // total via club_config) == AFTER (same total via the healed override) — no
    // drop to 0. This models the healed row (see config-self-heal.test.ts for
    // the backfill itself).
    mocks.lodgeSettingsFindUnique.mockResolvedValue({
      ...LEGACY_LODGE_SETTINGS_ROW,
      capacity: CLUB_CONFIG_LODGE_CAPACITY,
    });

    const status = await getLodgeCapacityStatus(DEFAULT_LODGE_ID);

    expect(status).toMatchObject({
      capacity: CLUB_CONFIG_LODGE_CAPACITY,
      source: "capacity_override",
      bedAllocationEnabled: false,
      activeBedCount: 0,
      fallbackCapacity: CLUB_CONFIG_LODGE_CAPACITY,
    });
    expect(await getLodgeCapacity(DEFAULT_LODGE_ID)).toBe(
      CLUB_CONFIG_LODGE_CAPACITY,
    );
    // The capacity read of ClubModuleSettings also uses the explicit select.
    expect(mocks.clubModuleSettingsFindUnique).toHaveBeenCalledWith(
      EXPECTED_SELECT,
    );
  });

  it("resolves an un-healed default lodge (null capacity) to 0, never overbooking (#1982)", async () => {
    // The default `LEGACY_LODGE_SETTINGS_ROW` has a null capacity — the pre-heal
    // (or self-heal-skipped) state. Without the removed club.json fallback it
    // resolves to 0 with a loud unconfigured source, rather than phantom
    // capacity that would silently overbook.
    const status = await getLodgeCapacityStatus(DEFAULT_LODGE_ID);

    expect(status).toMatchObject({
      capacity: 0,
      source: "unconfigured_lodge",
      bedAllocationEnabled: false,
      activeBedCount: 0,
      fallbackCapacity: 0,
    });
    expect(await getLodgeCapacity(DEFAULT_LODGE_ID)).toBe(0);
  });

  it("honours an explicit per-lodge capacity override (Off / capacity set)", async () => {
    // docs/CAPACITY_MODEL.md scenario table, row:
    //   Bed Allocation Off | — | 30 | 30 | capacity_override
    mocks.lodgeSettingsFindUnique.mockResolvedValue({
      ...LEGACY_LODGE_SETTINGS_ROW,
      capacity: 30,
    });

    const status = await getLodgeCapacityStatus(DEFAULT_LODGE_ID);

    expect(status).toMatchObject({
      capacity: 30,
      source: "capacity_override",
      bedAllocationEnabled: false,
      fallbackCapacity: 30,
    });
  });
});
