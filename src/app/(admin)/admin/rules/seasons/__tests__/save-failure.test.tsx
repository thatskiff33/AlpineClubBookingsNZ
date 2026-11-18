// @vitest-environment jsdom

/**
 * A refused season window save says why (#4976 follow-up).
 *
 * Kept beside `delete-and-toggle-failure.test.tsx` (the refused delete and
 * toggle) rather than in `page.test.tsx`, which pins the schedule itself.
 */

import "@testing-library/jest-dom/vitest";
import { useEffect } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ClubFormatTestProvider } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FROZEN_TEST_CLOCK_BASE_ISO } from "@/lib/__tests__/helpers/clock";

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}));

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

import { ClubTimeProvider } from "@/components/club-time-provider";
import SeasonsPage from "../page";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

type SeasonPayload = {
  id: string;
  name: string;
  type: string;
  startDate: string;
  endDate: string;
  active: boolean;
};

function season(overrides: Partial<SeasonPayload> = {}): SeasonPayload {
  return {
    id: "season-winter",
    name: "Winter 2026",
    type: "WINTER",
    startDate: "2026-06-01T00:00:00.000Z",
    endDate: "2026-09-30T00:00:00.000Z",
    active: true,
    ...overrides,
  };
}

function renderPage() {
  return render(
    <ClubFormatTestProvider>
      <ClubTimeProvider zone="Pacific/Auckland" locale={CLUB_FORMAT_TEST.locale}>
        <SeasonsPage />
      </ClubTimeProvider>
    </ClubFormatTestProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.setSystemTime(new Date(FROZEN_TEST_CLOCK_BASE_ISO));
});

/*
  #4976 follow-up: a refused save showed whatever `await res.json()` threw. An
  HTML 502 from the proxy in front of the app reached the officer as
  "Unexpected token < in JSON". The failure is now read through
  `apiErrorMessageFromResponse`, so the route's own sentence or this screen's
  fallback is what an officer sees.
*/
describe("Seasons page: a refused window save says why", () => {
  function mockSave(answer: () => Response | Promise<Response>) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/admin/seasons/") && init?.method === "PUT") return answer();
      if (url.startsWith("/api/admin/seasons")) return Response.json([season()]);
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function saveWindow() {
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit window of Winter 2026" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Update Season" }));
  }

  it("shows the route's own sentence from a JSON refusal", async () => {
    mockSave(() => Response.json({ error: "Season not found" }, { status: 404 }));
    await saveWindow();

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
    await saveWindow();

    expect(await screen.findByText("Failed to save season")).toBeInTheDocument();
    expect(screen.queryByText(/JSON/)).not.toBeInTheDocument();
  });

  it("shows the fallback when the request never gets an answer", async () => {
    mockSave(() => Promise.reject(new TypeError("Failed to fetch")));
    await saveWindow();

    expect(await screen.findByText("Failed to save season")).toBeInTheDocument();
    expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
  });

  it("closes the form and reloads the schedule on success", async () => {
    const fetchMock = mockSave(() => Response.json(season()));
    await saveWindow();

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Update Season" })).not.toBeInTheDocument(),
    );
    const listReads = fetchMock.mock.calls.filter(
      ([input, init]) => String(input).startsWith("/api/admin/seasons") && init?.method !== "PUT",
    );
    expect(listReads.length).toBeGreaterThanOrEqual(2);
  });
});
