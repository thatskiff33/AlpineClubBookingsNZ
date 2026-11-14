// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import DisplayBuilder from "../display-builder";
import { emptyBuilderModel } from "@/lib/lodge-display/builder-model";

// ADR-004 §7 / ADR-003 §5: the builder's Live preview frames /display with
// `sandbox="allow-scripts"` and WITHOUT `allow-same-origin`, so the authored
// HTML/CSS runs at an opaque origin — no cookies, no same-origin DOM, and
// therefore no reach into the admin session that authored it. That attribute is
// the only thing separating admin-authored board markup from the admin session,
// so it is pinned here rather than protected by a comment alone. The sibling
// preview host carries the mirrored assertion in
// `src/app/(admin)/admin/lodge-ops/display/preview/preview-page.test.tsx`.

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderBuilder() {
  return render(
    <DisplayBuilder
      layoutId={null}
      templateId={null}
      initialModel={emptyBuilderModel("columns", 2)}
      initialKey="foyer"
      initialName="Foyer board"
      initialFooterHtml=""
      initialCssOverrides=""
      isBuiltIn={false}
      canEdit
      lodges={[{ id: "lodge-a", name: "Ruapehu" }]}
      onDuplicate={() => undefined}
    />
  );
}

describe("DisplayBuilder — Live preview frame (ADR-004 §7)", () => {
  it("frames the draft in a sandbox with no same-origin escape", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: "signed.draft.grant" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { container } = renderBuilder();
    fireEvent.click(screen.getByRole("button", { name: /Live preview/i }));

    const iframe = await waitFor(() => {
      const frame = container.querySelector("iframe");
      expect(frame).not.toBeNull();
      return frame as HTMLIFrameElement;
    });

    // The security line: scripts allowed, same-origin is NOT — opaque origin.
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
    // The frame carries the short-lived grant, not the admin session.
    expect(iframe.getAttribute("src")).toBe(
      "/display?previewGrant=signed.draft.grant"
    );
    // The grant is minted through the admin-only endpoint from the DRAFT.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/display/preview-grant",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("opens no frame when the draft is refused", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ errors: [{ code: "empty", message: "Add a zone." }] }),
          { status: 400, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const { container } = renderBuilder();
    fireEvent.click(screen.getByRole("button", { name: /Live preview/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByText(/Fix these before previewing/i)).toBeInTheDocument();
    });
    expect(container.querySelector("iframe")).toBeNull();
  });
});
