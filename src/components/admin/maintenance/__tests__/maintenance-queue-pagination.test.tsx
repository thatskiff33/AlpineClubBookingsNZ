// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { createContext, useContext, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaintenanceQueueSection } from "@/components/admin/maintenance/maintenance-queue-section";

/**
 * #5202 / INV-OPS-020 — the maintenance queue pages through every report,
 * shows its total, restarts at page 1 on a filter change, steps back from a
 * page left empty, and never lets a slower read replace the page shown.
 */

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => true,
}));

// Each option is a button that picks its value, so a filter change is a click.
vi.mock("@/components/ui/select", async () => {
  const { createElement } = await import("react");
  const Pick = createContext<(value: string) => void>(() => {});
  return {
    Select: ({ children, onValueChange }: { children: ReactNode; onValueChange: (v: string) => void }) =>
      createElement(Pick.Provider, { value: onValueChange }, children),
    SelectContent: ({ children }: { children: ReactNode }) => createElement("div", null, children),
    SelectItem: function SelectItem({ children, value }: { children: ReactNode; value: string }) {
      const pick = useContext(Pick);
      return createElement("button", { type: "button", onClick: () => pick(value) }, children);
    },
    SelectTrigger: () => null,
    SelectValue: () => null,
  };
});

const route = "/api/admin/maintenance-reports";

function report(id: string, summary: string) {
  return {
    id,
    lodge: { id: "lodge-1", name: "Lodge One" },
    source: "MEMBER_PORTAL",
    status: "OPEN",
    summary,
    selfDeclaredName: null,
    selfDeclaredContact: null,
    member: { id: "m-1", firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
    photo: {
      contentType: null,
      capturedAt: null,
      expiresAt: null,
      deletedAt: null,
      deleteReason: null,
      retained: false,
    },
    resolvedAt: null,
    resolutionNote: null,
    createdAt: "2026-06-30T10:00:00.000Z",
    updatedAt: "2026-06-30T10:00:00.000Z",
    answers: [],
  };
}

/** The route's response: one page through the shared `adminListPage` keys. */
function envelope(reports: unknown[], page: number, total: number) {
  return {
    reports,
    lodges: [{ id: "lodge-1", name: "Lodge One" }],
    page,
    pageSize: 25,
    total,
    totalPages: Math.ceil(total / 25),
    outstandingCount: total,
  };
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetch(handler: (url: URL) => unknown | Promise<unknown>) {
  const urls: URL[] = [];
  global.fetch = vi.fn(async (input: unknown) => {
    const url = new URL(String(input), "http://localhost");
    urls.push(url);
    return jsonResponse(await handler(url));
  }) as unknown as typeof fetch;
  return { pages: () => urls.filter((url) => url.pathname === route).map((url) => url.searchParams.get("page")) };
}

function pageOf(url: URL) {
  return Number(url.searchParams.get("page"));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MaintenanceQueueSection paging", () => {
  it("asks for page 1, shows the total, steps through pages and restarts on a filter change", async () => {
    const fetches = installFetch((url) => envelope([report(`r-${pageOf(url)}`, `Fault ${pageOf(url)}`)], pageOf(url), 40));
    render(<MaintenanceQueueSection />);

    expect(await screen.findByText("Showing 1–25 of 40")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Showing 26–40 of 40")).toBeInTheDocument();
    expect(screen.getByText("Fault 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(await screen.findByText("Showing 1–25 of 40")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("Showing 26–40 of 40");
    fireEvent.click(screen.getByRole("button", { name: "Resolved" }));
    await screen.findByText("Showing 1–25 of 40");
    expect(fetches.pages()).toEqual(["1", "2", "1", "2", "1"]);
  });

  it("shows the total line on a single page", async () => {
    installFetch(() => envelope([report("r-1", "Fault 1")], 1, 1));
    render(<MaintenanceQueueSection />);
    expect(await screen.findByText("Showing 1–1 of 1")).toBeInTheDocument();
  });

  it("steps back a page when the page it is on has emptied", async () => {
    let total = 40;
    const fetches = installFetch((url) =>
      pageOf(url) === 2 && total === 25
        ? envelope([], 2, total)
        : envelope([report(`r-${pageOf(url)}`, `Fault ${pageOf(url)}`)], pageOf(url), total),
    );
    render(<MaintenanceQueueSection />);
    await screen.findByText("Showing 1–25 of 40");

    // Another officer resolves the reports on page 2 before it is read.
    total = 25;
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    // The total line is drawn from the stepped-back page number as soon as the
    // empty page 2 is received, in the render before the effect that asks for
    // page 1 again runs. So the third request is awaited, never counted straight after the
    // line appears (#5361: the send history's copy of this order failed once on
    // main).
    await waitFor(() => expect(fetches.pages()).toEqual(["1", "2", "1"]));
    expect(await screen.findByText("Showing 1–25 of 25")).toBeInTheDocument();
    // Page 1's row is back, so the step-back read was answered and shown.
    expect(await screen.findByText("Fault 1")).toBeInTheDocument();
    expect(fetches.pages()).toEqual(["1", "2", "1"]);
  });

  it("never lets a slower read for a page it has left replace the list shown", async () => {
    const slow: { release?: () => void } = {};
    installFetch(async (url) => {
      if (pageOf(url) === 2) {
        await new Promise<void>((resolve) => {
          slow.release = resolve;
        });
        return envelope([report("r-stale", "Stale fault")], 2, 40);
      }
      return envelope([report("r-1", "Fault 1")], 1, 40);
    });
    render(<MaintenanceQueueSection />);
    await screen.findByText("Showing 1–25 of 40");

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(slow.release).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(await screen.findByText("Fault 1")).toBeInTheDocument();

    slow.release!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("Stale fault")).not.toBeInTheDocument();
    expect(screen.getByText("Fault 1")).toBeInTheDocument();
    expect(screen.getByText("Showing 1–25 of 40")).toBeInTheDocument();
  });
});
