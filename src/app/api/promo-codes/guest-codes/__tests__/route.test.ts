/**
 * `POST /api/promo-codes/guest-codes` (#3492, epic #3813 C4) — the guest-code
 * chips' lookup. What it must never do is the point of these tests: answer for a
 * booking the caller does not own, offer a pending or declined guest's codes,
 * offer a non-family member's codes before the booking exists, echo a member
 * id, say anything beyond code and benefit, or run without its throttle and its
 * privacy audit row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { OPERATIONALLY_PRESENT_GUEST_WHERE } from "@/lib/member-guest-consent";

const mocks = vi.hoisted(() => ({
  session: {
    user: { id: "booker", role: "MEMBER", accessRoles: [{ role: "USER" }] } as Record<string, unknown>,
  },
  prisma: {
    booking: { findUnique: vi.fn() },
    bookingGuest: { findMany: vi.fn() },
    promoCodeLodge: { findMany: vi.fn() },
    lodge: { findUnique: vi.fn(), findFirst: vi.fn() },
  },
  rateLimited: null as Response | null,
  applyMemberScopedRateLimit: vi.fn(),
  getAssignedPromoCodeSummariesForMember: vi.fn(),
  resolveMemberFamily: vi.fn(),
  createStructuredAuditLog: vi.fn(),
  multiPromoCodesEnabled: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => mocks.session) }));
vi.mock("@/lib/session-guards", () => ({ requireActiveSessionUser: vi.fn(async () => null) }));
vi.mock("@/lib/rate-limit", () => ({
  applyMemberScopedRateLimit: (...args: unknown[]) => mocks.applyMemberScopedRateLimit(...args),
  rateLimiters: { promoGuestCodeLookup: { id: "promo-guest-code-lookup" } },
}));
vi.mock("@/lib/promo", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getAssignedPromoCodeSummariesForMember: (...args: unknown[]) =>
    mocks.getAssignedPromoCodeSummariesForMember(...args),
}));
vi.mock("@/lib/resolve-member-family", () => ({
  resolveMemberFamily: (...args: unknown[]) => mocks.resolveMemberFamily(...args),
}));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  createStructuredAuditLog: (...args: unknown[]) => mocks.createStructuredAuditLog(...args),
}));
vi.mock("@/lib/club-format-settings", () => ({
  getClubFormat: vi.fn(async () => ({ currency: "NZD", locale: "en-NZ", dateFormat: "DD/MM/YYYY" })),
}));
vi.mock("@/lib/promo-redemption-slot", () => ({
  multiPromoCodesEnabled: (...args: unknown[]) => mocks.multiPromoCodesEnabled(...args),
}));

import { POST } from "../route";

function summary(code: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `pc-${code}`,
    code,
    description: "Life member nights (private note)",
    type: "FREE_NIGHTS",
    percentOff: null,
    valueCents: null,
    freeNightsPerIndividual: 3,
    lifetimeFreeNightsCap: null,
    fixedNightlyPriceCents: null,
    fixedNightlyMode: null,
    visibleToMember: true,
    ...overrides,
  };
}

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/promo-codes/guest-codes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const codesByMember: Record<string, ReturnType<typeof summary>[]> = {
  "guest-b": [summary("BFREE")],
  "guest-c": [summary("CFREE")],
  "family-d": [summary("DFREE")],
  "outsider-e": [summary("EFREE")],
  booker: [summary("MINE")],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.user = { id: "booker", role: "MEMBER", accessRoles: [{ role: "USER" }] };
  mocks.applyMemberScopedRateLimit.mockResolvedValue(null);
  mocks.multiPromoCodesEnabled.mockResolvedValue(true);
  mocks.createStructuredAuditLog.mockResolvedValue(undefined);
  mocks.prisma.promoCodeLodge.findMany.mockResolvedValue([]);
  mocks.prisma.lodge.findUnique.mockResolvedValue({ id: "lodge-1", active: true });
  mocks.prisma.lodge.findFirst.mockResolvedValue({ id: "lodge-1", active: true });
  mocks.getAssignedPromoCodeSummariesForMember.mockImplementation(
    async (memberId: string) => codesByMember[memberId] ?? [],
  );
  mocks.prisma.booking.findUnique.mockResolvedValue({
    id: "booking-1",
    memberId: "booker",
    lodgeId: "lodge-1",
  });
  mocks.prisma.bookingGuest.findMany.mockResolvedValue([
    { id: "bg-booker", memberId: "booker" },
    { id: "bg-b", memberId: "guest-b" },
  ]);
  mocks.resolveMemberFamily.mockResolvedValue({
    familyMembers: [
      { id: "booker", relationship: "self" },
      { id: "family-d", relationship: "partner" },
      { id: "family-nocodes", relationship: "dependent" },
    ],
  });
});

describe("existing booking", () => {
  it("offers the staying guests' codes by booking-guest id, never the booker's own, and audits the lookup", async () => {
    const res = await post({ bookingId: "booking-1" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      multiPromoCodes: true,
      guests: [{ guestRef: "bg-b", codes: [{ code: "BFREE", benefit: "3 free nights per booking" }] }],
    });
    // Staying guests only — the pending/declined filter is in the query itself.
    const where = mocks.prisma.bookingGuest.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({ bookingId: "booking-1", OR: OPERATIONALLY_PRESENT_GUEST_WHERE.OR });
    expect(mocks.createStructuredAuditLog).toHaveBeenCalledTimes(1);
    expect(mocks.createStructuredAuditLog.mock.calls[0]![0]).toMatchObject({
      action: "promo_code.guest_lookup",
      category: "privacy",
      actor: { memberId: "booker" },
      entity: { type: "Booking", id: "booking-1" },
      metadata: { disclosedMemberIds: ["guest-b"], codeCount: 1 },
    });
  });

  it("answers a booking the caller does not own exactly as a missing one, and looks nothing up", async () => {
    mocks.session.user = { id: "stranger", role: "MEMBER", accessRoles: [{ role: "USER" }] };
    const notOwned = await post({ bookingId: "booking-1" });
    mocks.prisma.booking.findUnique.mockResolvedValueOnce(null);
    const missing = await post({ bookingId: "nope" });
    expect(notOwned.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await notOwned.json()).toEqual(await missing.json());
    expect(mocks.prisma.bookingGuest.findMany).not.toHaveBeenCalled();
    expect(mocks.createStructuredAuditLog).not.toHaveBeenCalled();
  });

  it("lets a booking officer look up another member's booking", async () => {
    mocks.session.user = { id: "officer", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] };
    const res = await post({ bookingId: "booking-1" });
    expect(res.status).toBe(200);
    expect((await res.json()).guests).toHaveLength(1);
  });

  it("omits a code restricted to another lodge", async () => {
    mocks.prisma.promoCodeLodge.findMany.mockResolvedValue([{ promoCodeId: "pc-BFREE", lodgeId: "lodge-2" }]);
    const body = await (await post({ bookingId: "booking-1" })).json();
    expect(body.guests).toEqual([]);
  });
});

describe("a party before the booking exists", () => {
  it("offers only family guests, referenced by position, and a non-family id looks like a family member with no codes", async () => {
    const res = await post({
      lodgeId: "lodge-1",
      guestMemberIds: ["outsider-e", "family-d", "family-nocodes", "no-such-member"],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.guests).toEqual([
      { guestRef: "1", codes: [{ code: "DFREE", benefit: "3 free nights per booking" }] },
    ]);
    // The outsider's codes were never even read.
    expect(mocks.getAssignedPromoCodeSummariesForMember).not.toHaveBeenCalledWith("outsider-e");
    expect(JSON.stringify(body)).not.toMatch(/family-d|outsider-e|no-such-member/);
    expect(mocks.createStructuredAuditLog.mock.calls[0]![0]).toMatchObject({
      category: "privacy",
      metadata: { examinedGuestCount: 4, disclosedMemberIds: ["family-d"] },
    });
  });

  it("carries only the code and its benefit — no description, usage or member id", async () => {
    const body = await (await post({ lodgeId: "lodge-1", guestMemberIds: ["family-d"] })).json();
    expect(Object.keys(body.guests[0])).toEqual(["guestRef", "codes"]);
    expect(Object.keys(body.guests[0].codes[0])).toEqual(["code", "benefit"]);
  });

  it("refuses forMemberId from anyone but a booking officer", async () => {
    const res = await post({ lodgeId: "lodge-1", guestMemberIds: ["family-d"], forMemberId: "family-d" });
    expect(res.status).toBe(403);
    expect(mocks.resolveMemberFamily).not.toHaveBeenCalled();
  });

  it("uses the on-behalf member's family for an officer", async () => {
    mocks.session.user = { id: "officer", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] };
    await post({ lodgeId: "lodge-1", guestMemberIds: ["family-d"], forMemberId: "booker" });
    expect(mocks.resolveMemberFamily).toHaveBeenCalledWith("booker");
    expect(mocks.createStructuredAuditLog.mock.calls[0]![0].metadata).toMatchObject({ onBehalfOfMemberId: "booker" });
  });

  it("writes no audit row when the party names no member guest", async () => {
    const res = await post({ lodgeId: "lodge-1", guestMemberIds: [] });
    expect(await res.json()).toEqual({ multiPromoCodes: true, guests: [] });
    expect(mocks.createStructuredAuditLog).not.toHaveBeenCalled();
  });
});

describe("the throttle", () => {
  it("is applied per member before anything is read", async () => {
    mocks.applyMemberScopedRateLimit.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 }),
    );
    const res = await post({ bookingId: "booking-1" });
    expect(res.status).toBe(429);
    expect(mocks.applyMemberScopedRateLimit.mock.calls[0]![2]).toBe("booker");
    expect(mocks.prisma.booking.findUnique).not.toHaveBeenCalled();
    expect(mocks.createStructuredAuditLog).not.toHaveBeenCalled();
  });
});
