// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

// #1997: the client now derives view-only gating from the session matrix via
// useAdminAreaEditAccess. Mock an all-edit admin so the existing approve/reject
// action assertions (enabled buttons) hold.
//
// #2627: the release control is additionally gated on Full Admin (the ADMIN
// access role), which is NOT the same permission as membership edit — a
// Membership Officer has the latter and not the former. The session is therefore
// mutable so both sides of that gate can be driven. `FULL_ADMIN_SESSION_USER` is
// the default; `restoreDefaultSessionUser()` puts it back.
const sessionMock = vi.hoisted(() => {
  const fullAdmin = {
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
  };
  return { fullAdmin, user: fullAdmin as Record<string, unknown> };
});

function restoreDefaultSessionUser() {
  sessionMock.user = sessionMock.fullAdmin;
}

/** A Membership Officer: membership edit access, no Full Admin access role. */
function useMembershipOfficerSession() {
  sessionMock.user = {
    ...sessionMock.fullAdmin,
    accessRoles: [{ role: "ADMIN_MEMBERSHIP" }],
  };
}

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: sessionMock.user } }),
}));

import DeletionRequestsClient from "../deletion-requests-client";
import {
  DELETION_APPROVAL_RELEASED_DISCLOSURE,
  DELETION_APPROVAL_RELEASED_LEAD,
  DELETION_REJECT_AFTER_RELEASE_CONFIRM_MESSAGE,
} from "@/lib/deletion-request-decision";
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";

/**
 * #2627: the release/reject disclosure is asserted as the shared CONSTANT rather
 * than retyped, so a copy that drifts from the single source fails here. It is
 * rendered inside a longer sentence, so it has to be matched as a substring —
 * hence a regex over the escaped literal rather than a string matcher.
 */
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface LifecycleRow {
  id: string;
  status: string;
  reason: string;
  reviewNote: string | null;
  requestedAt: string;
  reviewedAt: string | null;
  requestedByMemberId: string | null;
  requestedBy: { id: string; name: string; email: string } | null;
  targetName: string;
  member: { id: string; name: string; email: string } | null;
}

function buildFetchMock(
  lifecycleRequests: LifecycleRow[],
  lifecycleMeta: { total?: number; totalPages?: number } = {},
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/admin/member-lifecycle-action-requests")) {
      const params = new URL(url, "http://localhost").searchParams;
      return {
        ok: true,
        json: async () => ({
          requests: lifecycleRequests,
          total: lifecycleMeta.total ?? lifecycleRequests.length,
          page: Number(params.get("page") ?? "1"),
          pageSize: 25,
          totalPages: lifecycleMeta.totalPages ?? 1,
        }),
      };
    }
    // Self-service deletion-requests list: empty for these tests.
    return {
      ok: true,
      json: async () => ({
        requests: [],
        total: 0,
        page: 1,
        pageSize: 25,
        totalPages: 0,
      }),
    };
  });
}

function row(overrides: Partial<LifecycleRow> = {}): LifecycleRow {
  return {
    id: "del-1",
    status: "REQUESTED",
    reason: "Duplicate created in error",
    reviewNote: null,
    requestedAt: "2026-07-16T00:00:00.000Z",
    reviewedAt: null,
    requestedByMemberId: "admin-2",
    requestedBy: { id: "admin-2", name: "Other Admin", email: "o@a.test" },
    targetName: "Erroneous Record",
    member: null,
    ...overrides,
  };
}

describe("AdminInitiatedDeletionSection (#1938)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders an admin-initiated DELETE request row", async () => {
    vi.stubGlobal("fetch", buildFetchMock([row()]));

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);

    await waitFor(() =>
      expect(screen.getByText("Erroneous Record")).not.toBeNull(),
    );
    expect(
      screen.getByText("Admin-initiated deletion requests"),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Approve" })).not.toBeNull();
  });

  it("enables approve/reject for a request raised by a DIFFERENT admin", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchMock([row({ requestedByMemberId: "admin-2" })]),
    );

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);

    await waitFor(() =>
      expect(screen.getByText("Erroneous Record")).not.toBeNull(),
    );
    expect(
      (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      screen.queryByText("A different admin must review this request"),
    ).toBeNull();
  });

  it("disables approve/reject with a note when the current admin is the requester", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchMock([row({ requestedByMemberId: "admin-1" })]),
    );

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);

    await waitFor(() =>
      expect(screen.getByText("Erroneous Record")).not.toBeNull(),
    );
    expect(
      (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      screen.getByText("A different admin must review this request"),
    ).not.toBeNull();
  });

  it("sends a page param and shows pager controls when total exceeds one page", async () => {
    const fetchMock = buildFetchMock([row()], { total: 30, totalPages: 2 });
    vi.stubGlobal("fetch", fetchMock);

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);

    await waitFor(() =>
      expect(screen.getByText("Erroneous Record")).not.toBeNull(),
    );

    // Initial lifecycle fetch carries page=1.
    const lifecycleUrls = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/api/admin/member-lifecycle-action-requests"));
    expect(lifecycleUrls.length).toBeGreaterThan(0);
    expect(lifecycleUrls[0]).toContain("page=1");

    // Pager renders both controls and the page indicator.
    const next = screen.getByRole("button", { name: "Next" });
    expect(next).not.toBeNull();
    expect(screen.getByRole("button", { name: "Previous" })).not.toBeNull();
    expect(screen.getByText("Page 1 of 2")).not.toBeNull();

    // Advancing the page re-fetches with page=2.
    fireEvent.click(next);
    await waitFor(() => {
      const urls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) =>
          u.includes("/api/admin/member-lifecycle-action-requests"),
        );
      expect(urls.some((u) => u.includes("page=2"))).toBe(true);
    });
  });

  it("shows filter-aware empty copy for the admin-initiated section", async () => {
    // Default status filter is PENDING; no lifecycle rows returned.
    vi.stubGlobal("fetch", buildFetchMock([]));

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);

    await waitFor(() =>
      expect(
        screen.getByText(/No pending admin-initiated deletion requests\./),
      ).not.toBeNull(),
    );
  });
});

describe("self-service deletion partial recovery (#2597)", () => {
  const deletionRequest = {
    id: "request-1",
    status: "PENDING",
    reason: "Please remove my account",
    adminNote: null,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    member: {
      id: "member-1",
      firstName: "Riley",
      lastName: "Chen",
      email: "riley@example.test",
      role: "MEMBER",
      active: true,
    },
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  function buildPartialRecoveryFetch(responseBody: Record<string, unknown>) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/admin/member-lifecycle-action-requests")) {
        return {
          ok: true,
          json: async () => ({
            requests: [],
            total: 0,
            page: 1,
            pageSize: 25,
            totalPages: 0,
          }),
        } as Response;
      }
      if (
        url === "/api/admin/deletion-requests/request-1" &&
        init?.method === "POST"
      ) {
        return {
          ok: false,
          status: 409,
          json: async () => responseBody,
        } as Response;
      }
      if (url.startsWith("/api/admin/deletion-requests?")) {
        return {
          ok: true,
          json: async () => ({
            requests: [deletionRequest],
            total: 1,
            page: 1,
            pageSize: 25,
            totalPages: 1,
          }),
        } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  }

  it.each([
    {
      action: "approve" as const,
      finalDecision: "APPROVED",
      memberAnonymised: true,
      submitButton: "Approve & Delete Account",
      expectedDecision: /another administrator approved/i,
      expectedMember: /latest member record is anonymised/i,
    },
    {
      action: "reject" as const,
      finalDecision: "REJECTED",
      memberAnonymised: false,
      submitButton: "Reject and email member",
      expectedDecision: /another administrator rejected/i,
      expectedMember: /latest member record is not anonymised/i,
    },
  ])(
    "shows final $finalDecision facts without a cleanup retry",
    async ({
      action,
      finalDecision,
      memberAnonymised,
      submitButton,
      expectedDecision,
      expectedMember,
    }) => {
      vi.stubGlobal(
        "fetch",
        buildPartialRecoveryFetch({
          error: "private database detail",
          decisionFinal: true,
          finalDecision,
          cancelledBookings: 1,
          memberAnonymised,
          memberDataAnonymised: memberAnonymised,
          retryAllowed: false,
        }) as typeof fetch,
      );

      render(<DeletionRequestsClient sessionMemberId="admin-1" />);
      await screen.findByText("Riley Chen");
      fireEvent.click(
        screen.getByRole("button", {
          name: action === "approve" ? "Approve" : "Reject",
        }),
      );
      fireEvent.click(
        await screen.findByRole("button", { name: submitButton }),
      );

      const alert = document.getElementById("deletion-requests-recovery");
      await waitFor(() =>
        expect(alert?.textContent).toMatch(expectedDecision),
      );
      expect(alert?.textContent).toMatch(expectedMember);
      expect(alert?.textContent).toMatch(/1 future booking cancellation completed/i);
      expect(alert?.textContent).toMatch(/decision is final/i);
      expect(alert?.textContent).not.toContain("private database detail");
      expect(
        screen.queryByRole("button", { name: "Retry remaining cleanup" }),
      ).toBeNull();
      await expectRecoveryAlertToHoldFocus(alert);
    },
  );

  it("uses ordinary partial-cleanup facts to retain recovery and replace untouched approval with an explicit retry", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const blockingAlert = vi.spyOn(window, "alert").mockImplementation(() => {});
    let deletionReads = 0;
    let deletionWrites = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/admin/member-lifecycle-action-requests")) {
        return {
          ok: true,
          json: async () => ({
            requests: [],
            total: 0,
            page: 1,
            pageSize: 25,
            totalPages: 0,
          }),
        } as Response;
      }
      if (url === "/api/admin/deletion-requests/request-1" && init?.method === "POST") {
        deletionWrites += 1;
        if (deletionWrites > 1) {
          return {
            ok: false,
            status: 409,
            json: async () => ({ error: "The remaining cleanup changed; reload it." }),
          } as Response;
        }
        return {
          ok: false,
          status: 500,
          json: async () => ({
            error: "private database detail",
            cancelledBookings: 2,
            cancellationPending: true,
            retryBookingId: "booking/pending",
            remainingCleanupPending: true,
            memberAnonymised: false,
            memberDataAnonymised: false,
            approvalReceiptSent: false,
          }),
        } as Response;
      }
      if (url.startsWith("/api/admin/deletion-requests?")) {
        deletionReads += 1;
        if (deletionReads === 1) {
          return {
            ok: true,
            json: async () => ({
              requests: [deletionRequest],
              total: 1,
              page: 1,
              pageSize: 25,
              totalPages: 1,
            }),
          } as Response;
        }
        return { ok: false, json: async () => ({}) } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch);

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);
    await screen.findByText("Riley Chen");
    const recoveryAlert = document.getElementById("deletion-requests-recovery");
    const actionAlert = document.getElementById("deletion-requests-error");
    expect(recoveryAlert?.getAttribute("role")).toBe("alert");
    expect(recoveryAlert?.textContent).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Approve & Delete Account" }),
    );

    await waitFor(() =>
      expect(recoveryAlert?.textContent).toMatch(/2 future bookings were cancelled/i),
    );
    expect(recoveryAlert?.textContent).toMatch(/one remaining booking still needs cancellation/i);
    expect(recoveryAlert?.textContent).toMatch(/data was not anonymised/i);
    expect(recoveryAlert?.textContent).toMatch(/no approval receipt was sent/i);
    expect(recoveryAlert?.textContent).toMatch(/could not be refreshed/i);
    expect(recoveryAlert?.textContent).not.toContain("private database detail");
    await expectRecoveryAlertToHoldFocus(recoveryAlert);
    expect(scrollIntoView).toHaveBeenCalled();
    expect(blockingAlert).not.toHaveBeenCalled();

    expect(
      (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    const openBooking = screen.getByRole("link", { name: "Open pending booking" });
    expect(openBooking.getAttribute("href")).toBe(
      "/bookings/booking%2Fpending?returnTo=%2Fadmin%2Fdeletion-requests",
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry remaining cleanup" }));
    expect(
      await screen.findByRole("heading", { name: "Approve Deletion Request" }),
    ).not.toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Approve & Delete Account" }),
    );
    await waitFor(() =>
      expect(actionAlert?.textContent).toContain("The remaining cleanup changed; reload it."),
    );
    await expectRecoveryAlertToHoldFocus(actionAlert);
    expect(recoveryAlert?.textContent).toMatch(/2 future bookings were cancelled/i);
  });

  it("shows a committed cancellation with unconfirmed post-processing without calling it pending", async () => {
    vi.stubGlobal(
      "fetch",
      buildPartialRecoveryFetch({
        cancelledBookings: 1,
        cancellationPending: false,
        retryBookingId: null,
        cancellationPostProcessingUnconfirmed: true,
        reviewBookingId: "booking/committed",
        remainingCleanupPending: true,
        memberAnonymised: false,
        memberDataAnonymised: false,
        approvalReceiptSent: false,
      }) as typeof fetch,
    );

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);
    await screen.findByText("Riley Chen");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Approve & Delete Account" }),
    );

    const alert = document.getElementById("deletion-requests-recovery");
    await waitFor(() =>
      expect(alert?.textContent).toMatch(/cancellation committed/i),
    );
    expect(alert?.textContent).toMatch(/post-cancellation processing could not be confirmed/i);
    expect(alert?.textContent).not.toMatch(/still needs cancellation/i);
    expect(
      (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      screen
        .getByRole("link", { name: "Open booking for review" })
        .getAttribute("href"),
    ).toBe(
      "/bookings/booking%2Fcommitted?returnTo=%2Fadmin%2Fdeletion-requests",
    );
  });

  it("retains cancellation facts and the last-admin remedy while suppressing a fresh approval", async () => {
    vi.stubGlobal(
      "fetch",
      buildPartialRecoveryFetch({
        cancelledBookings: 2,
        cancellationPending: false,
        retryBookingId: null,
        remainingCleanupPending: true,
        memberAnonymised: false,
        memberDataAnonymised: false,
        approvalReceiptSent: false,
        blocker: {
          code: "LAST_FULL_ADMIN_GUARD",
          message: "This is the last Full Admin account.",
          remedy:
            "Give another active account Full Admin access, then retry only the remaining deletion cleanup.",
        },
      }) as typeof fetch,
    );

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);
    await screen.findByText("Riley Chen");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Approve & Delete Account" }),
    );

    const alert = document.getElementById("deletion-requests-recovery");
    await waitFor(() =>
      expect(alert?.textContent).toMatch(/2 future bookings were cancelled/i),
    );
    expect(alert?.textContent).toMatch(/last Full Admin/i);
    expect(alert?.textContent).toMatch(/another active account Full Admin access/i);
    expect(
      (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Retry remaining cleanup" }),
    ).not.toBeNull();
  });
});

describe("deletion review outcome that never came back legibly (#2597)", () => {
  const deletionRequest = {
    id: "request-1",
    status: "PENDING",
    reason: "Please remove my account",
    adminNote: null,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    member: {
      id: "member-1",
      firstName: "Riley",
      lastName: "Chen",
      email: "riley@example.test",
      role: "MEMBER",
      active: true,
    },
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  /**
   * `post` decides what the review POST does: reject the fetch outright
   * (transport failure) or answer with a body that cannot be parsed.
   */
  function buildFetch(post: () => Promise<Response>, listRows = [deletionRequest]) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/admin/member-lifecycle-action-requests")) {
        return {
          ok: true,
          json: async () => ({
            requests: [],
            total: 0,
            page: 1,
            pageSize: 25,
            totalPages: 0,
          }),
        } as Response;
      }
      if (
        url === "/api/admin/deletion-requests/request-1" &&
        init?.method === "POST"
      ) {
        return post();
      }
      if (url.startsWith("/api/admin/deletion-requests?")) {
        return {
          ok: true,
          json: async () => ({
            requests: listRows,
            total: listRows.length,
            page: 1,
            pageSize: 25,
            totalPages: 1,
          }),
        } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  }

  const unreadableBody = (ok: boolean, status: number) =>
    ({
      ok,
      status,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON at position 0");
      },
    }) as unknown as Response;

  it.each([
    {
      name: "the connection drops",
      post: () => Promise.reject(new TypeError("Failed to fetch")),
      expectedCause: /server could not be reached/i,
    },
    {
      name: "an error response body cannot be parsed",
      post: () => Promise.resolve(unreadableBody(false, 502)),
      expectedCause: /response could not be read/i,
    },
    {
      name: "a success response body cannot be parsed",
      post: () => Promise.resolve(unreadableBody(true, 200)),
      expectedCause: /accepted it but its confirmation could not be read/i,
    },
  ])(
    "suppresses the destructive controls and refuses a retry when $name",
    async ({ post, expectedCause }) => {
      const fetchMock = buildFetch(post);
      vi.stubGlobal("fetch", fetchMock);

      render(<DeletionRequestsClient sessionMemberId="admin-1" />);
      await screen.findByText("Riley Chen");
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Approve & Delete Account" }),
      );

      const alert = document.getElementById("deletion-requests-recovery");
      await waitFor(() => expect(alert?.textContent).toMatch(expectedCause));

      // The admin is told the outcome is unknown, not that nothing happened.
      expect(alert?.textContent).toMatch(/may already have been recorded/i);
      expect(alert?.textContent).toMatch(/may already have cancelled future bookings/i);
      expect(alert?.textContent).toMatch(/do not retry/i);

      // No retry affordance, and the row's own Approve/Reject are inert.
      expect(
        screen.queryByRole("button", { name: "Retry remaining cleanup" }),
      ).toBeNull();
      expect(
        (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      expect(
        (screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);

      // The authoritative queue was re-read rather than trusted from memory.
      const listReads = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.startsWith("/api/admin/deletion-requests?"));
      expect(listReads.length).toBeGreaterThan(1);
    },
  );

  it("keeps the warning active and says so when the queue re-read also fails", async () => {
    let seenList = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/admin/member-lifecycle-action-requests")) {
          return {
            ok: true,
            json: async () => ({
              requests: [],
              total: 0,
              page: 1,
              pageSize: 25,
              totalPages: 0,
            }),
          } as Response;
        }
        if (
          url === "/api/admin/deletion-requests/request-1" &&
          init?.method === "POST"
        ) {
          throw new TypeError("Failed to fetch");
        }
        if (url.startsWith("/api/admin/deletion-requests?")) {
          // First (mount) read succeeds so the row renders; the recovery
          // re-read then fails.
          if (seenList) return { ok: false, status: 503 } as Response;
          seenList = true;
          return {
            ok: true,
            json: async () => ({
              requests: [deletionRequest],
              total: 1,
              page: 1,
              pageSize: 25,
              totalPages: 1,
            }),
          } as Response;
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);
    await screen.findByText("Riley Chen");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Approve & Delete Account" }),
    );

    const alert = document.getElementById("deletion-requests-recovery");
    await waitFor(() =>
      expect(alert?.textContent).toMatch(/could not be refreshed either/i),
    );
    expect(alert?.textContent).toMatch(/stays active until you reload/i);
  });

  /**
   * #2627: this test used to assert that Resume was the ONLY control an
   * `APPROVAL_IN_PROGRESS` row offered, which pinned the claim as a one-way
   * door — the exact defect. It now pins the replacement contract: Reject is
   * still absent (it could only fail while the claim stands), and the way out is
   * an explicit Full-Admin release rather than nothing at all.
   */
  it("offers resume and a Full Admin release on an APPROVAL_IN_PROGRESS row, never a reject", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetch(
        () => {
          throw new Error("no review should be submitted in this test");
        },
        [{ ...deletionRequest, status: "APPROVAL_IN_PROGRESS" }],
      ),
    );

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);
    await screen.findByText("Riley Chen");

    // Rejection cannot win this request server-side while the claim stands, so
    // the button that could only fail is still not offered at all.
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Resume approval" }),
    ).not.toBeNull();
    // The way out of a claim that can never complete.
    expect(
      screen.getByRole("button", { name: "Release approval" }),
    ).not.toBeNull();

    // And it is not mislabelled as a finished rejection.
    expect(screen.getByText("Approval in progress")).not.toBeNull();
    expect(screen.queryByText("Rejected")).toBeNull();
    expect(
      screen.getByText(/release it back to pending to decide again/i),
    ).not.toBeNull();
  });

  it("hides the release from a membership admin who is not a Full Admin, and says who can", async () => {
    useMembershipOfficerSession();
    try {
      vi.stubGlobal(
        "fetch",
        buildFetch(
          () => {
            throw new Error("no review should be submitted in this test");
          },
          [{ ...deletionRequest, status: "APPROVAL_IN_PROGRESS" }],
        ),
      );

      render(<DeletionRequestsClient sessionMemberId="admin-1" />);
      await screen.findByText("Riley Chen");

      // Membership edit access still gets Resume; the route refuses the release
      // with a 403, so offering it here would be a button that can only fail.
      expect(
        screen.getByRole("button", { name: "Resume approval" }),
      ).not.toBeNull();
      expect(screen.queryByRole("button", { name: "Release approval" })).toBeNull();
      expect(
        screen.getByText(/a Full Admin can release it back to pending/i),
      ).not.toBeNull();
    } finally {
      restoreDefaultSessionUser();
    }
  });

  it("requires a reason before releasing, then posts the release and reloads the queue", async () => {
    const post = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ message: "Approval released." }),
        }) as Response,
    );
    const fetchMock = buildFetch(post, [
      { ...deletionRequest, status: "APPROVAL_IN_PROGRESS" },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);
    await screen.findByText("Riley Chen");
    fireEvent.click(screen.getByRole("button", { name: "Release approval" }));

    // The route rejects a reasonless release with a 400, so the control must not
    // let one be submitted in the first place.
    const submit = (await screen.findByRole("button", {
      name: "Release back to pending",
    })) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Reason for releasing/i), {
      target: { value: "Xero blocker will never clear" },
    });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const body = JSON.parse(
      String(
        (
          fetchMock.mock.calls.find(
            (call) => (call[1] as RequestInit | undefined)?.method === "POST",
          )?.[1] as RequestInit
        ).body,
      ),
    );
    expect(body).toEqual({
      action: "release",
      note: "Xero blocker will never clear",
    });

    // A release changes the row's status, so the queue is re-read rather than
    // patched locally.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          String(input).startsWith("/api/admin/deletion-requests?"),
        ).length,
      ).toBeGreaterThan(1),
    );
  });

  it("states in the release dialog that already-cancelled bookings stay cancelled", async () => {
    // The release's disclosed mitigation. Every other assertion here is about
    // controls and payloads; if this sentence can be dropped by a copy edit then
    // the admin who releases a claim is no longer told what it leaves behind.
    //
    // Asserted as the shared constant, not as prose: the release dialog used to
    // keep a near-duplicate of it, so "spelled once" was a claim two sentences
    // could drift apart behind. This dialog and the reject dialog now render the
    // same string, and this test fails if either grows its own copy.
    vi.stubGlobal(
      "fetch",
      buildFetch(
        () => {
          throw new Error("no review should be submitted in this test");
        },
        [{ ...deletionRequest, status: "APPROVAL_IN_PROGRESS" }],
      ),
    );

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);
    await screen.findByText("Riley Chen");
    fireEvent.click(screen.getByRole("button", { name: "Release approval" }));

    expect(
      await screen.findByText(
        new RegExp(escapeForRegExp(DELETION_APPROVAL_RELEASED_DISCLOSURE)),
      ),
    ).not.toBeNull();
    // And that it decides nothing on its own.
    expect(
      screen.getByText(/Nobody is anonymised and the member is not emailed/i),
    ).not.toBeNull();
  });
});

/**
 * #2627 review finding: a released request is PENDING again, so it renders with
 * Reject and Approve live — but it is NOT an ordinary pending request. An
 * approval may already have cancelled the member's future bookings, and
 * rejecting will not bring them back. The marker travels in the row itself
 * (PENDING + reviewedAt + no reviewer), so these tests pin that the next decider
 * is told, and cannot reject without confirming it.
 */
describe("a request whose started approval was released (#2627)", () => {
  const deletionRequest = {
    id: "request-1",
    status: "PENDING",
    reason: "Please remove my account",
    adminNote: null as string | null,
    reviewedBy: null as string | null,
    reviewedAt: null as string | null,
    createdAt: "2026-08-01T00:00:00.000Z",
    member: {
      id: "member-1",
      firstName: "Riley",
      lastName: "Chen",
      email: "riley@example.test",
      role: "MEMBER",
      active: true,
    },
  };

  /** The wire shape of a released request: pending, timestamped, no reviewer. */
  const releasedRequest = {
    ...deletionRequest,
    adminNote: "Xero blocker will never clear",
    reviewedBy: null,
    reviewedAt: "2026-08-06T21:30:00.000Z",
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    restoreDefaultSessionUser();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  function buildFetch(
    post: (init?: RequestInit) => Promise<Response>,
    listRows: Array<Record<string, unknown>> = [releasedRequest],
  ) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/admin/member-lifecycle-action-requests")) {
        return {
          ok: true,
          json: async () => ({
            requests: [],
            total: 0,
            page: 1,
            pageSize: 25,
            totalPages: 0,
          }),
        } as Response;
      }
      if (
        url === "/api/admin/deletion-requests/request-1" &&
        init?.method === "POST"
      ) {
        return post(init);
      }
      if (url.startsWith("/api/admin/deletion-requests?")) {
        return {
          ok: true,
          json: async () => ({
            requests: listRows,
            total: listRows.length,
            page: 1,
            pageSize: 25,
            totalPages: 1,
          }),
        } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  }

  function postBodies(fetchMock: ReturnType<typeof buildFetch>) {
    return fetchMock.mock.calls
      .filter((call) => (call[1] as RequestInit | undefined)?.method === "POST")
      .map((call) => JSON.parse(String((call[1] as RequestInit).body)));
  }

  it("warns on the row, and does not mislabel the release marker as a completed review", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetch(() => {
        throw new Error("no review should be submitted in this test");
      }),
    );

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);
    await screen.findByText("Riley Chen");

    // Still badged Pending — which is exactly why the row needs the warning.
    expect(screen.getAllByText("Pending").length).toBeGreaterThan(0);
    expect(
      screen.getByText(/Approval started and released back to pending/i),
    ).not.toBeNull();
    expect(
      screen.getByText(/stay cancelled — rejecting this request will not restore them/i),
    ).not.toBeNull();
    // The release reason is the note on the row, and it is labelled as one.
    expect(screen.getByText("Release reason:")).not.toBeNull();
    // A PENDING request has no reviewer, so its reviewedAt must never read as a
    // finished review.
    expect(screen.queryByText(/^Reviewed /)).toBeNull();
  });

  it("carries the confirmation from the dialog that stated what happened", async () => {
    const post = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ message: "Deletion request rejected." }),
        }) as Response,
    );
    const fetchMock = buildFetch(post);
    vi.stubGlobal("fetch", fetchMock);

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);
    await screen.findByText("Riley Chen");
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    // The dialog repeats the disclosure where the decision is actually taken,
    // from the same constant every other site renders.
    expect(
      await screen.findByText(
        new RegExp(escapeForRegExp(DELETION_APPROVAL_RELEASED_LEAD)),
      ),
    ).not.toBeNull();
    // Scoped to the dialog: the queue row behind it renders the same constant,
    // which is the point — one string, four sites.
    expect(screen.getByRole("dialog").textContent).toContain(
      DELETION_APPROVAL_RELEASED_DISCLOSURE,
    );
    // And the note example — the only thing the MEMBER is told — stops
    // suggesting they resolve bookings that no longer exist.
    expect(
      screen.getByText(/contact us if you want to rebook/i),
    ).not.toBeNull();

    fireEvent.change(screen.getByLabelText(/Reason for rejection/i), {
      target: { value: "The blocker will not clear — contact us to rebook" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Reject and email member" }),
    );

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    // The route refuses an unconfirmed reject-after-release with the disclosure,
    // so this flag is the proof the decider was shown it.
    expect(postBodies(fetchMock)[0]).toMatchObject({
      action: "reject",
      note: "The blocker will not clear — contact us to rebook",
      notifyMember: true,
      confirmReleasedApproval: true,
    });
  });

  it("makes the reason mandatory and offers no silent rejection", async () => {
    // The two things the MEMBER gets, as controls rather than as a 400 they have
    // to hit first. Their future stays were cancelled by the started approval,
    // this note is the only thing they are ever told about it, and the route
    // refuses a reasonless or suppressed rejection here (#1788's free choice
    // stays on every ordinary rejection, where nothing has been destroyed).
    vi.stubGlobal(
      "fetch",
      buildFetch(() => {
        throw new Error("no review should be submitted in this test");
      }),
    );

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);
    await screen.findByText("Riley Chen");
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    const submit = (await screen.findByRole("button", {
      name: "Reject and email member",
    })) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    // Not offered at all, rather than offered and refused by the server.
    expect(
      screen.queryByRole("button", { name: "Reject without emailing" }),
    ).toBeNull();
    // And the label says the reason is required and where it goes.
    expect(
      screen.getByText(/Reason for rejection \(required — will be sent to member\)/i),
    ).not.toBeNull();

    fireEvent.change(screen.getByLabelText(/Reason for rejection/i), {
      target: { value: "Contact us if you want to rebook" },
    });
    expect(submit.disabled).toBe(false);
  });

  it("sends no confirmation flag on an ordinary pending request", async () => {
    const post = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ message: "Deletion request rejected." }),
        }) as Response,
    );
    const fetchMock = buildFetch(post, [deletionRequest]);
    vi.stubGlobal("fetch", fetchMock);

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);
    await screen.findByText("Riley Chen");
    expect(
      screen.queryByText(/Approval started and released back to pending/i),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Reject and email member" }),
    );

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(postBodies(fetchMock)[0].confirmReleasedApproval).toBeUndefined();
  });

  it("hides Reject from a membership admin who is not a Full Admin, and says who can decide", async () => {
    useMembershipOfficerSession();
    try {
      vi.stubGlobal(
        "fetch",
        buildFetch(() => {
          throw new Error("no review should be submitted in this test");
        }),
      );

      render(<DeletionRequestsClient sessionMemberId="admin-1" />);
      await screen.findByText("Riley Chen");

      // The route answers 403, so a Reject button here could only fail.
      expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
      expect(screen.getByRole("button", { name: "Approve" })).not.toBeNull();
      expect(
        screen.getByText(/Only a Full Admin can reject it now/i),
      ).not.toBeNull();
    } finally {
      restoreDefaultSessionUser();
    }
  });

  it("explains a stale page's refused rejection and reloads the queue, leaving the row usable", async () => {
    // A page loaded BEFORE the release renders an ordinary pending row and sends
    // no confirmation. The route refuses it with the disclosure; the client must
    // state that and re-read the queue so the warning appears — not enter the
    // durable "needs verification" recovery, which suppresses the row's controls
    // and forbids a retry that is entirely legitimate here.
    const post = vi.fn(
      async () =>
        ({
          ok: false,
          status: 409,
          json: async () => ({
            code: "DELETION_REJECT_AFTER_RELEASE_CONFIRM_REQUIRED",
            // The route's own words, from the constant, so this test cannot pin a
            // stale copy of the refusal it exists to check.
            error: DELETION_REJECT_AFTER_RELEASE_CONFIRM_MESSAGE,
            approvalReleased: true,
            retryAllowed: false,
          }),
        }) as unknown as Response,
    );
    const fetchMock = buildFetch(post, [deletionRequest]);
    vi.stubGlobal("fetch", fetchMock);

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);
    await screen.findByText("Riley Chen");
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Reject and email member" }),
    );

    expect(
      await screen.findByText(/Reload the deletion queue, read that warning/i),
    ).not.toBeNull();
    expect(screen.queryByText("Deletion decision needs verification")).toBeNull();
    // Re-read, so the warning is on the row when the admin comes back to it.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          String(input).startsWith("/api/admin/deletion-requests?"),
        ).length,
      ).toBeGreaterThan(1),
    );
    const reject = screen.getByRole("button", {
      name: "Reject",
    }) as HTMLButtonElement;
    expect(reject.disabled).toBe(false);
  });

  it("reports a finalisation that lost its guard to a release as exactly that", async () => {
    // Not "its final state could not be confirmed": nothing is unknown, and the
    // row must not be durably disabled over a request that is decidable again.
    const post = vi.fn(
      async () =>
        ({
          ok: false,
          status: 409,
          json: async () => ({
            code: "DELETION_REQUEST_APPROVAL_RELEASED",
            error:
              "Another administrator released this request's started approval, so it is pending again and this action anonymised nobody. Reload the deletion queue and decide the request from there — the row shows that future bookings may already have been cancelled.",
            approvalReleased: true,
            decisionFinal: false,
            cancelledBookings: 2,
            retryAllowed: false,
          }),
        }) as unknown as Response,
    );
    const fetchMock = buildFetch(post, [releasedRequest]);
    vi.stubGlobal("fetch", fetchMock);

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);
    await screen.findByText("Riley Chen");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Approve & Delete Account" }),
    );

    const message = await screen.findByText(
      /released this request's started approval/i,
    );
    expect(message).not.toBeNull();
    // What the lost attempt did commit is still stated.
    expect(
      screen.getByText(
        /2 future booking cancellations had already committed and stay cancelled/i,
      ),
    ).not.toBeNull();
    expect(screen.queryByText("Deletion decision needs verification")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
