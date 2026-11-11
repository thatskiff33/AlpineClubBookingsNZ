// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AdminWaitlistPage from "@/app/(admin)/admin/booking-desk/waitlist/page";
import RefundRequestsPage from "@/app/(admin)/admin/finance/refund-requests/page";
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";
import { refundAppealCeilingParts } from "@/lib/manual-refund-task-settlement-rules";

const mocks = vi.hoisted(() => ({
  currentSearch: "",
  routerReplace: vi.fn(),
  sessionUser: {
    id: "admin-2",
    role: "ADMIN",
    accessRoles: [{ role: "ADMIN" }],
  },
}));

const fetchMock = vi.fn();
const scrollIntoView = vi.fn();
const toastSuccess = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: vi.fn() } }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: mocks.routerReplace,
    push: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(mocks.currentSearch),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: mocks.sessionUser },
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
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    mocks.sessionUser = {
      id: "admin-2",
      role: "ADMIN",
      accessRoles: [{ role: "ADMIN" }],
    };
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

  it("sends a suppressed live offer to the real booking page (#3635)", async () => {
    mocks.currentSearch = "";
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        entries: [
          {
            ...waitlistEntry(),
            offerEmailDelivery: {
              status: "SUPPRESSED",
              emailLogId: null,
              attempts: 0,
              lastAttemptAt: null,
              errorMessage: null,
              retryState: "suppressed_live_offer",
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

    // `/admin/bookings/<id>` does not exist; the booking page is /bookings/<id>.
    const link = await screen.findByRole("link", { name: /Open the booking/i });
    const href = decodeURIComponent(link.getAttribute("href") ?? "");
    expect(href.startsWith("/bookings/booking-1?returnTo=/admin/waitlist")).toBe(true);
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

  it("focuses and scrolls the fixed participant retry without stranding Force Confirm", async () => {
    mocks.currentSearch = "";
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/waitlist") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            entries: [waitlistEntry()],
            page: 1,
            pageSize: 25,
            total: 1,
          }),
        });
      }
      if (url === "/api/admin/bookings/booking-1/force-confirm") {
        return Promise.resolve({
          ok: false,
          json: async () => ({
            error:
              "The database update could not be completed because this booking or member changed. Reload before trying again. If a payment was involved, check its status before retrying.",
            code: "HOSTING_COVERAGE_PARTICIPANT_RETRY",
          }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    render(<AdminWaitlistPage />);

    await screen.findByText("Jane Doe");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("");
    const confirm = screen.getByRole("button", { name: "Force Confirm" });
    fireEvent.click(confirm);

    await screen.findByText(/database update could not be completed/i);
    await expectRecoveryAlertToHoldFocus(alert);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    expect(confirm).toBeEnabled();
  });

  it("restores Force Confirm after an unknown network outcome and supports retry", async () => {
    mocks.currentSearch = "";
    let forceConfirmCalls = 0;
    let waitlistLoads = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
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
        forceConfirmCalls += 1;
        if (forceConfirmCalls === 1) {
          return Promise.reject(new Error("private network detail"));
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, status: "PAYMENT_PENDING" }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    render(<AdminWaitlistPage />);

    await screen.findByText("Jane Doe");
    const confirm = screen.getByRole("button", { name: "Force Confirm" });
    fireEvent.click(confirm);
    await screen.findByText(/could not verify whether this booking was force-confirmed/i);
    expect(confirm).toBeEnabled();
    await expectRecoveryAlertToHoldFocus(screen.getByRole("alert"));
    expect(screen.queryByText(/private network detail/i)).not.toBeInTheDocument();

    fireEvent.click(confirm);
    await screen.findByText("No waitlisted bookings match the current filters");
    await waitFor(() => expect(forceConfirmCalls).toBe(2));
  });

  it("handles an unreadable force-confirm response and restores the control", async () => {
    mocks.currentSearch = "";
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/waitlist") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            entries: [waitlistEntry()],
            page: 1,
            pageSize: 25,
            total: 1,
          }),
        });
      }
      if (url === "/api/admin/bookings/booking-1/force-confirm") {
        return Promise.resolve({
          ok: false,
          json: async () => {
            throw new Error("private JSON detail");
          },
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    render(<AdminWaitlistPage />);

    await screen.findByText("Jane Doe");
    const confirm = screen.getByRole("button", { name: "Force Confirm" });
    fireEvent.click(confirm);

    await screen.findByText(/could not verify whether this booking was force-confirmed/i);
    expect(confirm).toBeEnabled();
    await expectRecoveryAlertToHoldFocus(screen.getByRole("alert"));
    expect(screen.queryByText(/private JSON detail/i)).not.toBeInTheDocument();
  });

  it("retains the overbook retry context when the final confirmation fails", async () => {
    mocks.currentSearch = "";
    let forceConfirmCalls = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/waitlist") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            entries: [waitlistEntry()],
            page: 1,
            pageSize: 25,
            total: 1,
          }),
        });
      }
      if (url === "/api/admin/bookings/booking-1/force-confirm") {
        forceConfirmCalls += 1;
        const requestBody = JSON.parse(String(init?.body ?? "{}")) as {
          allowOverbook?: boolean;
        };
        if (!requestBody.allowOverbook) {
          return Promise.resolve({
            ok: false,
            json: async () => ({
              error: "CAPACITY_EXCEEDED",
              overbookDates: ["2026-07-01"],
            }),
          });
        }
        return Promise.resolve({
          ok: false,
          json: async () => ({
            error:
              "The database update could not be completed because this booking or member changed. Reload before trying again. If a payment was involved, check its status before retrying.",
            code: "HOSTING_COVERAGE_PARTICIPANT_RETRY",
          }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    render(<AdminWaitlistPage />);

    await screen.findByText("Jane Doe");
    fireEvent.click(screen.getByRole("button", { name: "Force Confirm" }));
    await screen.findByText("This will overbook the lodge on the following dates:");
    const retry = screen.getByRole("button", { name: /Confirm Anyway/i });
    fireEvent.click(retry);

    await screen.findByText(/database update could not be completed/i);
    expect(screen.getByText("This will overbook the lodge on the following dates:")).toBeInTheDocument();
    await waitFor(() => expect(retry).toBeEnabled());
    expect(forceConfirmCalls).toBe(2);
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

  it("disables refund and credit review actions for finance view-only access", async () => {
    mocks.currentSearch = "";
    mocks.sessionUser = {
      id: "admin-readonly",
      role: "ADMIN",
      accessRoles: [{ role: "ADMIN_READONLY" }],
    };
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/admin/refund-requests?status=PENDING") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: [
              {
                id: "refund-1",
                bookingId: "booking-1",
                memberId: "member-1",
                reason: "Weather closure",
                requestedAmountCents: 2000,
                status: "PENDING",
                adminNotes: null,
                approvedAmountCents: null,
                reviewedAt: null,
                createdAt: "2026-07-01T00:00:00.000Z",
                booking: {
                  id: "booking-1",
                  checkIn: "2026-08-01T00:00:00.000Z",
                  checkOut: "2026-08-03T00:00:00.000Z",
                  finalPriceCents: 10000,
                  status: "CANCELLED",
                  creditsFromCancellation: [],
                  appealCeilingCents: 10000, // #4124: the list route's `refundAppealCeilingParts`
                  payment: {
                    status: "SUCCEEDED",
                    amountCents: 10000,
                    refundedAmountCents: 0,
                    stripePaymentIntentId: "pi_123",
                  },
                },
                member: {
                  id: "member-1",
                  firstName: "Jane",
                  lastName: "Doe",
                  email: "jane@example.com",
                },
              },
            ],
          }),
        });
      }

      if (url === "/api/admin/credit-approvals?status=PENDING") {
        return Promise.resolve({
          ok: true,
          json: async () => [
            {
              id: "credit-request-1",
              memberId: "member-2",
              amountCents: 3000,
              description: "Manual correction",
              status: "PENDING",
              createdAt: "2026-07-01T00:00:00.000Z",
              reviewedAt: null,
              member: {
                id: "member-2",
                firstName: "Rangi",
                lastName: "Smith",
                email: "rangi@example.com",
              },
              requestedBy: {
                id: "admin-1",
                firstName: "Alex",
                lastName: "Admin",
              },
              reviewedBy: null,
              approvedCredit: null,
            },
          ],
        });
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    render(<RefundRequestsPage />);

    expect(
      await screen.findByText(/can view refund appeals and credit approvals/i),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Review/ })).toBeDisabled();
    const creditSection = screen
      .getByText("Manual Credit Approvals")
      .closest("section");
    expect(creditSection).toBeTruthy();
    expect(
      within(creditSection as HTMLElement).getByRole("button", {
        name: /^Approve/,
      }),
    ).toBeDisabled();
    expect(
      within(creditSection as HTMLElement).getByRole("button", {
        name: /^Reject$/,
      }),
    ).toBeDisabled();
  });
  /*
    #3372 — the rendered half of #3340. The card's first money figure is the
    GROSS capture, which is right beside a net "Remaining", but it was labelled
    "Paid:" — the word that in the live incident read as "what the club holds".
    The label now says which figure it is; the figures themselves are unchanged.
  */
  it("labels the gross capture as gross, beside the net remaining figure", async () => {
    mocks.currentSearch = "";
    mocks.sessionUser = {
      id: "admin-2",
      role: "ADMIN",
      accessRoles: [{ role: "ADMIN" }],
    };
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/refund-requests?status=PENDING") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: [
              {
                id: "refund-1",
                bookingId: "booking-1",
                memberId: "member-1",
                reason: "Weather closure",
                requestedAmountCents: 2000,
                status: "PENDING",
                adminNotes: null,
                approvedAmountCents: null,
                reviewedAt: null,
                createdAt: "2026-07-01T00:00:00.000Z",
                booking: {
                  id: "booking-1",
                  checkIn: "2026-08-01T00:00:00.000Z",
                  checkOut: "2026-08-03T00:00:00.000Z",
                  finalPriceCents: 13000,
                  status: "CANCELLED",
                  creditsFromCancellation: [],
                  appealCeilingCents: 6500, // #4124: the list route's `refundAppealCeilingParts`
                  // The #3340 booking: $130.00 captured, $65.00 refunded.
                  payment: {
                    status: "PARTIALLY_REFUNDED",
                    amountCents: 13000,
                    refundedAmountCents: 6500,
                    stripePaymentIntentId: "pi_123",
                  },
                },
                member: {
                  id: "member-1",
                  firstName: "Jane",
                  lastName: "Doe",
                  email: "jane@example.com",
                },
              },
            ],
          }),
        });
      }
      if (url === "/api/admin/credit-approvals?status=PENDING") {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    render(<RefundRequestsPage />);

    const grossPaid = (await screen.findByText("Gross paid:")).parentElement;
    expect(grossPaid).toHaveTextContent("Gross paid: $130.00");
    // The net beside it says what it is: what can still be refunded.
    const remaining = screen.getByText("Remaining refundable:").parentElement;
    expect(remaining).toHaveTextContent("Remaining refundable: $65.00");
    // The bare words are gone, not merely supplemented.
    expect(screen.queryByText("Paid:")).toBeNull();
    expect(screen.queryByText("Remaining:")).toBeNull();
    expect(screen.getByText("To card:").parentElement).toHaveTextContent("To card: $65.00");

    // Display only (#3372 acceptance): rendering the page sends nothing but
    // reads.
    expect(fetchMock).toHaveBeenCalled();
    for (const [, init] of fetchMock.mock.calls) {
      const method = (init as RequestInit | undefined)?.method ?? "GET";
      expect(method).toBe("GET");
    }
  });

  /*
    #2932 review. `startRefundReview` had an `if (payment)` with no `else`, so
    opening a review for a request whose booking has no payment showed the
    amount prefilled for the request reviewed BEFORE it. The server refuses that
    amount, so it was an interface wart rather than a money leak - but it is a
    money box, and the number in it was another member's.

    The ceiling was also derived by hand here, `amountCents - refundedAmountCents`
    in two places, while the approve route decides by
    `getRemainingRefundableCents`. A payment that never captured therefore
    offered a ceiling the server would refuse, and a refund larger than the
    capture could show a negative one. Both places route through the helper now,
    which is what makes the middle request below read $0.00.
  */
  it("clears the refund amount when the next request has nothing refundable", async () => {
    mocks.currentSearch = "";
    mocks.sessionUser = {
      id: "admin-2",
      role: "ADMIN",
      accessRoles: [{ role: "ADMIN" }],
    };

    const refundRequest = (
      id: string,
      payment: Record<string, unknown> | null,
    ) => ({
      id,
      bookingId: `booking-${id}`,
      memberId: `member-${id}`,
      reason: "Weather closure",
      requestedAmountCents: null,
      status: "PENDING",
      adminNotes: null,
      approvedAmountCents: null,
      reviewedAt: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      booking: {
        id: `booking-${id}`,
        checkIn: "2026-08-01T00:00:00.000Z",
        checkOut: "2026-08-03T00:00:00.000Z",
        finalPriceCents: 10000,
        status: "CANCELLED",
        noEmails: false,
        creditsFromCancellation: [],
        // #4124: the list route's `refundAppealCeilingParts` of this payment.
        appealCeilingCents: refundAppealCeilingParts(payment && ({ ...payment, recoveryOperations: [], refunds: [] } as never), []).ceilingCents,
        payment,
      },
      member: {
        id: `member-${id}`,
        firstName: "Jane",
        lastName: id,
        email: `${id}@example.com`,
      },
    });

    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/refund-requests?status=PENDING") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: [
              refundRequest("captured", {
                status: "SUCCEEDED",
                amountCents: 10000,
                refundedAmountCents: 0,
                stripePaymentIntentId: "pi_123",
              }),
              // Money was never taken, so nothing is refundable - even though a
              // hand subtraction of the two cent columns says $100.00.
              refundRequest("uncaptured", {
                status: "PENDING",
                amountCents: 10000,
                refundedAmountCents: 0,
                stripePaymentIntentId: null,
              }),
              refundRequest("unpaid", null),
            ],
            page: 1,
            pageSize: 25,
            total: 3,
          }),
        });
      }
      if (url === "/api/admin/credit-approvals?status=PENDING") {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    render(<RefundRequestsPage />);

    const amountBox = () =>
      screen.getByRole("textbox", { name: /Refund Amount/i }) as HTMLInputElement;

    /*
      Only one review panel is open at a time, and the request being reviewed
      hides its own Review button - so the remaining buttons shift. `expected`
      pins the whole remaining list at each step, so the walk below fails saying
      the ordering moved rather than silently clicking a different card.
    */
    const whoseCard = (button: HTMLElement) =>
      [...screen.getAllByText(/^Jane (captured|uncaptured|unpaid)$/)]
        .reverse()
        .find(
          (heading) =>
            heading.compareDocumentPosition(button) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        )?.textContent;

    const review = async (who: string, expected: string[]) => {
      const buttons = await screen.findAllByRole("button", { name: "Review" });
      expect(buttons.map(whoseCard)).toEqual(
        expected.map((name) => `Jane ${name}`),
      );
      fireEvent.click(buttons[expected.indexOf(who)] as HTMLElement);
    };

    await review("captured", ["captured", "uncaptured", "unpaid"]);
    expect(amountBox().value).toBe("100.00");
    expect(screen.getByText("Max refundable: $100.00")).toBeTruthy();

    // No payment row at all: the box is emptied, not left holding $100.00.
    await review("unpaid", ["uncaptured", "unpaid"]);
    expect(amountBox().value).toBe("");
    expect(screen.getByText("Max refundable: $0.00")).toBeTruthy();

    // A payment that never captured: same answer, and it is the one a hand
    // subtraction of the cent columns got wrong.
    await review("uncaptured", ["captured", "uncaptured"]);
    expect(amountBox().value).toBe("");
    expect(screen.getByText("Max refundable: $0.00")).toBeTruthy();
  });

  /** Paid 200, refunded 75 at cancel, a 50 edit refund still open: one pending appeal, ceiling 75. */
  function mockEditedPendingAppeal(appealCardRefundOwedCents = 0) {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/refund-requests?status=PENDING") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: [
              {
                id: "edited",
                bookingId: "booking-edited",
                memberId: "member-edited",
                reason: "Weather closure",
                requestedAmountCents: null,
                status: "PENDING",
                adminNotes: null,
                approvedAmountCents: null,
                reviewedAt: null,
                createdAt: "2026-07-01T00:00:00.000Z",
                booking: {
                  id: "booking-edited",
                  checkIn: "2026-08-01T00:00:00.000Z",
                  checkOut: "2026-08-03T00:00:00.000Z",
                  finalPriceCents: 15000,
                  status: "CANCELLED",
                  noEmails: false,
                  creditsFromCancellation: [],
                  appealCeilingCents: 7500, // #4124: the list route's `refundAppealCeilingParts`
                  appealCardRefundOwedCents,
                  payment: {
                    status: "PARTIALLY_REFUNDED",
                    amountCents: 20000,
                    refundedAmountCents: 7500,
                    stripePaymentIntentId: null,
                  },
                },
                member: { id: "member-edited", firstName: "Jane", lastName: "edited", email: "e@example.com" },
              },
            ],
            page: 1,
            pageSize: 25,
            total: 1,
          }),
        });
      }
      if (url === "/api/admin/credit-approvals?status=PENDING") {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
  }

  // #3827 (`INV-PAY-117`): the ceiling the screen offers is the one the approve
  // route enforces - the remaining refundable cash LESS the edit refunds still
  // promised back by bank transfer. Paid 200, refunded 75 at cancel, a 50 edit
  // refund still open: 75, not the gross 125.
  it("offers the ceiling net of open edit refunds, the figure the approve route caps at", async () => {
    mocks.currentSearch = "";
    mocks.sessionUser = { id: "admin-2", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] };
    mockEditedPendingAppeal();

    render(<RefundRequestsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));

    expect((screen.getByRole("textbox", { name: /Refund Amount/i }) as HTMLInputElement).value).toBe("75.00");
    expect(screen.getByText("Max refundable: $75.00")).toBeTruthy();
    // #3372 x #3827: the card's net figure is that same ceiling, beside the
    // gross capture labelled as gross.
    expect(screen.getByText("Remaining refundable:").parentElement).toHaveTextContent("Remaining refundable: $75.00");
    expect(screen.getByText("Gross paid:").parentElement).toHaveTextContent("Gross paid: $200.00");
  });

  // #4124: a card refund not yet made is netted from the ceiling, and the
  // officer is told why it is lower, and where that refund is tracked.
  it("says under the ceiling how much of it is a card refund not yet made", async () => {
    mocks.currentSearch = "";
    mocks.sessionUser = { id: "admin-2", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] };
    mockEditedPendingAppeal(2500);

    render(<RefundRequestsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));

    expect(screen.getByText("Max refundable: $75.00")).toBeTruthy();
    const note = screen.getByText("Less $25.00 of card refund not yet made for this payment (retrying, or stopped and listed on Stuck states).");
    // The note and the maximum describe the amount box.
    const limits = document.getElementById("approvedAmountLimits");
    expect(limits?.contains(note)).toBe(true);
    expect(screen.getByRole("textbox", { name: /Refund Amount/i }).getAttribute("aria-describedby")).toContain("approvedAmountLimits");
  });

  it("CONTROL: shows no card refund line when none was netted", async () => {
    mocks.currentSearch = "";
    mocks.sessionUser = { id: "admin-2", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] };
    mockEditedPendingAppeal(0);

    render(<RefundRequestsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));

    expect(screen.getByText("Max refundable: $75.00")).toBeTruthy();
    expect(screen.queryByText(/card refund not yet made/)).toBeNull();
  });

  /*
    #3956 round 3: while the group cancellation's own refund to the organiser's
    card is still being made, the ceiling is zero only for now. The screen says
    so, rather than "Max refundable $0.00", which an officer would decline on.
  */
  it("says a group joiner's appeal waits on the group refund, not that nothing is left", async () => {
    mocks.currentSearch = "";
    mocks.sessionUser = { id: "admin-2", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] };
    const waitingRequest = (pending: boolean) => ({
      id: "joiner",
      bookingId: "booking-joiner",
      memberId: "member-joiner",
      reason: "Weather closure",
      requestedAmountCents: null,
      status: "PENDING",
      adminNotes: null,
      approvedAmountCents: null,
      reviewedAt: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      booking: {
        id: "booking-joiner",
        checkIn: "2026-08-01T00:00:00.000Z",
        checkOut: "2026-08-03T00:00:00.000Z",
        finalPriceCents: 15000,
        status: "CANCELLED",
        noEmails: false,
        creditsFromCancellation: [],
        appealCeilingCents: 15000, // #4124: the list route's `refundAppealCeilingParts`
        // #4124 delta review: a card refund owed on the child's own payment is
        // already in the organiser cap's room, so no "Less ..." line here.
        appealCardRefundOwedCents: 2_500,
        payment: { status: "SUCCEEDED", amountCents: 15000, refundedAmountCents: 0, stripePaymentIntentId: null },
        organiserCardMaxRefundableCents: pending ? 0 : 4_000,
        organiserCardCombinedRefundPending: pending,
      },
      member: { id: "member-joiner", firstName: "Jo", lastName: "Joiner", email: "j@example.com" },
    });
    for (const pending of [true, false]) {
      fetchMock.mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/admin/refund-requests?status=PENDING") {
          return Promise.resolve({
            ok: true,
            json: async () => ({ data: [waitingRequest(pending)], page: 1, pageSize: 25, total: 1 }),
          });
        }
        if (url === "/api/admin/credit-approvals?status=PENDING") {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        return Promise.reject(new Error(`Unexpected fetch: ${url}`));
      });

      const view = render(<RefundRequestsPage />);
      fireEvent.click(await screen.findByRole("button", { name: "Review" }));

      if (pending) {
        expect(
          screen.getByText(
            "The group cancellation's refund to the organiser's card is still being made or reconciled. Approve this once it is made.",
          ),
        ).toBeTruthy();
        expect(screen.queryByText(/Max refundable/)).toBeNull();
        expect(screen.getByText("Remaining refundable:").parentElement).toHaveTextContent(
          "Remaining refundable: Waiting for the group refund",
        );
      } else {
        expect(screen.getByText("Max refundable: $40.00")).toBeTruthy();
        expect(screen.queryByText(/still being made or reconciled/)).toBeNull();
        expect(screen.getByText("Refunded to the group organiser's card; the most that payment can still return for this booking.")).toBeTruthy();
        expect(screen.queryByText(/card refund not yet made/)).toBeNull();
      }
      view.unmount();
    }
  });
});

/*
  #4117 (`INV-PAY-128`): an approved appeal's card refund may not be made in
  full - Stripe refused a part, or a part could not be sent - and that part is
  queued for retry. The screen says so, rather than "approved and processed",
  and its Refunded figure is what was actually refunded.
*/
describe("an approved appeal whose card refund is still partly owed (#4117)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = fetchMock as typeof fetch;
    mocks.sessionUser = { id: "admin-2", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] };
  });

  function appeal(overrides: Record<string, unknown>) {
    return {
      id: "refund-1",
      bookingId: "booking-1",
      memberId: "member-1",
      reason: "Weather closure",
      requestedAmountCents: 2500,
      status: "PENDING",
      adminNotes: null,
      approvedAmountCents: null,
      reviewedAt: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      booking: {
        id: "booking-1",
        checkIn: "2026-08-01T00:00:00.000Z",
        checkOut: "2026-08-03T00:00:00.000Z",
        finalPriceCents: 10000,
        status: "CANCELLED",
        noEmails: false,
        creditsFromCancellation: [],
        appealCeilingCents: 10000, // #4124: the list route's `refundAppealCeilingParts`
        payment: { status: "SUCCEEDED", amountCents: 10000, refundedAmountCents: 0, stripePaymentIntentId: "pi_1" },
      },
      member: { id: "member-1", firstName: "Jane", lastName: "Doe", email: "jane@example.com" },
      ...overrides,
    };
  }

  function serve(status: string, rows: unknown[], put?: unknown) {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/admin/refund-requests?status=${status}`) {
        return Promise.resolve({ ok: true, json: async () => ({ data: rows, page: 1, pageSize: 25, total: rows.length }) });
      }
      if (url === `/api/admin/credit-approvals?status=${status}`) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url === "/api/admin/refund-requests/refund-1" && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => put });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
  }

  it("shows Refunded as what was made, and the part still queued for retry", async () => {
    mocks.currentSearch = "status=APPROVED";
    serve("APPROVED", [
      appeal({ status: "APPROVED", approvedAmountCents: 2500, reviewedAt: "2026-07-02T00:00:00.000Z", cardRefundState: "retrying", cardRefundOwedCents: 1000 }),
    ]);

    render(<RefundRequestsPage />);

    expect((await screen.findByText("Refunded:")).parentElement).toHaveTextContent("Refunded: $15.00");
    expect(screen.getByText("$10.00 of the card refund is queued for retry.")).toBeTruthy();
  });

  it.each([
    [{ cardRefundState: "dead", cardRefundOwedCents: 1000 }, "$15.00", "$10.00 of the card refund is still owed: its retries ran out."],
    [
      { cardRefundState: "not_queued", cardRefundOwedCents: 2500, cardRefundRefusedCents: 1500, cardRefundUnansweredCents: 1000 },
      "$0.00",
      "This card refund could not be queued for retry. $15.00 was refused by Stripe, so it certainly did not go back: refund it another way. $10.00 got no answer from Stripe and may have been made: check the payment in Stripe before refunding it another way. A refund made another way does not show here: check and record it.",
    ],
    [{ cardRefundState: "made", cardRefundOwedCents: 0, handBackOwedCents: 500 }, "$20.00", "$5.00 is still to be refunded by bank transfer."],
    [{ cardRefundState: "made", cardRefundOwedCents: 0, handBackDismissedCents: 700 }, "$18.00", "$7.00 was not refunded: its bank-transfer task was dismissed."],
  ])("an appeal %o: Refunded %s, and says what is still owed", async (outcome, refunded, line) => {
    mocks.currentSearch = "status=APPROVED";
    serve("APPROVED", [appeal({ status: "APPROVED", approvedAmountCents: 2500, reviewedAt: "2026-07-02T00:00:00.000Z", ...outcome })]);

    render(<RefundRequestsPage />);

    expect((await screen.findByText("Refunded:")).parentElement).toHaveTextContent(`Refunded: ${refunded}`);
    expect(screen.getByText(line)).toBeTruthy();
    expect(screen.queryByText(/queued for retry\.$/)).toBeNull();
  });

  it("an appeal refunded in full shows the whole amount and no retry line", async () => {
    mocks.currentSearch = "status=APPROVED";
    serve("APPROVED", [appeal({ status: "APPROVED", approvedAmountCents: 2500, reviewedAt: "2026-07-02T00:00:00.000Z", cardRefundOwedCents: 0 })]);

    render(<RefundRequestsPage />);

    expect((await screen.findByText("Refunded:")).parentElement).toHaveTextContent("Refunded: $25.00");
    expect(screen.queryByText(/queued for retry/)).toBeNull();
  });

  it.each([
    [{ cardRefundOwedCents: 1000, cardRefundQueued: true }, "Refund approved; $10.00 is queued for retry"],
    [{ cardRefundOwedCents: 0, cardRefundQueued: true }, "Refund approved and processed"],
    [
      { cardRefundOwedCents: 2500, cardRefundQueued: false, cardRefundRefusedCents: 1500, cardRefundUnansweredCents: 1000 },
      "Refund approved, but its card refund could not be queued for retry. $15.00 was refused by Stripe, so it certainly did not go back: refund it another way. $10.00 got no answer from Stripe and may have been made: check the payment in Stripe before refunding it another way.",
    ],
  ])("after approving, the toast reads the route's answer %o", async (answer, toast) => {
    mocks.currentSearch = "";
    serve("PENDING", [appeal({})], { ...appeal({ status: "APPROVED", approvedAmountCents: 2500 }), ...answer });

    render(<RefundRequestsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve & Refund" }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve and email member" }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(toast));
  });
});

