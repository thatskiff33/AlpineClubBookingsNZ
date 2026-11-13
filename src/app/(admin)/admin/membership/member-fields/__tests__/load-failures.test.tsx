// @vitest-environment jsdom

/**
 * A refused member-fields load says why (#4976, ALP-589).
 *
 * The load parsed every reply as JSON, so an HTML 502 from the proxy read as
 * a JSON parse error. It now parses with a catch, like the save beside it.
 * A request that never gets an answer is the shared section hook's to word,
 * so these cases cover the two readable refusals only.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import { htmlErrorPage } from "@/lib/__tests__/support/failed-write-cases";

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    status: "authenticated",
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

import AdminMemberFieldsPage from "../page";

function loadWith(answer: () => Response) {
  vi.stubGlobal("fetch", vi.fn(async () => answer()));
  render(<AdminMemberFieldsPage />);
}

describe("loading member-field settings", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the route's own sentence from a JSON refusal", async () => {
    loadWith(() => Response.json({ error: "Settings are unavailable." }, { status: 404 }));

    expect(await screen.findByText("Settings are unavailable.")).toBeInTheDocument();
  });

  it.each([500, 502])("shows the fallback, not a parse error, for an HTML %i", async (status) => {
    loadWith(() => htmlErrorPage(status));

    expect(await screen.findByText("Failed to load settings")).toBeInTheDocument();
    expect(screen.queryByText(/JSON/)).not.toBeInTheDocument();
  });
});
