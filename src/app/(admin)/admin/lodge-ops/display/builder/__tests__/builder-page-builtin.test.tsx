// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// §U1: a built-in board reaches the builder only as Advanced-only (built-ins never
// carry the dlb-root signature). The old path offered "Rebuild in builder", which
// rendered a read-only builder whose Save could never persist and whose "Duplicate
// to customise" button was a no-op — a dead end. The built-in must instead offer a
// real "Duplicate to customise" that forks into a fresh, EDITABLE board.

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => true,
}));

// A built-in template whose body has no builder signature → parseBuilderModel
// returns not-ok → the page shows Advanced-only; its key is a reserved built-in
// key, so the built-in branch renders.
const BUILT_IN_TEMPLATE = {
  id: "builtin-template-everyday-board",
  key: "everyday-board",
  name: "Everyday board",
  layout: {
    id: "builtin-layout-everyday-board",
    bodyHtml: '<div class="eb-grid">{{area:board}}</div>',
    defaultCss: "",
    areas: [],
  },
  slotContent: {},
  cssOverrides: "",
  footerHtml: "<p>Have a nice day</p>",
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  window.history.pushState(
    {},
    "",
    "/admin/display/builder?templateId=builtin-template-everyday-board"
  );
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/admin/lodges")) {
      return jsonResponse({ lodges: [{ id: "lodge-a", name: "Ruapehu", active: true }] });
    }
    if (url.includes("/api/admin/display/templates/")) {
      return jsonResponse({ template: BUILT_IN_TEMPLATE });
    }
    return jsonResponse({}, 404);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Visual builder page — built-in board (§U1)", () => {
  it("offers a working Duplicate-to-customise that lands the author editable", async () => {
    const { default: DisplayBuilderPage } = await import("../page");
    render(<DisplayBuilderPage />);

    // The built-in banner appears, and it does NOT offer the dead-end Rebuild path.
    const duplicate = await screen.findByRole("button", {
      name: /Duplicate to customise/i,
    });
    expect(screen.getByText(/This is a built-in design/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Rebuild in builder/i })
    ).toBeNull();

    fireEvent.click(duplicate);

    // The fork lands in an editable create: a "Create board" action (not a
    // disabled read-only builder) and a pre-filled, editable key/name copy.
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Create board/i })
      ).toBeInTheDocument();
    });
    const key = screen.getByLabelText(/Board key/i) as HTMLInputElement;
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    expect(key.value).toBe("everyday-board-copy");
    expect(name.value).toBe("Everyday board (copy)");
    // The key field is editable (create mode), not locked.
    expect(key).toBeEnabled();
    // The built-in read-only banner is gone (this is a fresh, non-built-in board).
    expect(screen.queryByText(/This is a built-in design/i)).toBeNull();
  });
});
