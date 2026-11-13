// @vitest-environment jsdom

/**
 * A refused cancellation or archive review says why (#4976, ALP-589).
 *
 * The two queue loads and both reviews used to `await response.json()` before
 * checking `ok`, and their catches showed `err.message`: an HTML 502 from the
 * proxy reached the officer as a JSON parse error, and a dropped connection as
 * the browser's "Failed to fetch". Each now throws an `ApiRefusalError` read
 * through the shared reader and shows its own fallback for anything else.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { itShowsEveryRefusal } from "@/lib/__tests__/support/failed-write-cases";

// The page reads its tab from the URL since S1 (#4796); no tab is the queue.
// Stable instances: a fresh URLSearchParams per render re-runs the load effect.
const navigation = vi.hoisted(() => ({
  router: { replace: () => {}, push: () => {}, refresh: () => {} },
  params: new URLSearchParams(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => navigation.router,
  useSearchParams: () => navigation.params,
}));
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

import MembershipCancellationsPage from "@/app/(admin)/admin/membership/membership-cancellations/page";

const participant = {
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
  holdsPrivilegedAccess: false,
  accountType: "user" as const,
};

const otherAdmin = { id: "admin-2", name: "Other Admin", email: "o@a.test" };

const cancellationQueue = {
  requests: [
    {
      id: "request-1",
      status: "REQUESTED",
      reason: "Moving overseas",
      adminNote: null,
      submittedAt: "2026-07-01T00:00:00.000Z",
      reviewedAt: null,
      completedAt: null,
      requestedBy: otherAdmin,
      reviewedBy: null,
      participants: [participant],
    },
  ],
  pendingCount: 1,
  total: 1,
  page: 1,
  pageSize: 25,
  totalPages: 1,
};

const archiveQueue = {
  requests: [
    {
      id: "archive-1",
      memberId: "member-9",
      action: "ARCHIVE",
      status: "REQUESTED",
      reason: "Duplicate record",
      reviewNote: null,
      requestedAt: "2026-07-01T00:00:00.000Z",
      reviewedAt: null,
      processedAt: null,
      requestedBy: otherAdmin,
      reviewedBy: null,
      member: {
        id: "member-9",
        name: "Sam Archive",
        email: "sam@example.test",
        active: false,
        canLogin: false,
        cancelledAt: null,
        archivedAt: null,
        archivedReason: null,
      },
    },
  ],
  pendingCount: 1,
  total: 1,
  page: 1,
  pageSize: 25,
  totalPages: 1,
};

type Answer = () => Response | Promise<Response>;

/** Every route answers well unless the test names one to answer otherwise. */
function installFetch(overrides: {
  cancellationGet?: Answer;
  archiveGet?: Answer;
  participantReview?: Answer;
  archiveReview?: Answer;
}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/participants/")) {
      return (overrides.participantReview ?? (() => Response.json({ orphanedLinks: null })))();
    }
    if (url.includes("/api/admin/member-lifecycle-action-requests/")) {
      return (overrides.archiveReview ?? (() => Response.json({ orphanedLinks: null })))();
    }
    if (url.includes("/api/admin/member-lifecycle-action-requests")) {
      return (overrides.archiveGet ?? (() => Response.json(archiveQueue)))();
    }
    if (url.includes("/api/admin/membership-cancellation-requests") && !init?.method) {
      return (overrides.cancellationGet ?? (() => Response.json(cancellationQueue)))();
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function getCount(fetchMock: ReturnType<typeof installFetch>, fragment: string) {
  return fetchMock.mock.calls.filter(
    ([input, init]) => String(input).includes(fragment) && !init?.method,
  ).length;
}

async function approveTheParticipant() {
  fireEvent.click(await screen.findByRole("button", { name: /^Approve$/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Approve and email member" }));
}

async function approveTheArchive() {
  fireEvent.click(await screen.findByRole("button", { name: /Approve Archive/ }));
}

describe("membership-cancellation reviews and queue loads", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    cleanup();
  });

  describe("loading the cancellation queue", () => {
    itShowsEveryRefusal({
      fallback: "Could not load cancellation requests.",
      submit: async (answer) => {
        installFetch({ cancellationGet: answer });
        render(<MembershipCancellationsPage />);
      },
    });
  });

  describe("loading the archive queue", () => {
    itShowsEveryRefusal({
      fallback: "Could not load archive requests.",
      submit: async (answer) => {
        installFetch({ archiveGet: answer });
        render(<MembershipCancellationsPage />);
      },
    });
  });

  describe("reviewing a cancellation participant", () => {
    itShowsEveryRefusal({
      fallback: "Could not review participant.",
      submit: async (answer) => {
        installFetch({ participantReview: answer });
        render(<MembershipCancellationsPage />);
        await screen.findByText("Jo Member");
        await approveTheParticipant();
      },
    });

    it("reloads the queue after a successful approval", async () => {
      const fetchMock = installFetch({});
      render(<MembershipCancellationsPage />);
      await screen.findByText("Jo Member");
      const before = getCount(fetchMock, "/api/admin/membership-cancellation-requests");

      await approveTheParticipant();

      expect(
        await screen.findByText("Membership cancellation approved and processed."),
      ).toBeInTheDocument();
      await waitFor(() =>
        expect(getCount(fetchMock, "/api/admin/membership-cancellation-requests")).toBe(before + 1),
      );
    });
  });

  describe("reviewing an archive request", () => {
    itShowsEveryRefusal({
      fallback: "Could not review archive request.",
      submit: async (answer) => {
        installFetch({ archiveReview: answer });
        render(<MembershipCancellationsPage />);
        await screen.findByText("Sam Archive");
        await approveTheArchive();
      },
    });

    it("reloads the archive queue after a successful approval", async () => {
      const fetchMock = installFetch({});
      render(<MembershipCancellationsPage />);
      await screen.findByText("Sam Archive");
      const before = getCount(fetchMock, "/api/admin/member-lifecycle-action-requests");

      await approveTheArchive();

      expect(await screen.findByText("Member archived.")).toBeInTheDocument();
      await waitFor(() =>
        expect(getCount(fetchMock, "/api/admin/member-lifecycle-action-requests")).toBe(before + 1),
      );
    });
  });
});
