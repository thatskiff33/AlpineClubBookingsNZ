// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #4969: every tab shows its pending count, from the one payload the sidebar
// badge adds up, and a bare link opens on the first tab with work.

const nav = vi.hoisted(() => {
  let query = "";
  const listeners = new Set<() => void>();
  return {
    get query() {
      return query;
    },
    setQuery(next: string) {
      query = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

// A router whose `replace` really moves the URL, so a test sees the tab the
// page lands on rather than only the call it made.
const replace = vi.fn<(href: string, options?: { scroll?: boolean }) => void>(
  (href) => {
    nav.setQuery(href.split("?")[1] ?? "");
  },
);
const push = vi.fn();
const router = { replace, push, refresh: vi.fn() };

vi.mock("next/navigation", async () => {
  const { useMemo, useSyncExternalStore } = await import("react");
  return {
    useRouter: () => router,
    useSearchParams: () => {
      const query = useSyncExternalStore(nav.subscribe, () => nav.query);
      return useMemo(() => new URLSearchParams(query), [query]);
    },
  };
});

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "u1",
        adminPermissionMatrix: {
          overview: "view",
          bookings: "edit",
          membership: "view",
          finance: "view",
          lodge: "view",
          content: "view",
          support: "view",
        },
      },
    },
    status: "authenticated",
  }),
}));

// Like the real panels, each one writes its own tab into the URL as soon as it
// mounts (its canonical address). The Approvals panel therefore turns a bare
// link into `?tab=approvals` before the counts arrive — the landing tab must
// still be chosen.
const panel = vi.hoisted(() => (tab: string, testId: string) =>
  function Panel() {
    useEffect(() => {
      const params = new URLSearchParams(nav.query);
      params.set("tab", tab);
      router.replace(`/admin/booking-requests?${params.toString()}`, {
        scroll: false,
      });
    }, []);
    return <div data-testid={testId} />;
  },
);
vi.mock("@/components/admin/booking-requests/booking-approvals-panel", () => ({
  BookingApprovalsPanel: panel("approvals", "approvals-panel"),
}));
vi.mock(
  "@/components/admin/booking-requests/booking-change-requests-panel",
  () => ({ BookingChangeRequestsPanel: panel("changes", "changes-panel") }),
);
vi.mock(
  "@/components/admin/booking-requests/policy-exception-requests-panel",
  () => ({ PolicyExceptionRequestsPanel: panel("exceptions", "exceptions-panel") }),
);
vi.mock(
  "@/components/admin/booking-requests/public-booking-requests-panel",
  () => ({ PublicBookingRequestsPanel: panel("public", "public-panel") }),
);

import BookingRequestsPage from "@/app/(admin)/admin/booking-requests/page";
import { totalBookingRequestsPending } from "@/lib/admin-booking-requests-path";

const ZERO_COUNTS = {
  bookingReviews: 0,
  lockedPeriodChangeRequests: 0,
  policyExceptionRequests: 0,
  publicBookingRequests: 0,
};

const fetchMock = vi.fn();

function serveCounts(counts: Partial<typeof ZERO_COUNTS>) {
  // The real endpoint's payload carries every sidebar queue; the page must
  // pick out only its four.
  fetchMock.mockImplementation(async (url: string) =>
    url === "/api/admin/pending-counts"
      ? Response.json({ ...ZERO_COUNTS, issueReports: 7, ...counts })
      : new Response(null, { status: 404 }),
  );
}

function tab(name: RegExp) {
  return screen.getByRole("tab", { name });
}

async function countsLoaded() {
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/pending-counts"),
  );
  // Let the fetch chain and any landing-tab replace settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("BookingRequestsPage tab counts and landing tab (#4969)", () => {
  beforeEach(() => {
    nav.setQuery("");
    replace.mockClear();
    push.mockClear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("badges all four tabs, adding up to the sidebar total", async () => {
    const counts = {
      bookingReviews: 1,
      lockedPeriodChangeRequests: 2,
      policyExceptionRequests: 3,
      publicBookingRequests: 4,
    };
    serveCounts(counts);
    render(<BookingRequestsPage />);

    await waitFor(() => expect(tab(/^Approvals/)).toHaveTextContent("Approvals1"));
    expect(tab(/^Changes/)).toHaveTextContent("Changes2");
    expect(tab(/^Policy Exceptions/)).toHaveTextContent("Policy Exceptions3");
    expect(tab(/^Public Requests/)).toHaveTextContent("Public Requests4");
    const badgeSum = screen
      .getAllByRole("tab")
      .reduce((sum, trigger) => sum + Number(trigger.textContent?.match(/\d+$/)?.[0] ?? 0), 0);
    expect(badgeSum).toBe(totalBookingRequestsPending(counts));
    // Approvals has work, so the bare URL stays there.
    await countsLoaded();
    expect(nav.query).toBe("tab=approvals");
    expect(tab(/^Approvals/)).toHaveAttribute("aria-selected", "true");
  });

  it("opens a bare URL on Changes when only change requests are waiting", async () => {
    serveCounts({ lockedPeriodChangeRequests: 3 });
    render(<BookingRequestsPage />);

    await waitFor(() =>
      expect(tab(/^Changes/)).toHaveAttribute("aria-selected", "true"),
    );
    expect(screen.getByTestId("changes-panel")).toBeInTheDocument();
    expect(nav.query).toBe("tab=changes");
    expect(replace).toHaveBeenCalledWith("/admin/booking-requests?tab=changes", {
      scroll: false,
    });
    expect(push).not.toHaveBeenCalled();
  });

  it("opens a bare URL on Policy Exceptions when only exceptions are waiting", async () => {
    serveCounts({ policyExceptionRequests: 1 });
    render(<BookingRequestsPage />);

    await waitFor(() =>
      expect(tab(/^Policy Exceptions/)).toHaveAttribute("aria-selected", "true"),
    );
    expect(screen.getByTestId("exceptions-panel")).toBeInTheDocument();
    expect(tab(/^Changes/)).toHaveTextContent(/^Changes$/);
  });

  it("keeps other query params when it picks the landing tab", async () => {
    nav.setQuery("from=dashboard");
    serveCounts({ publicBookingRequests: 1 });
    render(<BookingRequestsPage />);

    await waitFor(() =>
      expect(tab(/^Public Requests/)).toHaveAttribute("aria-selected", "true"),
    );
    expect(nav.query).toBe("from=dashboard&tab=public");
  });

  it("never overrides an explicit ?tab=", async () => {
    nav.setQuery("tab=public");
    serveCounts({ lockedPeriodChangeRequests: 3 });
    render(<BookingRequestsPage />);

    await waitFor(() => expect(tab(/^Changes/)).toHaveTextContent("Changes3"));
    await countsLoaded();
    expect(nav.query).toBe("tab=public");
    expect(tab(/^Public Requests/)).toHaveAttribute("aria-selected", "true");
  });

  it("never overrides an explicit ?tab=approvals", async () => {
    nav.setQuery("tab=approvals");
    serveCounts({ lockedPeriodChangeRequests: 3 });
    render(<BookingRequestsPage />);

    await waitFor(() => expect(tab(/^Changes/)).toHaveTextContent("Changes3"));
    await countsLoaded();
    expect(nav.query).toBe("tab=approvals");
    expect(tab(/^Approvals/)).toHaveAttribute("aria-selected", "true");
  });

  it.each(["bookingId=b1", "requestId=r1", "status=REQUESTED"])(
    "leaves a link carrying %s where it points",
    async (query) => {
      nav.setQuery(query);
      serveCounts({ lockedPeriodChangeRequests: 3 });
      render(<BookingRequestsPage />);

      await waitFor(() => expect(tab(/^Changes/)).toHaveTextContent("Changes3"));
      await countsLoaded();
      expect(new URLSearchParams(nav.query).get("tab")).toBe("approvals");
      expect(tab(/^Approvals/)).toHaveAttribute("aria-selected", "true");
    },
  );

  it("keeps a tab the officer chose while the counts were loading", async () => {
    let respond: (response: Response) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        respond = resolve;
      }),
    );
    render(<BookingRequestsPage />);
    await waitFor(() => expect(nav.query).toBe("tab=approvals"));

    fireEvent.mouseDown(tab(/^Changes/), { button: 0 });
    await waitFor(() => expect(nav.query).toBe("tab=changes"));

    await act(async () => {
      respond(Response.json({ ...ZERO_COUNTS, publicBookingRequests: 2 }));
    });
    await waitFor(() =>
      expect(tab(/^Public Requests/)).toHaveTextContent("Public Requests2"),
    );
    await countsLoaded();
    expect(nav.query).toBe("tab=changes");
    expect(tab(/^Changes/)).toHaveAttribute("aria-selected", "true");
  });

  it("stays on Approvals with no badges when nothing is waiting", async () => {
    serveCounts({});
    render(<BookingRequestsPage />);

    await countsLoaded();
    expect(nav.query).toBe("tab=approvals");
    expect(tab(/^Approvals/)).toHaveAttribute("aria-selected", "true");
    expect(tab(/^Approvals/)).toHaveTextContent(/^Approvals$/);
    expect(tab(/^Changes/)).toHaveTextContent(/^Changes$/);
  });

  it.each([
    ["the endpoint errors", () => fetchMock.mockResolvedValue(new Response(null, { status: 500 }))],
    ["the request fails", () => fetchMock.mockRejectedValue(new Error("offline"))],
  ])("stays on Approvals with no badges when %s", async (_label, arrange) => {
    arrange();
    render(<BookingRequestsPage />);

    await countsLoaded();
    expect(nav.query).toBe("tab=approvals");
    expect(tab(/^Approvals/)).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("approvals-panel")).toBeInTheDocument();
    for (const name of [/^Approvals/, /^Changes/, /^Policy Exceptions/, /^Public Requests/]) {
      expect(tab(name).textContent).not.toMatch(/\d/);
    }
  });
});
