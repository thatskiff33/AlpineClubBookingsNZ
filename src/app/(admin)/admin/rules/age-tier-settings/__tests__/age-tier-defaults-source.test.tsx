// @vitest-environment jsdom

/*
  INV-SSOT-001: the age-tier editor has no built-in tiers of its own.

  `AGE_TIER_DEFAULTS` in `@/lib/policies/age-tier` is the one hard-coded age-tier
  safety net. This page falls back to it when the table is empty and restores it
  on "Restore default tiers". The policy is replaced here with a set no real club
  would carry, so the page can only show those tiers by reading the policy: a
  private copy of the four built-in tiers would show the real ones and fail.
*/

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import AgeTierSettingsPage from "../page";

vi.mock("@/lib/policies/age-tier", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/policies/age-tier")),
  AGE_TIER_DEFAULTS: [
    // The two optional booleans are left out, so the editor's normaliser decides them.
    { tier: "CHILD", minAge: 0, maxAge: 11, label: "Sentinel child", sortOrder: 0 },
    {
      tier: "ADULT",
      minAge: 12,
      maxAge: null,
      label: "Sentinel adult",
      subscriptionRequiredForBooking: false,
      familyGroupRequestCreateMemberAllowed: true,
      sortOrder: 1,
    },
  ],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({}),
  usePathname: () => "/admin",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}));

vi.setConfig({ testTimeout: 45_000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubEmptyTable() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ settings: [] }) })),
  );
}

function labelOf(tier: string) {
  return (document.getElementById(`age-tier-label-${tier}`) as HTMLInputElement | null)
    ?.value;
}

describe("age tier settings built-in tiers", () => {
  it("falls back to the policy defaults when the table is empty", async () => {
    stubEmptyTable();
    render(<AgeTierSettingsPage />);

    await waitFor(() => expect(labelOf("CHILD")).toBe("Sentinel child"));
    expect(labelOf("ADULT")).toBe("Sentinel adult");
    expect(document.getElementById("age-tier-label-INFANT")).toBeNull();
    // An omitted flag takes the normaliser's default; a stated one is kept.
    const flag = (id: string) => document.getElementById(id) as HTMLInputElement | null;
    expect(flag("subscription-required-CHILD")?.checked).toBe(true);
    expect(flag("subscription-required-ADULT")?.checked).toBe(false);
    expect(flag("family-request-create-member-CHILD")?.checked).toBe(false);
    expect(flag("family-request-create-member-ADULT")?.checked).toBe(true);
  });

  it("restores the policy defaults, and offers it only below their count", async () => {
    stubEmptyTable();
    render(<AgeTierSettingsPage />);
    await waitFor(() => expect(labelOf("CHILD")).toBe("Sentinel child"));

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.queryByRole("button", { name: "Restore default tiers" })).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    expect(labelOf("CHILD")).toBeUndefined();

    fireEvent.click(await screen.findByRole("button", { name: "Restore default tiers" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore defaults" }));

    await waitFor(() => expect(labelOf("CHILD")).toBe("Sentinel child"));
    expect(labelOf("ADULT")).toBe("Sentinel adult");
  });
});
