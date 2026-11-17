// @vitest-environment jsdom

/**
 * Paging behaviour of both deletion-request queues (INV-OPS-020, #4960 follow-up).
 *
 * The two queues page through `useAdminQueuePage`, keyed on the status filter,
 * and the Reset button drives both. `admin-queue-pagination-census` reads the
 * source for those calls; this file proves what they do: a filter change or
 * Reset returns BOTH queues to page 1, a page left empty by a decision steps
 * back, and a slower read for a page the officer has left never replaces the
 * list now shown.
 */
import { act, fireEvent, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        accessRoles: [{ role: "ADMIN" }],
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

// A native <select> stands in for the Radix one, which jsdom cannot drive. The
// client only reads its value and `onValueChange`.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
  }: {
    value: string;
    onValueChange: (next: string) => void;
  }) => (
    <select
      aria-label="Filter by status"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      <option value="PENDING">Pending</option>
      <option value="APPROVED">Approved</option>
      <option value="REJECTED">Rejected</option>
      <option value="ALL">All</option>
    </select>
  ),
  SelectContent: () => null,
  SelectItem: () => null,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

import DeletionRequestsClient from "../deletion-requests-client";

const SELF_SERVICE = "/api/admin/deletion-requests";
const ADMIN_INITIATED = "/api/admin/member-lifecycle-action-requests";

interface Queue {
  /** Rows to answer for a page, and the total the route reports. */
  rows: (page: number) => unknown[];
  total: number;
  /** Answer a page later than the others, by resolving the returned gate. */
  hold?: (page: number) => Promise<void> | null;
}

function lifecycleRow(id: string, targetName: string) {
  return {
    id,
    status: "REQUESTED",
    reason: "Duplicate created in error",
    reviewNote: null,
    requestedAt: "2026-07-16T00:00:00.000Z",
    reviewedAt: null,
    requestedByMemberId: "admin-2",
    requestedBy: { id: "admin-2", name: "Other Admin", email: "o@a.test" },
    targetName,
    member: null,
  };
}

/** Answers both queues from `queues` and records every URL asked for. */
function installFetch(queues: Record<string, Queue>) {
  const urls: URL[] = [];
  global.fetch = vi.fn(async (input: unknown) => {
    const url = new URL(String(input), "http://localhost");
    urls.push(url);
    const queue = queues[url.pathname];
    if (!queue) return new Response("{}", { status: 404 });
    const page = Number(url.searchParams.get("page") ?? "1");
    const gate = queue.hold?.(page);
    if (gate) await gate;
    return new Response(
      JSON.stringify({
        requests: queue.rows(page),
        total: queue.total,
        page,
        pageSize: 25,
        totalPages: Math.ceil(queue.total / 25),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return {
    reads(path: string) {
      return urls.filter((url) => url.pathname === path);
    },
    /** Forget what was asked so far, so a later assertion sees only what follows. */
    forget() {
      urls.length = 0;
    },
  };
}

function selfServicePager() {
  return within(screen.getByRole("navigation", { name: "Self-service deletion request pages" }));
}

function adminInitiatedPager() {
  return within(screen.getByRole("navigation", { name: "Admin-initiated deletion request pages" }));
}

const pageOf = (url: URL) => url.searchParams.get("page");

describe("paging both deletion queues (INV-OPS-020)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /** Both queues long enough for a second page; the admin-initiated one shows a row. */
  function twoLongQueues() {
    return installFetch({
      [SELF_SERVICE]: { rows: () => [], total: 60 },
      [ADMIN_INITIATED]: {
        rows: (page) => [lifecycleRow(`del-${page}`, `Record on page ${page}`)],
        total: 30,
      },
    });
  }

  async function moveBothToPageTwo() {
    await screen.findByText("Showing 1–25 of 60");
    await screen.findByText("Showing 1–25 of 30");
    fireEvent.click(selfServicePager().getByRole("button", { name: "Next page" }));
    fireEvent.click(adminInitiatedPager().getByRole("button", { name: "Next page" }));
    await screen.findByText("Showing 26–50 of 60");
    await screen.findByText("Showing 26–30 of 30");
  }

  it("a status change returns both queues to page 1 and reads page 1 for the new filter", async () => {
    const fetched = twoLongQueues();
    render(<DeletionRequestsClient sessionMemberId="admin-1" />);
    await moveBothToPageTwo();
    await screen.findByText("Record on page 2");

    fetched.forget();
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "ALL" } });

    await screen.findByText("Showing 1–25 of 60");
    await screen.findByText("Showing 1–25 of 30");
    await waitFor(() => {
      expect(fetched.reads(SELF_SERVICE).length).toBeGreaterThan(0);
      expect(fetched.reads(ADMIN_INITIATED).length).toBeGreaterThan(0);
    });
    // Every read for the new filter, in either queue, is for page 1: neither
    // queue is read once at its old page 2 under the new filter.
    for (const url of [...fetched.reads(SELF_SERVICE), ...fetched.reads(ADMIN_INITIATED)]) {
      expect(url.searchParams.get("status")).toBe("ALL");
      expect(pageOf(url)).toBe("1");
    }
    await screen.findByText("Record on page 1");
  });

  it("Reset returns both queues to page 1", async () => {
    const fetched = twoLongQueues();
    render(<DeletionRequestsClient sessionMemberId="admin-1" />);
    await moveBothToPageTwo();

    fetched.forget();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    await screen.findByText("Showing 1–25 of 60");
    await screen.findByText("Showing 1–25 of 30");
    await waitFor(() => {
      expect(fetched.reads(SELF_SERVICE).map(pageOf)).toEqual(["1"]);
      expect(fetched.reads(ADMIN_INITIATED).map(pageOf)).toEqual(["1"]);
    });
    await screen.findByText("Record on page 1");
  });

  it("steps back to the new last page when a decision has emptied the page now shown", async () => {
    const lifecycle: Queue = {
      rows: (page) => (page === 1 ? [lifecycleRow("del-1", "Record on page 1")] : []),
      total: 30,
    };
    const fetched = installFetch({
      [SELF_SERVICE]: { rows: () => [], total: 0 },
      [ADMIN_INITIATED]: lifecycle,
    });
    render(<DeletionRequestsClient sessionMemberId="admin-1" />);
    await screen.findByText("Showing 1–25 of 30");

    // Another officer decides the last five while this one is paging: page 2 now
    // comes back empty and the total fits on one page.
    lifecycle.total = 25;
    fireEvent.click(adminInitiatedPager().getByRole("button", { name: "Next page" }));

    await waitFor(() => {
      expect(fetched.reads(ADMIN_INITIATED).map(pageOf)).toEqual(["1", "2", "1"]);
    });
    await screen.findByText("Showing 1–25 of 25");
    await screen.findByText("Record on page 1");
  });

  it("a slower read for a page the officer has left never replaces the list now shown", async () => {
    let releasePageTwo: () => void = () => {};
    const pageTwoGate = new Promise<void>((resolve) => {
      releasePageTwo = resolve;
    });
    const fetched = installFetch({
      [SELF_SERVICE]: { rows: () => [], total: 0 },
      [ADMIN_INITIATED]: {
        rows: (page) => [lifecycleRow(`del-${page}`, `Record on page ${page}`)],
        total: 30,
        // Only the first read of page 2 is slow.
        hold: (page) => (page === 2 ? pageTwoGate : null),
      },
    });
    render(<DeletionRequestsClient sessionMemberId="admin-1" />);
    await screen.findByText("Record on page 1");

    fireEvent.click(adminInitiatedPager().getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(fetched.reads(ADMIN_INITIATED).map(pageOf)).toEqual(["1", "2"]));

    // The officer goes back before page 2 has answered.
    fireEvent.click(adminInitiatedPager().getByRole("button", { name: "Previous page" }));
    await waitFor(() => expect(fetched.reads(ADMIN_INITIATED).map(pageOf)).toEqual(["1", "2", "1"]));
    await screen.findByText("Showing 1–25 of 30");

    // Now the slow page-2 read lands. It must not replace page 1's rows.
    await act(async () => {
      releasePageTwo();
      await pageTwoGate;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByText("Record on page 1")).not.toBeNull();
    expect(screen.queryByText("Record on page 2")).toBeNull();
    expect(screen.getByText("Showing 1–25 of 30")).not.toBeNull();
  });
});
