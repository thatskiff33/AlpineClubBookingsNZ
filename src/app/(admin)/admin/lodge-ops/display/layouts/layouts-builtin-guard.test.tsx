// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// #1940: the page reads the session permission matrix for view-only gating;
// provide an edit-level admin session so the built-in guard cases keep working.
vi.mock("next-auth/react", () => ({
  useSession: () => ({
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

import AdminDisplayLayoutsPage from "./page";

// Fork issue #156: editing a built-in Layout (`everyday-board` etc.) in place is
// overwritten on the next re-seed/upgrade (#111 refresh-from-code contract). The
// editor must (1) show a persistent notice with a one-click Duplicate action and
// (2) require an explicit confirmation before saving an in-place built-in edit.

const BUILT_IN_ROW = {
  id: "builtin-layout-everyday-board",
  key: "everyday-board",
  name: "Everyday board",
  description: "The daily arrivals board.",
  updatedAt: "2026-07-15T00:00:00.000Z",
  templateCount: 1,
};

const CUSTOM_ROW = {
  id: "layout-custom-1",
  key: "foyer-board",
  name: "Foyer board",
  description: "A custom board.",
  updatedAt: "2026-07-15T00:00:00.000Z",
  templateCount: 0,
};

/** Full authored row the GET /layouts/[id] route returns for a built-in. */
const BUILT_IN_FULL = {
  id: BUILT_IN_ROW.id,
  key: BUILT_IN_ROW.key,
  name: BUILT_IN_ROW.name,
  description: BUILT_IN_ROW.description,
  bodyHtml: '<div class="board">{{area:main}}</div>',
  defaultCss: ".board { width: 100%; }",
  areas: [{ key: "main", description: "The board", kind: "static" }],
};

const CUSTOM_FULL = {
  id: CUSTOM_ROW.id,
  key: CUSTOM_ROW.key,
  name: CUSTOM_ROW.name,
  description: CUSTOM_ROW.description,
  bodyHtml: '<div class="board">{{area:main}}</div>',
  defaultCss: ".board { width: 100%; }",
  areas: [{ key: "main", description: "The board", kind: "static" }],
};

/** Route the page's fetches by URL + method. Records every call for assertions. */
function installFetch() {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });
    if (url === "/api/admin/display/layouts" && method === "GET") {
      return new Response(
        JSON.stringify({ layouts: [BUILT_IN_ROW, CUSTOM_ROW] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url === `/api/admin/display/layouts/${BUILT_IN_ROW.id}` && method === "GET") {
      return new Response(JSON.stringify({ layout: BUILT_IN_FULL }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === `/api/admin/display/layouts/${CUSTOM_ROW.id}` && method === "GET") {
      return new Response(JSON.stringify({ layout: CUSTOM_FULL }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === `/api/admin/display/layouts/${BUILT_IN_ROW.id}` && method === "PUT") {
      return new Response(
        JSON.stringify({ layout: { id: BUILT_IN_ROW.id, key: BUILT_IN_ROW.key, name: BUILT_IN_ROW.name }, warnings: [] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

async function openBuiltIn() {
  render(<AdminDisplayLayoutsPage />);
  // Wait for the list, then open the built-in row in the editor.
  const editButtons = await screen.findAllByRole("button", { name: "Edit" });
  fireEvent.click(editButtons[0]); // first row is the built-in
  await screen.findByText("This is a built-in layout.");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AdminDisplayLayoutsPage — built-in guard", () => {
  beforeEach(() => {
    installFetch();
  });

  it("shows the persistent not-upgrade-safe notice when a built-in is opened", async () => {
    await openBuiltIn();
    expect(screen.getByText(/overwritten/i)).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Duplicate to customise" })
    ).toBeDefined();
  });

  it("Duplicate forks to a new custom layout (notice clears, key suffixed)", async () => {
    await openBuiltIn();
    fireEvent.click(
      screen.getByRole("button", { name: "Duplicate to customise" })
    );
    // The notice is gone — the draft is now a NEW row (id cleared).
    await waitFor(() =>
      expect(screen.queryByText("This is a built-in layout.")).toBeNull()
    );
    const keyInput = screen.getByLabelText("Key") as HTMLInputElement;
    expect(keyInput.value).toBe("everyday-board-copy");
    // A new draft creates rather than edits.
    expect(screen.getByRole("button", { name: "Create layout" })).toBeDefined();
  });

  // #2048 D: built-in layouts are read-only server-side (PUT 409s), so Save never
  // fires a doomed in-place PUT. It offers ONLY the duplicate-to-customise fork.
  // These assert the REAL contract (no PUT for a built-in), not a mocked PUT that
  // would mask the mismatch.
  it("Save on a built-in never fires the doomed PUT; Cancel leaves it open", async () => {
    const { calls } = installFetch();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<AdminDisplayLayoutsPage />);
    const editButtons = await screen.findAllByRole("button", { name: "Edit" });
    fireEvent.click(editButtons[0]);
    await screen.findByText("This is a built-in layout.");

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    // The prompt offers to duplicate (read-only), not to "save anyway".
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toMatch(/read-only/i);
    expect(confirmSpy.mock.calls[0][0]).toMatch(/duplicate/i);
    // Cancelled → no PUT reached the API, and still the built-in (no fork).
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(
      calls.some(
        (c) => c.method === "PUT" && c.url.includes("/api/admin/display/layouts/")
      )
    ).toBe(false);
    expect(screen.getByText("This is a built-in layout.")).toBeDefined();
  });

  it("confirming the built-in Save forks to a duplicate — still no PUT", async () => {
    const { calls } = installFetch();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<AdminDisplayLayoutsPage />);
    const editButtons = await screen.findAllByRole("button", { name: "Edit" });
    fireEvent.click(editButtons[0]);
    await screen.findByText("This is a built-in layout.");

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    // Confirming duplicates rather than saving: the draft becomes a new custom
    // layout (key suffixed, Create action), and no PUT is ever sent.
    await waitFor(() =>
      expect(screen.queryByText("This is a built-in layout.")).toBeNull()
    );
    const keyInput = screen.getByLabelText("Key") as HTMLInputElement;
    expect(keyInput.value).toBe("everyday-board-copy");
    expect(screen.getByRole("button", { name: "Create layout" })).toBeDefined();
    expect(
      calls.some(
        (c) => c.method === "PUT" && c.url.includes("/api/admin/display/layouts/")
      )
    ).toBe(false);
  });

  it("a custom layout shows no built-in notice", async () => {
    render(<AdminDisplayLayoutsPage />);
    const editButtons = await screen.findAllByRole("button", { name: "Edit" });
    // The custom row is second; its non-reserved key must never trip the notice.
    fireEvent.click(editButtons[1]);
    await waitFor(() => {
      const nameInput = screen.getByLabelText("Name") as HTMLInputElement;
      expect(nameInput.value).toBe(CUSTOM_ROW.name);
    });
    expect(screen.queryByText("This is a built-in layout.")).toBeNull();
  });
});
