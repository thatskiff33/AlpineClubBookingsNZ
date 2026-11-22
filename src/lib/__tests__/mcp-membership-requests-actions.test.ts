/**
 * ALP-720 (`INV-MCP-006`): the application and request-queue actions an
 * officer's AI app connection may run, each held to its contract
 * (`expectActionContract`): the connection gets exactly the action's
 * `returns` fields and the browser's answer is unchanged.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class ServiceError extends Error {
    constructor(
      message: string,
      public readonly statusCode = 400,
    ) {
      super(message);
    }
  }
  return {
    ServiceError,
    auth: vi.fn(),
    prisma: {
      memberApplication: { findMany: vi.fn(), count: vi.fn() },
      nominationToken: { findMany: vi.fn() },
      member: { findMany: vi.fn() },
      deletionRequest: { findMany: vi.fn(), count: vi.fn() },
    },
    createMemberArchiveRequest: vi.fn(),
    getAdminMemberLifecycleRequests: vi.fn(),
    createAdminMembershipCancellationRequest: vi.fn(),
    reissueParticipantConfirmationToken: vi.fn(),
    getAdminMembershipCancellationRequests: vi.fn(),
    refreshMemberApplicationNominations: vi.fn(),
    replaceMemberApplicationNominator: vi.fn(),
  };
});

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock,
  requireActiveSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/rate-limit", () => ({ getClientIp: () => "203.0.113.9" }));
vi.mock("@/lib/member-lifecycle-actions", () => ({
  createMemberArchiveRequest: h.createMemberArchiveRequest,
  getAdminMemberLifecycleRequests: h.getAdminMemberLifecycleRequests,
  MemberLifecycleActionError: h.ServiceError,
}));
vi.mock("@/lib/membership-cancellation-requests", () => ({
  createAdminMembershipCancellationRequest: h.createAdminMembershipCancellationRequest,
  reissueParticipantConfirmationToken: h.reissueParticipantConfirmationToken,
  MembershipCancellationRequestError: h.ServiceError,
}));
vi.mock("@/lib/membership-cancellation-admin", () => ({
  getAdminMembershipCancellationRequests: h.getAdminMembershipCancellationRequests,
}));
vi.mock("@/lib/nomination", () => ({
  refreshMemberApplicationNominations: h.refreshMemberApplicationNominations,
  replaceMemberApplicationNominator: h.replaceMemberApplicationNominator,
}));

import { GET as listApplications } from "@/app/api/admin/member-applications/route";
import { POST as refreshNominations } from "@/app/api/admin/member-applications/[id]/nominations/refresh/route";
import { POST as replaceNominator } from "@/app/api/admin/member-applications/[id]/nominators/[slot]/replace/route";
import { POST as requestArchive } from "@/app/api/admin/members/[id]/lifecycle/archive/route";
import { POST as requestCancellation } from "@/app/api/admin/members/[id]/membership-cancellation/route";
import { GET as listLifecycleRequests } from "@/app/api/admin/member-lifecycle-action-requests/route";
import { GET as listCancellationRequests } from "@/app/api/admin/membership-cancellation-requests/route";
import { POST as resendConfirmation } from "@/app/api/admin/membership-cancellation-requests/[requestId]/participants/[participantId]/resend-confirmation/route";
import { GET as listDeletionRequests } from "@/app/api/admin/deletion-requests/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";
import { MCP_PRINCIPAL_HEADER } from "@/lib/mcp/principal";
import { NOMINATION_AUTOMATIC_REMINDER_LIMIT } from "@/lib/nomination-token-policy";

const listPage = { page: 1, pageSize: 25, total: 1, totalPages: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue(officerMemberSession());
});

describe("list_member_applications", () => {
  /** An application row as the route reads it: date of birth, phone, address and family details included. */
  const applicationRow = {
    id: "app-1",
    applicantFirstName: "Mere",
    applicantLastName: "Tane",
    applicantEmail: "mere@example.test",
    applicantDateOfBirth: new Date("1990-04-05T00:00:00.000Z"),
    applicantPhone: "021 555 0101",
    applicantAddress: null,
    familyMembers: [{ firstName: "Tui", lastName: "Tane", dateOfBirth: "2015-03-04" }],
    nominator1Email: "ana@example.test",
    nominator2Email: "kai@example.test",
    nominator1Id: "member-2",
    nominator2Id: "member-3",
    nominator1ConfirmedAt: new Date("2026-06-10T00:00:00.000Z"),
    nominator2ConfirmedAt: null,
    status: "PENDING_NOMINATORS",
    adminNotes: "Called the applicant",
    reviewedBy: "officer-2",
    reviewedAt: new Date("2026-06-20T00:00:00.000Z"),
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  };

  it("sends names, nominator and reminder state and the family count, never the applicant's private details", async () => {
    h.prisma.memberApplication.findMany.mockResolvedValue([applicationRow]);
    h.prisma.memberApplication.count.mockImplementation(async ({ where }: { where?: { status?: string } }) =>
      where?.status === "PENDING_ADMIN" ? 0 : 1,
    );
    h.prisma.member.findMany.mockResolvedValue([
      { id: "member-2", firstName: "Ana", lastName: "Hale" },
      { id: "member-3", firstName: "Kai", lastName: "Ngata" },
      { id: "officer-2", firstName: "Rua", lastName: "Kerr" },
    ]);
    h.prisma.nominationToken.findMany.mockResolvedValue([
      {
        id: "token-1",
        applicationId: "app-1",
        nominatorMemberId: "member-3",
        expiresAt: new Date("2026-07-10T00:00:00.000Z"),
        reminderCount: 2,
        lastSentAt: new Date("2026-06-25T00:00:00.000Z"),
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    ]);

    const { connection, browser } = await expectActionContract({
      actionId: "list_member_applications",
      handler: listApplications,
      args: { status: "PENDING_NOMINATORS" },
    });

    expect(connection).toEqual({
      applications: [
        {
          id: "app-1",
          applicantFirstName: "Mere",
          applicantLastName: "Tane",
          applicantEmail: "mere@example.test",
          familyMemberCount: 1,
          nominator1Id: "member-2",
          nominator2Id: "member-3",
          nominator1Name: "Ana Hale",
          nominator2Name: "Kai Ngata",
          nominator1ConfirmedAt: "2026-06-10T00:00:00.000Z",
          nominator2ConfirmedAt: null,
          nominator1TokenExpiresAt: null,
          nominator2TokenExpiresAt: "2026-07-10T00:00:00.000Z",
          nominator1TokenLastSentAt: null,
          nominator2TokenLastSentAt: "2026-06-25T00:00:00.000Z",
          nominator1ReminderCount: 0,
          nominator2ReminderCount: 2,
          nominatorReminderLimit: NOMINATION_AUTOMATIC_REMINDER_LIMIT,
          nominator1ReminderExhausted: false,
          nominator2ReminderExhausted: false,
          status: "PENDING_NOMINATORS",
          adminNotes: "Called the applicant",
          reviewerName: "Rua Kerr",
          reviewedAt: "2026-06-20T00:00:00.000Z",
          createdAt: "2026-06-01T00:00:00.000Z",
        },
      ],
      pendingCount: 0,
      ...listPage,
    });
    expect(browser).toMatchObject({
      data: [
        {
          applicantDateOfBirth: "1990-04-05",
          applicantPhone: "021 555 0101",
          familyMembers: [{ firstName: "Tui", dateOfBirth: "2015-03-04" }],
        },
      ],
    });
    expect(h.prisma.memberApplication.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "PENDING_NOMINATORS" } }),
    );
  });
});

describe("refresh_application_nominations and replace_application_nominator", () => {
  it("refreshes the application named in the address, as the officer", async () => {
    h.refreshMemberApplicationNominations.mockResolvedValue({
      application: { id: "app-1", applicantPhone: "021 555 0101" },
      refreshedCount: 2,
      emailWarnings: ["Could not email kai@example.test"],
    });

    const { connection } = await expectActionContract({
      actionId: "refresh_application_nominations",
      handler: refreshNominations,
      args: { id: "app-1" },
    });

    expect(connection).toEqual({
      success: true,
      refreshedCount: 2,
      warnings: ["Could not email kai@example.test"],
    });
    expect(h.refreshMemberApplicationNominations).toHaveBeenCalledWith("app-1", "officer-1");
  });

  it("replaces the nominator in the slot named in the address", async () => {
    h.replaceMemberApplicationNominator.mockResolvedValue({
      application: { id: "app-1", applicantPhone: "021 555 0101" },
      replacementNominatorId: "member-4",
      emailWarnings: [],
    });

    const { connection } = await expectActionContract({
      actionId: "replace_application_nominator",
      handler: replaceNominator,
      args: { id: "app-1", slot: "nominator2", memberId: "member-4" },
    });

    expect(connection).toEqual({ success: true, replacementNominatorId: "member-4", warnings: [] });
    expect(h.replaceMemberApplicationNominator).toHaveBeenCalledWith({
      applicationId: "app-1",
      slot: "nominator2",
      replacementMemberId: "member-4",
      adminMemberId: "officer-1",
    });
  });

  it("refuses a slot that is not nominator1 or nominator2, before the service runs", async () => {
    const response = await replaceNominator(
      new NextRequest("https://club.example.test/api/admin/member-applications/app-1/nominators/nominator3/replace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ memberId: "member-4" }),
      }),
      { params: Promise.resolve({ id: "app-1", slot: "nominator3" }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid nominator slot" });
    expect(h.replaceMemberApplicationNominator).not.toHaveBeenCalled();
  });
});

describe("request_member_archive", () => {
  it("raises the request for the member in the address, as the officer, and sends no snapshot", async () => {
    h.createMemberArchiveRequest.mockResolvedValue({
      request: {
        id: "lifecycle-1",
        memberId: "member-9",
        action: "ARCHIVE",
        status: "REQUESTED",
        reason: "Left the district",
        reviewNote: null,
        requestedAt: "2026-07-01T00:00:00.000Z",
        reviewedAt: null,
        processedAt: null,
        requestedByMemberId: "officer-1",
        requestedBy: { id: "officer-1", name: "Officer One", email: "officer@example.test" },
        reviewedBy: null,
        memberSnapshot: null,
      },
    });

    const { connection, browser } = await expectActionContract({
      actionId: "request_member_archive",
      handler: requestArchive,
      args: { id: "member-9", reason: "  Left the district  " },
    });

    expect(connection).toEqual({
      request: {
        id: "lifecycle-1",
        memberId: "member-9",
        action: "ARCHIVE",
        status: "REQUESTED",
        reason: "Left the district",
        requestedAt: "2026-07-01T00:00:00.000Z",
        requestedByMemberId: "officer-1",
      },
    });
    expect(browser).toMatchObject({ request: { requestedBy: { email: "officer@example.test" } } });
    expect(h.createMemberArchiveRequest).toHaveBeenCalledWith({
      memberId: "member-9",
      requestedByMemberId: "officer-1",
      reason: "Left the district",
      ipAddress: "203.0.113.9",
    });
  });
});

/** A cancellation request as the member-facing serializer builds it. */
const cancellationRequest = {
  id: "cancel-1",
  status: "REQUESTED",
  reason: "Moving overseas",
  submittedAt: "2026-07-01T00:00:00.000Z",
  reviewedAt: null,
  completedAt: null,
  requestedBy: { id: "officer-1", name: "Officer One", email: "officer@example.test" },
  participants: [
    {
      id: "participant-1",
      memberId: "member-9",
      name: "Hemi Walker",
      email: "hemi@example.test",
      ageTier: "ADULT",
      canLogin: true,
      active: true,
      status: "PENDING_CONFIRMATION",
      confirmationTokenExpiresAt: "2026-07-08T00:00:00.000Z",
      confirmedAt: null,
      declinedAt: null,
      createdAt: "2026-07-01T00:00:00.000Z",
    },
  ],
};

const cancellationResultForConnection = {
  request: {
    id: "cancel-1",
    status: "REQUESTED",
    reason: "Moving overseas",
    submittedAt: "2026-07-01T00:00:00.000Z",
    participants: [
      {
        id: "participant-1",
        memberId: "member-9",
        name: "Hemi Walker",
        email: "hemi@example.test",
        status: "PENDING_CONFIRMATION",
        confirmationTokenExpiresAt: "2026-07-08T00:00:00.000Z",
        confirmedAt: null,
        declinedAt: null,
      },
    ],
  },
  emailWarnings: ["Admin review alert could not be sent"],
};

describe("request_membership_cancellation and resend_cancellation_confirmation", () => {
  it("raises the request for the member in the address, as the officer", async () => {
    h.createAdminMembershipCancellationRequest.mockResolvedValue({
      request: cancellationRequest,
      emailWarnings: ["Admin review alert could not be sent"],
    });

    const { connection, browser } = await expectActionContract({
      actionId: "request_membership_cancellation",
      handler: requestCancellation,
      args: { id: "member-9", reason: "Moving overseas" },
    });

    expect(connection).toEqual(cancellationResultForConnection);
    expect(browser).toMatchObject({ request: { participants: [{ ageTier: "ADULT", canLogin: true }] } });
    expect(h.createAdminMembershipCancellationRequest).toHaveBeenCalledWith({
      targetMemberId: "member-9",
      adminMemberId: "officer-1",
      reason: "Moving overseas",
      ipAddress: "203.0.113.9",
    });
  });

  it("re-sends the confirmation for the participant in the address, as the officer", async () => {
    h.reissueParticipantConfirmationToken.mockResolvedValue({
      request: cancellationRequest,
      emailWarnings: ["Admin review alert could not be sent"],
    });

    const { connection } = await expectActionContract({
      actionId: "resend_cancellation_confirmation",
      handler: resendConfirmation,
      args: { requestId: "cancel-1", participantId: "participant-1" },
    });

    expect(connection).toEqual(cancellationResultForConnection);
    expect(h.reissueParticipantConfirmationToken).toHaveBeenCalledWith({
      requestId: "cancel-1",
      participantId: "participant-1",
      adminMemberId: "officer-1",
      ipAddress: "203.0.113.9",
    });
  });
});

describe("list_member_lifecycle_requests", () => {
  it("sends each request and its member, never the member snapshot or sign-in flag", async () => {
    h.getAdminMemberLifecycleRequests.mockResolvedValue({
      requests: [
        {
          id: "lifecycle-1",
          memberId: "member-9",
          action: "DELETE",
          status: "REQUESTED",
          reason: "Duplicate record",
          reviewNote: "Checked",
          requestedAt: "2026-06-01T00:00:00.000Z",
          reviewedAt: "2026-06-02T00:00:00.000Z",
          processedAt: null,
          requestedByMemberId: "officer-2",
          requestedBy: { id: "officer-2", name: "Rua Kerr", email: "rua@example.test" },
          reviewedBy: { id: "officer-3", name: "Pita Lowe", email: "pita@example.test" },
          memberSnapshot: { member: { firstName: "Hemi", phone: "021 555 0102" } },
          member: {
            id: "member-9",
            name: "Hemi Walker",
            email: "hemi@example.test",
            active: false,
            canLogin: false,
            cancelledAt: "2026-05-01T00:00:00.000Z",
            archivedAt: null,
            archivedReason: "Old note",
          },
          targetName: "Hemi Walker",
        },
      ],
      pendingCount: 1,
      ...listPage,
    });

    const { connection, browser } = await expectActionContract({
      actionId: "list_member_lifecycle_requests",
      handler: listLifecycleRequests,
      args: { action: "DELETE", status: "PENDING" },
    });

    expect(connection).toEqual({
      requests: [
        {
          id: "lifecycle-1",
          memberId: "member-9",
          action: "DELETE",
          status: "REQUESTED",
          reason: "Duplicate record",
          reviewNote: "Checked",
          requestedAt: "2026-06-01T00:00:00.000Z",
          reviewedAt: "2026-06-02T00:00:00.000Z",
          processedAt: null,
          requestedByMemberId: "officer-2",
          requestedBy: { id: "officer-2", name: "Rua Kerr" },
          reviewedBy: { id: "officer-3", name: "Pita Lowe" },
          member: {
            id: "member-9",
            name: "Hemi Walker",
            email: "hemi@example.test",
            active: false,
            cancelledAt: "2026-05-01T00:00:00.000Z",
            archivedAt: null,
          },
          targetName: "Hemi Walker",
        },
      ],
      pendingCount: 1,
      ...listPage,
    });
    expect(browser).toMatchObject({ data: [{ memberSnapshot: { member: { phone: "021 555 0102" } } }] });
    // PENDING is the deletion page's word for REQUESTED.
    expect(h.getAdminMemberLifecycleRequests).toHaveBeenCalledWith({
      action: "DELETE",
      status: "REQUESTED",
      page: 1,
      pageSize: 25,
    });
  });
});

describe("list_membership_cancellation_requests", () => {
  const participant = {
    id: "participant-1",
    memberId: "member-9",
    name: "Hemi Walker",
    email: "hemi@example.test",
    ageTier: "ADULT",
    active: true,
    canLogin: true,
    cancelledAt: null,
    status: "REQUESTED",
    reason: "Moving overseas",
    adminNote: "Spoke to Hemi",
    confirmationTokenExpiresAt: null,
    confirmedAt: "2026-06-02T00:00:00.000Z",
    declinedAt: null,
    reviewedAt: "2026-06-03T00:00:00.000Z",
    cancelledAtParticipant: null,
    reviewedBy: { id: "officer-3", name: "Pita Lowe", email: "pita@example.test" },
    blockers: [
      {
        type: "owned_booking",
        bookingId: "booking-1",
        bookingStatus: "CONFIRMED",
        checkIn: "2026-08-01",
        checkOut: "2026-08-03",
        guestAppearanceId: "guest-1",
      },
    ],
    sharedInvoiceNotice: {
      invoiceId: "xero-invoice-1",
      invoiceNumber: "INV-0042",
      xeroUrl: "https://go.xero.com/invoice",
      sharedWith: [{ memberId: "member-10", name: "Aroha Walker" }],
      blocksApproval: false,
      route: "cancel_others_first",
    },
    invoiceCheckSkipped: false,
    holdsPrivilegedAccess: false,
    accountType: "MEMBER",
    includedWithoutOwnOrSecondAdultConfirmation: false,
  };
  const queueRequest = {
    id: "cancel-1",
    status: "REQUESTED",
    reason: "Family is moving",
    adminNote: "Awaiting second officer",
    submittedAt: "2026-06-01T00:00:00.000Z",
    reviewedAt: "2026-06-03T00:00:00.000Z",
    completedAt: null,
    requestedBy: { id: "officer-2", name: "Rua Kerr", email: "rua@example.test" },
    reviewedBy: { id: "officer-3", name: "Pita Lowe", email: "pita@example.test" },
    participants: [participant],
  };

  it("sends each request, its members and their blockers, never Xero invoice detail or the shared-invoice notice", async () => {
    h.getAdminMembershipCancellationRequests.mockResolvedValue({
      requests: [queueRequest],
      pendingCount: 1,
      ...listPage,
    });

    const { connection, browser } = await expectActionContract({
      actionId: "list_membership_cancellation_requests",
      handler: listCancellationRequests,
      args: { status: "ALL", pageSize: 10 },
    });

    expect(connection).toEqual({
      requests: [
        {
          id: "cancel-1",
          status: "REQUESTED",
          reason: "Family is moving",
          adminNote: "Awaiting second officer",
          submittedAt: "2026-06-01T00:00:00.000Z",
          reviewedAt: "2026-06-03T00:00:00.000Z",
          completedAt: null,
          requestedBy: { id: "officer-2", name: "Rua Kerr" },
          reviewedBy: { id: "officer-3", name: "Pita Lowe" },
          participants: [
            {
              id: "participant-1",
              memberId: "member-9",
              name: "Hemi Walker",
              email: "hemi@example.test",
              active: true,
              cancelledAt: null,
              status: "REQUESTED",
              reason: "Moving overseas",
              adminNote: "Spoke to Hemi",
              confirmationTokenExpiresAt: null,
              confirmedAt: "2026-06-02T00:00:00.000Z",
              declinedAt: null,
              reviewedAt: "2026-06-03T00:00:00.000Z",
              cancelledAtParticipant: null,
              reviewedBy: { id: "officer-3", name: "Pita Lowe" },
              blockers: [
                {
                  type: "owned_booking",
                  bookingId: "booking-1",
                  bookingStatus: "CONFIRMED",
                  checkIn: "2026-08-01",
                  checkOut: "2026-08-03",
                },
              ],
              invoiceCheckSkipped: false,
              holdsPrivilegedAccess: false,
              accountType: "MEMBER",
              includedWithoutOwnOrSecondAdultConfirmation: false,
            },
          ],
        },
      ],
      pendingCount: 1,
      ...listPage,
    });
    expect(browser).toMatchObject({
      data: [{ participants: [{ sharedInvoiceNotice: { invoiceNumber: "INV-0042" } }] }],
    });
    // A Full Admin holds Membership edit, so the metered check runs as on the screen.
    expect(h.getAdminMembershipCancellationRequests).toHaveBeenCalledWith({
      status: "ALL",
      page: 1,
      pageSize: 10,
      viewerCanApprove: true,
    });
  });

  it("sends only the kind of an unpaid-invoice blocker", async () => {
    h.getAdminMembershipCancellationRequests.mockResolvedValue({
      requests: [
        {
          ...queueRequest,
          participants: [
            {
              ...participant,
              blockers: [
                {
                  type: "unpaid_invoice",
                  invoiceId: "xero-invoice-2",
                  invoiceNumber: "INV-0043",
                  invoiceStatus: "AUTHORISED",
                  direction: "receivable",
                  amountDueCents: 12050,
                  amountDueTenThousandths: 1205000,
                  currency: "NZD",
                  dueDate: "2026-07-20",
                  xeroUrl: "https://go.xero.com/invoice",
                  xeroContactUrl: "https://go.xero.com/contact",
                },
              ],
            },
          ],
        },
      ],
      pendingCount: 1,
      ...listPage,
    });

    const response = await listCancellationRequests(
      new NextRequest("https://club.example.test/api/admin/membership-cancellation-requests", {
        headers: { [MCP_PRINCIPAL_HEADER]: "contract-test-principal" },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { requests: Array<{ participants: Array<{ blockers: unknown }> }> };
    expect(body.requests[0].participants[0].blockers).toEqual([{ type: "unpaid_invoice" }]);
  });
});

describe("list_account_deletion_requests", () => {
  it("sends each request and its member, never the member's role", async () => {
    h.prisma.deletionRequest.findMany.mockResolvedValue([
      {
        id: "deletion-1",
        status: "PENDING",
        reason: "No longer skiing",
        adminNote: "Checked bookings",
        reviewedBy: "officer-3",
        reviewedAt: new Date("2026-06-03T00:00:00.000Z"),
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        memberId: "member-9",
        member: {
          id: "member-9",
          firstName: "Hemi",
          lastName: "Walker",
          email: "hemi@example.test",
          role: "USER",
          active: true,
        },
      },
    ]);
    h.prisma.deletionRequest.count.mockResolvedValue(1);

    const { connection, browser } = await expectActionContract({
      actionId: "list_account_deletion_requests",
      handler: listDeletionRequests,
      args: { status: "REJECTED" },
    });

    expect(connection).toEqual({
      requests: [
        {
          id: "deletion-1",
          status: "PENDING",
          reason: "No longer skiing",
          adminNote: "Checked bookings",
          reviewedBy: "officer-3",
          reviewedAt: "2026-06-03T00:00:00.000Z",
          createdAt: "2026-06-01T00:00:00.000Z",
          member: {
            id: "member-9",
            firstName: "Hemi",
            lastName: "Walker",
            email: "hemi@example.test",
            active: true,
          },
        },
      ],
      ...listPage,
    });
    expect(browser).toMatchObject({ data: [{ member: { role: "USER" } }] });
    expect(h.prisma.deletionRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "REJECTED" } }),
    );
  });
});
