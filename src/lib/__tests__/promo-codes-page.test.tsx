// @vitest-environment jsdom

import {
  render,
  screen,
  waitFor,
  fireEvent,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptyAdminPermissionMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({
    lodges: [{ id: "lodge-1", name: "Lodge One" }],
    loading: false,
    failed: false,
    forbidden: false,
    reload: vi.fn(),
  }),
}));

import { PromoCodesPageClient } from "@/app/(admin)/admin/promo-codes/promo-codes-page-client";

function matrix(
  overrides: Partial<AdminPermissionMatrix>,
): AdminPermissionMatrix {
  return { ...emptyAdminPermissionMatrix(), ...overrides };
}

// The promo-codes list always resolves to []; the Xero reference fetches
// (chart-of-accounts + items) take the configured status so we can drive the
// permission-denied and genuine-failure paths independently.
function stubFetch(xeroStatus = 200) {
  const calls: string[] = [];
  const xeroOk = xeroStatus >= 200 && xeroStatus < 300;
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("xero/chart-of-accounts")) {
      return {
        ok: xeroOk,
        status: xeroStatus,
        json: async () => ({
          accounts: [{ code: "201", name: "Sales", type: "REVENUE" }],
        }),
      };
    }
    if (url.includes("xero/items")) {
      return {
        ok: xeroOk,
        status: xeroStatus,
        json: async () => ({ items: [{ code: "X", name: "Item" }] }),
      };
    }
    return { ok: true, status: 200, json: async () => [] };
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

/*
  #2257 — these tests used to select the manual Xero-code input by its
  `e.g. PROMO-DISC` placeholder. That example moved OUT of the placeholder and
  into an associated `FieldHint` under the field ("Greyed out text as Example
  text looks like a field is already filled in"), so the selector moved to the
  ROLE + accessible name, which is stable against any future copy change. The
  manual branch is a `textbox`; the Xero-data branch is a Radix `combobox`, so
  the two branches stay distinguishable without depending on placeholder text.
*/
function manualXeroItemCodeInput() {
  return screen.queryByRole("textbox", { name: "Xero Item Code" });
}

async function openForm() {
  const addButton = await screen.findByRole("button", {
    name: "Add Promo Code",
  });
  fireEvent.click(addButton);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PromoCodesPageClient — permission-aware Xero reference fetch (#1598)", () => {
  it("fetches Xero reference data when the viewer has finance access", async () => {
    const { calls } = stubFetch(200);
    render(
      <PromoCodesPageClient
        permissionMatrix={matrix({ bookings: "edit", finance: "view" })}
      />,
    );
    await openForm();

    await waitFor(() => {
      expect(calls.some((u) => u.includes("xero/chart-of-accounts"))).toBe(true);
    });
    // With Xero data loaded, the codes are chosen from a Select, not typed.
    expect(manualXeroItemCodeInput()).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "Xero Item Code" }),
    ).not.toBeNull();
  });

  it("skips the finance-area fetch and shows manual inputs for a viewer without finance access", async () => {
    const { calls } = stubFetch(200);
    render(
      <PromoCodesPageClient
        permissionMatrix={matrix({ bookings: "edit" })}
      />,
    );
    await openForm();

    // Manual entry inputs appear immediately; the Xero fetch never fires.
    const manualInput = await screen.findByRole("textbox", {
      name: "Xero Item Code",
    });
    // The example is now helper text the field POINTS AT, not grey pseudo-content
    // inside it. Assert the wiring, not just the words.
    expect(manualInput.getAttribute("placeholder")).toBeNull();
    const hintId = manualInput.getAttribute("aria-describedby");
    expect(hintId).toBeTruthy();
    expect(document.getElementById(hintId ?? "")?.textContent).toContain(
      "Example: PROMO-DISC",
    );
    expect(calls.some((u) => u.includes("xero/chart-of-accounts"))).toBe(false);
    expect(calls.some((u) => u.includes("xero/items"))).toBe(false);
  });

  it("degrades quietly on a 403 — no error banner, manual inputs remain", async () => {
    const { calls } = stubFetch(403);
    render(
      <PromoCodesPageClient
        permissionMatrix={matrix({ bookings: "edit", finance: "view" })}
      />,
    );
    await openForm();

    await waitFor(() => {
      expect(calls.some((u) => u.includes("xero/chart-of-accounts"))).toBe(true);
    });
    expect(screen.queryByText(/Enter the codes manually below/)).toBeNull();
    expect(manualXeroItemCodeInput()).not.toBeNull();
  });

  it("keeps the amber note on a genuine 500 (Xero not connected)", async () => {
    stubFetch(500);
    render(
      <PromoCodesPageClient
        permissionMatrix={matrix({ bookings: "edit", finance: "view" })}
      />,
    );
    await openForm();

    // A 5xx is a real failure, not a permission denial: the informational
    // fallback note is preserved.
    expect(
      await screen.findByText(/Enter the codes manually below/),
    ).toBeTruthy();
  });
});
