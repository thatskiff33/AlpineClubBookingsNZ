// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CANCELLATION_BLOCKED_BY_ADMIN_ROLE_HEADING,
  CANCELLATION_BLOCKED_BY_ADMIN_ROLE_REASON,
  CANCELLATION_BLOCKED_BY_DORMANT_ADMIN_ROLE_REASON,
  MemberLifecycleCard,
} from "../member-lifecycle-card";
import type {
  MemberDetail,
  OpenCancellationRequestSummary,
} from "../../_types";
import {
  canAdminRequestMembershipCancellation,
  isMembershipCancellationBlockedByAdminRole,
} from "@/lib/member-roles";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function buildMember(overrides: Partial<MemberDetail> = {}): MemberDetail {
  return {
    id: "member-1",
    firstName: "Alice",
    lastName: "Summit",
    email: "alice@example.test",
    role: "USER",
    active: true,
    canLogin: true,
    cancelledAt: null,
    cancelledReason: null,
    archivedAt: null,
    archivedReason: null,
    ...overrides,
  } as unknown as MemberDetail;
}

/**
 * Renders the card with the two cancellation props derived exactly as
 * `/admin/members/[id]` derives them, so a role's end-to-end behaviour is what
 * is pinned here rather than the card's response to hand-picked booleans. The
 * page's own use of the same two helpers is asserted structurally by
 * `src/lib/__tests__/membership-cancellation-gate-contract.test.ts`.
 */
function renderCard(
  member: MemberDetail,
  openCancellationRequest: OpenCancellationRequestSummary | null = null,
) {
  return render(
    <MemberLifecycleCard
      member={member}
      pendingArchiveRequest={null}
      reviewedArchiveRequests={[]}
      isArchiveRequester={false}
      canRequestArchive={false}
      canRequestCancellation={Boolean(
        canAdminRequestMembershipCancellation(member) &&
          !openCancellationRequest,
      )}
      cancellationBlockedByAdminRole={Boolean(
        isMembershipCancellationBlockedByAdminRole(member) &&
          !openCancellationRequest,
      )}
      openCancellationRequest={openCancellationRequest}
      archiveError=""
      archiveReason=""
      archiveReviewNotes={{}}
      archiveActionLoading={null}
      cancellationError=""
      cancellationReason=""
      cancellationSubmitting={false}
      onChangeArchiveReason={vi.fn()}
      onChangeArchiveReviewNote={vi.fn()}
      onChangeCancellationReason={vi.fn()}
      onSubmitArchive={vi.fn()}
      onSubmitCancellation={vi.fn()}
      onReviewArchive={vi.fn()}
      canEdit
    />,
  );
}

function cancellationAction() {
  return screen.queryByRole("button", { name: /request cancellation/i });
}

function explanation() {
  return screen.queryByText(CANCELLATION_BLOCKED_BY_ADMIN_ROLE_HEADING);
}

describe("MemberLifecycleCard cancellation affordance (#2354, #2356)", () => {
  it("offers the working action to an ordinary member", () => {
    renderCard(buildMember());

    expect(cancellationAction()).toBeEnabled();
    expect(screen.getByLabelText(/cancellation reason/i)).toBeInTheDocument();
    expect(explanation()).not.toBeInTheDocument();
  });

  it("offers it to a dependant with no login of their own", () => {
    // #2354's case: no login, so no access roles — still a cancellable member.
    renderCard(buildMember({ canLogin: false, email: undefined }));

    expect(cancellationAction()).toBeEnabled();
    expect(explanation()).not.toBeInTheDocument();
  });

  it("explains the block for a member whose account is classed as an Admin", () => {
    // #2356: before this the page showed nothing at all here — no action, no
    // reason — so the membership looked as if it had no cancellation path.
    renderCard(buildMember({ role: "ADMIN" }));

    expect(cancellationAction()).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/cancellation reason/i)).not.toBeInTheDocument();

    const heading = explanation();
    expect(heading).toBeVisible();
    // The reason is readable in the reading order, as visible prose — not
    // parked on a disabled control's `title`, which never fires at all here
    // (`buttonVariants` sets `disabled:pointer-events-none`).
    const reason = screen.getByText(CANCELLATION_BLOCKED_BY_ADMIN_ROLE_REASON);
    expect(reason).toBeVisible();
    expect(reason.closest("[title]")).toBeNull();
    // And it names both the remedy and where to perform it.
    expect(reason).toHaveTextContent(/Account & Access/);
    expect(reason).toHaveTextContent(/User Type from Admin to User/);
  });

  it("gives a non-login Admin record the remedy that actually works for it", () => {
    // Account & Access disables the User Type control while Can Login is off,
    // so the ordinary wording would strand the admin at a greyed-out select.
    renderCard(buildMember({ role: "ADMIN", canLogin: false }));

    expect(explanation()).toBeVisible();
    expect(
      screen.getByText(CANCELLATION_BLOCKED_BY_DORMANT_ADMIN_ROLE_REASON),
    ).toBeVisible();
    expect(
      screen.queryByText(CANCELLATION_BLOCKED_BY_ADMIN_ROLE_REASON),
    ).not.toBeInTheDocument();
  });

  it("stays silent for device and organisation accounts", () => {
    // A kiosk, school, or booking-request guest record holds no membership, so
    // neither the action nor an explanation about cancelling one belongs here.
    for (const role of ["LODGE", "SCHOOL", "NON_MEMBER"] as const) {
      const view = renderCard(buildMember({ role }));

      expect(cancellationAction()).not.toBeInTheDocument();
      expect(explanation()).not.toBeInTheDocument();

      view.unmount();
    }
  });

  it("stays silent for an Admin whose membership is already cancelled", () => {
    // The cancelled badge is the explanation in that state; the role is no
    // longer what stands in the way.
    renderCard(
      buildMember({ role: "ADMIN", cancelledAt: "2026-07-01T00:00:00.000Z" }),
    );

    expect(explanation()).not.toBeInTheDocument();
    expect(screen.getByText(/^Cancelled /)).toBeInTheDocument();
  });

  it("stays silent for an Admin who already has a cancellation request open", () => {
    // The pending-request panel already says what is happening.
    renderCard(buildMember({ role: "ADMIN" }), {
      id: "request-1",
      reason: "Moving overseas",
      submittedAt: "2026-07-01T00:00:00.000Z",
      participantStatus: "AWAITING_REVIEW",
      requestedBy: { id: "admin-1", name: "Sam Admin" },
    } as unknown as OpenCancellationRequestSummary);

    expect(explanation()).not.toBeInTheDocument();
    expect(screen.getByText(/Pending cancellation request/)).toBeInTheDocument();
  });
});
