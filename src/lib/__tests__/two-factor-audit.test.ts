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
    await recordTwoFactorClear(db, {
      before: {
        twoFactorEnabled: false,
        twoFactorMethod: null,
        authenticatorApp: false,
        passkeyCount: 1,
      },
      actor,
      subjectMemberId: "member-1",
    });
    expect(createAuditLog).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: TWO_FACTOR_AUDIT_ACTIONS.cleared,
        metadata: expect.objectContaining({ passkeyCount: 1, authenticatorApp: false }),
      }),
      db,
    );
  });
});

// #4456 PR 2: the data-key re-encrypt records its two key-maintenance actions,
// and is the only actor that may; it may record nothing else.
describe("the data-key re-encrypt's two-factor actions (INV-PRIV-020)", () => {
  const REENCRYPT = { kind: "system", actor: "data-key-reencrypt" } as const;
  const MAINTENANCE = [
    TWO_FACTOR_AUDIT_ACTIONS.secretRewrapped,
    TWO_FACTOR_AUDIT_ACTIONS.recoveryCodesRetired,
  ] as const;
  // @ts-expect-error a key-maintenance row names the re-encrypt job, never a person
  const rewrapByMember: TwoFactorMutation = { action: TWO_FACTOR_AUDIT_ACTIONS.secretRewrapped, actor: { kind: "member", memberId: "m" }, subjectMemberId: "m", method: null, authenticatorApp: true };
  // @ts-expect-error nor another job
  const rewrapByOtherJob: TwoFactorMutation = { action: TWO_FACTOR_AUDIT_ACTIONS.secretRewrapped, actor: JOB, subjectMemberId: "m", method: null, authenticatorApp: true };
  void [rewrapByMember, rewrapByOtherJob];

  it("lets the re-encrypt job record its own actions", () => {
    for (const action of MAINTENANCE) {
      expect(() => assertTwoFactorActorMayAct(action, REENCRYPT, "member-1")).not.toThrow();
    }
  });

  it("refuses its actions to anyone else: a member, an administrator or another job", () => {
    for (const action of MAINTENANCE) {
      for (const actor of [{ kind: "member", memberId: "member-1" }, { kind: "admin", memberId: "admin-1" }, JOB]) {
        expect(() => assertTwoFactorActorMayAct(action, actor, "member-1")).toThrow(
          /only the "data-key-reencrypt" job records it/,
        );
      }
    }
  });

  it("refuses the re-encrypt job everything else, a clear included", () => {
    for (const action of [
      TWO_FACTOR_AUDIT_ACTIONS.enrolled,
      TWO_FACTOR_AUDIT_ACTIONS.recoveryCodesReplaced,
      TWO_FACTOR_AUDIT_ACTIONS.cleared,
    ]) {
      expect(() => assertTwoFactorActorMayAct(action, REENCRYPT, "member-1")).toThrow(TwoFactorActorError);
    }
  });

  it("records a retirement with the count and no code, and a re-wrap with no secret", async () => {
    await recordTwoFactorMutation(db, {
      action: TWO_FACTOR_AUDIT_ACTIONS.recoveryCodesRetired,
      actor: REENCRYPT,
      subjectMemberId: "member-1",
      method: null,
      authenticatorApp: false,
      recoveryCodesRetired: 4,
    });
    await recordTwoFactorMutation(db, {
      action: TWO_FACTOR_AUDIT_ACTIONS.secretRewrapped,
      actor: REENCRYPT,
      subjectMemberId: "member-1",
      method: null,
      authenticatorApp: true,
    });
    expect(vi.mocked(createAuditLog).mock.calls.map(([row]) => [row.action, row.summary, row.metadata, row.category])).toEqual([
      [
        "security.two_factor.recovery_codes_retired",
        "Two-factor recovery codes retired by a data-encryption key change",
        { actorKind: "system", systemActor: "data-key-reencrypt", method: null, authenticatorApp: false, recoveryCodesRetired: 4 },
        "security",
      ],
      [
        "security.two_factor.secret_rewrapped",
        "Two-factor authenticator secret re-encrypted under the current data key",
        { actorKind: "system", systemActor: "data-key-reencrypt", method: null, authenticatorApp: true },
        "security",
      ],
    ]);
  });
});
