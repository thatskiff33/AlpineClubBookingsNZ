/**
 * ALP-653 (`INV-MCP-006`): three routes the website already reads send an AI
 * app connection a narrower answer. The website's answer is unchanged; only a
 * request carrying the internal principal header gets the projection.
 *
 * - `GET /api/members/family` (`get_my_family_group`): id, name, age group,
 *   relationship and whether the person can be booked. No dates of birth,
 *   email addresses, parent links, notes or pending-request details.
 * - `GET /api/bookings/drafts` (`list_my_draft_bookings`): no dietary data and
 *   no consent or internal booking columns.
 * - `GET /api/member/subscription-status` (`get_my_subscription_status`): no
 *   invoice link, which opens the invoice for anyone holding it.
 * - `GET /api/member/credit-balance` (`get_my_credit_balance`): the balance
 *   only, not the credit ledger with its reasons and booking links.
 *
 * `create_draft_booking`'s answer is pinned in `issue7-8-draft-subscription.test.ts`.
 *
 * Each test fails if a withheld field reappears in what a connection is sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  viaConnection: false,
  auth: vi.fn(),
  getMemberFamily: vi.fn(),
  bookingFindMany: vi.fn(),
  memberFindUnique: vi.fn(),
  creditBalance: vi.fn(),
  creditHistory: vi.fn(),
}));

vi.mock("@/lib/mcp-connection-request", () => ({
  servingMcpConnection: async () => h.viaConnection,
}));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({ requireActiveSessionUser: vi.fn(async () => null) }));
vi.mock("@/lib/member-family-service", () => ({ getMemberFamily: h.getMemberFamily }));
vi.mock("@/lib/member-credit", () => ({
  getMemberCreditBalance: h.creditBalance,
  getMemberCreditHistory: h.creditHistory,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: h.bookingFindMany },
    member: { findUnique: h.memberFindUnique },
  },
}));
vi.mock("@/lib/club-time/server", () => ({ clubTimeZone: vi.fn(async () => "Pacific/Auckland") }));
vi.mock("@/lib/membership-type-policy", () => ({
  requiresPaidSubscriptionForMemberForBooking: vi.fn(async () => true),
  resolveMembershipTypePolicyForMember: vi.fn(async () => null),
}));
vi.mock("@/lib/member-subscription-eligibility", () => ({
  resolveSubscriptionLockoutMode: vi.fn(async () => "HARD_BLOCK"),
}));

import { GET as getDrafts } from "@/app/api/bookings/drafts/route";
import { GET as getCreditBalance } from "@/app/api/member/credit-balance/route";
import { GET as getSubscriptionStatus } from "@/app/api/member/subscription-status/route";
import { GET as getFamily } from "@/app/api/members/family/route";
import { projectForConnection } from "@/lib/connection-projection";
import { SUBSCRIPTION_STATUS_CONNECTION_SHAPE } from "@/lib/connection-shapes";

/** Every key anywhere in a JSON value, so a withheld field cannot hide in a nested object. */
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

beforeEach(() => {
  vi.clearAllMocks();
  h.viaConnection = false;
  h.auth.mockResolvedValue({ user: { id: "member-1" } });
});

describe("GET /api/members/family", () => {
  const fullFamily = {
    ownDependants: [{ id: "kid-2", firstName: "Tui", lastName: "Reid" }],
    familyGroupId: "fg-1",
    familyGroupName: "Reid family",
    familyGroupIds: ["fg-1"],
    displayName: "Ana Reid",
    familyMembers: [
      {
        id: "member-1", firstName: "Ana", lastName: "Reid", ageTier: "ADULT", role: "MEMBER",
        relationship: "self", canLogin: true, canBeBooked: true, missingFields: [],
        canCurrentUserConfirmDetails: false, familyGroupIds: ["fg-1"],
        dateOfBirth: "1980-02-03", pendingRequests: [{ id: "r1", type: "JOIN", status: "PENDING", familyGroupId: "fg-1" }],
        parentLinks: [{ id: "p1", email: "parent@example.test" }],
        notificationEmailFromId: null, notificationEmailFromName: null, detailsConfirmedBy: null,
      },
      {
        id: "kid-1", firstName: "Mere", lastName: "Reid", ageTier: "CHILD", role: "MEMBER",
        relationship: "dependent", canLogin: false, canBeBooked: false, missingFields: ["dateOfBirth"],
        canCurrentUserConfirmDetails: true, familyGroupIds: ["fg-1"],
        dateOfBirth: "2019-05-06", pendingRequests: [], parentLinks: [],
        notificationEmailFromId: "member-1", notificationEmailFromName: null, detailsConfirmedBy: null,
      },
    ],
    myPendingCreateRequest: null,
    pendingRequests: [{
      id: "r2", requestedEmail: "partner@example.test", requestedDateOfBirth: "1981-01-01",
      requestNotes: "Please add my partner", childDateOfBirth: null,
    }],
  };

  it("sends a connection who can go on a booking, and nothing else", async () => {
    h.getMemberFamily.mockResolvedValue({ body: fullFamily });
    h.viaConnection = true;
    const res = await getFamily();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      displayName: "Ana Reid",
      // ALP-795: the ids the family actions take, and who has a login.
      familyGroupIds: ["fg-1"],
      familyMembers: [
        {
          id: "member-1", firstName: "Ana", lastName: "Reid", ageTier: "ADULT", relationship: "self",
          canBeBooked: true, canLogin: true, canCurrentUserConfirmDetails: false, familyGroupIds: ["fg-1"],
        },
        {
          id: "kid-1", firstName: "Mere", lastName: "Reid", ageTier: "CHILD", relationship: "dependent",
          canBeBooked: false, canLogin: false, canCurrentUserConfirmDetails: true, familyGroupIds: ["fg-1"],
        },
      ],
    });
    const keys = allKeys(body);
    for (const withheld of [
      "dateOfBirth", "email", "parentLinks", "pendingRequests", "requestedEmail",
      "requestedDateOfBirth", "requestNotes", "childDateOfBirth", "ownDependants",
      "notificationEmailFromId", "missingFields",
    ]) {
      expect(keys.has(withheld), withheld).toBe(false);
    }
  });

  it("answers the website exactly as before", async () => {
    h.getMemberFamily.mockResolvedValue({ body: fullFamily });
    const res = await getFamily();
    expect(await res.json()).toEqual(fullFamily);
  });

  it("passes a refusal through unchanged to a connection", async () => {
    h.getMemberFamily.mockResolvedValue({ body: { error: "Member not found" }, init: { status: 404 } });
    h.viaConnection = true;
    const res = await getFamily();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Member not found" });
  });
});

describe("GET /api/bookings/drafts", () => {
  // What `include: { guests: true }` returns: every booking column and every guest column.
  const fullDraft = {
    id: "draft-1", memberId: "member-1", status: "DRAFT",
    checkIn: new Date("2026-08-07T00:00:00.000Z"), checkOut: new Date("2026-08-09T00:00:00.000Z"),
    draftExpiresAt: new Date("2026-07-02T00:00:00.000Z"), createdAt: new Date("2026-06-30T00:00:00.000Z"),
    notes: "Arriving late", finalPriceCents: 24000, stripePaymentIntentId: "pi_1", internalNotes: "officer only",
    lodge: { id: "lodge-1", name: "Main lodge", address: "1 Road" },
    guests: [{
      id: "g1", firstName: "Ana", lastName: "Reid", ageTier: "ADULT", isMember: true, memberId: "member-1",
      dietaryRequirements: "Peanut allergy", consentGivenAt: new Date(), stayNights: ["2026-08-07"],
    }],
  };

  it("sends a connection a narrow summary, with no dietary, consent or internal columns", async () => {
    h.bookingFindMany.mockResolvedValue([fullDraft]);
    h.viaConnection = true;
    const res = await getDrafts();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      drafts: [{
        id: "draft-1", status: "DRAFT", checkIn: "2026-08-07", checkOut: "2026-08-09",
        draftExpiresAt: "2026-07-02T00:00:00.000Z", lodge: { id: "lodge-1", name: "Main lodge" },
        notes: "Arriving late",
        guests: [{ firstName: "Ana", lastName: "Reid", ageTier: "ADULT", isMember: true }],
      }],
    });
    const keys = allKeys(body);
    for (const withheld of [
      "dietaryRequirements", "consentGivenAt", "stripePaymentIntentId", "internalNotes",
      "memberId", "address", "stayNights",
    ]) {
      expect(keys.has(withheld), withheld).toBe(false);
    }
    // The query itself names the columns rather than including whole rows.
    const query = h.bookingFindMany.mock.calls[0][0];
    expect(query.include).toBeUndefined();
    expect(query.select.guests.select).not.toHaveProperty("dietaryRequirements");
  });

  it("answers the website exactly as before", async () => {
    h.bookingFindMany.mockResolvedValue([fullDraft]);
    const res = await getDrafts();
    const body = await res.json();
    expect(body.drafts[0].guests[0].dietaryRequirements).toBe("Peanut allergy");
    expect(h.bookingFindMany.mock.calls[0][0].include).toEqual({ guests: true });
  });
});

describe("GET /api/member/subscription-status", () => {
  beforeEach(() => {
    h.memberFindUnique.mockResolvedValue({
      role: "MEMBER",
      ageTier: "ADULT",
      subscriptions: [{
        status: "UNPAID", xeroInvoiceId: "inv-1", xeroInvoiceNumber: "INV-0042",
        xeroOnlineInvoiceUrl: "https://in.xero.com/invoice-link",
      }],
    });
  });

  it("sends a connection the status without the invoice link", async () => {
    h.viaConnection = true;
    const res = await getSubscriptionStatus();
    const body = await res.json();
    expect(body).toMatchObject({ status: "UNPAID", subscriptionRequired: true, invoiceNumber: "INV-0042" });
    expect(allKeys(body).has("invoiceUrl")).toBe(false);
    expect(allKeys(body).has("rawInvoiceUrl")).toBe(false);
    expect(JSON.stringify(body)).not.toContain("in.xero.com");
  });

  it("sends only named fields, so a field the website gains later does not reach a connection", () => {
    expect(projectForConnection({ status: "PAID", invoiceUrl: "https://x", someNewField: "secret" }, SUBSCRIPTION_STATUS_CONNECTION_SHAPE)).toEqual({
      status: "PAID",
    });
  });

  it("answers the website exactly as before", async () => {
    const res = await getSubscriptionStatus();
    const body = await res.json();
    expect(body.invoiceUrl).toBe("https://in.xero.com/invoice-link");
    expect(body.rawInvoiceUrl).toBe("https://in.xero.com/invoice-link");
  });
});

describe("GET /api/member/credit-balance", () => {
  beforeEach(() => {
    h.creditBalance.mockResolvedValue(4500);
    h.creditHistory.mockResolvedValue([
      { id: "c1", amountCents: 4500, reason: "Refund for cancelled stay", sourceBooking: { id: "b1" } },
    ]);
  });

  it("sends a connection the balance only", async () => {
    h.viaConnection = true;
    const res = await getCreditBalance();
    expect(await res.json()).toEqual({ balanceCents: 4500 });
  });

  it("answers the website exactly as before", async () => {
    const res = await getCreditBalance();
    const body = await res.json();
    expect(body.balanceCents).toBe(4500);
    expect(body.history).toHaveLength(1);
  });
});
