// @vitest-environment jsdom

// #4976: a refused season delete or active toggle used to parse the reply as
// JSON unguarded, so an HTML error page from the proxy in front of the app
// reached the officer as "Unexpected token < in JSON". The refusal is now read
// through the shared error-message helper.

import "@testing-library/jest-dom/vitest";
import { useEffect } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ClubFormatTestProvider } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const WINTER = {
  id: "season-winter",
  name: "Winter 2026",
  type: "WINTER",
  startDate: "2026-06-01T00:00:00.000Z",
  endDate: "2026-09-30T00:00:00.000Z",
  active: true,
};

const HTML_502 = () =>
  new Response("<html>Bad gateway</html>", {
    status: 502,
    headers: { "content-type": "text/html" },
  });

let mutationResponse: () => Response;
let listFetches = 0;

beforeEach(() => {
  listFetches = 0;
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "DELETE" || init?.method === "PUT") return mutationResponse();
      if (url.startsWith("/api/admin/seasons")) {
        listFetches += 1;
        return Response.json([WINTER]);
      }
      throw new Error(`unexpected request: ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPage() {
  return render(
    <ClubFormatTestProvider>
      <ClubTimeProvider zone="Pacific/Auckland" locale={CLUB_FORMAT_TEST.locale}>
        <SeasonsPage />
      </ClubTimeProvider>
    </ClubFormatTestProvider>,
  );
}

async function click(name: string) {
  fireEvent.click(await screen.findByRole("button", { name }));
}

describe("Seasons page: a refused delete or toggle is readable (#4976)", () => {
  it("shows the server's sentence for a 404 delete", async () => {
    mutationResponse = () => Response.json({ error: "Season not found" }, { status: 404 });
    renderPage();
    await click("Delete Winter 2026");

    expect(await screen.findByRole("alert")).toHaveTextContent("Season not found");
  });

  it("shows the fallback, not a parse error, for an HTML delete refusal", async () => {
    mutationResponse = HTML_502;
    renderPage();
    await click("Delete Winter 2026");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to delete");
    expect(alert).not.toHaveTextContent(/JSON/);
  });

  it("shows the fallback, not a parse error, for an HTML toggle refusal", async () => {
    mutationResponse = HTML_502;
    renderPage();
    await click("Deactivate Winter 2026");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to update");
    expect(alert).not.toHaveTextContent(/JSON/);
  });

  it("refreshes the list after a successful delete", async () => {
    mutationResponse = () => Response.json({ success: true });
    renderPage();
    await click("Delete Winter 2026");

    await waitFor(() => expect(listFetches).toBe(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
