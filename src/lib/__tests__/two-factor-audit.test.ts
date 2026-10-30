import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));

import { createAuditLog } from "@/lib/audit";
import {
  TWO_FACTOR_AUDIT_ACTIONS,
  TwoFactorActorError,
  assertTwoFactorActor,
  recordTwoFactorClear,
  recordTwoFactorMutation,
} from "@/lib/two-factor-audit";

const db = { auditLog: {} } as never;

beforeEach(() => vi.clearAllMocks());

// #4457: a named background job may clear a second factor, and nothing else.
describe("two-factor system actors (INV-PRIV-020)", () => {
  it("accepts a job from the closed list and refuses any other name", () => {
    expect(() =>
      assertTwoFactorActor("op", { kind: "system", actor: "former-member-anonymisation" }),
    ).not.toThrow();
    expect(() => assertTwoFactorActor("op", { kind: "system", actor: "some-other-job" })).toThrow(
      TwoFactorActorError,
    );
    expect(() => assertTwoFactorActor("op", { kind: "system" })).toThrow(TwoFactorActorError);
  });

  it("refuses a system actor for anything but a clear, before writing a row", async () => {
    for (const action of [TWO_FACTOR_AUDIT_ACTIONS.enrolled, TWO_FACTOR_AUDIT_ACTIONS.recoveryCodesReplaced]) {
      await expect(
        recordTwoFactorMutation(db, {
          action,
          actor: { kind: "system", actor: "former-member-anonymisation" },
          subjectMemberId: "member-1",
          method: "TOTP",
          authenticatorApp: true,
        }),
      ).rejects.toThrow(TwoFactorActorError);
    }
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it("records a system clear with no acting member, and nothing when there was no factor", async () => {
    const actor = { kind: "system", actor: "former-member-anonymisation" } as const;
    await recordTwoFactorClear(db, {
      before: { twoFactorEnabled: false, twoFactorMethod: null, authenticatorApp: false },
      actor,
      subjectMemberId: "member-1",
    });
    expect(createAuditLog).not.toHaveBeenCalled();
    await recordTwoFactorClear(db, {
      before: { twoFactorEnabled: true, twoFactorMethod: "EMAIL", authenticatorApp: false },
      actor,
      subjectMemberId: "member-1",
    });
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: TWO_FACTOR_AUDIT_ACTIONS.cleared,
        memberId: null,
        actorMemberId: null,
        subjectMemberId: "member-1",
        metadata: { actorKind: "system", systemActor: "former-member-anonymisation", method: "EMAIL", authenticatorApp: false },
      }),
      db,
    );
  });
});
