// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyAdminPermissionMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { SubscriptionLockoutSettingsPanel } from "@/components/admin/subscription-lockout-settings-panel";

function matrix(
  overrides: Partial<AdminPermissionMatrix>,
): AdminPermissionMatrix {
  return { ...emptyAdminPermissionMatrix(), ...overrides };
}

// Routes each endpoint to a 200 body by default; `overrides` forces a status on
// any URL matched by substring so a single fetch can be denied/failed.
function stubFetch(
  overrides: Record<string, { status: number; body?: unknown }> = {},
) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    const key = Object.keys(overrides).find((k) => url.includes(k));
    if (key) {
      const { status, body } = overrides[key];
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body ?? {},
      };
    }
    let body: unknown = {};
    if (url.includes("membership-lockout-settings")) {
      body = {
        settings: {
          mode: "NO_BLOCK",
          financialYearEndMonthOverride: null,
          textFallbackEnabled: false,
          useFeeScheduleItemCodes: false,
        },
        feeScheduleItemCodes: [],
        overlappingCodes: [],
      };
    } else if (url.includes("xero/account-mappings")) {
      body = { subscriptionIncome: { code: null, itemCode: null } };
    } else if (url.includes("xero/chart-of-accounts")) {
      body = { accounts: [] };
    } else if (url.includes("xero/items")) {
      body = { items: [] };
    } else if (url.includes("xero/organisation")) {
      body = { financialYearEndMonth: 3 };
    } else if (url.includes("age-tier-settings")) {
      body = { settings: [] };
    }
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SubscriptionLockoutSettingsPanel — permission-aware cross-area sections (#1598)", () => {
  it("renders every card when the viewer holds all backing areas", async () => {
    stubFetch();
    render(
      <SubscriptionLockoutSettingsPanel
        permissionMatrix={matrix({
          support: "view",
          membership: "edit",
          finance: "edit",
          bookings: "edit",
        })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Booking lockout")).toBeTruthy();
    });
    expect(screen.getByText("Paid-subscription detection")).toBeTruthy();
    expect(screen.getByText("Age tiers")).toBeTruthy();
  });

  it("hides the finance and bookings cards (and skips their fetches) for a membership-only viewer", async () => {
    const { calls } = stubFetch();
    render(
      <SubscriptionLockoutSettingsPanel
        permissionMatrix={matrix({ support: "view", membership: "edit" })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Booking lockout")).toBeTruthy();
    });
    // Cross-area sections hidden by matrix…
    expect(screen.queryByText("Paid-subscription detection")).toBeNull();
    expect(screen.queryByText("Age tiers")).toBeNull();
    // …and their backing endpoints were never fetched.
    expect(calls.some((u) => u.includes("xero/chart-of-accounts"))).toBe(false);
    expect(calls.some((u) => u.includes("age-tier-settings"))).toBe(false);
    expect(calls.some((u) => u.includes("membership-lockout-settings"))).toBe(
      true,
    );
  });

  it("renders nothing (no fetch) when the viewer lacks membership — the backbone area", async () => {
    const { calls } = stubFetch();
    const { container } = render(
      <SubscriptionLockoutSettingsPanel
        permissionMatrix={matrix({ support: "view" })}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("Loading settings…")).toBeNull();
    });
    expect(screen.queryByText("Booking lockout")).toBeNull();
    expect(container.firstChild).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("renders nothing quietly on a 403 from the backbone settings load (no toast)", async () => {
    const sonner = await import("sonner");
    stubFetch({ "membership-lockout-settings": { status: 403 } });
    render(
      <SubscriptionLockoutSettingsPanel
        permissionMatrix={matrix({
          support: "view",
          membership: "edit",
          finance: "edit",
          bookings: "edit",
        })}
      />,
    );

    // Starts on the loading state, then unmounts to null once forbidden resolves.
    await waitFor(() => {
      expect(screen.queryByText("Loading settings…")).toBeNull();
    });
    expect(screen.queryByText("Booking lockout")).toBeNull();
    expect(sonner.toast.error).not.toHaveBeenCalled();
  });

  it("does NOT quiet-hide on a genuine 500 from the backbone load", async () => {
    // `forbidden` (the render-nothing backstop) must flip only on 401/403. A
    // 500 on the membership backbone leaves the panel on its loading state — it
    // never resolves to null the way a 403 does — so a genuine failure stays
    // distinguishable from a permission denial.
    const { fetchMock } = stubFetch({
      "membership-lockout-settings": { status: 500 },
    });
    render(
      <SubscriptionLockoutSettingsPanel
        permissionMatrix={matrix({
          support: "view",
          membership: "edit",
          finance: "edit",
          bookings: "edit",
        })}
      />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Let the 500 response resolve and the load's finally run.
    await new Promise((resolve) => setTimeout(resolve));
    // Still loading (not hidden): a 403 here would have rendered null instead.
    expect(screen.getByText("Loading settings…")).toBeTruthy();
  });
});

describe("SubscriptionLockoutSettingsPanel — item-code matching mode (#2109)", () => {
  const fullMatrix = () =>
    matrix({
      support: "view",
      membership: "edit",
      finance: "edit",
      bookings: "edit",
    });

  // Serve a fee-schedule-on body with a resolved preview + an overlap.
  function stubWithLookThrough(
    overrides: {
      useFeeScheduleItemCodes?: boolean;
      feeScheduleItemCodes?: string[];
      overlappingCodes?: string[];
    } = {},
  ) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      let body: unknown = {};
      if (url.includes("membership-lockout-settings")) {
        body = {
          settings: {
            mode: "NO_BLOCK",
            financialYearEndMonthOverride: null,
            textFallbackEnabled: false,
            useFeeScheduleItemCodes: overrides.useFeeScheduleItemCodes ?? true,
          },
          feeScheduleItemCodes: overrides.feeScheduleItemCodes ?? [
            "FULL-ADULT",
            "FULL-YOUTH",
          ],
          overlappingCodes: overrides.overlappingCodes ?? ["FULL-ADULT"],
        };
      } else if (url.includes("xero/account-mappings")) {
        body = { subscriptionIncome: { code: "203", itemCode: "SUBS" } };
      } else if (url.includes("xero/chart-of-accounts")) {
        body = { accounts: [{ code: "203", name: "Annual Subs" }] };
      } else if (url.includes("xero/items")) {
        body = { items: [{ code: "SUBS", name: "Subscription" }] };
      } else if (url.includes("xero/organisation")) {
        body = { financialYearEndMonth: 3 };
      } else if (url.includes("age-tier-settings")) {
        body = { settings: [] };
      }
      return { ok: true, status: 200, json: async () => body };
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, calls };
  }

  it("renders the resolved fee-schedule item codes as chips, flagging overlaps", async () => {
    stubWithLookThrough();
    render(<SubscriptionLockoutSettingsPanel permissionMatrix={fullMatrix()} />);

    await waitFor(() => {
      expect(screen.getByText("Item code matching")).toBeTruthy();
    });
    // Both resolved codes show as preview chips.
    expect(screen.getByText("FULL-ADULT")).toBeTruthy();
    expect(screen.getByText("FULL-YOUTH")).toBeTruthy();
    // The overlapping code triggers the warning.
    expect(screen.getByText(/Overlap warning:/)).toBeTruthy();
  });

  it("hides the preview and overlap warning when look-through is off", async () => {
    stubWithLookThrough({
      useFeeScheduleItemCodes: false,
      overlappingCodes: [],
    });
    render(<SubscriptionLockoutSettingsPanel permissionMatrix={fullMatrix()} />);

    await waitFor(() => {
      expect(screen.getByText("Item code matching")).toBeTruthy();
    });
    expect(screen.queryByText(/Overlap warning:/)).toBeNull();
    expect(
      screen.queryByText("Membership fee item codes matched as paid"),
    ).toBeNull();
  });

  it("persists useFeeScheduleItemCodes via the membership route on save", async () => {
    const { calls } = stubWithLookThrough({ overlappingCodes: [] });
    render(<SubscriptionLockoutSettingsPanel permissionMatrix={fullMatrix()} />);

    await waitFor(() => {
      expect(screen.getByText("Item code matching")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));

    await waitFor(() => {
      const put = calls.find(
        (c) =>
          c.url.includes("membership-lockout-settings") &&
          c.init?.method === "PUT",
      );
      expect(put).toBeTruthy();
      expect(JSON.parse(String(put!.init!.body))).toEqual(
        expect.objectContaining({ useFeeScheduleItemCodes: true }),
      );
    });
  });

  it("disables the mode select for a membership view-only admin", async () => {
    stubWithLookThrough();
    render(
      <SubscriptionLockoutSettingsPanel
        permissionMatrix={matrix({
          support: "view",
          membership: "view",
          finance: "edit",
          bookings: "view",
        })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Item code matching")).toBeTruthy();
    });
    // The Radix Select trigger carries the disabled attribute when the
    // membership area is view-only (the mode is a membership setting).
    const trigger = document.getElementById("item-code-mode");
    expect(trigger).toBeTruthy();
    expect(trigger).toHaveProperty("disabled", true);
  });
});

// #5259 review: the admin layout hands every season screen the year-end through
// `ClubSeasonProvider`, and Next keeps that layout across client navigation. A
// save that moves the effective month must refresh the router, or the season
// screens keep the old month while the routes resolve the new one.
describe("SubscriptionLockoutSettingsPanel — year-end change refreshes the layout (#5259)", () => {
  function stubYearEnd(loaded: number, saved: number) {
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      let body: unknown = {};
      if (url.includes("membership-lockout-settings")) {
        const isSave = init?.method === "PUT";
        body = {
          settings: {
            mode: "NO_BLOCK",
            financialYearEndMonthOverride: isSave && saved !== 3 ? saved : null,
            textFallbackEnabled: false,
            useFeeScheduleItemCodes: false,
          },
          financialYear: {
            overrideMonth: null,
            xeroMonth: null,
            effectiveMonth: isSave ? saved : loaded,
          },
          feeScheduleItemCodes: [],
          overlappingCodes: [],
        };
      } else if (url.includes("xero/account-mappings")) {
        body = { subscriptionIncome: { code: null, itemCode: null } };
      } else if (url.includes("age-tier-settings")) {
        body = { settings: [] };
      }
      return { ok: true, status: 200, json: async () => body };
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
  }

  async function saveOnce() {
    render(
      <SubscriptionLockoutSettingsPanel
        permissionMatrix={matrix({
          support: "view",
          membership: "edit",
          finance: "edit",
          bookings: "edit",
        })}
      />,
    );
    const save = await screen.findByRole("button", { name: /Save settings/ });
    fireEvent.click(save);
    const { toast } = await import("sonner");
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalled();
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes the router when the save moves the effective month", async () => {
    stubYearEnd(3, 6);
    await saveOnce();
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh when the effective month is unchanged", async () => {
    stubYearEnd(6, 6);
    await saveOnce();
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
