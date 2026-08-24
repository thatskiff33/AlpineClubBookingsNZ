// @vitest-environment jsdom

import { render, screen } from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

/**
 * What the QUEUE looks like once the unpaid-invoice check is scoped (#2402).
 *
 * Three properties, none of which the library tests can see because they are all
 * about the rendered page:
 *
 * 1. a view-only admin gets the explanation ONCE per request and a short marker
 *    per affected row, not the same paragraph five times (#2402 review, F5);
 * 2. the Approve button follows the same rule the server does, so it is never
 *    enabled on a row whose checks were skipped (#2402 review, F4); and
 * 3. a row that cannot be approved says WHY, so a dead button is never
 *    unexplained.
 */

let membershipLevel: "view" | "edit" = "edit";

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    status: "authenticated",
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "edit",
          bookings: "edit",
          membership: membershipLevel,
          finance: "edit",
          lodge: "edit",
          content: "edit",
          support: "edit",
        },
      },
    },
  }),
}));

// Radix Select/Dialog are not drivable in jsdom; same swap the sibling suite uses.
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectItem: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

import MembershipCancellationsPage from "@/app/(admin)/admin/membership-cancellations/page";

type ParticipantOverrides = Partial<{
  id: string;
  memberId: string;
  name: string;
  status: string;
  confirmedAt: string | null;
  active: boolean;
  cancelledAt: string | null;
  invoiceCheckSkipped: boolean;
}>;

function participant(overrides: ParticipantOverrides = {}) {
  return {
    id: "participant-1",
    memberId: "member-1",
    name: "Jo Member",
    email: "jo@example.test",
    ageTier: "ADULT",
    active: true,
    canLogin: true,
    cancelledAt: null,
    status: "REQUESTED",
    reason: null,
    adminNote: null,
    confirmationTokenExpiresAt: null,
    confirmedAt: "2026-07-02T00:00:00.000Z",
    declinedAt: null,
    reviewedAt: null,
    cancelledAtParticipant: null,
    reviewedBy: null,
    blockers: [],
    sharedInvoiceNotice: null,
    invoiceCheckSkipped: false,
    holdsPrivilegedAccess: false,
    accountType: "user" as const,
    ...overrides,
  };
}

function queue(participants: ReturnType<typeof participant>[]) {
  return {
    requests: [
      {
        id: "request-1",
        status: "REQUESTED",
        reason: "Moving overseas",
        adminNote: null,
        submittedAt: "2026-07-01T00:00:00.000Z",
        reviewedAt: null,
        completedAt: null,
        // A different admin raised it, so separation of duties is not in play.
        requestedBy: { id: "admin-2", name: "Other Admin", email: "o@a.test" },
        reviewedBy: null,
        participants,
      },
    ],
    pendingCount: participants.length,
    total: 1,
    page: 1,
    pageSize: 25,
    totalPages: 1,
  };
}

const emptyArchiveQueue = {
  requests: [],
  pendingCount: 0,
  total: 0,
  page: 1,
  pageSize: 25,
  totalPages: 0,
};

function installFetch(body: ReturnType<typeof queue>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/admin/member-lifecycle-action-requests")) {
        return { ok: true, json: async () => emptyArchiveQueue };
      }
      return { ok: true, json: async () => body };
    }),
  );
}

const EXPLANATION = /this queue did not ask Xero whether anything is owing/i;
const ROW_MARKER = /Money-owing check not run for this member/i;

describe("the review queue when the invoice check is scoped (#2402)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    membershipLevel = "edit";
  });

  it("explains itself once per request, and marks each affected row (F5)", async () => {
    membershipLevel = "view";
    installFetch(
      queue([
        participant({ invoiceCheckSkipped: true }),
        participant({
          id: "participant-2",
          memberId: "member-2",
          name: "Sam Member",
          invoiceCheckSkipped: true,
        }),
        participant({
          id: "participant-3",
          memberId: "member-3",
          name: "Kit Member",
          status: "REJECTED",
        }),
      ]),
    );

    render(<MembershipCancellationsPage />);
    await screen.findByText("Jo Member");

    // One paragraph for the whole request, however many rows it covers…
    expect(screen.getAllByText(EXPLANATION)).toHaveLength(1);
    expect(screen.getByText(/for 2 members below/i)).toBeDefined();
    // …and a short line on exactly the affected rows, so it is still clear WHO.
    expect(screen.getAllByText(ROW_MARKER)).toHaveLength(2);
  });

  it("says nothing at all to an admin whose checks did run", async () => {
    installFetch(queue([participant()]));

    render(<MembershipCancellationsPage />);
    await screen.findByText("Jo Member");

    expect(screen.queryByText(EXPLANATION)).toBeNull();
    expect(screen.queryByText(ROW_MARKER)).toBeNull();
    const approve = screen.getByRole("button", { name: /Approve$/ });
    expect(approve.hasAttribute("disabled")).toBe(false);
  });

  it("disables Approve on a deactivated membership, and says why (F4)", async () => {
    // The divergence the old page-local `canApprove` allowed: REQUESTED and
    // confirmed, so the button was enabled — but the membership was deactivated
    // out of band, so the server would 409 and the queue never ran its checks
    // for this row. An enabled button beside an empty panel is exactly the
    // silence-reads-as-clean hazard this issue exists to remove.
    installFetch(queue([participant({ active: false })]));

    render(<MembershipCancellationsPage />);
    await screen.findByText("Jo Member");

    const approve = screen.getByRole("button", { name: /Approve$/ });
    expect(approve.hasAttribute("disabled")).toBe(true);
    // Rejecting it is still offered — that is the way out.
    expect(
      screen.getByRole("button", { name: /Reject/ }).hasAttribute("disabled"),
    ).toBe(false);
    // And the row explains itself rather than sitting inertly disabled.
    expect(
      screen.getByText(/already inactive or cancelled/i),
    ).toBeDefined();
  });

  it("disables Approve on an already-cancelled membership too", async () => {
    installFetch(
      queue([participant({ cancelledAt: "2026-07-05T00:00:00.000Z" })]),
    );

    render(<MembershipCancellationsPage />);
    await screen.findByText("Jo Member");

    expect(
      screen.getByRole("button", { name: /Approve$/ }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("keeps the original wording for a member who has not confirmed", async () => {
    installFetch(
      queue([participant({ status: "PENDING_CONFIRMATION", confirmedAt: null })]),
    );

    render(<MembershipCancellationsPage />);
    await screen.findByText("Jo Member");

    expect(
      screen.getByText(
        "Approval is unavailable until this adult confirms their own cancellation request.",
      ),
    ).toBeDefined();
  });
});
