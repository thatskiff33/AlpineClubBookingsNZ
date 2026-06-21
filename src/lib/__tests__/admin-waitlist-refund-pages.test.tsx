// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AdminWaitlistPage from "@/app/(admin)/admin/waitlist/page";
import RefundRequestsPage from "@/app/(admin)/admin/refund-requests/page";

const mocks = vi.hoisted(() => ({
  currentSearch: "",
  routerReplace: vi.fn(),
}));

const fetchMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: mocks.routerReplace,
    push: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(mocks.currentSearch),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "admin-2", role: "ADMIN" } },
  }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

function waitlistEntry() {
  return {
    id: "booking-1",
    memberName: "Jane Doe",
    memberEmail: "jane@example.com",
    memberId: "member-1",
    checkIn: "2026-07-01",
    checkOut: "2026-07-03",
    guestCount: 3,
    status: "WAITLIST_OFFERED",
    waitlistPosition: 2,
    waitlistOfferedAt: "2026-06-01T09:00:00.000Z",
    waitlistOfferExpiresAt: "2026-06-02T09:00:00.000Z",
    requiresAdminReview: true,
    adminReviewReason: "Booking has no adult guest",
    finalPriceCents: 12500,
    createdAt: "2026-05-01T00:00:00.000Z",
    offerEmailDelivery: null,
  };
}

function parseRouterPath(path: string) {
  return new URL(path, "http://localhost");
}

describe("Admin waitlist page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = fetchMock as typeof fetch;
  });

  it("loads API query params and links members and booking context with return state", async () => {
    mocks.currentSearch = "from=2026-07-01&to=2026-07-31&page=2&pageSize=10";
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        entries: [waitlistEntry()],
        page: 2,
        pageSize: 10,
        total: 30,
      }),
    });

    render(<AdminWaitlistPage />);

    await screen.findByText("Jane Doe");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/waitlist?from=2026-07-01&to=2026-07-31&page=2&pageSize=10"
    );
    expect(screen.getByText("30 total")).toBeTruthy();
    expect(screen.getByText("Showing 11-20 of 30")).toBeTruthy();
    expect(screen.getByText("Booking has no adult guest")).toBeTruthy();

    const memberLink = screen.getByRole("link", {
      name: /Jane Doe jane@example\.com/i,
    });
    const memberHref = decodeURIComponent(memberLink.getAttribute("href") ?? "");
    expect(memberHref).toContain(
      "/admin/members/member-1?returnTo=/admin/waitlist?from=2026-07-01&to=2026-07-31&page=2&pageSize=10"
    );

    const bookingLink = screen.getByRole("link", { name: /View booking/i });
    const bookingHref = decodeURIComponent(bookingLink.getAttribute("href") ?? "");
    expect(bookingHref).toContain(
      "/bookings/booking-1?returnTo=/admin/waitlist?from=2026-07-01&to=2026-07-31&page=2&pageSize=10"
    );
  });

  it("surfaces failed waitlist offer email recovery state", async () => {
    mocks.currentSearch = "";
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        entries: [
          {
            ...waitlistEntry(),
            offerEmailDelivery: {
              status: "FAILED",
              emailLogId: "email-log-1",
              attempts: 3,
              lastAttemptAt: "2026-06-01T09:30:00.000Z",
              errorMessage: "SMTP rejected recipient",
              retryState: "exhausted",
              needsOperatorAction: true,
            },
          },
        ],
        page: 1,
        pageSize: 25,
        total: 1,
      }),
    });

    render(<AdminWaitlistPage />);

    await screen.findByText("Offer email retry exhausted");
    expect(screen.getByText("SMTP rejected recipient")).toBeTruthy();
    const recoveryLink = screen.getByRole("link", {
      name: /Review email recovery/i,
    });
    expect(recoveryLink.getAttribute("href")).toBe("/admin/email-deliverability");
  });

  it("reports force-confirmed overbook dates and links the critical audit record", async () => {
    mocks.currentSearch = "";
    let waitlistLoads = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/admin/waitlist") {
        waitlistLoads += 1;
        return Promise.resolve({
          ok: true,
          json: async () => ({
            entries: waitlistLoads === 1 ? [waitlistEntry()] : [],
            page: 1,
            pageSize: 25,
            total: waitlistLoads === 1 ? 1 : 0,
          }),
        });
      }

      if (url === "/api/admin/bookings/booking-1/force-confirm") {
        const requestBody = JSON.parse(String(init?.body ?? "{}")) as {
          allowOverbook?: boolean;
        };

        if (requestBody.allowOverbook) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              success: true,
              overbooked: true,
              overbookDates: ["2026-07-01"],
              auditAction: "waitlist.force_confirmed_overbook",
              status: "PAYMENT_PENDING",
            }),
          });
        }

        return Promise.resolve({
          ok: false,
          json: async () => ({
            error: "CAPACITY_EXCEEDED",
            overbookDates: ["2026-07-01"],
          }),
        });
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    render(<AdminWaitlistPage />);

    await screen.findByText("Jane Doe");
    fireEvent.click(screen.getByRole("button", { name: "Force Confirm" }));
    await screen.findByText("This will overbook the lodge on the following dates:");
    fireEvent.click(screen.getByRole("button", { name: /Confirm Anyway/i }));

    await screen.findByText("Force-confirmed overbooked booking");
    expect(screen.getByText("New status: Payment Pending")).toBeTruthy();
    expect(screen.getByText("2026-07-01")).toBeTruthy();
    const auditLink = screen.getByRole("link", {
      name: /View critical audit record/i,
    });
    const auditHref = decodeURIComponent(auditLink.getAttribute("href") ?? "");
    expect(auditHref).toContain("/admin/audit-log?");
    expect(auditHref).toContain("eventType=waitlist.force_confirmed_overbook");
    expect(auditHref).toContain("severity=critical");
    expect(auditHref).toContain("q=booking-1");
  });

  it("keeps date filters, page size, and pagination in the URL query", async () => {
    mocks.currentSearch = "page=2&pageSize=10";
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        entries: [waitlistEntry()],
        page: 2,
        pageSize: 10,
        total: 30,
      }),
    });

    render(<AdminWaitlistPage />);
    await screen.findByText("Jane Doe");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    let nextPath = parseRouterPath(mocks.routerReplace.mock.calls.at(-1)?.[0]);
    expect(nextPath.pathname).toBe("/admin/waitlist");
    expect(nextPath.searchParams.get("page")).toBe("3");
    expect(nextPath.searchParams.get("pageSize")).toBe("10");

    fireEvent.change(screen.getByLabelText("Page size"), {
      target: { value: "50" },
    });
    nextPath = parseRouterPath(mocks.routerReplace.mock.calls.at(-1)?.[0]);
    expect(nextPath.searchParams.get("page")).toBe("1");
    expect(nextPath.searchParams.get("pageSize")).toBe("50");

    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "2026-08-01" },
    });
    fireEvent.change(screen.getByLabelText("To"), {
      target: { value: "2026-08-05" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    nextPath = parseRouterPath(mocks.routerReplace.mock.calls.at(-1)?.[0]);
    expect(nextPath.searchParams.get("from")).toBe("2026-08-01");
    expect(nextPath.searchParams.get("to")).toBe("2026-08-05");
    expect(nextPath.searchParams.get("page")).toBe("1");
    expect(nextPath.searchParams.get("pageSize")).toBe("10");
  });
});

describe("Admin refund and credit review page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = fetchMock as typeof fetch;
  });

  it("links approved manual credits to the member credit ledger instead of showing raw ids", async () => {
    mocks.currentSearch = "status=APPROVED";
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/admin/refund-requests?status=APPROVED") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: [], page: 1, pageSize: 25, total: 0 }),
        });
      }

      if (url === "/api/admin/credit-approvals?status=APPROVED") {
        return Promise.resolve({
          ok: true,
          json: async () => [
            {
              id: "credit-request-1",
              memberId: "member-1",
              amountCents: 4000,
              description: "Manual correction",
              status: "APPROVED",
              createdAt: "2026-05-01T00:00:00.000Z",
              reviewedAt: "2026-05-02T00:00:00.000Z",
              member: {
                id: "member-1",
                firstName: "Jane",
                lastName: "Doe",
                email: "jane@example.com",
              },
              requestedBy: {
                id: "admin-1",
                firstName: "Alex",
                lastName: "Admin",
              },
              reviewedBy: {
                id: "admin-2",
                firstName: "Riley",
                lastName: "Reviewer",
              },
              approvedCredit: {
                id: "credit-opaque-1",
                createdAt: "2026-05-02T00:00:00.000Z",
              },
            },
          ],
        });
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    render(<RefundRequestsPage />);

    await screen.findByText("Manual Credit Approvals");

    const ledgerLink = screen.getByRole("link", { name: /View credit ledger/i });
    const href = decodeURIComponent(ledgerLink.getAttribute("href") ?? "");
    expect(href).toContain(
      "/admin/members/member-1?returnTo=/admin/refund-requests?status=APPROVED#account-credit"
    );
    expect(screen.queryByText("credit-opaque-1")).toBeNull();
  });
});
