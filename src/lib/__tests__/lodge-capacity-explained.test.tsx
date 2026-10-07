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

const VIEW_ONLY_MATRIX: AdminPermissionMatrix = { ...EDIT_MATRIX, lodge: "view" };

/** Swapped per test so the same screen can be opened view-only. */
let permissionMatrix: AdminPermissionMatrix = EDIT_MATRIX;

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

// Imported after the mocks are registered.
import LodgeConfigurationHubPage from "@/app/(admin)/admin/lodges/[id]/page";
import { lodgeCapacitySettingsHref } from "@/components/admin/lodge-capacity-settings-link";

const LODGE = {
  id: "lodge-1",
  name: "Lodge 1",
  slug: "lodge-1",
  active: true,
  doorCode: null,
  travelNote: null,
};

let lodgeSettingsPuts: Array<Record<string, unknown>> = [];

interface PageStub {
  activeBedCount: number;
  savedCapacity: number | null;
  resolvedCapacity: number;
  source: string;
  /** Shareable doubles in the lodge; 0 unless a case is about partner spots. */
  activeDoubleBedCount?: number;
}

/**
 * Stub the page's reads with a given bed inventory and saved capacity. A PUT
 * to lodge-settings is recorded and answered 200, which is what "the save is
 * accepted" means on this screen — the server-side validation of the value
 * itself is `capacity.test.ts`'s subject, not this file's.
 */
function stubPage(options: PageStub) {
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
            activeDoubleBedCount: options.activeDoubleBedCount ?? 0,
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

/**
 * Everything the capacity field says it is described by, whitespace-normalised
 * — read through `aria-describedby` rather than by role, which is what proves
 * the guidance is attached to the field a screen reader would announce it for.
 * The static fallback hint is filtered out; what is left is the live guidance.
 */
function capacityNotices(field: HTMLInputElement): string[] {
  const ids = (field.getAttribute("aria-describedby") ?? "").split(/\s+/);
  expect(ids).toContain("lodge-capacity-guidance");
  return ids
    .filter((id) => id !== "" && id !== "lodge-capacity-fallback-hint")
    .map((id) => document.getElementById(id))
    .filter((node): node is HTMLElement => node !== null)
    .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim());
}

async function openScreenWith(options: PageStub) {
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
  permissionMatrix = EDIT_MATRIX;
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

    const notice = capacityNotices(field).find((text) => /is above/i.test(text));
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

    const notice = capacityNotices(field).find((text) => /is above/i.test(text));
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

    const notice = capacityNotices(field).find((text) => /is below/i.test(text));
    expect(notice).toBeDefined();
    expect(notice).toContain("This is below the 24 active beds");
    expect(notice).toContain("cap the lodge at 20");
    expect(notice).toContain("the extra 4 beds");
    // The two explanations are mutually exclusive by construction.
    expect(capacityNotices(field).some((text) => /is above/i.test(text))).toBe(false);
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

    expect(capacityNotices(field)).toEqual([]);
  });

  it("never predicts a save for a value the server would refuse, at either bound", async () => {
    // Before #2724 the check accepted any finite number, so "0" was explained
    // as capping the lodge at zero — a prediction of something that cannot
    // happen, since `saveCapacityOverride` refuses anything below 1. The upper
    // bound is the same class one bound out: `100001` is above the beds, so
    // without the shared bounds the screen cheerfully said "saving 100001 is
    // allowed" and the save then failed with a bare "Invalid input".
    const field = await openScreenWith({
      activeBedCount: 24,
      savedCapacity: null,
      resolvedCapacity: 24,
      source: "configured_beds",
    });

    // The field is `type="number"`, so a browser never delivers letters here —
    // these are the refusable values it CAN deliver.
    for (const refused of ["0", "-5", "2.5", "100001"]) {
      await typeCapacity(field, refused);
      const notices = capacityNotices(field);
      expect(notices.some((text) => /is above|is below/i.test(text))).toBe(
        false,
      );
      // It does not go silent either: silence is what sent an officer who
      // typed a stray extra zero to a bare "Invalid input" on save.
      expect(notices).toEqual([
        "Enter a whole number from 1 to 100,000, or clear it to fall back.",
      ]);
    }
  });

  it("refuses the same figure on save, with the same message", async () => {
    const field = await openScreenWith({
      activeBedCount: 24,
      savedCapacity: null,
      resolvedCapacity: 24,
      source: "configured_beds",
    });
    await typeCapacity(field, "100001");

    const save = screen
      .getAllByRole("button", { name: /^Save$/ })
      .find((button) => field.parentElement?.contains(button));
    fireEvent.click(save as HTMLElement);

    // Two places say it, in the same words, from the same constant: the
    // description under the field and the save's own refusal. That agreement
    // is the point — the guidance can never promise a save the server refuses,
    // and the refusal can never name a different range.
    await waitFor(() =>
      expect(
        screen.getAllByText(
          "Enter a whole number from 1 to 100,000, or clear it to fall back.",
        ),
      ).toHaveLength(2),
    );
    expect(lodgeSettingsPuts).toHaveLength(0);
  });

  it("bounds the field itself so the browser refuses it too", async () => {
    const field = await openScreenWith({
      activeBedCount: 24,
      savedCapacity: null,
      resolvedCapacity: 24,
      source: "configured_beds",
    });
    expect(field).toHaveAttribute("min", "1");
    expect(field).toHaveAttribute("max", "100000");
  });

  it("says nothing while the field is blank", async () => {
    const field = await openScreenWith({
      activeBedCount: 24,
      savedCapacity: 30,
      resolvedCapacity: 24,
      source: "configured_beds",
    });
    await waitFor(() => expect(field.value).toBe("30"));
    expect(capacityNotices(field).some((text) => /is above/i.test(text))).toBe(true);

    await typeCapacity(field, "");
    expect(capacityNotices(field)).toEqual([]);
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

    expect(capacityNotices(field)).toEqual([]);
  });
});

/**
 * The surplus is NOT inert, and the screen must not suggest it is.
 *
 * A configured capacity above the active beds does not raise what can be
 * BOOKED until beds are activated — but it is also the ceiling the
 * partner-shared double-bed headroom is measured against (#1745,
 * `INV-CAP-031`), and that takes effect on save. With 24 beds of which 5 are
 * shareable doubles, a configured 30 yields 5 partner spots and a configured
 * 24 yields none.
 *
 * That matters because it is reachable harm, not a wording nicety: an officer
 * who reads "the 30 does nothing until I install beds" and lowers it to 24 to
 * clear the message silently zeroes every partner-shared admission slot —
 * slots this very screen's Capacity card displays. The explanation must name
 * the consequence at the moment the officer is deciding.
 */
describe("the surplus above the beds is not described as inert (#1745)", () => {
  it("names the partner spots the configured figure allows, and what lowering it costs", async () => {
    const field = await openScreenWith({
      activeBedCount: 24,
      activeDoubleBedCount: 5,
      savedCapacity: null,
      resolvedCapacity: 24,
      source: "configured_beds",
    });
    await typeCapacity(field, "30");

    const notice = capacityNotices(field).find((text) => /is above/i.test(text));
    expect(notice).toBeDefined();
    // min(5 doubles, 30 − 24) = 5.
    expect(notice).toContain("allows up to 5 partner spots");
    expect(notice).toContain("lowering the capacity to 24 would leave none");
    // And it must not be left reading as though the figure does nothing.
    expect(notice).not.toMatch(/does nothing|inert|no effect/i);
  });

  it("names only the spots the gap actually allows, not one per double", async () => {
    // 24 beds, 5 doubles, capacity 26: headroom is the GAP (2), not the
    // doubles (5). A screen that printed the double count would overstate it.
    const field = await openScreenWith({
      activeBedCount: 24,
      activeDoubleBedCount: 5,
      savedCapacity: null,
      resolvedCapacity: 24,
      source: "configured_beds",
    });
    await typeCapacity(field, "26");

    const notice = capacityNotices(field).find((text) => /is above/i.test(text));
    expect(notice).toContain("allows up to 2 partner spots");
  });

  it("singularises a single partner spot", async () => {
    const field = await openScreenWith({
      activeBedCount: 24,
      activeDoubleBedCount: 1,
      savedCapacity: null,
      resolvedCapacity: 24,
      source: "configured_beds",
    });
    await typeCapacity(field, "30");

    const notice = capacityNotices(field).find((text) => /is above/i.test(text));
    expect(notice).toContain("allows up to 1 partner spot on");
  });

  it("says nothing about partner spots when the lodge has no shareable doubles", async () => {
    const field = await openScreenWith({
      activeBedCount: 24,
      activeDoubleBedCount: 0,
      savedCapacity: null,
      resolvedCapacity: 24,
      source: "configured_beds",
    });
    await typeCapacity(field, "30");

    const notice = capacityNotices(field).find((text) => /is above/i.test(text));
    expect(notice).toBeDefined();
    expect(notice).not.toMatch(/partner/i);
  });

  it("tells a capping officer the doubles lose their second occupant too", async () => {
    // The same silent loss one step further down: a capacity BELOW the bed
    // count zeroes the headroom outright, and the stranded-beds sentence on
    // its own says nothing about it.
    const field = await openScreenWith({
      activeBedCount: 24,
      activeDoubleBedCount: 5,
      savedCapacity: null,
      resolvedCapacity: 24,
      source: "configured_beds",
    });
    await typeCapacity(field, "20");

    const notice = capacityNotices(field).find((text) => /is below/i.test(text));
    expect(notice).toContain("the extra 4 beds");
    expect(notice).toContain("no room for partner spots");
    expect(notice).toContain("none of the 5 shareable double beds");
  });
});

describe("the guidance is a description, not a live region", () => {
  it("is not announced on every keystroke, and every keystroke is a full sentence", async () => {
    // Typing 30 against 24 beds passes through "3", whose capping sentence is
    // true of the prefix and false of the figure. As a live region that
    // announced in full, twice. It is a description of the field instead, so
    // it is read on focus and never interrupts mid-typing.
    const field = await openScreenWith({
      activeBedCount: 24,
      savedCapacity: null,
      resolvedCapacity: 24,
      source: "configured_beds",
    });

    for (const keystroke of ["3", "30"]) {
      await typeCapacity(field, keystroke);
      const guidance = document.getElementById("lodge-capacity-guidance");
      expect(guidance).not.toBeNull();
      expect(guidance).not.toHaveAttribute("role");
      expect(guidance).not.toHaveAttribute("aria-live");
    }
  });
});

describe("a view-only officer reads the explanation too", () => {
  it("shows the guidance, and the association that announces it, with no edit rights", async () => {
    // The whole purpose of this change is that an officer understands why the
    // smaller number governs. An officer with `lodge: view` cannot type, so
    // the saved value and the description attached to the field are the only
    // route they have to it.
    permissionMatrix = VIEW_ONLY_MATRIX;
    const field = await openScreenWith({
      activeBedCount: 24,
      activeDoubleBedCount: 5,
      savedCapacity: 30,
      resolvedCapacity: 24,
      source: "configured_beds",
    });
    await waitFor(() => expect(field.value).toBe("30"));

    expect(field).toBeDisabled();
    const notice = capacityNotices(field).find((text) => /is above/i.test(text));
    expect(notice).toBeDefined();
    expect(notice).toContain("This is above the 24 active beds");
    expect(notice).toContain("only 24 places can be booked right now");
    expect(notice).toContain("allows up to 5 partner spots");
  });
});

describe("the not-set-up notice's link lands on this field (#3407 round 3, F2)", () => {
  it("resolves the link's fragment to the hub's capacity input", async () => {
    const field = await openScreenWith({
      activeBedCount: 0,
      savedCapacity: null,
      resolvedCapacity: 0,
      source: "unconfigured_lodge",
    });
    const fragment = new URL(lodgeCapacitySettingsHref("lodge-1"), "http://club.test").hash.slice(1);
    expect(fragment).not.toBe("");
    expect(document.getElementById(fragment)).toBe(field);
  });
});

/**
 * #3440 — lowering a saved capacity warns how many partner spots it removes.
 * 24 beds, 5 doubles: saved 30 gives 5 spots, 26 gives 2, 24 or below none.
 */
describe("lowering the capacity warns what it removes (#3440)", () => {
  const LOWERING = /^Lowering the capacity/;
  const SETTING = /^Setting a capacity of/;
  const setting = (field: HTMLInputElement) =>
    capacityNotices(field).find((text) => SETTING.test(text));
  const lowering = (field: HTMLInputElement) =>
    capacityNotices(field).find((text) => LOWERING.test(text));

  const open = (doubles = 5, saved: number | null = 30) =>
    openScreenWith({
      activeBedCount: 24,
      activeDoubleBedCount: doubles,
      savedCapacity: saved,
      resolvedCapacity: 24,
      source: "configured_beds",
    });

  it("names the old and new figure and the spots lost, to the parity case", async () => {
    const field = await open();
    await waitFor(() => expect(field.value).toBe("30"));
    await typeCapacity(field, "24");
    expect(lowering(field)).toContain("from 30 to 24 removes 5 partner spots");
  });

  it("counts only the spots the lowering actually removes", async () => {
    const field = await open();
    await waitFor(() => expect(field.value).toBe("30"));
    await typeCapacity(field, "26");
    expect(lowering(field)).toContain("removes 3 partner spots");
  });

  it("singularises one spot", async () => {
    const field = await open(5, 25);
    await waitFor(() => expect(field.value).toBe("25"));
    await typeCapacity(field, "24");
    expect(lowering(field)).toContain("removes 1 partner spot ");
  });

  it("says nothing when raising or unchanged", async () => {
    const field = await open(5, 26);
    await waitFor(() => expect(field.value).toBe("26"));
    expect(lowering(field)).toBeUndefined();
    await typeCapacity(field, "30");
    expect(lowering(field)).toBeUndefined();
  });

  it("says nothing without shareable doubles or a valid figure", async () => {
    let field = await open(0, 30);
    await waitFor(() => expect(field.value).toBe("30"));
    await typeCapacity(field, "24");
    expect(lowering(field)).toBeUndefined();
    cleanup();

    field = await open(5, 30);
    await waitFor(() => expect(field.value).toBe("30"));
    await typeCapacity(field, "");
    expect(lowering(field)).toBeUndefined();
  });

  it("warns when the lodge has no saved capacity, which bounds nothing", async () => {
    const field = await open(5, null);
    await typeCapacity(field, "24");
    expect(lowering(field)).toBeUndefined();
    expect(setting(field)).toContain(
      "Setting a capacity of 24 removes 5 partner spots this lodge has now.",
    );
    await typeCapacity(field, "26");
    expect(setting(field)).toContain("removes 3 partner spots");
    await typeCapacity(field, "29");
    expect(setting(field)).toBeUndefined();
  });

  it("says nothing for a blank saved capacity on a lodge with no doubles", async () => {
    const field = await open(0, null);
    await typeCapacity(field, "24");
    expect(setting(field)).toBeUndefined();
  });

  it("does not stop the save", async () => {
    const field = await open();
    await waitFor(() => expect(field.value).toBe("30"));
    await typeCapacity(field, "24");
    const save = screen
      .getAllByRole("button", { name: /^Save$/ })
      .find((button) => field.parentElement?.contains(button));
    expect(save).toBeEnabled();
  });
});
