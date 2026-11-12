// @vitest-environment jsdom

/**
 * A refused season save on Fees → Hut Fees says why (#4976 follow-up).
 *
 * The save handler used to `await res.json()` on every failure, so an HTML 502
 * from the proxy in front of the app reached the officer as "Unexpected token <
 * in JSON". The failure is now read through `apiErrorMessageFromResponse`: the
 * route's own sentence when it sent one, this screen's fallback otherwise.
 */

import "@testing-library/jest-dom/vitest";
import { useEffect } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/lodge-select", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/components/lodge-select");
  return {
    ...actual,
    initialLodgeIdFromLocation: () => null,
    useLodgeOptions: () => ({
      lodges: [{ id: "lodge-a", name: "Lodge A" }],
      loading: false,
      failed: false,
      forbidden: false,
      reload: vi.fn(),
    }),
    LodgeSelect: ({
      lodges,
      value,
      onChange,
    }: {
      lodges: ReadonlyArray<{ id: string; name: string }>;
      value: string | null;
      onChange: (value: string | null) => void;
    }) => {
      useEffect(() => {
        if (!value && lodges[0]) onChange(lodges[0].id);
      }, [lodges, onChange, value]);
      return <div data-testid="lodge-select" />;
    },
  };
});

import { ClubTimeTestProvider } from "@/lib/__tests__/support/club-time-render";
import { HutFeesSection } from "../hut-fees-section";

const FULL = {
  id: "type-full",
  key: "FULL",
  name: "Full",
  bookingBehavior: "MEMBER_RATE",
  ageGroupsApply: false,
  isActive: true,
};

const WINTER = {
  id: "season-1",
  name: "Winter 2026",
  type: "WINTER",
  startDate: "2026-06-01T00:00:00.000Z",
  endDate: "2026-09-30T00:00:00.000Z",
  active: true,
  flatWholeLodgeNightCents: null,
  membershipTypeRates: [
    { membershipTypeId: FULL.id, ageTier: null, pricePerNightCents: 4500 },
  ],
};

function mockSave(answer: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/admin/seasons/") && init?.method === "PUT") return answer();
    if (url.startsWith("/api/admin/age-tier-settings")) return Response.json({ settings: [] });
    if (url.startsWith("/api/admin/membership-types")) {
      return Response.json({ membershipTypes: [FULL] });
    }
    if (url.startsWith("/api/admin/seasons")) return Response.json([WINTER]);
    throw new Error(`unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function saveSeason() {
  render(<HutFeesSection canEdit={true} />, { wrapper: ClubTimeTestProvider });
  fireEvent.click(await screen.findByRole("button", { name: "Edit Winter 2026" }));
  fireEvent.click(screen.getByRole("button", { name: "Update Season" }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Hut Fees: a refused season save says why", () => {
  it("shows the route's own sentence from a JSON refusal", async () => {
    mockSave(() => Response.json({ error: "Season not found" }, { status: 404 }));
    await saveSeason();

    expect(await screen.findByText("Season not found")).toBeInTheDocument();
  });

  it.each([500, 502])("shows the fallback, not a parse error, for an HTML %i", async (status) => {
    mockSave(
      () =>
        new Response("<html><body>Bad Gateway</body></html>", {
          status,
          headers: { "content-type": "text/html" },
        }),
    );
    await saveSeason();

    expect(await screen.findByText("Failed to save season")).toBeInTheDocument();
    expect(screen.queryByText(/JSON/)).not.toBeInTheDocument();
  });

  it("shows the fallback when the request never gets an answer", async () => {
    mockSave(() => Promise.reject(new TypeError("Failed to fetch")));
    await saveSeason();

    expect(await screen.findByText("Failed to save season")).toBeInTheDocument();
    expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
  });

  it("closes the form and reloads the seasons on success", async () => {
    const fetchMock = mockSave(() => Response.json(WINTER));
    await saveSeason();

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Update Season" })).not.toBeInTheDocument(),
    );
    const listReads = fetchMock.mock.calls.filter(
      ([input, init]) => String(input).startsWith("/api/admin/seasons") && init?.method !== "PUT",
    );
    expect(listReads.length).toBeGreaterThanOrEqual(2);
  });
});
