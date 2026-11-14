// @vitest-environment jsdom

/*
  The sidebar's Needs Attention counts stay current (#4962).

  The admin layout is persistent, so the sidebar mounts once per admin session.
  It used to fetch its counts on mount and never again: an officer who cleared a
  queue kept seeing the old badge until a full reload, and a failed request read
  as zero everywhere, which looks exactly like "nothing to do". These tests pin
  each refetch trigger (navigation, focus, a tab coming back into view, and the
  `admin-queue-changed` event a queue page fires after a decision) and the
  visible error a failed load leaves behind. The clock is the suite's frozen
  instant (2026-07-01T00:00:00.000Z); nothing here reads elapsed time.
*/

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import {
  ZERO_ADMIN_PENDING_COUNTS,
  type AdminPendingCounts,
} from "@/lib/admin-work-queues";

const navigation = vi.hoisted(() => ({ pathname: "/admin/dashboard" }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
}));

import { AdminSidebar } from "@/components/admin-sidebar";
import { notifyAdminQueueChanged } from "@/lib/admin-queue-events";

const allOn: FeatureFlags = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;

type CountsReply = Partial<AdminPendingCounts> | "reject" | 500;

/** A fetch that answers each pending-counts call with the next queued reply. */
function queueReplies(...replies: CountsReply[]) {
  const pending = [...replies];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (!String(input).includes("/api/admin/pending-counts")) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    // The last reply repeats once the queue runs out.
    const reply = pending.length > 1 ? pending.shift()! : pending[0]!;
    if (reply === "reject") throw new TypeError("Failed to fetch");
    if (reply === 500) {
      return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ...ZERO_ADMIN_PENDING_COUNTS, ...reply }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function countCalls(fetchMock: ReturnType<typeof queueReplies>) {
  return fetchMock.mock.calls.filter(([input]) =>
    String(input).includes("/api/admin/pending-counts"),
  ).length;
}

/**
 * The Issue Reports link's text while it carries a badge, else null. The page
 * is linked twice (Needs Attention and its own section) and both show the
 * badge, so any link with a number in it will do.
 */
function issueReportsBadge(): string | null {
  return (
    screen
      .queryAllByRole("link", { name: /Issue Reports/ })
      .map((link) => link.textContent ?? "")
      .find((text) => /\d/.test(text)) ?? null
  );
}

describe("AdminSidebar pending counts", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
    navigation.pathname = "/admin/dashboard";
  });

  it("refetches after a navigation, so a cleared queue's badge goes", async () => {
    const fetchMock = queueReplies({ issueReports: 2 }, { issueReports: 0 });
    const { rerender } = render(<AdminSidebar features={allOn} />);

    await waitFor(() => expect(issueReportsBadge()).toContain("2"));

    navigation.pathname = "/admin/issue-reports";
    rerender(<AdminSidebar features={allOn} />);

    await waitFor(() => expect(countCalls(fetchMock)).toBe(2));
    await waitFor(() => expect(issueReportsBadge()).toBeNull());
  });

  it("refetches when the window regains focus", async () => {
    const fetchMock = queueReplies({ issueReports: 1 }, { issueReports: 4 });
    render(<AdminSidebar features={allOn} />);
    await waitFor(() => expect(issueReportsBadge()).toContain("1"));

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(issueReportsBadge()).toContain("4"));
    expect(countCalls(fetchMock)).toBe(2);
  });

  it("refetches when the tab becomes visible again", async () => {
    const fetchMock = queueReplies({ issueReports: 1 }, { issueReports: 3 });
    render(<AdminSidebar features={allOn} />);
    await waitFor(() => expect(issueReportsBadge()).toContain("1"));

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(issueReportsBadge()).toContain("3"));
    expect(countCalls(fetchMock)).toBe(2);
  });

  /** A fetch whose first pending-counts load waits for `release`. */
  function holdFirstLoad() {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) await held;
      return {
        ok: true,
        status: 200,
        json: async () => ({ ...ZERO_ADMIN_PENDING_COUNTS, issueReports: calls }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, release: () => release() };
  }

  it("does not load twice when a tab comes back mid-request", async () => {
    const { fetchMock, release } = holdFirstLoad();
    render(<AdminSidebar features={allOn} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // A returning tab fires both; the request in flight is already fresh.
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    release();

    await waitFor(() => expect(issueReportsBadge()).toContain("1"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("queues exactly one more load for decisions made mid-request", async () => {
    const { fetchMock, release } = holdFirstLoad();
    render(<AdminSidebar features={allOn} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // The request may predate these decisions, so one more load follows it.
    act(() => {
      notifyAdminQueueChanged();
      notifyAdminQueueChanged();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release();

    await waitFor(() => expect(issueReportsBadge()).toContain("2"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refetches when a queue page reports a decision", async () => {
    const fetchMock = queueReplies({ issueReports: 1 }, { issueReports: 0 });
    render(<AdminSidebar features={allOn} />);
    await waitFor(() => expect(issueReportsBadge()).toContain("1"));

    act(() => {
      notifyAdminQueueChanged();
    });

    await waitFor(() => expect(issueReportsBadge()).toBeNull());
    expect(countCalls(fetchMock)).toBe(2);
  });

  it("says the counts failed when the request is rejected, and Retry recovers", async () => {
    const fetchMock = queueReplies("reject", { issueReports: 2 });
    render(<AdminSidebar features={allOn} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load counts");
    // The section stays, so the failure is not mistaken for "all clear".
    expect(screen.getByText("Needs Attention")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(issueReportsBadge()).toContain("2"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(countCalls(fetchMock)).toBe(2);
  });

  it("says the counts failed on a server error rather than showing zero", async () => {
    queueReplies(500);
    render(<AdminSidebar features={allOn} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load counts");
    expect(issueReportsBadge()).toBeNull();
  });

  it("keeps the last good badges when a later refetch fails", async () => {
    queueReplies({ issueReports: 2 }, 500);
    render(<AdminSidebar features={allOn} />);
    await waitFor(() => expect(issueReportsBadge()).toContain("2"));

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await screen.findByRole("alert");
    expect(issueReportsBadge()).toContain("2");
  });

  it("names a partial failure while still showing the counts that loaded", async () => {
    queueReplies({ issueReports: 2, unavailable: ["familyRequests"] });
    render(<AdminSidebar features={allOn} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load some counts");
    expect(issueReportsBadge()).toContain("2");
  });
});
