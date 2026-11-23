/**
 * ALP-795 (`INV-MCP-006`): the member lookup, partner link and membership
 * cancellation actions an AI app connection may run, each held to the
 * contract it exposes (`expectActionContract`):
 *
 * - the connection is answered with exactly the action's `returns` fields;
 * - it acts as the signed-in member only, though that member is also an
 *   officer (`officerMemberSession`);
 * - the browser's answer is unchanged.
 *
 * The guest lookups are the privacy-critical ones: another member's contact
 * details or date of birth must never reach an AI provider, even if the
 * lookup that feeds the route starts carrying them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  gate: vi.fn(),
  searchByName: vi.fn(),
  resolveByEmail: vi.fn(),
  auditSearch: vi.fn(),
  auditResolve: vi.fn(),
  partner: {
    getPartnerLinkState: vi.fn(),
    listOneStepPartnerCandidates: vi.fn(),
    getPendingPartnerInviteIntent: vi.fn(),
    requestPartnerLink: vi.fn(),
    respondToPartnerLink: vi.fn(),
    removeOwnPartnerLink: vi.fn(),
  },
  cancelOwnPartnerInviteToken: vi.fn(),
  cancellationOverview: vi.fn(),
  prisma: { familyGroupMember: { findFirst: vi.fn() }, member: { findUnique: vi.fn() } },
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn(async () => null),
  requireActiveSession: vi.fn(async () => ({ ok: true, session: await h.auth() })),
}));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn(async () => null),
  applyMemberScopedRateLimit: vi.fn(async () => null),
  checkRateLimit: vi.fn(async () => ({ success: true })),
  getClientIp: vi.fn(() => "127.0.0.1"),
  rateLimiters: {
    api: { id: "api" },
    familyGroupJoinRequest: { id: "family-group-join-request" },
    memberGuestSearch: { id: "member-guest-search" },
    memberGuestSearchDaily: { id: "member-guest-search-daily" },
    memberGuestResolve: { id: "member-guest-resolve" },
    memberGuestResolveDaily: { id: "member-guest-resolve-daily" },
    membershipCancellationRequest: { id: "membership-cancellation-request" },
  },
}));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/member-guest-find-service", () => ({
  loadMemberGuestFindGate: h.gate,
  searchMemberGuestCandidatesByName: h.searchByName,
  resolveMemberGuestCandidatesByEmail: h.resolveByEmail,
  auditMemberGuestSearch: h.auditSearch,
  auditMemberGuestResolve: h.auditResolve,
}));
vi.mock("@/lib/member-guest-probe-guard", () => ({
  startMemberGuestRefusalClock: vi.fn(() => 0),
  equaliseMemberGuestRefusalTiming: vi.fn(async () => undefined),
}));
vi.mock("@/lib/member-partner-link", () => h.partner);
vi.mock("@/lib/partner-invite-token", () => ({ cancelOwnPartnerInviteToken: h.cancelOwnPartnerInviteToken }));
vi.mock("@/lib/transaction-contended-response", () => ({ transactionContendedResponse: vi.fn(() => null) }));
vi.mock("@/lib/membership-cancellation-requests", () => ({
  getMembershipCancellationOverview: h.cancellationOverview,
  createMembershipCancellationRequest: vi.fn(),
  MembershipCancellationRequestError: class extends Error {},
}));

import { GET as getCancellationOptions } from "@/app/api/member/membership-cancellation-requests/route";
import { GET as getGuestOptions } from "@/app/api/members/guest-candidates/route";
import { POST as resolveGuest } from "@/app/api/members/guest-candidates/resolve/route";
import { GET as searchGuests } from "@/app/api/members/guest-candidates/search/route";
import {
  DELETE as deletePartnerLink,
  GET as getPartnerLink,
  POST as postPartnerLink,
} from "@/app/api/members/partner-link/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";
import { NextRequest } from "next/server";

import { findMcpAction } from "@/lib/mcp/catalogue";
import { MCP_PRINCIPAL_HEADER } from "@/lib/mcp/principal";

const MEMBER_ID = "officer-1";

/** Every key anywhere in a JSON value. */
function allKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, keys);
  } else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      keys.add(key);
      allKeys(inner, keys);
    }
  }
  return keys;
}

const GUEST_SETTINGS = {
  openMemberSearchEnabled: true,
  approvalRequired: true,
  pendingHoldExpiryDays: 7,
  includeMinorsInOpenSearch: false,
};

/**
 * A candidate as a careless lookup could return it: the four fields the
 * website's picker shows plus another member's contact details and date of
 * birth, which the route must never pass to a connection.
 */
const LEAKY_CANDIDATE = {
  memberId: "member-2",
  firstName: "Moana",
  lastName: "Hale",
  ageTier: "ADULT",
  email: "moana@example.test",
  phoneNumber: "021 555 0101",
  dateOfBirth: "1985-03-04",
  streetAddressLine1: "2 Tongariro Street",
};

const PICKER_FIELDS = { memberId: "member-2", firstName: "Moana", lastName: "Hale", ageTier: "ADULT" };
const PRIVATE_FIELDS = ["email", "phoneNumber", "dateOfBirth", "streetAddressLine1"];

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue(officerMemberSession(MEMBER_ID));
  h.gate.mockResolvedValue({ ok: true, settings: GUEST_SETTINGS });
});

describe("get_member_guest_options", () => {
  it("answers with how members are found, and none of the club's other guest settings", async () => {
    const { connection, browser } = await expectActionContract({
      actionId: "get_member_guest_options",
      handler: getGuestOptions,
    });
    expect(connection).toEqual({
      enabled: true,
      openSearchEnabled: true,
      approvalRequired: true,
      pendingHoldExpiryDays: 7,
    });
    expect(browser).toEqual(connection);
  });
});

describe("search_members_for_guest", () => {
  it("sends only what the website's picker shows of another member", async () => {
    h.searchByName.mockResolvedValue({ candidates: [LEAKY_CANDIDATE], truncated: true });
    const { connection } = await expectActionContract({
      actionId: "search_members_for_guest",
      handler: searchGuests,
      args: { q: "Moa" },
    });
    expect(connection).toEqual({ candidates: [PICKER_FIELDS], truncated: true });
    const keys = allKeys(connection);
    for (const field of PRIVATE_FIELDS) expect(keys.has(field), field).toBe(false);
    // Searched as a member: the club's minors switch applies, not the officer view.
    expect(h.searchByName).toHaveBeenCalledWith({ q: "Moa", settings: GUEST_SETTINGS });
    // Each search is audited against the signed-in member, as on the website.
    expect(h.auditSearch).toHaveBeenCalledWith(expect.objectContaining({ actorMemberId: MEMBER_ID, q: "Moa" }));
  });

  it("offers an app no query longer than the route reads", () => {
    const action = findMcpAction("search_members_for_guest")!;
    expect(action.query!.safeParse({ q: "x".repeat(257) }).success).toBe(false);
  });
});

describe("find_member_by_email", () => {
  it("is a read that sends only what the website's picker shows of another member", async () => {
    h.resolveByEmail.mockResolvedValue({ candidates: [LEAKY_CANDIDATE], truncated: false });
    const { connection } = await expectActionContract({
      actionId: "find_member_by_email",
      handler: resolveGuest,
      args: { email: "moana@example.test" },
    });
    expect(connection).toEqual({ candidates: [PICKER_FIELDS], truncated: false });
    const keys = allKeys(connection);
    for (const field of PRIVATE_FIELDS) expect(keys.has(field), field).toBe(false);
    expect(h.auditResolve).toHaveBeenCalledWith(
      expect.objectContaining({ actorMemberId: MEMBER_ID, email: "moana@example.test" }),
    );
    expect(findMcpAction("find_member_by_email")).toMatchObject({ kind: "read", preview: true });
  });
});

describe("get_my_partner_link", () => {
  const link = (id: string, initiatedByMe: boolean) => ({
    id,
    status: initiatedByMe ? "PENDING" : "CONFIRMED",
    partner: { id: "member-2", firstName: "Moana", lastName: "Hale", canLogin: true, email: "moana@example.test" },
    initiatedByMe,
    assignedByAdmin: false,
    confirmedAt: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
  });

  it("answers with the member's links and never the invited email address", async () => {
    h.partner.getPartnerLinkState.mockResolvedValue({
      confirmed: link("link-1", false),
      pendingIncoming: [link("link-2", false)],
      pendingOutgoing: [link("link-3", true)],
    });
    h.partner.listOneStepPartnerCandidates.mockResolvedValue([
      { id: "member-4", firstName: "Rawiri", lastName: "Reid", canLogin: false },
    ]);
    h.partner.getPendingPartnerInviteIntent.mockResolvedValue({
      id: "token-1",
      invitedEmail: "not-yet-a-member@example.test",
      expiresAt: new Date("2026-07-14T00:00:00.000Z"),
    });
    const { connection, browser } = await expectActionContract({
      actionId: "get_my_partner_link",
      handler: getPartnerLink,
    });
    const keys = allKeys(connection);
    expect(keys.has("invitedEmail")).toBe(false);
    expect(keys.has("email")).toBe(false);
    expect((connection as { pendingPartnerInvite: unknown }).pendingPartnerInvite).toEqual({
      id: "token-1",
      expiresAt: "2026-07-14T00:00:00.000Z",
    });
    // The website still shows the member who they invited.
    expect(allKeys(browser).has("invitedEmail")).toBe(true);
    expect(h.partner.getPartnerLinkState).toHaveBeenCalledWith(MEMBER_ID);
  });
});

describe("request_partner_link", () => {
  beforeEach(() => {
    h.prisma.familyGroupMember.findFirst.mockResolvedValue({ familyGroupId: "fg-1" });
  });

  it("asks a family member with a login to confirm, for the signed-in member", async () => {
    h.prisma.member.findUnique.mockResolvedValue({ canLogin: true });
    h.partner.requestPartnerLink.mockResolvedValue({
      ok: true,
      linkId: "link-5",
      status: "PENDING",
      message: "Partner request sent.",
    });
    const { connection, browser } = await expectActionContract({
      actionId: "request_partner_link",
      handler: postPartnerLink,
      args: { memberId: "member-4" },
    });
    expect(connection).toEqual(browser);
    expect(h.partner.requestPartnerLink).toHaveBeenCalledWith({
      initiatorMemberId: MEMBER_ID,
      targetEmail: undefined,
      targetMemberId: "member-4",
    });
  });

  it("refuses a connection the one-step partnership with a family member who has no login", async () => {
    // That forms a confirmed partnership at once: the member's own declaration, made on the website.
    h.prisma.member.findUnique.mockResolvedValue({ canLogin: false });
    h.partner.requestPartnerLink.mockResolvedValue({ ok: true, linkId: "link-6", status: "CONFIRMED", message: "Done." });
    const send = (viaConnection: boolean) =>
      postPartnerLink(
        new NextRequest("https://club.example.test/api/members/partner-link", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(viaConnection ? { [MCP_PRINCIPAL_HEADER]: "contract-test-principal" } : {}),
          },
          body: JSON.stringify({ memberId: "member-5" }),
        }),
      );
    expect((await send(true)).status).toBe(403);
    expect(h.partner.requestPartnerLink).not.toHaveBeenCalled();
    // The website's one-step declaration is unchanged.
    expect((await send(false)).status).toBe(201);
    expect(h.partner.requestPartnerLink).toHaveBeenCalledTimes(1);
  });
});

describe("end_partner_link", () => {
  it("ends one of the signed-in member's own links", async () => {
    h.partner.removeOwnPartnerLink.mockResolvedValue({ ok: true, message: "Partner link removed." });
    const { connection } = await expectActionContract({
      actionId: "end_partner_link",
      handler: deletePartnerLink,
      args: { id: "link-1" },
    });
    expect(connection).toEqual({ message: "Partner link removed." });
    expect(h.partner.removeOwnPartnerLink).toHaveBeenCalledWith({ memberId: MEMBER_ID, linkId: "link-1" });
  });

  it("cancels one of the signed-in member's own unclaimed invitations", async () => {
    h.cancelOwnPartnerInviteToken.mockResolvedValue(true);
    const { connection } = await expectActionContract({
      actionId: "end_partner_link",
      handler: deletePartnerLink,
      args: { inviteTokenId: "token-1" },
    });
    expect(connection).toEqual({ message: "Partner invitation cancelled." });
    expect(h.cancelOwnPartnerInviteToken).toHaveBeenCalledWith({ tokenId: "token-1", memberId: MEMBER_ID });
  });
});

describe("get_membership_cancellation_options", () => {
  it("answers without anyone's email address or the club's Xero settings", async () => {
    h.cancellationOverview.mockResolvedValue({
      settings: {
        warningText: "Cancelling ends your membership.",
        rejoinProcessText: "Apply again to rejoin.",
        xeroArchiveContactsOnCancellation: true,
        xeroContactGroups: [{ id: "xg-1", name: "Members" }],
      },
      candidates: [
        {
          id: MEMBER_ID,
          name: "Ana Reid",
          email: "ana@example.test",
          ageTier: "ADULT",
          relationship: "self",
          canLogin: true,
          requiresOwnConfirmation: false,
          eligible: false,
          ineligibleReason: "A request is already open",
          familyGroupNames: ["Reid family"],
          activeRequest: { id: "mcr-1", status: "PENDING", participantStatus: "PENDING", submittedAt: "2026-06-01" },
        },
      ],
      requests: [
        {
          id: "mcr-1",
          status: "PENDING",
          reason: null,
          submittedAt: "2026-06-01",
          reviewedAt: null,
          completedAt: null,
          requestedBy: { id: MEMBER_ID, name: "Ana Reid", email: "ana@example.test" },
          participants: [
            {
              id: "p-1",
              memberId: "member-4",
              name: "Rawiri Reid",
              email: "ana@example.test",
              ageTier: "ADULT",
              canLogin: false,
              active: true,
              status: "PENDING",
              confirmationTokenExpiresAt: "2026-06-08",
              confirmedAt: null,
              declinedAt: null,
              createdAt: "2026-06-01",
            },
          ],
        },
      ],
    });
    const { connection, browser } = await expectActionContract({
      actionId: "get_membership_cancellation_options",
      handler: getCancellationOptions,
    });
    const keys = allKeys(connection);
    for (const withheld of ["email", "xeroArchiveContactsOnCancellation", "xeroContactGroups"]) {
      expect(keys.has(withheld), withheld).toBe(false);
    }
    expect(allKeys(browser).has("email")).toBe(true);
    expect(h.cancellationOverview).toHaveBeenCalledWith(MEMBER_ID);
  });
});
