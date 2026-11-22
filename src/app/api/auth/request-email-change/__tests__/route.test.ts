import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The email-change request writes its token inside one transaction: the
// member's older tokens are deleted and the new one created together, so a
// crash between them cannot leave two live links or none. These pins sat on a
// helper production never called (#5392); they belong on the route.
const h = vi.hoisted(() => {
  const calls: string[] = [];
  const tx = {
    emailChangeToken: {
      deleteMany: vi.fn(async () => {
        calls.push("deleteMany");
        return { count: 1 };
      }),
      create: vi.fn(async () => {
        calls.push("create");
        return { id: "token-1" };
      }),
    },
  };
  return {
    calls,
    tx,
    auth: vi.fn(),
    requireActiveSessionUser: vi.fn(),
    applyRateLimit: vi.fn(),
    memberFindUnique: vi.fn(),
    memberFindFirst: vi.fn(),
    transaction: vi.fn(),
    createStructuredAuditLog: vi.fn(),
    sendEmailChangeVerification: vi.fn(),
    sendEmailChangeNotification: vi.fn(),
  };
});

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: h.requireActiveSessionUser,
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: h.applyRateLimit,
  rateLimiters: { requestEmailChange: { id: "request-email-change" } },
}));
// No `emailChangeToken` on the global client: a token write outside the
// transaction would throw here rather than pass unseen.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: h.memberFindUnique, findFirst: h.memberFindFirst },
    $transaction: h.transaction,
  },
}));
vi.mock("@/lib/audit", () => ({
  createStructuredAuditLog: h.createStructuredAuditLog,
  getAuditEmailDomain: (email: string) => email.split("@")[1] ?? null,
  getAuditRequestContext: () => ({}),
}));
vi.mock("@/lib/email", () => ({
  sendEmailChangeVerification: h.sendEmailChangeVerification,
  sendEmailChangeNotification: h.sendEmailChangeNotification,
}));
vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/auth/request-email-change/route";
import { EMAIL_CHANGE_TTL_MS } from "@/lib/verification-tokens";

function req(body: unknown) {
  return new NextRequest("http://localhost/api/auth/request-email-change", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.calls.length = 0;
  h.applyRateLimit.mockResolvedValue(null);
  h.auth.mockResolvedValue({ user: { id: "member-1" } });
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.memberFindUnique.mockResolvedValue({
    id: "member-1",
    email: "old@example.com",
    firstName: "Ana",
  });
  h.memberFindFirst.mockResolvedValue(null);
  h.createStructuredAuditLog.mockResolvedValue(undefined);
  h.sendEmailChangeVerification.mockResolvedValue(undefined);
  h.sendEmailChangeNotification.mockResolvedValue(undefined);
  h.transaction.mockImplementation(async (callback: (tx: typeof h.tx) => Promise<unknown>) => {
    h.calls.push("begin");
    const result = await callback(h.tx);
    h.calls.push("commit");
    return result;
  });
});

describe("POST /api/auth/request-email-change", () => {
  it("creates a token that expires EMAIL_CHANGE_TTL_MS (two hours) from now", async () => {
    const res = await POST(req({ newEmail: "New@Example.com" }));

    expect(res.status).toBe(200);
    expect(EMAIL_CHANGE_TTL_MS).toBe(2 * 60 * 60 * 1000);
    expect(h.tx.emailChangeToken.create).toHaveBeenCalledWith({
      data: {
        memberId: "member-1",
        newEmail: "new@example.com",
        tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        // The frozen test clock: `Date.now()` is the pinned instant.
        expiresAt: new Date(Date.now() + EMAIL_CHANGE_TTL_MS),
      },
    });
  });

  it("deletes the member's older email-change tokens in the same transaction, before creating the new one", async () => {
    await POST(req({ newEmail: "new@example.com" }));

    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(h.tx.emailChangeToken.deleteMany).toHaveBeenCalledWith({
      where: { memberId: "member-1" },
    });
    expect(h.calls).toEqual(["begin", "deleteMany", "create", "commit"]);
  });

  it("writes no token and sends nothing when the new address is already in use", async () => {
    h.memberFindFirst.mockResolvedValue({ id: "member-2" });

    const res = await POST(req({ newEmail: "taken@example.com" }));

    expect(res.status).toBe(409);
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.sendEmailChangeVerification).not.toHaveBeenCalled();
  });
});
