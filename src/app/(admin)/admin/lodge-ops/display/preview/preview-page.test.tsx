// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminDisplayPreviewPage from "./page";

// LTV-036 (ADR-003 §5): the sandboxed preview host. It mints a grant, then
// frames /display with `sandbox="allow-scripts"` — WITHOUT allow-same-origin,
// so the framed authored HTML/CSS runs at an opaque origin and can never reach
// the admin session. The lodge is labelled, never a silent default (#64).

beforeEach(() => {
  window.history.pushState(
    {},
    "",
    "/admin/display/preview?templateId=tpl-1&templateName=Foyer%20board&previewLodge=lodge-b"
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

describe("AdminDisplayPreviewPage", () => {
  it("mints a grant and frames /display in a sandbox with no same-origin escape", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          token: "signed.grant.blob",
          lodgeId: "lodge-b",
          lodgeName: "Ruapehu Lodge",
          expiresInSeconds: 300,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<AdminDisplayPreviewPage />);
    await act(async () => {
      await Promise.resolve();
    });

    // The grant was requested from the admin-only endpoint with the template.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/display/preview-grant",
      expect.objectContaining({ method: "POST" })
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toMatchObject({
      templateId: "tpl-1",
      previewLodge: "lodge-b",
    });

    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    // The security line: scripts allowed, same-origin is NOT — opaque origin.
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe?.getAttribute("sandbox")).not.toContain("allow-same-origin");
    // The frame carries the grant, not a session.
    expect(iframe?.getAttribute("src")).toContain(
      "previewGrant=signed.grant.blob"
    );

    // The lodge is explicit on the page chrome.
    expect(screen.getAllByText(/Ruapehu Lodge/).length).toBeGreaterThan(0);
  });

  it("shows an error and no frame when the grant is refused", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ error: "Template not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<AdminDisplayPreviewPage />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText(/Template not found/)).toBeDefined();
    expect(container.querySelector("iframe")).toBeNull();
  });
});
