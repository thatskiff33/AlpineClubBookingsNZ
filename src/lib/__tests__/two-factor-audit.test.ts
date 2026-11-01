import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));

import { createAuditLog } from "@/lib/audit";
import type { enrollTwoFactor, replaceRecoveryCodes } from "@/lib/two-factor";
import {
  TWO_FACTOR_AUDIT_ACTIONS,
  TwoFactorActorError,
  assertTwoFactorActor,
  assertTwoFactorActorMayAct,
  recordTwoFactorClear,
  recordTwoFactorMutation,
  type TwoFactorMutation,
} from "@/lib/two-factor-audit";

const JOB = { kind: "system", actor: "former-member-anonymisation" } as const;

// Type-level: a job cannot be named where a factor is enrolled or replaced.
// Each line fails to compile without its directive, so `pnpm run typecheck`
// fails if the person-only types are ever widened back to admit a job.
// @ts-expect-error a job may never enrol a second factor
const enrolByJob: Parameters<typeof enrollTwoFactor>[0]["actor"] = JOB;
// @ts-expect-error a job may never replace recovery codes
const replaceByJob: Parameters<typeof replaceRecoveryCodes>[0]["actor"] = JOB;
const enrolRow = { action: TWO_FACTOR_AUDIT_ACTIONS.enrolled, subjectMemberId: "member-1", method: "TOTP", authenticatorApp: true } as const;
// @ts-expect-error a job's row may only be a clear
const enrolRowByJob: TwoFactorMutation = { ...enrolRow, actor: JOB };
const clearRowByJob: TwoFactorMutation = {
  action: TWO_FACTOR_AUDIT_ACTIONS.cleared,
  actor: JOB,
  subjectMemberId: "member-1",
  method: null,
  authenticatorApp: false,
};
void [enrolByJob, replaceByJob, enrolRowByJob, clearRowByJob];

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

  it("refuses a job for anything but a clear, with a message that says so", () => {
    for (const action of [TWO_FACTOR_AUDIT_ACTIONS.enrolled, TWO_FACTOR_AUDIT_ACTIONS.recoveryCodesReplaced]) {
      expect(() => assertTwoFactorActorMayAct(action, JOB, "member-1")).toThrow(
        /a job .* may only clear a second factor/,
      );
    }
    expect(() => assertTwoFactorActorMayAct(TWO_FACTOR_AUDIT_ACTIONS.cleared, JOB, "member-1")).not.toThrow();
  });

  it("refuses a cast job row for anything but a clear, before writing a row", async () => {
    for (const action of [TWO_FACTOR_AUDIT_ACTIONS.enrolled, TWO_FACTOR_AUDIT_ACTIONS.recoveryCodesReplaced]) {
      await expect(
        recordTwoFactorMutation(db, {
          action,
          actor: JOB,
          subjectMemberId: "member-1",
          method: "TOTP",
          authenticatorApp: true,
        } as never),
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
