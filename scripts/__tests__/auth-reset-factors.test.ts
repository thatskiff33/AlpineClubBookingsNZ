import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  switchOn: { value: true },
  findFirst: vi.fn(),
  clearMemberSecondFactors: vi.fn(),
  sendOfficerFactorResetEmail: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("../../src/lib/officer-sign-in-switch", () => ({
  get OFFICER_SIGN_IN_ENFORCED() {
    return mocks.switchOn.value;
  },
}));
vi.mock("../../src/lib/prisma", () => ({
  prisma: { member: { findFirst: mocks.findFirst }, $disconnect: vi.fn() },
}));
vi.mock("../../src/lib/officer-factor-reset", () => ({
  clearMemberSecondFactors: mocks.clearMemberSecondFactors,
}));
vi.mock("../../src/lib/email/account", () => ({
  sendOfficerFactorResetEmail: mocks.sendOfficerFactorResetEmail,
}));
vi.mock("../../src/lib/logger", () => ({ default: { error: mocks.loggerError } }));

import { parseResetFactorsArgs, runResetFactorsCommand } from "../auth-reset-factors";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) } };
}

describe("auth:reset-factors (#4618)", () => {
  beforeEach(() => {
    mocks.switchOn.value = true;
    mocks.findFirst.mockReset();
    mocks.clearMemberSecondFactors.mockReset().mockResolvedValue({
      ok: true,
      memberId: "member-1",
      email: "officer@example.com",
      firstName: "Ola",
      factorsResetAt: new Date(),
    });
    mocks.sendOfficerFactorResetEmail.mockReset().mockResolvedValue(undefined);
    mocks.loggerError.mockReset();
  });

  it("parses --member in both forms and refuses anything else without echoing it", () => {
    expect(parseResetFactorsArgs(["--member", "a@example.com"])).toEqual({
      kind: "run",
      email: "a@example.com",
    });
    expect(parseResetFactorsArgs(["--member=a@example.com"])).toEqual({
      kind: "run",
      email: "a@example.com",
    });
    expect(parseResetFactorsArgs([]).kind).toBe("error");
    expect(parseResetFactorsArgs(["--member"]).kind).toBe("error");
    const unknown = parseResetFactorsArgs(["secret-value"]);
    expect(unknown.kind).toBe("error");
    expect(JSON.stringify(unknown)).not.toContain("secret-value");
  });

  it("writes nothing while the release switch is off", async () => {
    mocks.switchOn.value = false;
    const run = io();
    expect(await runResetFactorsCommand(["--member", "officer@example.com"], run.io)).toBe(1);
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.clearMemberSecondFactors).not.toHaveBeenCalled();
  });

  it("refuses an unknown email", async () => {
    mocks.findFirst.mockResolvedValueOnce(null);
    const run = io();
    expect(await runResetFactorsCommand(["--member", "nobody@example.com"], run.io)).toBe(1);
    expect(mocks.clearMemberSecondFactors).not.toHaveBeenCalled();
  });

  it("clears as the named system actor, emails the member, and exits 0", async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: "member-1" }).mockResolvedValueOnce(null);
    const run = io();
    expect(await runResetFactorsCommand(["--member", " Officer@Example.com "], run.io)).toBe(0);
    expect(mocks.findFirst.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ where: { email: "officer@example.com", canLogin: true } }),
    );
    expect(mocks.clearMemberSecondFactors).toHaveBeenCalledWith({
      memberId: "member-1",
      actor: { kind: "system", actor: "officer-factor-reset" },
    });
    expect(mocks.sendOfficerFactorResetEmail).toHaveBeenCalledWith("officer@example.com", "Ola");
    expect(run.out.join("\n")).toContain("officer@example.com");
  });

  it("refuses the kiosk", async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: "kiosk" });
    mocks.clearMemberSecondFactors.mockResolvedValueOnce({ ok: false, reason: "kiosk" });
    const run = io();
    expect(await runResetFactorsCommand(["--member", "lodge@example.com"], run.io)).toBe(1);
    expect(mocks.sendOfficerFactorResetEmail).not.toHaveBeenCalled();
  });

  it("still exits 0 when the email cannot be queued, and says so", async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: "member-1" }).mockResolvedValueOnce(null);
    mocks.sendOfficerFactorResetEmail.mockRejectedValueOnce(new Error("queue down"));
    const run = io();
    expect(await runResetFactorsCommand(["--member", "officer@example.com"], run.io)).toBe(0);
    expect(run.err.join("\n")).toContain("could not be queued");
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
  });
});
