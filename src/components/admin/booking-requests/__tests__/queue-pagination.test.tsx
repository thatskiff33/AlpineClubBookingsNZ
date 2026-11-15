// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BookingApprovalsPanel } from "@/components/admin/booking-requests/booking-approvals-panel";
import { BookingChangeRequestsPanel } from "@/components/admin/booking-requests/booking-change-requests-panel";
import { PolicyExceptionRequestsPanel } from "@/components/admin/booking-requests/policy-exception-requests-panel";
import { PublicBookingRequestsPanel } from "@/components/admin/booking-requests/public-booking-requests-panel";
import { PINNED_QUEUE_RECORD_NOTE } from "@/lib/admin-list-page";

/**
 * #4960 / INV-OPS-019 — every booking-requests queue pages through its rows,
 * shows its total, restarts at page 1 on a filter change, and a deep link to a
 * record beyond page 1 still lands on that record.
 */

const navigation = vi.hoisted(() => ({ search: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span />,
}));

vi.mock("@/components/admin/booking-requests/booking-request-contact-picker", () => ({
  BookingRequestContactPicker: () => <div data-testid="contact-picker" />,
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
  ClubIdentityProvider: ({ children }: { children: ReactNode }) => children,
}));

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Routes each GET by path prefix; records every URL the panel asked for. */
function installFetch(routes: Record<string, (url: URL) => unknown>) {
  const urls: URL[] = [];
  global.fetch = vi.fn(async (input: unknown) => {
    const url = new URL(String(input), "http://localhost");
    urls.push(url);
    const handler = Object.entries(routes).find(([path]) => url.pathname === path)?.[1];
    return jsonResponse(handler ? handler(url) : {});
  }) as unknown as typeof fetch;
  return {
    reads(path: string) {
      return urls.filter((url) => url.pathname === path);
    },
  };
}

function pageOf(url: URL) {
  return url.searchParams.get("page");
}

const booking = {
  id: "booking-1",
  checkIn: "2026-08-10",
  checkOut: "2026-08-12",
  status: "AWAITING_REVIEW",
  finalPriceCents: 12000,
  memberReviewJustification: "No adult host is available.",
  adminReviewStatus: "PENDING",
  adminReviewNotes: null,
  adminReviewedAt: null,
  createdAt: "2026-06-01T00:00:00.000Z",
  noEmails: false,
  member: { id: "member-1", firstName: "Riley", lastName: "Chen", email: "riley@example.org" },
  adminReviewedBy: null,
  guests: [],
};

function changeRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    bookingId: "bk-1",
    requestedByMemberId: "m-1",
    status: "REQUESTED",
    requestedChanges: { requested: { summary: "check-out to 2026-08-14" } },
    reason: "Weather closed the road.",
    adminNotes: null,
    internalNotes: null,
    reviewedAt: null,
    createdAt: "2026-06-23T10:00:00.000Z",
    requestedBy: { id: "m-1", firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
    reviewedBy: null,
    linkedModification: null,
    booking: {
      id: "bk-1",
      checkIn: "2026-08-10T00:00:00.000Z",
      checkOut: "2026-08-12T00:00:00.000Z",
      status: "CONFIRMED",
      finalPriceCents: 12000,
      member: { id: "m-1", firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
      payment: null,
    },
    ...overrides,
  };
}

const publicRequest = {
  id: "public-1",
  type: "GENERAL",
  status: "NEW",
  schoolName: null,
  cateringPreference: null,
  teachers: [],
  linkedGuestMembers: [],
  contactFirstName: "Ada",
  contactLastName: "Lovelace",
  contactEmail: "ada@example.com",
  contactPhone: null,
  checkIn: "2026-08-01",
  checkOut: "2026-08-03",
  guests: [],
  message: null,
  indicativePriceCents: null,
  priceCents: null,
  verifiedAt: null,
  pricedAt: null,
  pricedByMemberId: null,
  pricedByMemberName: null,
  reviewedAt: null,
  reviewedByMemberId: null,
  reviewedByMemberName: null,
  declineReason: null,
  convertedBookingId: null,
  attendeesConfirmedAt: null,
  convertedMemberId: null,
  lodgeName: null,
  heldBookingId: null,
  acceptedQuoteOptionId: null,
  acceptedPriceCents: null,
  acceptedAt: null,
  responseMessage: null,
  responseMessageAt: null,
  latestQuote: null,
  createdAt: "2026-06-01T00:00:00.000Z",
};

function exceptionItem() {
  return {
    source: "MODIFICATION",
    id: "exc-1",
    status: "REQUESTED",
    createdAt: "2026-06-01T10:00:00.000Z",
    version: 3,
    bookingId: "bk-1",
    lodgeId: "lodge-1",
    requestedBy: { id: "m-1", firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
    reviewedBy: null,
    reviewedAt: null,
    memberMessage: "Please allow the one-night stay.",
    proposalHash: "abc",
    aggregateCapacityMode: "HOLD",
    reasonCodes: ["MINIMUM_STAY"],
    policyRefs: [
      { reasonCode: "MINIMUM_STAY", policyId: "pol-1", policyVersion: 1, capacityMode: "HOLD" },
    ],
    affectedNights: ["2026-08-01"],
    proposedCheckIn: "2026-08-01",
    proposedCheckOut: "2026-08-02",
    proposedGuestCount: 1,
    adminNotes: null,
    internalNotes: null,
    createdBookingId: null,
    attemptCount: 1,
    conflictCount: 0,
    lastConflictAt: null,
    lastConflictReason: null,
    supersededByRequestId: null,
    summary: "check-out to 2026-08-02",
  };
}

/** A page envelope as every capped queue route returns it. */
function envelope(data: unknown[], page: number, total: number) {
  return { data, page, pageSize: 25, total, totalPages: Math.ceil(total / 25) };
}

beforeEach(() => {
  navigation.search = "";
  vi.clearAllMocks();
});

describe("BookingApprovalsPanel paging", () => {
  const route = "/api/admin/booking-reviews";

  it("asks for page 1, shows the total, steps to page 2 and restarts on a filter change", async () => {
    const fetches = installFetch({
      [route]: (url) => envelope([booking], Number(pageOf(url) ?? 1), 40),
    });
    render(<BookingApprovalsPanel />);

    expect(await screen.findByText("Showing 1–25 of 40")).toBeInTheDocument();
    expect(fetches.reads(route)[0].searchParams.get("status")).toBe("PENDING");
    expect(pageOf(fetches.reads(route)[0])).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Showing 26–40 of 40")).toBeInTheDocument();
    expect(pageOf(fetches.reads(route).at(-1)!)).toBe("2");

    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(await screen.findByText("Showing 1–25 of 40")).toBeInTheDocument();
    expect(pageOf(fetches.reads(route).at(-1)!)).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("Showing 26–40 of 40");
    fireEvent.click(screen.getByRole("button", { name: "Approved" }));
    await waitFor(() =>
      expect(fetches.reads(route).at(-1)!.searchParams.get("status")).toBe("APPROVED"),
    );
    expect(pageOf(fetches.reads(route).at(-1)!)).toBe("1");

    // Back to the first filter: it starts on page 1, not the page it was left on.
    fireEvent.click(screen.getByRole("button", { name: "Pending" }));
    await waitFor(() =>
      expect(fetches.reads(route).at(-1)!.searchParams.get("status")).toBe("PENDING"),
    );
    expect(pageOf(fetches.reads(route).at(-1)!)).toBe("1");
    expect(await screen.findByText("Showing 1–25 of 40")).toBeInTheDocument();
    expect(fetches.reads(route).filter((url) => pageOf(url) === "2")).toHaveLength(2);
  });

  it("shows the total line on a single page", async () => {
    installFetch({ [route]: () => envelope([booking], 1, 1) });
    render(<BookingApprovalsPanel />);
    expect(await screen.findByText("Showing 1–1 of 1")).toBeInTheDocument();
  });

  it("pins a deep-linked booking that is not on the loaded page", async () => {
    navigation.search = "bookingId=booking-99";
    const focused = {
      ...booking,
      id: "booking-99",
      member: { ...booking.member, id: "member-99", firstName: "Jordan", lastName: "Singh" },
    };
    const fetches = installFetch({
      [route]: (url) =>
        url.searchParams.get("bookingId") === "booking-99"
          ? envelope([focused], 1, 1)
          : envelope([booking], 1, 40),
    });
    render(<BookingApprovalsPanel />);

    expect(await screen.findByText(PINNED_QUEUE_RECORD_NOTE)).toBeInTheDocument();
    expect(screen.getByText(/Jordan Singh/)).toBeInTheDocument();
    expect(screen.getByText(/Riley Chen/)).toBeInTheDocument();
    const byId = fetches.reads(route).find((url) => url.searchParams.has("bookingId"))!;
    expect(byId.searchParams.get("status")).toBe("ALL");
    expect(byId.searchParams.get("pageSize")).toBe("1");
  });

  it("does not pin a deep-linked booking already on the page", async () => {
    navigation.search = "bookingId=booking-1";
    const fetches = installFetch({ [route]: () => envelope([booking], 1, 40) });
    render(<BookingApprovalsPanel />);
    expect(await screen.findByText("Showing 1–25 of 40")).toBeInTheDocument();
    expect(screen.queryByText(PINNED_QUEUE_RECORD_NOTE)).toBeNull();
    expect(fetches.reads(route).some((url) => url.searchParams.has("bookingId"))).toBe(false);
  });

  it("opens on the page the URL names", async () => {
    navigation.search = "page=2";
    const fetches = installFetch({
      [route]: (url) => envelope([booking], Number(pageOf(url) ?? 1), 40),
    });
    render(<BookingApprovalsPanel />);
    expect(await screen.findByText("Showing 26–40 of 40")).toBeInTheDocument();
    expect(pageOf(fetches.reads(route)[0])).toBe("2");
  });

  it("steps back a page when the page it is on has emptied", async () => {
    navigation.search = "page=3";
    const fetches = installFetch({
      [route]: (url) =>
        pageOf(url) === "3" ? envelope([], 3, 40) : envelope([booking], Number(pageOf(url)), 40),
    });
    render(<BookingApprovalsPanel />);
    expect(await screen.findByText("Showing 26–40 of 40")).toBeInTheDocument();
    expect(fetches.reads(route).map(pageOf)).toEqual(["3", "2"]);
  });

  it("Reset returns a later page of the default filter to page 1", async () => {
    navigation.search = "page=2";
    const fetches = installFetch({
      [route]: (url) => envelope([booking], Number(pageOf(url)), 40),
    });
    render(<BookingApprovalsPanel />);
    expect(await screen.findByText("Showing 26–40 of 40")).toBeInTheDocument();

    const reset = screen.getByRole("button", { name: "Reset" });
    expect(reset).toBeEnabled();
    fireEvent.click(reset);
    expect(await screen.findByText("Showing 1–25 of 40")).toBeInTheDocument();
    expect(pageOf(fetches.reads(route).at(-1)!)).toBe("1");
    expect(screen.getByRole("button", { name: /^Reset\./ })).toBeDisabled();
  });

  it("never lets a slower read for a filter it has left replace the list shown", async () => {
    const slow: { release?: () => void } = {};
    global.fetch = vi.fn(async (input: unknown) => {
      const url = new URL(String(input), "http://localhost");
      if (url.searchParams.get("status") === "APPROVED") {
        await new Promise<void>((resolve) => {
          slow.release = resolve;
        });
        const stale = { ...booking, id: "booking-2", member: { ...booking.member, firstName: "Stale", lastName: "Row" } };
        return jsonResponse(envelope([stale], 1, 3));
      }
      return jsonResponse(envelope([booking], 1, 40));
    }) as unknown as typeof fetch;
    render(<BookingApprovalsPanel />);
    await screen.findByText("Showing 1–25 of 40");

    fireEvent.click(screen.getByRole("button", { name: "Approved" }));
    await waitFor(() => expect(slow.release).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Pending" }));
    expect(await screen.findByText("Showing 1–25 of 40")).toBeInTheDocument();

    slow.release!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText(/Stale Row/)).not.toBeInTheDocument();
    expect(screen.getByText(/Riley Chen/)).toBeInTheDocument();
    expect(screen.getByText("Showing 1–25 of 40")).toBeInTheDocument();
  });

  it("never lets a slower failed read for a filter it has left show its error", async () => {
    const slow: { release?: () => void } = {};
    global.fetch = vi.fn(async (input: unknown) => {
      const url = new URL(String(input), "http://localhost");
      if (url.searchParams.get("status") === "APPROVED") {
        await new Promise<void>((resolve) => {
          slow.release = resolve;
        });
        return jsonResponse({ error: "Stale read failed" }, 500);
      }
      return jsonResponse(envelope([booking], 1, 40));
    }) as unknown as typeof fetch;
    render(<BookingApprovalsPanel />);
    await screen.findByText("Showing 1–25 of 40");

    fireEvent.click(screen.getByRole("button", { name: "Approved" }));
    await waitFor(() => expect(slow.release).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Pending" }));
    expect(await screen.findByText("Showing 1–25 of 40")).toBeInTheDocument();

    slow.release!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("Stale read failed")).not.toBeInTheDocument();
    expect(screen.getByText(/Riley Chen/)).toBeInTheDocument();
  });
});

describe("BookingChangeRequestsPanel paging", () => {
  const route = "/api/admin/booking-change-requests";

  it("asks for page 1, shows the total, steps to page 2 and restarts on a filter change", async () => {
    const fetches = installFetch({
      [route]: (url) => envelope([changeRequest()], Number(pageOf(url) ?? 1), 30),
    });
    render(<BookingChangeRequestsPanel />);

    expect(await screen.findByText("Showing 1–25 of 30")).toBeInTheDocument();
    expect(fetches.reads(route)[0].searchParams.get("status")).toBe("REQUESTED");
    expect(pageOf(fetches.reads(route)[0])).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Showing 26–30 of 30")).toBeInTheDocument();
    expect(pageOf(fetches.reads(route).at(-1)!)).toBe("2");

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() =>
      expect(fetches.reads(route).at(-1)!.searchParams.get("status")).toBe("ALL"),
    );
    expect(pageOf(fetches.reads(route).at(-1)!)).toBe("1");
  });

  it("pins a deep-linked request that is not on the loaded page", async () => {
    navigation.search = "requestId=req-99";
    const focused = changeRequest({
      id: "req-99",
      requestedBy: { id: "m-9", firstName: "Bea", lastName: "Tui", email: "bea@example.com" },
    });
    const fetches = installFetch({
      [route]: (url) =>
        url.searchParams.get("requestId") === "req-99"
          ? envelope([focused], 1, 1)
          : envelope([changeRequest()], 1, 30),
    });
    render(<BookingChangeRequestsPanel />);

    expect(await screen.findByText(PINNED_QUEUE_RECORD_NOTE)).toBeInTheDocument();
    expect(screen.getByTestId("change-request-req-99")).toBeInTheDocument();
    expect(screen.getByTestId("change-request-req-1")).toBeInTheDocument();
    const byId = fetches.reads(route).find((url) => url.searchParams.has("requestId"))!;
    expect(byId.searchParams.get("status")).toBe("ALL");
  });
});

describe("PublicBookingRequestsPanel paging", () => {
  const route = "/api/admin/booking-requests";

  it("asks for page 1, shows the total, steps to page 2 and restarts on a filter change", async () => {
    const fetches = installFetch({
      [route]: (url) => envelope([publicRequest], Number(pageOf(url) ?? 1), 26),
    });
    render(<PublicBookingRequestsPanel />);

    expect(await screen.findByText("Showing 1–25 of 26")).toBeInTheDocument();
    expect(fetches.reads(route)[0].searchParams.get("status")).toBe("QUEUE");
    expect(pageOf(fetches.reads(route)[0])).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Showing 26–26 of 26")).toBeInTheDocument();
    expect(pageOf(fetches.reads(route).at(-1)!)).toBe("2");

    fireEvent.click(screen.getByRole("button", { name: "Accepted" }));
    await waitFor(() =>
      expect(fetches.reads(route).at(-1)!.searchParams.get("status")).toBe("ACCEPTED"),
    );
    expect(pageOf(fetches.reads(route).at(-1)!)).toBe("1");
  });

  it("pins a deep-linked request that is not on the loaded page", async () => {
    navigation.search = "requestId=public-99";
    const focused = { ...publicRequest, id: "public-99", contactEmail: "bea@example.com" };
    installFetch({
      [route]: (url) =>
        url.searchParams.get("requestId") === "public-99"
          ? envelope([focused], 1, 1)
          : envelope([publicRequest], 1, 26),
    });
    render(<PublicBookingRequestsPanel />);

    expect(await screen.findByText(PINNED_QUEUE_RECORD_NOTE)).toBeInTheDocument();
    expect(screen.getAllByText(/bea@example\.com/).length).toBeGreaterThan(0);
  });
});

describe("PolicyExceptionRequestsPanel paging", () => {
  const route = "/api/admin/booking-exception-requests";

  it("uses the shared pager instead of a fixed 100-row read", async () => {
    const fetches = installFetch({
      [route]: (url) => envelope([exceptionItem()], Number(pageOf(url) ?? 1), 27),
    });
    render(<PolicyExceptionRequestsPanel />);

    expect(await screen.findByText("Showing 1–25 of 27")).toBeInTheDocument();
    const first = fetches.reads(route)[0];
    expect(first.searchParams.get("status")).toBe("REQUESTED");
    expect(pageOf(first)).toBe("1");
    expect(first.searchParams.has("pageSize")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Showing 26–27 of 27")).toBeInTheDocument();
    expect(pageOf(fetches.reads(route).at(-1)!)).toBe("2");

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() =>
      expect(fetches.reads(route).at(-1)!.searchParams.get("status")).toBe("ALL"),
    );
    expect(pageOf(fetches.reads(route).at(-1)!)).toBe("1");
  });
});

/**
 * A pager that unmounts while the next page loads drops a keyboard or
 * screen-reader user's focus to the page body on every page change, on lists
 * of tall cards. Each queue keeps the one `Pagination` in place through a load.
 */
describe("every booking queue keeps its pager mounted through a page change", () => {
  const cases: Array<[string, string, () => ReactElement, unknown]> = [
    ["booking approvals", "/api/admin/booking-reviews", () => <BookingApprovalsPanel />, booking],
    ["change requests", "/api/admin/booking-change-requests", () => <BookingChangeRequestsPanel />, changeRequest()],
    ["public requests", "/api/admin/booking-requests", () => <PublicBookingRequestsPanel />, publicRequest],
    ["policy exceptions", "/api/admin/booking-exception-requests", () => <PolicyExceptionRequestsPanel />, exceptionItem()],
  ];

  it.each(cases)("%s: Next page stays the same focused button while the next page loads", async (_name, route, panel, row) => {
    const slow: { release?: () => void } = {};
    global.fetch = vi.fn(async (input: unknown) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname !== route) return jsonResponse({});
      if (pageOf(url) === "2") {
        await new Promise<void>((resolve) => {
          slow.release = resolve;
        });
        return jsonResponse(envelope([row], 2, 100));
      }
      return jsonResponse(envelope([row], 1, 100));
    }) as unknown as typeof fetch;
    render(panel());
    await screen.findByText("Showing 1–25 of 100");

    const next = screen.getByRole("button", { name: "Next page" });
    next.focus();
    fireEvent.click(next);
    await waitFor(() => expect(slow.release).toBeDefined());

    // The page-2 read is still out: the pager is the same element, still focused.
    expect(screen.getByRole("button", { name: "Next page" })).toBe(next);
    expect(document.activeElement).toBe(next);

    slow.release!();
    expect(await screen.findByText("Showing 26–50 of 100")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next page" })).toBe(next);
    expect(document.activeElement).toBe(next);
  });
});
