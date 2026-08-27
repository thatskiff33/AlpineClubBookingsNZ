// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

/**
 * What the admin is left looking at when an approval is REFUSED (#2392).
 *
 * A refusal here is a statement about the queue, not just about the click: the
 * commonest one is "Xero says money is owing" against a participant whose panel
 * was rendered before that invoice existed. So the queue is reloaded first and
 * the refusal is set afterwards — `loadRequests` clears the error banner as it
 * starts, so the reverse order would wipe the very message the admin needs. That
 * ordering is a one-line dependency between two functions with nothing else
 * holding it in place, which is what this suite pins (#2392 review, residuals
 * 4 and 5).
 */

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    status: "authenticated",
    data: {
      user: {
        id: "admin-1",
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

// Radix's Select and Dialog are not drivable through jsdom's pointer-capture
// flow; the repo's pattern (access-role-ui.test.tsx,
// admin-member-detail-xero-create.test.tsx) is to swap them for plain elements
// so the flow under test — approve, refusal, reload — is deterministic.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    children?: ReactNode;
  }) => (
    <select
      value={value ?? ""}
      onChange={(event) => onValueChange?.(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
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
import type { MembershipCancellationBlocker } from "@/lib/membership-cancellation-blocker-messages";

const REFUSAL =
  "Approval is blocked while Xero still shows money owing on this member's contact: INV-0042 (NZD 120.50).";

const UNPAID_INVOICE: MembershipCancellationBlocker = {
  type: "unpaid_invoice",
  invoiceId: "inv-1",
  invoiceNumber: "INV-0042",
  invoiceStatus: "AUTHORISED",
  direction: "receivable",
  amountDueCents: 12050,
  currency: "NZD",
  dueDate: "2026-06-30",
  xeroUrl: "https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=inv-1",
  xeroContactUrl: "https://go.xero.com/Contacts/View/contact-1",
};

function queue(blockers: MembershipCancellationBlocker[]) {
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
        // A DIFFERENT admin raised it, so this admin may approve it.
        requestedBy: { id: "admin-2", name: "Other Admin", email: "o@a.test" },
        reviewedBy: null,
        participants: [
          {
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
            blockers,
            holdsPrivilegedAccess: false,
            accountType: "user" as const,
          },
        ],
      },
    ],
    pendingCount: 1,
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

/**
 * `reloads` supplies the cancellation-queue GET responses in order: the first is
 * the initial page load, the second is the reload a refusal triggers. `null`
 * stands for a GET that itself fails.
 */
function installFetch(reloads: Array<ReturnType<typeof queue> | null>) {
  let cancellationGets = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes("/api/admin/member-lifecycle-action-requests")) {
      return { ok: true, json: async () => emptyArchiveQueue };
    }

    if (url.includes("/participants/")) {
      return {
        ok: false,
        status: 409,
        json: async () => ({ error: REFUSAL }),
      };
    }

    const body = reloads[Math.min(cancellationGets, reloads.length - 1)];
    cancellationGets += 1;
    if (!body) {
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: "The queue could not be read." }),
      };
    }
    return { ok: true, json: async () => body };
  });

  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    cancellationGetCount: () => cancellationGets,
  };
}

async function approveTheParticipant() {
  fireEvent.click(await screen.findByRole("button", { name: /Approve$/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Approve and email member" }),
  );
}

describe("a refused membership-cancellation approval", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reloads the queue and still shows the refusal afterwards", async () => {
    // The queue starts clean — the panel shows no blocker at all — and the
    // reload is what brings the invoice into view.
    const { cancellationGetCount } = installFetch([queue([]), queue([UNPAID_INVOICE])]);

    render(<MembershipCancellationsPage />);
    await screen.findByText("Jo Member");
    expect(screen.queryByText(/still owing/)).toBeNull();

    await approveTheParticipant();

    // The refusal survives the reload. Setting it BEFORE the reload would leave
    // this empty, because loadRequests clears the error as it starts.
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(REFUSAL),
    );
    // …and the reload really happened: the queue now carries the invoice the
    // refusal is about, linked into Xero.
    expect(cancellationGetCount()).toBe(2);
    expect(
      screen.getByRole("link", { name: "Invoice INV-0042" }).getAttribute("href"),
    ).toBe("https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=inv-1");
  });

  it("says so when the reload failed as well, instead of showing a stale queue silently", async () => {
    const { cancellationGetCount } = installFetch([queue([]), null]);

    render(<MembershipCancellationsPage />);
    await screen.findByText("Jo Member");

    await approveTheParticipant();

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(REFUSAL),
    );
    const banner = screen.getByRole("alert").textContent ?? "";
    // Both facts, not just the refusal: the queue below is stale and says why.
    expect(banner).toContain("could not be reloaded");
    expect(banner).toContain("The queue could not be read.");
    expect(cancellationGetCount()).toBe(2);
  });
});
