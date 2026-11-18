// @vitest-environment jsdom

/**
 * A refused member-fields load says why (#4976, ALP-589).
 *
 * The load parsed every reply as JSON, so an HTML 502 from the proxy read as
 * a JSON parse error. It now parses with a catch, like the save beside it.
 * A request that never gets an answer showed the browser's "Failed to fetch"
 * until the shared section hook worded it with the page's fallback (ALP-650).
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, vi } from "vitest";
import { itShowsEveryRefusal } from "@/lib/__tests__/support/failed-write-cases";

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

function loadWith(answer: () => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(async () => answer()));
  render(<AdminMemberFieldsPage />);
}

describe("loading member-field settings", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  itShowsEveryRefusal({
    submit: async (answer) => loadWith(answer),
    fallback: "Failed to load settings",
  });
});
