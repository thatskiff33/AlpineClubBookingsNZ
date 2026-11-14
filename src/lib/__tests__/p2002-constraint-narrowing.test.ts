/**
 * The three remaining places that treated ANY unique-constraint violation as
 * one specific, friendly-sounding failure (#2455, following #2385 and #2412).
 *
 * Each site gets the same pair of tests: the constraint it really cares about
 * still produces the friendly outcome, and a DIFFERENT unique constraint no
 * longer masquerades as it. The fixtures are the shapes `@prisma/adapter-pg`
 * actually raises — see `helpers/p2002-fixtures.ts`, and note that
 * `meta.target` is never populated on this stack, so a guard reading only
 * `meta.target` would pass every test here by accident. It cannot: these
 * fixtures do not carry one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  prisma: {
    member: { findMany: vi.fn() },
    memberFieldsSettings: { findUnique: vi.fn() },
    emailChangeToken: { findUnique: vi.fn(), delete: vi.fn() },
    passwordResetToken: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  requireAdmin: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mocks.requireAdmin(...args),
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockResolvedValue(null),
  rateLimiters: { verificationToken: { id: "verification-token" } },
}));
vi.mock("@/lib/action-tokens", () => ({
  hashActionToken: vi.fn().mockReturnValue("token-hash"),
  isActionTokenFormat: vi.fn().mockReturnValue(true),
  issueActionToken: vi
    .fn()
    .mockReturnValue({ token: "t", tokenHash: "token-hash" }),
}));
vi.mock("@/lib/audit", () => ({
  createAuditLog: vi.fn(),
  createStructuredAuditLog: vi.fn(),
  getAuditEmailDomain: vi.fn().mockReturnValue("example.com"),
  getAuditRequestContext: vi.fn().mockReturnValue({}),
}));
vi.mock("@/lib/xero", () => ({
  isXeroConnected: vi.fn().mockResolvedValue(false),
  updateXeroContact: vi.fn(),
}));
vi.mock("@/lib/xero-contact-sync", () => ({
  buildXeroContactUpdatePayload: vi.fn().mockReturnValue({}),
  shouldRepairXeroContactNameOrder: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/email", () => ({ sendMemberSetupInviteEmail: vi.fn() }));
vi.mock("@/lib/age-tier", () => ({
  computeAgeTier: vi.fn().mockResolvedValue("ADULT"),
  getSeasonStartDate: vi.fn().mockReturnValue(new Date("2026-04-01")),
}));


import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { GET as confirmEmailChange } from "@/app/api/auth/confirm-email-change/route";
import { POST as importMembers } from "@/app/api/admin/members/import/route";
import { createWorkPartyEventWithPromo } from "@/lib/work-party";
import {
  emailChangeTokenCollisionError,
  emailChangeTokenIndexNameCollisionError,
  googleSubCollisionError,
  loginEmailCollisionError,
  promoCodeCollisionError,
  unidentifiableUniqueCollisionError,
  workPartyPromoCodeIdCollisionError,
} from "@/lib/__tests__/helpers";

// ---------------------------------------------------------------------------
// 1. Confirming an email change
// ---------------------------------------------------------------------------

describe("confirm-email-change only blames the address for an email clash", () => {
  const tokenRecord = {
    id: "tok1",
    memberId: "m1",
    newEmail: "new@example.com",
    expiresAt: new Date("2999-01-01"),
    member: { id: "m1", email: "old@example.com", xeroContactId: null },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.emailChangeToken.findUnique).mockResolvedValue(
      tokenRecord as never,
    );
    vi.mocked(prisma.member.findMany).mockResolvedValue([] as never);
  });

  const confirm = () =>
    confirmEmailChange(
      new NextRequest(
        "http://localhost/api/auth/confirm-email-change?token=abcdef",
      ),
    );

  const redirectTarget = async () =>
    (await confirm()).headers.get("location") ?? "";

  it("still tells the member the address is taken on a login-email clash", async () => {
    vi.mocked(prisma.$transaction).mockRejectedValue(
      loginEmailCollisionError("update"),
    );

    expect(await redirectTarget()).toContain("emailChangeError=taken");
  });

  it("does not blame the address for a collision on another constraint", async () => {
    // Stands in for any non-email constraint the transaction could ever raise
    // — `EmailChangeToken.tokenHash` is the other unique it touches, though as
    // a DELETE it cannot actually raise 23505 today. Before #2455 every one of
    // these told the member their new address was already in use.
    vi.mocked(prisma.$transaction).mockRejectedValue(
      emailChangeTokenCollisionError(),
    );

    const target = await redirectTarget();
    expect(target).toContain("emailChangeError=error");
    expect(target).not.toContain("emailChangeError=taken");
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ constraint: "tokenhash", memberId: "m1" }),
      "Email change confirmation hit an unexpected unique constraint",
    );
  });

  it("does not blame the address when only the index NAME survives", async () => {
    // The same token-hash collision as above, arriving as the index name
    // instead of a column list — the shape left when Postgres withholds the
    // `Key (…)` detail. Prisma index names carry the model prefix, so this
    // normalises to `emailchangetoken_tokenhash_key`, which CONTAINS "email":
    // a substring test sends the member off to change an address that is fine.
    vi.mocked(prisma.$transaction).mockRejectedValue(
      emailChangeTokenIndexNameCollisionError(),
    );

    const target = await redirectTarget();
    expect(target).toContain("emailChangeError=error");
    expect(target).not.toContain("emailChangeError=taken");
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({
        constraint: "emailchangetoken_tokenhash_key",
        memberId: "m1",
      }),
      "Email change confirmation hit an unexpected unique constraint",
    );
  });

  it("does not blame the address for a googleSub clash either", async () => {
    vi.mocked(prisma.$transaction).mockRejectedValue(googleSubCollisionError());

    expect(await redirectTarget()).toContain("emailChangeError=error");
  });

  it("keeps the benefit of the doubt for a P2002 that names nothing", async () => {
    // The email writes are the only unique-bearing statements the transaction
    // makes, so an unnamed collision here really is the address clash.
    vi.mocked(prisma.$transaction).mockRejectedValue(
      unidentifiableUniqueCollisionError(),
    );

    expect(await redirectTarget()).toContain("emailChangeError=taken");
  });

  it("still answers the pre-check's own EMAIL_TAKEN signal", async () => {
    vi.mocked(prisma.$transaction).mockRejectedValue(new Error("EMAIL_TAKEN"));

    expect(await redirectTarget()).toContain("emailChangeError=taken");
  });
});

// ---------------------------------------------------------------------------
// 2. Importing members from a CSV
// ---------------------------------------------------------------------------

describe("member import only blames the login emails for an email clash", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "actor1", role: "ADMIN", accessRoles: ["ADMIN"] } },
    });
    vi.mocked(prisma.memberFieldsSettings.findUnique).mockResolvedValue(
      null as never,
    );
    vi.mocked(prisma.member.findMany).mockResolvedValue([] as never);
  });

  const importRows = (rows: Array<Record<string, unknown>>) =>
    importMembers(
      new NextRequest("http://localhost/api/admin/members/import", {
        method: "POST",
        body: JSON.stringify({ rows, sendInvites: false }),
        headers: { "Content-Type": "application/json" },
      }),
    );

  const loginRow = {
    firstName: "Ada",
    lastName: "Adult",
    email: "ada@example.com",
  };
  // A cancelled date imports the member non-login (#1946), so a batch of these
  // cannot have hit `Member_email_login_unique` at all.
  const nonLoginRow = {
    firstName: "Cora",
    lastName: "Cancelled",
    email: "cora@example.com",
    cancelledDate: "2020-06-30",
  };

  it("still reports the login-email clash for an email collision", async () => {
    vi.mocked(prisma.$transaction).mockRejectedValue(loginEmailCollisionError());

    const res = await importRows([loginRow]);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("login emails already exist");
  });

  it("does not claim a login email exists when another constraint collided", async () => {
    vi.mocked(prisma.$transaction).mockRejectedValue(googleSubCollisionError());

    const res = await importRows([loginRow]);
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error).not.toContain("login emails already exist");
    expect(error).toContain("already used by another record");
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ constraint: "googlesub" }),
      "Member import hit an unexpected unique constraint",
    );
  });

  it("keeps the unnamed P2002 when the batch does create a login", async () => {
    vi.mocked(prisma.$transaction).mockRejectedValue(
      unidentifiableUniqueCollisionError(),
    );

    const res = await importRows([loginRow]);
    expect((await res.json()).error).toContain("login emails already exist");
  });

  it("disowns the unnamed P2002 when nobody in the batch can log in", async () => {
    vi.mocked(prisma.$transaction).mockRejectedValue(
      unidentifiableUniqueCollisionError(),
    );

    const res = await importRows([nonLoginRow]);
    expect(res.status).toBe(409);
    expect((await res.json()).error).not.toContain(
      "login emails already exist",
    );
  });

  it("leaves a non-unique failure as the generic 500", async () => {
    vi.mocked(prisma.$transaction).mockRejectedValue(new Error("boom"));

    const res = await importRows([loginRow]);
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// 3. Generating a work party promo code
// ---------------------------------------------------------------------------

describe("work party promo code retry only re-rolls a code collision", () => {
  const eventInput = {
    name: "Spring working bee",
    description: null,
    startDate: new Date("2026-09-05T00:00:00.000Z"),
    endDate: new Date("2026-09-06T00:00:00.000Z"),
    discountPercent: 100,
    active: true,
    lodgeId: null,
  };

  const promoCreate = vi.fn();
  const eventCreate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset, not just clear: these tests queue `…Once` behaviours, and a
    // leftover one would otherwise answer the NEXT test's first call.
    promoCreate.mockReset();
    eventCreate.mockReset();
    promoCreate.mockResolvedValue({ id: "promo1" });
    eventCreate.mockResolvedValue({ id: "wp1", promoCode: { id: "promo1" } });
    vi.mocked(prisma.$transaction).mockImplementation((fn) =>
      (fn as (tx: unknown) => Promise<unknown>)({
        promoCode: { create: promoCreate },
        workPartyEvent: { create: eventCreate },
      }),
    );
  });

  const attemptedCodes = () =>
    promoCreate.mock.calls.map(
      (call) => (call[0] as { data: { code: string } }).data.code,
    );

  it("re-rolls the code and retries on a real promo code collision", async () => {
    promoCreate
      .mockRejectedValueOnce(promoCodeCollisionError())
      .mockRejectedValueOnce(promoCodeCollisionError())
      .mockResolvedValueOnce({ id: "promo1" });

    await expect(
      createWorkPartyEventWithPromo(eventInput),
    ).resolves.toMatchObject({ id: "wp1" });
    expect(promoCreate).toHaveBeenCalledTimes(3);
    // Each attempt generated a fresh code rather than resubmitting the rejected
    // one, which is the only thing a retry can usefully change.
    expect(new Set(attemptedCodes()).size).toBe(3);
  });

  it("does not spend a retry on the event's own promoCodeId collision", async () => {
    // `promoCodeId` normalises to `promocodeid`, which CONTAINS "code" — a
    // substring test would burn the whole budget here.
    const collision = workPartyPromoCodeIdCollisionError();
    eventCreate.mockRejectedValue(collision);

    await expect(createWorkPartyEventWithPromo(eventInput)).rejects.toBe(
      collision,
    );
    expect(promoCreate).toHaveBeenCalledTimes(1);
    expect(eventCreate).toHaveBeenCalledTimes(1);
  });

  it("re-rolls a P2002 that names nothing, and says the name was missing", async () => {
    // The only uniques this transaction can violate are the generated `code`
    // and `WorkPartyEvent.promoCodeId` — and that one is the cuid minted a
    // statement earlier, so it cannot collide. An unnamed collision here is the
    // code, and re-rolling is the one thing that can fix it.
    promoCreate
      .mockRejectedValueOnce(unidentifiableUniqueCollisionError())
      .mockResolvedValueOnce({ id: "promo1" });

    await expect(
      createWorkPartyEventWithPromo(eventInput),
    ).resolves.toMatchObject({ id: "wp1" });
    expect(promoCreate).toHaveBeenCalledTimes(2);
    expect(new Set(attemptedCodes()).size).toBe(2);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("carried no constraint name"),
    );
  });

  it("does not spend a retry on a failure that is not a unique violation", async () => {
    promoCreate.mockRejectedValue(new Error("connection lost"));

    await expect(createWorkPartyEventWithPromo(eventInput)).rejects.toThrow(
      "connection lost",
    );
    expect(promoCreate).toHaveBeenCalledTimes(1);
  });

  it("gives up after the budget and says so", async () => {
    promoCreate.mockRejectedValue(promoCodeCollisionError());

    await expect(createWorkPartyEventWithPromo(eventInput)).rejects.toThrow(
      Prisma.PrismaClientKnownRequestError,
    );
    expect(promoCreate).toHaveBeenCalledTimes(5);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 5, constraint: "code" }),
      "Work party promo code generation exhausted its attempts",
    );
  });
});
