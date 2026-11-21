// @vitest-environment jsdom

/**
 * A refused promo-code write says why (#4976, ALP-589).
 *
 * Save, delete, restore and activate used to `await res.json()` on every
 * failure, so an HTML 502 from the proxy in front of the app reached the
 * officer as "Unexpected token < in JSON", and a dropped connection as the
 * browser's "Failed to fetch". Each now reads the failure through
 * `apiErrorMessageFromResponse`.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import { itShowsEveryRefusal } from "@/lib/__tests__/support/failed-write-cases";

vi.mock("@/components/lodge-select", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  useLodgeOptions: () => ({
    lodges: [{ id: "lodge-a", name: "Lodge A" }],
    loading: false,
    failed: false,
    forbidden: false,
    reload: vi.fn(),
  }),
}));

import { PromoCodesPageClient } from "../promo-codes-page-client";

const EDIT: AdminPermissionMatrix = {
  overview: "edit",
  bookings: "edit",
  membership: "edit",
  finance: "none",
  lodge: "edit",
  content: "edit",
  support: "edit",
};

function promo(overrides: Record<string, unknown> = {}) {
  return {
    id: "promo-1",
    code: "WINTER20",
    description: null,
    type: "PERCENTAGE",
    valueCents: null,
    percentOff: 20,
    freeNightsPerIndividual: null,
    lifetimeFreeNightsCap: null,
    fixedNightlyPriceCents: null,
    fixedNightlyMode: null,
    maxNightlyValueCents: null,
    maxGuestsPerBooking: null,
    maxRedemptionsTotal: null,
    maxUniqueMembersTotal: null,
    maxUsesPerMember: null,
    currentRedemptions: 0,
    validFrom: null,
    validUntil: null,
    bookingStartFrom: null,
    bookingStartUntil: null,
    membersOnly: false,
    memberGuestsOnly: false,
    assignedMembersOnlyOwnNights: null,
    xeroItemCode: null,
    xeroAccountCode: null,
    active: true,
    archivedAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    redemptions: [],
    totalRedemptionCount: 0,
    benefitFreeRedemptionCount: 0,
    assignments: [],
    lodgeIds: [],
    ...overrides,
  };
}

function mockWrite(method: string, answer: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/admin/promo-codes") && init?.method === method) return answer();
    if (url === "/api/admin/promo-codes?archived=true") {
      return Response.json([promo({ id: "promo-2", code: "OLD", archivedAt: "2026-05-01T00:00:00.000Z" })]);
    }
    if (url === "/api/admin/promo-codes") return Response.json([promo()]);
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function listReads(fetchMock: ReturnType<typeof mockWrite>) {
  return fetchMock.mock.calls.filter(
    ([input, init]) => String(input) === "/api/admin/promo-codes" && !init?.method,
  ).length;
}

async function press(method: string, button: RegExp, answer: () => Response | Promise<Response>) {
  const fetchMock = mockWrite(method, answer);
  render(<PromoCodesPageClient permissionMatrix={EDIT} />);
  if (method === "PATCH") {
    fireEvent.click(await screen.findByRole("button", { name: /Archived Promo Codes/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
  } else if (method === "POST") {
    fireEvent.click(await screen.findByRole("button", { name: "Add Promo Code" }));
    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: "SPRING10" } });
    // Submit the form directly: jsdom would hold a click back on the form's
    // other `required` inputs, which this test does not fill.
    fireEvent.submit(screen.getByRole("button", { name: "Create Promo Code" }).closest("form")!);
  } else {
    fireEvent.click(await screen.findByRole("button", { name: button }));
  }
  return fetchMock;
}

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const HANDLERS = [
  { name: "create", method: "POST", button: /Create Promo Code/, fallback: "Failed to save promo code" },
  { name: "delete", method: "DELETE", button: /^Delete$/, fallback: "Failed to delete" },
  { name: "restore", method: "PATCH", button: /^Restore$/, fallback: "Failed to restore" },
  { name: "deactivate", method: "PUT", button: /^Deactivate$/, fallback: "Failed to update" },
] as const;

for (const handler of HANDLERS) {
  describe(`Promo codes: a refused ${handler.name} says why`, () => {
    itShowsEveryRefusal({
      fallback: handler.fallback,
      submit: async (answer) => {
        await press(handler.method, handler.button, answer);
      },
    });

    it("reloads the codes on success", async () => {
      const fetchMock = await press(handler.method, handler.button, () =>
        Response.json(promo()),
      );
      await waitFor(() => expect(listReads(fetchMock)).toBeGreaterThanOrEqual(2));
      expect(screen.queryByText(handler.fallback)).not.toBeInTheDocument();
    });
  });
}
