// @vitest-environment jsdom

/**
 * A refused report load or update says why (#4976, ALP-589).
 *
 * Both parsed the reply as JSON before checking it and alerted `err.message`,
 * so an HTML 502 from the proxy read as a JSON parse error and a dropped
 * connection as "Failed to fetch". The page still reports through
 * `window.alert`; here the alert writes into the document.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { itShowsEveryRefusal } from "@/lib/__tests__/support/failed-write-cases";

const navigation = vi.hoisted(() => ({ searchParams: new URLSearchParams() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => navigation.searchParams }));
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}));
vi.mock("@/components/admin/dataset-reset-button", () => ({ DatasetResetButton: () => null }));
vi.mock("@/components/admin/issue-report-screenshot", () => ({
  IssueReportScreenshotBadge: () => null,
  IssueReportScreenshotPanel: () => null,
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div role="dialog">{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import AdminIssueReportsPage from "../page";

const report = {
  id: "report-1",
  pageUrl: "https://club.example.test/bookings",
  pageTitle: "Bookings",
  description: "The calendar did not load.",
  screenshot: {
    disposition: "none",
    capturedAt: null,
    expiresAt: null,
    deletedAt: null,
    retained: false,
    withheld: false,
    dataUrl: null,
    deletedById: null,
    deleteReason: null,
  },
  browserInfo: { expiresAt: null, deletedAt: null, retained: false, value: null },
  resolvedAt: null,
  resolutionNote: null,
  createdAt: "2026-06-30T00:00:00.000Z",
  member: { id: "member-1", firstName: "Alex", lastName: "Example", email: "alex@example.test" },
};

type Answer = () => Response | Promise<Response>;

function installFetch({ detail, update }: { detail?: Answer; update?: Answer }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/admin/issue-reports/report-1")) {
      if (init?.method === "PATCH") {
        return (update ?? (() => Response.json({ report: { ...report, resolvedAt: "2026-07-01T00:00:00.000Z" } })))();
      }
      return (detail ?? (() => Response.json({ report })))();
    }
    return Response.json({ reports: [report], total: 1, page: 1, pageSize: 20, totalPages: 1 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function viewTheReport() {
  render(<AdminIssueReportsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "View" }));
}

async function resolveTheReport() {
  await viewTheReport();
  fireEvent.click(await screen.findByRole("button", { name: "Resolve" }));
}

const listLoads = (fetchMock: ReturnType<typeof installFetch>) =>
  fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/admin/issue-reports?"));

beforeEach(() => {
  vi.stubGlobal("alert", (message: string) => {
    const said = document.createElement("p");
    said.textContent = message;
    document.body.append(said);
  });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("issue report refusals", () => {
  describe("opening a report", () => {
    itShowsEveryRefusal({
      fallback: "Failed to load report",
      submit: async (answer) => {
        installFetch({ detail: answer });
        await viewTheReport();
      },
    });
  });

  describe("resolving a report", () => {
    itShowsEveryRefusal({
      fallback: "Failed to update report",
      submit: async (answer) => {
        installFetch({ update: answer });
        await resolveTheReport();
      },
    });

    it("shows the resolved report and reloads the list on success", async () => {
      const fetchMock = installFetch({});
      await resolveTheReport();

      expect(await screen.findByRole("button", { name: "Reopen" })).toBeInTheDocument();
      await waitFor(() => expect(listLoads(fetchMock)).toHaveLength(2));
    });
  });
});
