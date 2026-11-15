// @vitest-environment jsdom

/**
 * A refused age-tier save says why (ALP-649, #4976 follow-up).
 *
 * The save parsed the reply as JSON before checking `ok`, so an HTML error page
 * from the proxy in front of the app fell into the catch and reached the
 * officer as "Network error". The refusal is now thrown through
 * `apiRefusalFromResponse`: the route's own sentence when it sent one, this
 * screen's fallback otherwise, and the fallback again when the request never
 * arrives. A 403 keeps its own permission sentence.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_FORBIDDEN_SAVE_REASON } from "@/components/admin/view-only-action";
import { itShowsEveryRefusal } from "@/lib/__tests__/support/failed-write-cases";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}));

import AgeTierSettingsPage from "../page";

async function saveTiers(answer: () => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "PUT" ? answer() : Response.json({ settings: [] }),
    ),
  );
  render(<AgeTierSettingsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.click(await screen.findByRole("button", { name: "Save Changes" }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Age tier settings: a refused save says why", () => {
  itShowsEveryRefusal({ submit: saveTiers, fallback: "Failed to save" });

  it("keeps the permission sentence for a 403", async () => {
    await saveTiers(() => Response.json({ error: "Forbidden" }, { status: 403 }));
    expect(await screen.findByText(ADMIN_FORBIDDEN_SAVE_REASON)).toBeInTheDocument();
  });

  it("confirms a successful save", async () => {
    await saveTiers(() => Response.json({ settings: [] }));
    expect(await screen.findByText("Age tier settings saved successfully.")).toBeVisible();
    expect(document.getElementById("age-tier-save-error")).toBeEmptyDOMElement();
  });
});
