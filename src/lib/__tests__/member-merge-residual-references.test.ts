/**
 * #4855: the census of what member merge checks for rows still naming the
 * duplicate once it holds its Member rows (`member-merge-residual-references.ts`).
 *
 * Every relation spec is either checked or excluded with a reason, and the
 * exclusions are pinned here by key: a new relation is checked without anyone
 * touching this file, and a new exclusion (a cascade relation, a second
 * `movedLast`, a late sweep) fails it until its reason is reviewed (`INV-SSOT`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { MEMBER_MERGE_RELATION_SPECS } from "@/lib/member-merge-relations";
import {
  findMemberMergeResidualReferences,
  MEMBER_MERGE_RESIDUAL_REFERENCE_PLAN,
} from "@/lib/member-merge-residual-references";

import { stripComments } from "./support/strip-comments";

/** The relations not checked, and why: each is handled another way. */
const EXCLUDED: Record<string, RegExp> = {
  // Member self-relations: the step-5 inbound re-check refuses a late link (#2437).
  "Member.parent": /#2437/,
  "Member.secondaryParent": /#2437/,
  "Member.inheritEmailFrom": /#2437/,
  "Member.inheritEmailChoice": /#2437/,
  "Member.detailsConfirmedBy": /#2437/,
  // Moved last, NOWAIT, under the Member rows (#4823).
  "Payment.manuallyMarkedPaidBy": /#4823/,
  // Swept late under the Member rows (#2597): the table's `sweptLate` flag.
  "HostingCoverageReevaluation.member": /^sweptLate: .*applyLateHostingCoverageMoves/,
  // The duplicate's own auth identity and ephemeral rows, dropped with it.
  "PasswordResetToken.member": /cascade/,
  "MagicLinkToken.member": /cascade/,
  "EmailVerificationToken.member": /cascade/,
  "EmailChangeToken.member": /cascade/,
  "TwoFactorEmailCode.member": /cascade/,
  "TwoFactorRecoveryCode.member": /cascade/,
  "TwoFactorSessionChallenge.member": /cascade/,
  "SessionReauthChallenge.member": /cascade/,
  "WebAuthnCredential.member": /cascade/,
  "WebAuthnChallenge.member": /cascade/,
  "PartnerInviteToken.createdBy": /cascade/,
  "SchoolMemberClassification.member": /cascade/,
};

describe("member merge's residual-reference census (#4855)", () => {
  it("covers every relation spec exactly once, in table order", () => {
    expect(MEMBER_MERGE_RESIDUAL_REFERENCE_PLAN.map((entry) => entry.key)).toEqual(
      MEMBER_MERGE_RELATION_SPECS.map((spec) => spec.key),
    );
  });

  it("excludes exactly the pinned relations, each with its reason", () => {
    const excluded = Object.fromEntries(
      MEMBER_MERGE_RESIDUAL_REFERENCE_PLAN.flatMap((entry) => (entry.checked ? [] : [[entry.key, entry.reason]])),
    );
    expect(Object.keys(excluded).sort()).toEqual(Object.keys(EXCLUDED).sort());
    for (const [key, reason] of Object.entries(EXCLUDED)) expect(excluded[key], key).toMatch(reason);
  });

  it("excludes a relation as swept late only because merge's late sweep moves exactly the flagged relations", () => {
    // One list (`INV-SSOT`): the exclusion and `applyLateHostingCoverageMoves`
    // both read `sweptLate`. Drop the flag and the exclusion goes with it (the
    // pinned set above fails); drop the sweep's use of it and this fails.
    const flagged = MEMBER_MERGE_RELATION_SPECS.filter((spec) => spec.sweptLate).map((spec) => spec.key);
    expect(flagged).toEqual(["HostingCoverageReevaluation.member"]);
    const merge = stripComments(readFileSync(join(import.meta.dirname, "..", "member-merge.ts"), "utf8"));
    const start = merge.indexOf("async function applyLateHostingCoverageMoves(");
    expect(start).toBeGreaterThan(-1);
    const sweep = merge.slice(start, merge.indexOf("\n}\n", start));
    expect(sweep).toContain("for (const spec of MEMBER_MERGE_LATE_SWEPT_SPECS)");
    expect(merge).toContain("const MEMBER_MERGE_LATE_SWEPT_SPECS = MEMBER_MERGE_RELATION_SPECS.filter((spec) => spec.sweptLate);");
    expect(sweep).not.toContain("hostingCoverageReevaluation.updateMany({\n    where: { memberId");
  });

  it("checks every other moved or resolved relation, the officer columns among them", () => {
    const checked = MEMBER_MERGE_RESIDUAL_REFERENCE_PLAN.filter((entry) => entry.checked).map((entry) => entry.key);
    expect(checked.length).toBe(MEMBER_MERGE_RELATION_SPECS.length - Object.keys(EXCLUDED).length);
    for (const key of [
      "Booking.member", "BookingGuest.member", "BookingChangeRequest.reviewedBy", "NewBookingPolicyExceptionRequest.reviewedBy",
      "Booking.createdBy", "ManualRefundTask.completedBy", "AdminCreditAdjustmentRequest.reviewedBy", "MemberCredit.member",
      "MemberAccessRole.member", "IssueReport.member",
    ]) expect(checked, key).toContain(key);
  });

  it("reads each checked relation for the duplicate's rows and reports the ones that still name it", async () => {
    const reads: Array<{ delegate: string; args: unknown }> = [];
    const db = new Proxy({}, {
      get: (_target, delegate: string) => ({
        findMany: vi.fn((args: { where: Record<string, unknown> }) => {
          reads.push({ delegate, args });
          if (delegate === "bookingChangeRequest" && args.where.reviewedByMemberId === "loser-1") return Promise.resolve([{ id: "request-1" }]);
          if (delegate === "issueReport") return Promise.resolve([{ id: "report-1" }]);
          return Promise.resolve([]);
        }),
      }),
    });

    await expect(findMemberMergeResidualReferences(db, "loser-1")).resolves.toEqual({
      driftFields: ["BookingChangeRequest.reviewedBy", "IssueReport.member"],
      residualRowIds: { "BookingChangeRequest.reviewedBy": ["request-1"], "IssueReport.member": ["report-1"] },
    });
    expect(reads).toHaveLength(MEMBER_MERGE_RESIDUAL_REFERENCE_PLAN.filter((entry) => entry.checked).length);
    expect(reads).toContainEqual({
      delegate: "bookingChangeRequest",
      args: { where: { reviewedByMemberId: "loser-1" }, select: { id: true }, orderBy: { id: "asc" }, take: 20 },
    });
    expect(reads.some(({ delegate }) => delegate === "passwordResetToken")).toBe(false);
  });
});
