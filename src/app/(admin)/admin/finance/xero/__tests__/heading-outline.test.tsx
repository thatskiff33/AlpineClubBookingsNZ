// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectSoundOutline } from "@/lib/__tests__/support/heading-outline";

/**
 * Xero Sync's heading outline in every state it renders (#5216,
 * `INV-PUB-006`), with every real panel mounted: the page's "Xero Sync" h1,
 * each card and collapsible section a level 2 under it, and a section's own
 * sub-headings (such as "Targeted force sync") a level 3 inside it. A section
 * whose title were not a heading would hand its sub-headings to the section
 * above it.
 */

const access = vi.hoisted(() => ({ canEdit: true }));
vi.mock("@/components/confirm-its-you", () => ({ fetchWithRecentAuth: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/finance/xero",
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => access.canEdit,
  useAdminAccessToAll: () => access.canEdit,
  useFullAdminEditAccess: () => access.canEdit,
  useAdminAreaViewAccess: () => true,
  useCanOpenAdminPath: () => true,
}));
vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ name: "Test Club" }),
}));

import XeroPage from "../page";

const CONNECTED = { connected: true, needsReentry: false, tenantId: "tenant-1", tokenExpiresAt: null };

/**
 * Answers the connection status read; every panel's own read fails, which
 * each shows in place, so the outline is the one every panel draws around
 * its body.
 */
function serveStatus(status: () => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) =>
      String(input).startsWith("/api/admin/xero/status")
        ? status()
        : Response.json({ error: "unavailable" }, { status: 500 }),
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  access.canEdit = true;
});

describe("/admin/finance/xero heading outline (#5216)", () => {
  it("loading", () => {
    serveStatus(() => new Promise<Response>(() => {}));
    render(<XeroPage />);
    expectSoundOutline("Xero Sync");
  });

  it.each([
    ["an officer who can edit", true],
    ["a view-only officer", false],
  ])("connected, every section mounted, for %s", async (_who, canEdit) => {
    access.canEdit = canEdit;
    serveStatus(() => Response.json(CONNECTED));
    render(<XeroPage />);
    await screen.findByRole("heading", { level: 2, name: "Contact Sync" });

    expectSoundOutline("Xero Sync");
    expect(screen.getByRole("heading", { level: 2, name: /Connection Status/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Targeted force sync" })).toBeInTheDocument();
  });

  it("not connected", async () => {
    serveStatus(() => Response.json({ ...CONNECTED, connected: false, tenantId: null }));
    render(<XeroPage />);
    await screen.findByRole("heading", { level: 2, name: /Connection Status/ });
    expectSoundOutline("Xero Sync");
  });

  it("error: the status read fails", async () => {
    serveStatus(() => Response.json({ error: "down" }, { status: 500 }));
    render(<XeroPage />);
    await screen.findByText(/failed to (load|fetch)/i);
    expectSoundOutline("Xero Sync");
  });
});
