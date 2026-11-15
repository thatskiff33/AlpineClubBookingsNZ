// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeEvent, ReactNode } from "react";

/**
 * #4960 / INV-OPS-019: the cancellation and archive queues are each capped at
 * 25 rows a page by their routes. Each shows its total, pages on its own,
 * keeps its page in the URL, and the cancellation filter restarts at page 1.
 */

const navigation = vi.hoisted(() => ({ search: "", replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace, push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    status: "authenticated",
    data: { user: { id: "admin-1", adminPermissionMatrix: { membership: "edit" } } },
  }),
}));

// The filter is a Radix Select, which jsdom cannot drive; a native select
// keeps its value and change wiring.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children?: ReactNode;
    value?: string;
    onValueChange?: (value: string) => void;
  }) => (
    <select
      aria-label="Filter requests"
      value={value}
      onChange={(event: ChangeEvent<HTMLSelectElement>) => onValueChange?.(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children?: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
}));

import MembershipCancellationsPage from "@/app/(admin)/admin/membership/membership-cancellations/page";

function cancellationRequest(id: string) {
  return {
    id,
    status: "COMPLETED",
    reason: `Moving overseas (${id})`,
    adminNote: null,
    submittedAt: "2026-06-01T00:00:00.000Z",
    reviewedAt: null,
    completedAt: null,
    requestedBy: { id: "admin-2", name: "Other Admin", email: "o@a.test" },
    reviewedBy: null,
    participants: [],
  };
}

function archiveRequest(id: string) {
  return {
    id,
    memberId: `member-${id}`,
    action: "ARCHIVE",
    status: "REQUESTED",
    reason: `Duplicate record (${id})`,
    reviewNote: null,
    requestedAt: "2026-06-01T00:00:00.000Z",
    reviewedAt: null,
    processedAt: null,
    requestedBy: { id: "admin-2", name: "Other Admin", email: "o@a.test" },
    reviewedBy: null,
    member: null,
  };
}

function envelope(rows: unknown[], page: number, total: number, pendingCount: number) {
  return { requests: rows, pendingCount, page, pageSize: 25, total, totalPages: Math.ceil(total / 25) };
}

let cancellationUrls: URL[];
let archiveUrls: URL[];

beforeEach(() => {
  vi.clearAllMocks();
  navigation.search = "";
  cancellationUrls = [];
  archiveUrls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      const page = Number(url.searchParams.get("page"));
      if (url.pathname === "/api/admin/member-lifecycle-action-requests") {
        archiveUrls.push(url);
        return { ok: true, json: async () => envelope([archiveRequest(`a${page}`)], page, 30, 30) };
      }
      cancellationUrls.push(url);
      return { ok: true, json: async () => envelope([cancellationRequest(`c${page}`)], page, 60, 0) };
    }),
  );
});

describe("membership cancellation queue paging (#4960)", () => {
  it("shows each queue's total and pages the cancellation queue on its own", async () => {
    render(<MembershipCancellationsPage />);

    expect(await screen.findByText("Showing 1–25 of 60")).toBeInTheDocument();
    expect(await screen.findByText("Showing 1–25 of 30")).toBeInTheDocument();
    expect(cancellationUrls[0].searchParams.get("page")).toBe("1");
    expect(archiveUrls[0].searchParams.get("page")).toBe("1");

    const cancellationPager = screen.getByRole("navigation", { name: "Cancellation request pages" });
    fireEvent.click(cancellationPager.querySelector('[aria-label="Next page"]')!);
    expect(await screen.findByText("Showing 26–50 of 60")).toBeInTheDocument();
    expect(cancellationUrls.at(-1)!.searchParams.get("page")).toBe("2");
    // The archive queue stays where it was.
    expect(screen.getByText("Showing 1–25 of 30")).toBeInTheDocument();
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenLastCalledWith("/admin/membership-cancellations?page=2", {
        scroll: false,
      }),
    );

    fireEvent.change(screen.getByLabelText("Filter requests"), { target: { value: "ALL" } });
    await waitFor(() => expect(cancellationUrls.at(-1)!.searchParams.get("status")).toBe("ALL"));
    expect(cancellationUrls.at(-1)!.searchParams.get("page")).toBe("1");
  });

  it("pages the archive queue and keeps its page in the URL", async () => {
    render(<MembershipCancellationsPage />);

    const archivePager = await screen.findByRole("navigation", { name: "Archive request pages" });
    fireEvent.click(archivePager.querySelector('[aria-label="Next page"]')!);
    expect(await screen.findByText("Showing 26–30 of 30")).toBeInTheDocument();
    expect(archiveUrls.at(-1)!.searchParams.get("page")).toBe("2");
    expect(archiveUrls.at(-1)!.searchParams.get("status")).toBe("REQUESTED");
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenLastCalledWith(
        "/admin/membership-cancellations?archivePage=2",
        { scroll: false },
      ),
    );
  });

  it("opens on the filter and pages the URL names", async () => {
    navigation.search = "status=COMPLETED&page=3&archivePage=2";
    render(<MembershipCancellationsPage />);

    expect(await screen.findByText("Showing 51–60 of 60")).toBeInTheDocument();
    expect(await screen.findByText("Showing 26–30 of 30")).toBeInTheDocument();
    expect(cancellationUrls[0].searchParams.get("status")).toBe("COMPLETED");
  });
});

/*
  The page-2 read of one queue is held while the officer goes back to page 1.
  Its late answer must not put page 2's rows under page 1's pager, and the pager
  is the same focused button through the load (INV-OPS-019). Each queue has its
  own guard, so each is proved on its own.
*/
describe("membership queue paging under a slow read (#4960)", () => {
  const queues = [
    {
      name: "cancellation",
      path: "/api/admin/membership-cancellation-requests",
      pager: "Cancellation request pages",
      row: (page: number) => cancellationRequest(`c${page}`),
      reason: (page: number) => new RegExp(`Moving overseas \\(c${page}\\)`),
      pendingCount: 0,
    },
    {
      name: "archive",
      path: "/api/admin/member-lifecycle-action-requests",
      pager: "Archive request pages",
      row: (page: number) => archiveRequest(`a${page}`),
      reason: (page: number) => new RegExp(`Duplicate record \\(a${page}\\)`),
      pendingCount: 100,
    },
  ];

  function serveSlowSecondPage(path: string, row: (page: number) => unknown, pendingCount: number, failure: boolean) {
    const slow: { release?: () => void } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        const page = Number(url.searchParams.get("page"));
        if (url.pathname === path && page === 2) {
          await new Promise<void>((resolve) => {
            slow.release = resolve;
          });
          if (failure) return { ok: false, json: async () => ({ error: "Stale read failed" }) };
        }
        const isArchive = url.pathname === "/api/admin/member-lifecycle-action-requests";
        const rowFor = url.pathname === path ? row(page) : isArchive ? archiveRequest(`a${page}`) : cancellationRequest(`c${page}`);
        return { ok: true, json: async () => envelope([rowFor], page, 100, pendingCount) };
      }),
    );
    return slow;
  }

  it.each(queues)("$name queue: keeps its pager focused through a load and ignores a slower read for a page left", async ({ path, pager, row, reason, pendingCount }) => {
    const slow = serveSlowSecondPage(path, row, pendingCount, false);
    render(<MembershipCancellationsPage />);
    const nav = await screen.findByRole("navigation", { name: pager });
    await waitFor(() => expect(within(nav).getByText("Showing 1–25 of 100")).toBeInTheDocument());

    const next = within(nav).getByRole("button", { name: "Next page" });
    next.focus();
    fireEvent.click(next);
    await waitFor(() => expect(slow.release).toBeDefined());
    expect(within(screen.getByRole("navigation", { name: pager })).getByRole("button", { name: "Next page" })).toBe(next);
    expect(document.activeElement).toBe(next);

    fireEvent.click(within(screen.getByRole("navigation", { name: pager })).getByRole("button", { name: "Previous page" }));
    expect(await screen.findByText(reason(1))).toBeInTheDocument();

    slow.release!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText(reason(2))).not.toBeInTheDocument();
    expect(screen.getByText(reason(1))).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: pager })).getByText("Showing 1–25 of 100")).toBeInTheDocument();
  });

  it.each(queues)("$name queue: a slower failed read for a page left shows no error", async ({ path, pager, row, reason, pendingCount }) => {
    const slow = serveSlowSecondPage(path, row, pendingCount, true);
    render(<MembershipCancellationsPage />);
    const nav = await screen.findByRole("navigation", { name: pager });
    await waitFor(() => expect(within(nav).getByText("Showing 1–25 of 100")).toBeInTheDocument());

    fireEvent.click(within(nav).getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(slow.release).toBeDefined());
    fireEvent.click(within(screen.getByRole("navigation", { name: pager })).getByRole("button", { name: "Previous page" }));
    expect(await screen.findByText(reason(1))).toBeInTheDocument();

    slow.release!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("Stale read failed")).not.toBeInTheDocument();
    expect(screen.getByText(reason(1))).toBeInTheDocument();
  });
});
