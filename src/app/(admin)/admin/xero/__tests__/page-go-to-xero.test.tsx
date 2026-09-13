// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// #2261 review: the button and the short-code hook each have their own unit
// tests, but nothing pinned the WIRING between the page and the header button.
// Without this, hardcoding the link's state (or dropping the short code / the
// loading flag on the way through) stays green while the page tells a
// disconnected admin that Xero is connected, sends a connected admin to
// whichever organisation Xero last used, or blames a read that is still in
// flight for a link it cannot yet promise.

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/xero",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ name: "Test Club" }),
}));

// Keep the real "Go to Xero" button and state mapper — they are what the page
// is pinned against here — and stub the data-fetching panels, which are not.
vi.mock("../_components/panels", async () => {
  const actual =
    (await vi.importActual("../_components/go-to-xero-button")) as typeof import("../_components/go-to-xero-button");
  const stub = () => null;
  return {
    GoToXeroButton: actual.GoToXeroButton,
    xeroLinkState: actual.xeroLinkState,
    ConnectionStatusPanel: stub,
    ContactSyncPanel: stub,
    HealthAndDiagnosticsPanels: stub,
    InboundEventsPanel: stub,
    MembershipSyncPanel: stub,
    OperationsPanel: stub,
    SyncResultsPanel: stub,
    UsagePanel: stub,
  };
});

import XeroPage from "../page";

type StubbedResponse = { ok: boolean; json: () => Promise<unknown> };

function ok(body: unknown): StubbedResponse {
  return { ok: true, json: async () => body };
}

/**
 * Serves the two routes the page reads on mount. `organisation: "pending"`
 * leaves the organisation read in flight forever, which is the only way to
 * observe the loading window from outside.
 */
function stubFetch(options: {
  status: Record<string, unknown>;
  organisation: unknown | "pending" | "error";
}) {
  const fetchMock = vi.fn(
    (input: string | URL | Request): Promise<StubbedResponse> => {
      const url = String(input);
      if (url.startsWith("/api/admin/xero/status")) {
        return Promise.resolve(ok(options.status));
      }
      if (url.startsWith("/api/admin/xero/organisation")) {
        if (options.organisation === "pending") {
          return new Promise<StubbedResponse>(() => {});
        }
        if (options.organisation === "error") {
          return Promise.resolve({ ok: false, json: async () => ({}) });
        }
        return Promise.resolve(ok(options.organisation));
      }
      // Everything else on the page (the webhook badge) stays quiet.
      return Promise.resolve({ ok: false, json: async () => ({}) });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function goToXeroLink(name: "Go to Xero" | "Log in to Xero") {
  return screen.findByRole("link", { name }) as Promise<HTMLAnchorElement>;
}

describe("Xero Sync page header 'Go to Xero' wiring (#2261)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("deep-links the page header into THIS organisation", async () => {
    stubFetch({
      status: {
        connected: true,
        needsReentry: false,
        tenantId: "tenant-1",
        tokenExpiresAt: null,
      },
      organisation: {
        name: "Alpine Club",
        financialYearEndMonth: 3,
        shortCode: "!aBc12",
      },
    });

    render(<XeroPage />);

    const link = await goToXeroLink("Go to Xero");
    await waitFor(() =>
      expect(link.getAttribute("href")).toBe(
        "https://go.xero.com/organisationlogin/default.aspx?shortcode=!aBc12&redirecturl=%2FDashboard%2F",
      ),
    );
    expect(link.getAttribute("title")).toBe(
      "Opens this club's Xero organisation in a new tab.",
    );
  });

  it("falls back to the generic Xero link when the organisation read fails", async () => {
    stubFetch({
      status: {
        connected: true,
        needsReentry: false,
        tenantId: "tenant-1",
        tokenExpiresAt: null,
      },
      organisation: "error",
    });

    render(<XeroPage />);

    const link = await goToXeroLink("Go to Xero");
    await waitFor(() =>
      expect(link.getAttribute("title")).toMatch(/could not be read/i),
    );
    expect(link.getAttribute("href")).toBe("https://go.xero.com/Dashboard/");
  });

  it("keeps the explanation neutral while the short code is still being read", async () => {
    stubFetch({
      status: {
        connected: true,
        needsReentry: false,
        tenantId: "tenant-1",
        tokenExpiresAt: null,
      },
      organisation: "pending",
    });

    render(<XeroPage />);

    const link = await goToXeroLink("Go to Xero");
    expect(link.getAttribute("title")).toBe("Opens Xero in a new tab.");
    expect(link.getAttribute("href")).toBe("https://go.xero.com/Dashboard/");
  });

  it("does not promise a connected organisation, or read one, while disconnected", async () => {
    const fetchMock = stubFetch({
      status: {
        connected: false,
        needsReentry: false,
        tenantId: null,
        tokenExpiresAt: null,
      },
      organisation: { shortCode: "!aBc12" },
    });

    render(<XeroPage />);

    const link = await goToXeroLink("Log in to Xero");
    expect(link.getAttribute("title")).toMatch(/not connected to this site/i);
    expect(link.getAttribute("href")).toBe("https://go.xero.com/Dashboard/");
    // The organisation route is never touched without a connection to read.
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).startsWith("/api/admin/xero/organisation"),
      ),
    ).toHaveLength(0);
  });

  it("tells a needs-re-entry connection that signing in to Xero is not reconnecting", async () => {
    stubFetch({
      status: {
        connected: false,
        needsReentry: true,
        tenantId: "tenant-1",
        tokenExpiresAt: null,
      },
      organisation: { shortCode: "!aBc12" },
    });

    render(<XeroPage />);

    const link = await goToXeroLink("Log in to Xero");
    expect(link.getAttribute("title")).toMatch(/reconnect Xero here/i);
  });
});
