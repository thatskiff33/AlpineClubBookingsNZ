// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// #2048 E: a CUSTOM template (its own key is not reserved) can be bound to a
// BUILT-IN layout. The layout is read-only server-side, so a Rebuild-then-Save
// would 409 on the layout PUT with a message blaming the wrong entity. The
// Advanced-only branch must detect the built-in LAYOUT (not just a built-in
// template) and offer the paths that actually work — duplicate-to-customise into
// a fresh builder board, and Advanced mode — never Rebuild.

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => true,
}));

// Custom template key ("foyer-board") on a built-in layout ("everyday-board").
// Its body carries no dlb-root signature → parseBuilderModel fails → Advanced-only.
const CUSTOM_ON_BUILTIN_LAYOUT = {
  id: "template-foyer-board",
  key: "foyer-board",
  name: "Foyer board",
  layout: {
    id: "builtin-layout-everyday-board",
    key: "everyday-board",
    bodyHtml: '<div class="eb-grid">{{area:board}}</div>',
    defaultCss: "",
    areas: [{ key: "board", description: "The board", kind: "static" }],
  },
  slotContent: {},
  cssOverrides: "",
  footerHtml: "<p>Welcome</p>",
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
    "/admin/display/builder?templateId=template-foyer-board"
  );
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/admin/lodges")) {
      return jsonResponse({ lodges: [{ id: "lodge-a", name: "Ruapehu", active: true }] });
    }
    if (url.includes("/api/admin/display/templates/")) {
      return jsonResponse({ template: CUSTOM_ON_BUILTIN_LAYOUT });
    }
    return jsonResponse({}, 404);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Visual builder page — custom template on a built-in layout (§2048 E)", () => {
  it("explains the layout is built-in and offers duplicate/Advanced, never Rebuild", async () => {
    const { default: DisplayBuilderPage } = await import("../page");
    render(<DisplayBuilderPage />);

    // The layout-built-in banner appears (not the generic hand-edited one) and it
    // does NOT offer the doomed Rebuild path.
    await screen.findByText(/This board's layout is a built-in/i);
    expect(
      screen.queryByRole("button", { name: /Rebuild in builder/i })
    ).toBeNull();
    // Advanced mode is offered as a working in-place path.
    expect(
      screen.getAllByRole("link", { name: /Advanced mode/i }).length
    ).toBeGreaterThan(0);

    // Duplicate-to-customise lands an editable fresh board (Create action), with
    // the custom key suffixed — never a read-only builder.
    fireEvent.click(
      await screen.findByRole("button", { name: /Duplicate to customise/i })
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Create board/i })
      ).toBeInTheDocument();
    });
    const key = screen.getByLabelText(/Board key/i) as HTMLInputElement;
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    expect(key.value).toBe("foyer-board-copy");
    expect(name.value).toBe("Foyer board (copy)");
    expect(key).toBeEnabled();
    expect(screen.queryByText(/This board's layout is a built-in/i)).toBeNull();
  });
});
