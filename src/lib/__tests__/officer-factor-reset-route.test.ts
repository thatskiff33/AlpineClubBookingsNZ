import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  switchOn: { value: true },
  requireAdmin: vi.fn(),
  isFullAdmin: vi.fn(),
  requireRecentAuth: vi.fn(),
  clearMemberSecondFactors: vi.fn(),
  sendOfficerFactorResetEmail: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/officer-sign-in-switch", () => ({
  get OFFICER_SIGN_IN_ENFORCED() {
    return mocks.switchOn.value;
  },
}));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/access-roles", () => ({ isFullAdmin: mocks.isFullAdmin }));
vi.mock("@/lib/require-recent-auth", () => ({
  requireRecentAuth: mocks.requireRecentAuth,
}));
vi.mock("@/lib/officer-factor-reset", () => ({
  clearMemberSecondFactors: mocks.clearMemberSecondFactors,
}));
vi.mock("@/lib/email/account", () => ({
  sendOfficerFactorResetEmail: mocks.sendOfficerFactorResetEmail,
}));
vi.mock("@/lib/audit", () => ({ getAuditRequestContext: () => ({}) }));
vi.mock("@/lib/logger", () => ({ default: { error: mocks.loggerError } }));

import { POST } from "@/app/api/admin/security/two-factor-reset/[memberId]/route";

const ADMIN_ID = "admin-1";
const TARGET_ID = "member-2";

function call(memberId = TARGET_ID) {
  return POST(new Request(`http://localhost/api/admin/security/two-factor-reset/${memberId}`, {
    method: "POST",
  }), { params: Promise.resolve({ memberId }) });
}

describe("POST /api/admin/security/two-factor-reset/[memberId] (#4618)", () => {
  beforeEach(() => {
    mocks.switchOn.value = true;
    mocks.requireAdmin.mockReset().mockResolvedValue({
      ok: true,
      session: { user: { id: ADMIN_ID } },
    });
    mocks.isFullAdmin.mockReset().mockReturnValue(true);
    mocks.requireRecentAuth.mockReset().mockResolvedValue({ ok: true });
    mocks.clearMemberSecondFactors.mockReset().mockResolvedValue({
      ok: true,
      memberId: TARGET_ID,
      email: "officer@example.com",
      firstName: "Ola",
      factorsResetAt: new Date(),
    });
    mocks.sendOfficerFactorResetEmail.mockReset().mockResolvedValue(undefined);
    mocks.loggerError.mockReset();
  });

  it("is not found while the release switch is off, and touches nothing", async () => {
    mocks.switchOn.value = false;
    expect((await call()).status).toBe(404);
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.clearMemberSecondFactors).not.toHaveBeenCalled();
  });

  it("asks requireAdmin for Support & System edit and returns its refusal", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });
    expect((await call()).status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "support", level: "edit" },
    });
    expect(mocks.clearMemberSecondFactors).not.toHaveBeenCalled();
  });

  it("refuses an officer who is not a Full Admin", async () => {
    mocks.isFullAdmin.mockReturnValue(false);
    expect((await call()).status).toBe(403);
    expect(mocks.requireRecentAuth).not.toHaveBeenCalled();
    expect(mocks.clearMemberSecondFactors).not.toHaveBeenCalled();
  });

  it("refuses without a fresh proof", async () => {
    mocks.requireRecentAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "REAUTH_REQUIRED" }, { status: 403 }),
    });
    const response = await call();
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ code: "REAUTH_REQUIRED" });
    expect(mocks.clearMemberSecondFactors).not.toHaveBeenCalled();
  });

  it("refuses a Full Admin resetting themselves", async () => {
    expect((await call(ADMIN_ID)).status).toBe(400);
    expect(mocks.clearMemberSecondFactors).not.toHaveBeenCalled();
  });

  it("clears as the admin actor, then emails the member", async () => {
    expect((await call()).status).toBe(200);
    expect(mocks.clearMemberSecondFactors).toHaveBeenCalledWith(
      expect.objectContaining({
        memberId: TARGET_ID,
        actor: { kind: "admin", memberId: ADMIN_ID },
      }),
    );
    expect(mocks.sendOfficerFactorResetEmail).toHaveBeenCalledWith(
      "officer@example.com",
      "Ola",
    );
  });

  it("answers 404 for a missing member and 400 for the kiosk, sending nothing", async () => {
    mocks.clearMemberSecondFactors.mockResolvedValueOnce({ ok: false, reason: "missing" });
    expect((await call()).status).toBe(404);
    mocks.clearMemberSecondFactors.mockResolvedValueOnce({ ok: false, reason: "kiosk" });
    expect((await call()).status).toBe(400);
    expect(mocks.sendOfficerFactorResetEmail).not.toHaveBeenCalled();
  });

  it("keeps a committed reset when the email cannot be queued", async () => {
    mocks.sendOfficerFactorResetEmail.mockRejectedValue(new Error("queue down"));
    expect((await call()).status).toBe(200);
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
  });
});
